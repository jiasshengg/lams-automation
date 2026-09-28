"""
Manual check of the add-links wizard against the sandbox event only.

Run from the repository root with: npm run elentra:sandbox-test
Add -- --dry-run to only report which test links are missing.
"""

import sys

from playwright.sync_api import sync_playwright

from playwright_resource_adder import add_both_links, build_title
from settings import AUTH_STATE_PATH, launch_options

TEST_EVENT_ID = "42374"  # the "please ignore" sandbox event, not a real lesson
monitoring_title = build_title("MSK TBL01 280826 2025Y2", "monitoring")
learner_title = build_title("MSK TBL01 280826 2025Y2", "learner")
monitoring_link = "https://ilams.lamsinternational.com/lams/monitoring/monitoring/monitorLesson.do?lessonID=41170"
learner_link = "https://ilams.lamsinternational.com/lams/home/learner.do?lessonID=41170"

dry_run = "--dry-run" in sys.argv[1:]

if not AUTH_STATE_PATH.exists():
    raise SystemExit("No saved Elentra session. Run: npm run login:elentra")

with sync_playwright() as p:
    browser = p.chromium.launch(**launch_options(headless=False))
    context = browser.new_context(storage_state=str(AUTH_STATE_PATH))
    page = context.new_page()
    add_both_links(page, TEST_EVENT_ID, monitoring_title, monitoring_link, learner_title, learner_link, dry_run=dry_run)
    # add_both_links() has already re-read the resource list and printed VERIFIED lines;
    # leave the window up briefly so a watcher can see the result.
    page.wait_for_timeout(5_000)
    browser.close()
