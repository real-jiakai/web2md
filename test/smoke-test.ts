/**
 * Smoke test: boot the compiled server on a scratch port and verify live
 * conversions. Checks the static path always; also checks the Camoufox
 * dynamic fallback when the .venv install is present.
 *
 * Usage: npm test   (builds first, then runs this file from dist/test/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';

const PORT = 3123;

function fail(msg: string, code = 1): never {
  console.error(`SMOKE TEST FAILED: ${msg}`);
  process.exit(code);
}

async function convert(target: string, timeoutMs: number): Promise<string> {
  const res = await fetch(`http://localhost:${PORT}/${target}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) fail(`HTTP ${res.status} for ${target}: ${await res.text()}`);
  return res.text();
}

(async () => {
  // This file runs from dist/test/; the project root is two levels up.
  const ROOT = path.join(__dirname, '..', '..');
  const server: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, 'dist', 'src', 'server.js')],
    {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    }
  );
  const stop = () => {
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  };
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
  const hasBrowser = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'));
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
})().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
