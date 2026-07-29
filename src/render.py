"""
Render a page with Camoufox (patched headless Firefox) and print the
post-JavaScript HTML to stdout. server.js uses this as the dynamic-page
fallback when static Readability extraction comes back empty/thin.

Usage: python render.py <url>
Exit 0 + HTML on stdout on success; exit 1 + message on stderr on failure.
"""

import sys

from camoufox.sync_api import Camoufox

GOTO_TIMEOUT_MS = 45_000
NETWORKIDLE_TIMEOUT_MS = 15_000
WAF_WAIT_ROUNDS = 4  # __jsl_clearance challenges reload the page a few times
WAF_WAIT_SEC = 2.5


def looks_like_waf_challenge(html: str) -> bool:
    # Challenge pages are tiny shells; the heavy variant also names the cookie.
    return len(html) < 2000 or "__jsl_clearance" in html


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: render.py <url>", file=sys.stderr)
        return 2
    url = sys.argv[1]

    try:
        with Camoufox(headless=True) as browser:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
            try:
                page.wait_for_load_state("networkidle", timeout=NETWORKIDLE_TIMEOUT_MS)
            except Exception:
                pass  # many pages never go fully idle (analytics pings etc.)

            html = page.content()
            # Let JS WAF challenges (Knownsec __jsl_clearance, etc.) set their
            # cookie and reload; poll until the real page shows up.
            for _ in range(WAF_WAIT_ROUNDS):
                if not looks_like_waf_challenge(html):
                    break
                page.wait_for_timeout(int(WAF_WAIT_SEC * 1000))
                html = page.content()
    except Exception as e:  # noqa: BLE001 - report anything to the caller
        print(f"render failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    if not html.strip():
        print("render failed: empty page", file=sys.stderr)
        return 1
    sys.stdout.write(html)
    return 0


if __name__ == "__main__":
    sys.exit(main())
