/**
 * Smoke test: boot the server on a scratch port and verify live conversions.
 * Checks the static path always; also checks the Camoufox dynamic fallback
 * when the .venv install is present.
 *
 * Usage: node smoke-test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3123;

function fail(msg, code = 1) {
  console.error(`SMOKE TEST FAILED: ${msg}`);
  process.exit(code);
}

async function convert(target, timeoutMs) {
  const res = await fetch(`http://localhost:${PORT}/${target}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) fail(`HTTP ${res.status} for ${target}: ${await res.text()}`);
  return res.text();
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const stop = () => { try { server.kill(); } catch {} };
  process.on('exit', stop);

  // Wait for the listener to come up.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fetch(`http://localhost:${PORT}/`);
      break;
    } catch {
      if (Date.now() > deadline) fail('server did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // 1) Static path.
  const target = 'http://example.com/';
  const body = await convert(target, 60_000);
  if (!body.includes('Title: Example Domain')) fail('missing extracted title');
  if (!body.includes(`URL Source: ${target}`)) fail('missing source URL');
  if (!body.includes('Markdown Content:')) fail('missing markdown body');
  console.log('static path: ok');

  // 2) Dynamic path (only when the Camoufox install is present).
  const hasBrowser = fs.existsSync(path.join(__dirname, '.venv', 'bin', 'python'));
  if (hasBrowser) {
    const spa = await convert('https://quotes.toscrape.com/js/', 150_000);
    if (!spa.includes('world as we have created it')) {
      fail('dynamic fallback did not extract JS-rendered content');
    }
    console.log('dynamic path (Camoufox): ok');
  } else {
    console.log('dynamic path: skipped (.venv not installed)');
  }

  stop();
  console.log('smoke test passed');
})().catch((e) => fail(e.message));
