"""Offline smoke test, embedded in PetGPT and run by QQ-MCP's managed Python."""

from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as playwright:
        # Match screenshot_chat: default Chromium headless shell, no channel or
        # executable override that could hide a missing Playwright revision.
        browser = playwright.chromium.launch(timeout=30_000)
        try:
            page = browser.new_page(viewport={"width": 64, "height": 64})
            page.set_default_timeout(10_000)
            page.route("**/*", lambda route: route.abort())
            page.set_content("<!doctype html><html><body>QQ screenshot check</body></html>")
            png = page.screenshot(type="png", timeout=10_000)
            if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("Chromium did not produce a PNG screenshot")
            print(f"Chromium {browser.version}: screenshot OK ({len(png)} bytes)")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
