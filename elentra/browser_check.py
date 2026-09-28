"""Setup/doctor probe: the Elentra scripts' packages import and their browser opens headed."""

import bs4  # noqa: F401
import requests  # noqa: F401
from playwright.sync_api import sync_playwright

from settings import launch_options

with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options(headless=False))
    try:
        page = browser.new_page()
        page.set_content("<title>Elentra runtime check</title><p>ok</p>")
        if page.title() != "Elentra runtime check":
            raise SystemExit("The Elentra browser opened but did not render the check page.")
    finally:
        browser.close()
