/**
 * web2md — a lightweight r.jina.ai style reader service.
 *
 * Usage:
 *   node server.js            # starts on PORT (default 3000)
 *   curl http://localhost:3000/http://example.com/article
 *
 * The service fetches the target page, extracts the main content with
 * Mozilla Readability, and converts it to AI-ready Markdown.
 *
 * It can pass the __jsl_clearance JavaScript WAF challenge (Knownsec/yunaq,
 * common on Chinese government sites) by evaluating the challenge in a vm
 * sandbox and retrying with the computed cookie. Solved cookies are cached
 * per host so later requests skip the challenge.
 */

const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');

const PORT = process.env.PORT || 3000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_CHALLENGE_ATTEMPTS = 10; // the WAF issues a random number of stages
const COOKIE_TTL_MS = 50 * 60 * 1000; // clearance cookies live ~1h
const RENDER_TIMEOUT_MS = 90_000; // headless-browser budget per page
const MIN_STATIC_TEXT = 100; // below this, treat the page as a JS-rendered shell

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

// Drop noisy elements that Readability sometimes keeps.
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button']);

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const USAGE = `web2md — turn any webpage into AI-ready Markdown.

Usage:
  http://localhost:${PORT}/https://example.com/article
  http://localhost:${PORT}/http://example.com/article
  http://localhost:${PORT}/example.com/article        (https is assumed)

Response: text/markdown with the page title, source URL, and extracted content.
`;

// ---------------------------------------------------------------------------
// WAF challenge solving
// ---------------------------------------------------------------------------

/** Per-host cookie jar: host -> { cookies: ["name=value", ...], expiresAt }. */
const cookieCache = new Map();

function getCachedCookies(host) {
  const entry = cookieCache.get(host);
  if (!entry) return [];
  if (Date.now() > entry.expiresAt) {
    cookieCache.delete(host);
    return [];
  }
  return [...entry.cookies];
}

function setCachedCookies(host, cookies) {
  cookieCache.set(host, {
    cookies: [...cookies],
    expiresAt: Date.now() + COOKIE_TTL_MS,
  });
}

/** Upsert a "name=value" pair into a cookie jar (array of pairs). */
function upsertCookie(jar, pair) {
  const name = pair.split('=')[0];
  const i = jar.findIndex((c) => c.startsWith(`${name}=`));
  if (i >= 0) jar[i] = pair;
  else jar.push(pair);
}

/**
 * Try to evaluate one script block as a WAF challenge. Returns the computed
 * "__jsl_clearance=..." cookie pair, or null when the script does not yield it.
 */
function evalChallengeScript(js, targetUrl) {
  const { pathname, search } = new URL(targetUrl);
  let cookie = '';
  const documentObj = {};
  Object.defineProperty(documentObj, 'cookie', {
    set: (v) => {
      cookie = String(v);
    },
    get: () => cookie,
  });

  const sandbox = {
    document: documentObj,
    location: { href: '', pathname, search },
    navigator: { userAgent: USER_AGENT },
    // Some challenges defer work with setTimeout; run it immediately.
    setTimeout: (fn) => (typeof fn === 'function' ? fn() : undefined),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { timeout: 3000 });
  } catch {
    return null;
  }
  const pair = cookie.split(';')[0];
  return pair.includes('__jsl_clearance=') ? pair : null;
}

/**
 * If the HTML looks like a Knownsec-style JS challenge (a <script> that
 * computes __jsl_clearance and reloads), evaluate every script block in a
 * sandbox and return the computed cookie pair. Returns null otherwise.
 *
 * Detection: a 521/520 status is always treated as a candidate. Otherwise
 * look for tells — the heavy variant passes "tn":"__jsl_clearance" to go()
 * in plaintext, the light one builds the name by concatenating strings
 * ('j')+('s')+('l')..., so it only shows "document.cookie".
 */
function solveJslChallenge(html, targetUrl, isChallengeStatus) {
  const looksLikeChallenge =
    isChallengeStatus ||
    html.includes('__jsl_clearance') ||
    html.includes('document.cookie');
  if (!looksLikeChallenge) return null;
  const scripts = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const solved = evalChallengeScript(m[1], targetUrl);
    if (solved) return solved;
  }
  return null;
}

async function fetchOnce(targetUrl, cookies) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (cookies.length) headers.Cookie = cookies.join('; ');
    return await fetch(targetUrl, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(targetUrl) {
  const host = new URL(targetUrl).host;
  const cookies = getCachedCookies(host);

  for (let attempt = 1; attempt <= MAX_CHALLENGE_ATTEMPTS; attempt++) {
    const res = await fetchOnce(targetUrl, cookies);

    // Merge Set-Cookie pairs (e.g. __jsluid_h) into the cookie jar.
    for (const sc of res.headers.getSetCookie?.() || []) {
      upsertCookie(cookies, sc.split(';')[0]);
    }

    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BODY_BYTES) {
      throw new Error(`Page too large (${length} bytes)`);
    }
    const body = Buffer.from(await res.arrayBuffer());

    // A WAF challenge can come back with 521/520 or even 200; detect by content.
    if (
      (res.status === 521 || res.status === 520 || res.ok) &&
      body.length < 1024 * 1024
    ) {
      const solved = solveJslChallenge(
        body.toString('utf8'),
        targetUrl,
        res.status === 521 || res.status === 520
      );
      console.error(
        `[web2md] attempt ${attempt}: HTTP ${res.status}, ${body.length}B, challenge=${!!solved}`
      );
      if (solved) {
        upsertCookie(cookies, solved);
        continue; // retry with the clearance cookie
      }
    }

    if (!res.ok) {
      throw new Error(`Target returned HTTP ${res.status} ${res.statusText}`);
    }
    setCachedCookies(host, cookies); // real page served -> clearance is valid
    return body;
  }

  throw new Error('Failed to pass the JavaScript WAF challenge');
}

// ---------------------------------------------------------------------------
// Dynamic fallback: render with Camoufox (headless Firefox) via render.py
// ---------------------------------------------------------------------------

function renderWithBrowser(targetUrl) {
  const python = path.join(__dirname, '.venv', 'bin', 'python');
  if (!fs.existsSync(python)) {
    return Promise.reject(
      new Error(
        'browser fallback not installed. Run: python3 -m venv .venv && ' +
          '.venv/bin/pip install camoufox && .venv/bin/python -m camoufox fetch'
      )
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      python,
      [path.join(__dirname, 'render.py'), targetUrl],
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || '').trim().slice(0, 300);
          return reject(
            new Error(`browser render failed: ${detail || err.message}`)
          );
        }
        resolve(Buffer.from(stdout, 'utf8'));
      }
    );
  });
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

function pageToMarkdown(htmlBuffer, targetUrl) {
  // Silence jsdom's css/script noise; sniff encoding from the buffer.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(htmlBuffer, { url: targetUrl, virtualConsole });
  const doc = dom.window.document;

  const reader = new Readability(doc);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error('Could not extract readable content from this page');
  }

  const body = turndown.turndown(article.content);
  const parts = [];
  if (article.title) parts.push(`Title: ${article.title.trim()}`);
  parts.push(`URL Source: ${targetUrl}`);
  if (article.byline) parts.push(`Author: ${article.byline.trim()}`);
  if (article.publishedTime) parts.push(`Published Time: ${article.publishedTime}`);
  parts.push('', 'Markdown Content:', '', body);
  return {
    markdown: parts.join('\n'),
    textLength: (article.textContent || '').trim().length,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let target = decodeURIComponent(reqUrl.pathname.slice(1)); // strip leading "/"

    if (!target) {
      return send(res, 200, USAGE);
    }

    // Allow scheme-less URLs: /example.com/path -> https://example.com/path
    if (!/^https?:\/\//i.test(target)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        return send(res, 400, `Unsupported protocol in URL: ${target}`);
      }
      target = `https://${target}`;
    }

    // Basic validation; only http/https are fetchable.
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return send(res, 400, `Invalid target URL: ${target}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return send(res, 400, `Unsupported protocol: ${parsed.protocol}`);
    }

    const html = await fetchPage(target);

    // Fast path: extract from the static HTML.
    let result = null;
    try {
      result = pageToMarkdown(html, target);
    } catch {
      /* likely a JS-rendered shell — the browser fallback below handles it */
    }

    // Slow path: page looks like an SPA shell — static extraction failed,
    // came back nearly empty, or the text density is tiny (a few nav words
    // buried in KBs of JS bundles). Render in headless Firefox (Camoufox)
    // and extract from the live DOM.
    const textLen = result ? result.textLength : 0;
    const density = result ? textLen / html.length : 0;
    const suspectShell =
      !result || textLen < MIN_STATIC_TEXT || (textLen < 600 && density < 0.05);

    if (suspectShell) {
      console.error(
        `[web2md] static extraction ${
          result ? `suspect (${textLen} chars, density ${density.toFixed(3)})` : 'failed'
        }; rendering in browser...`
      );
      try {
        const rendered = await renderWithBrowser(target);
        const dynamic = pageToMarkdown(rendered, target);
        if (!result || dynamic.textLength > result.textLength) {
          result = dynamic; // use the rendered page when it yields more text
        }
      } catch (err) {
        if (!result) throw err; // nothing static to fall back to
        console.error(`[web2md] browser render failed, serving static result: ${err.message}`);
      }
    }

    send(res, 200, result.markdown, 'text/markdown; charset=utf-8');
  } catch (err) {
    const msg =
      err.name === 'AbortError'
        ? `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : err.message;
    send(res, 502, `web2md error: ${msg}`);
  }
});

server.listen(PORT, () => {
  console.log(`web2md listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/https://example.com`);
});
