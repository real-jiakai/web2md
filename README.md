# web2md

**[English](README.md) | [简体中文](README.zh-CN.md)**

A lightweight, self-hosted [r.jina.ai](https://r.jina.ai) style reader service.
Prepend the service prefix to any URL and get the page back as clean, AI-ready
Markdown — from static pages and JS-rendered SPAs alike (WeChat
official-account articles included).

## Features

- **Prefix-based usage, just like r.jina.ai** — `http://localhost:3000/<url>` → `text/markdown`
- **Static pages, sub-second** — Mozilla Readability extraction + Turndown conversion
- **SPA / JS-rendered pages** — automatic fallback to a real headless browser ([Camoufox](https://github.com/daijro/camoufox), an anti-detect Firefox build)
- **WAF bypass** — solves the Knownsec/yunaq `__jsl_clearance` JavaScript challenge (common on Chinese government sites) in a sandboxed VM; cookies cached per host
- **Encoding-safe** — jsdom sniffs the charset, so GBK and UTF-8 pages both decode correctly
- **Docker Compose deployment** — one command, everything included

## Project structure

```
├── src/
│   ├── server.js        # HTTP service: fetch, WAF solver, extraction, SPA fallback
│   └── render.py        # Camoufox (headless Firefox) renderer for JS pages
├── test/
│   └── smoke-test.js    # end-to-end smoke test (static + dynamic paths)
├── Dockerfile           # all-in-one image: Node 22 + Python + Camoufox browser
├── docker-compose.yml
├── package.json
└── start.command        # macOS double-click launcher
```

## Quick start (local)

```bash
npm install
npm start          # listens on http://localhost:3000 (set PORT to change)
```

Or double-click `start.command` on macOS.

Static pages work out of the box. For JS-rendered pages (React/Vue SPAs),
install the Camoufox browser fallback:

```bash
python3 -m venv .venv
.venv/bin/pip install camoufox
.venv/bin/python -m camoufox fetch   # downloads the browser to ~/Library/Caches/camoufox
```

No configuration needed — when static extraction comes back empty or looks
like a JS shell, the service automatically renders the page in headless
Firefox. Without `.venv`, everything still works for static pages.

## Deploy with Docker Compose

Everything (Node 22 + Python venv + Camoufox browser + Firefox system
libraries) is baked into one image:

```bash
docker compose up -d --build   # first build downloads ~500MB (browser included)
curl http://localhost:3000/example.com
docker compose logs -f         # watch requests
docker compose down            # stop
```

Change the port mapping in `docker-compose.yml` (`"8080:3000"` to serve on
port 8080); `PORT` inside the container stays 3000.

## Usage

```
http://localhost:3000/https://example.com/article
http://localhost:3000/http://example.com/article
http://localhost:3000/example.com/article        (https is assumed)
```

Example:

```bash
curl "http://localhost:3000/http://www.scio.gov.cn/xwfb/dfxwfb/gssfbh/gx_13845/202509/t20250923_932502.html"
```

Response (`text/markdown`):

```
Title: 广西举行第22届中国—东盟博览会闭幕新闻发布会
URL Source: http://www.scio.gov.cn/...

Markdown Content:

中国—东盟博览会、中国—东盟商务与投资峰会指挥中心于2025年9月21日...
```

## How it works

1. **Fetch** the target page with browser-like headers (30s timeout, 20MB cap).
2. **Pass WAF challenges** — `__jsl_clearance` challenge scripts are evaluated
   in a `node:vm` sandbox and the service retries with the computed cookie;
   solved cookies are cached per host for ~50 minutes.
3. **Extract** the main content with Mozilla Readability (the Firefox Reader
   View engine); jsdom sniffs the charset.
4. **Detect JS shells** — static extraction that fails, returns almost no text
   (<100 chars), or has suspiciously low text density (<600 chars at <5% of
   the HTML) marks the page as a JS-rendered SPA.
5. **Dynamic fallback** — suspect pages are rendered by `src/render.py` in
   headless Camoufox (real Firefox engine, executes the page's JS, waits out
   WAF reloads naturally); Readability then runs on the rendered DOM. The
   rendered result wins only when it yields more text, and any static result
   is still served if the browser fails.
6. **Convert** the content HTML to Markdown with Turndown.

Typical latency: static pages well under 1s; browser-rendered pages ~5–15s.

## Test

```bash
npm test   # boots the server on a scratch port; checks the static
           # path, and the Camoufox fallback when .venv is present
```

## Notes

- Only `http://` and `https://` targets are supported.
- The WAF solver runs remote challenge code inside a `vm` sandbox with no
  access to the host — the same technique cloudscraper-style tools use.
- Each dynamic render spawns a fresh browser (~200MB RAM); it's a fallback,
  not the default path.

## Acknowledgements

- Built with [Kimi K3](https://www.kimi.com/code/docs/en/) +
  [Kimi Code](https://code.kimi.com) — the whole project was pair-programmed
  with it.
- [Mozilla Readability](https://github.com/mozilla/readability),
  [Turndown](https://github.com/mixmark-io/turndown) and
  [Camoufox](https://github.com/daijro/camoufox) do the heavy lifting.
