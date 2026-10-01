"""
Manual check of the add-links wizard against the sandbox event only.

Run from the repository root with: npm run elentra:sandbox-test
Add -- --dry-run to only report which test links are missing.
"""

import sys

from playwright.sync_api import sync_playwright

from playwright_resource_adder import add_both_links, build_title
from session import signed_in_profile

TEST_EVENT_ID = "42374"  # the "please ignore" sandbox event, not a real lesson
monitoring_title = build_title("MSK TBL01 280826 2025Y2", "monitoring")
learner_title = build_title("MSK TBL01 280826 2025Y2", "learner")
monitoring_link = "https://ilams.lamsinternational.com/lams/monitoring/monitoring/monitorLesson.do?lessonID=41170"
learner_link = "https://ilams.lamsinternational.com/lams/home/learner.do?lessonID=41170"

dry_run = "--dry-run" in sys.argv[1:]

with sync_playwright() as p, signed_in_profile(p, headless=False) as context:
    page = context.pages[0] if context.pages else context.new_page()
    add_both_links(page, TEST_EVENT_ID, monitoring_title, monitoring_link, learner_title, learner_link, dry_run=dry_run)
    # add_both_links() has already re-read the resource list and printed VERIFIED lines;
    # leave the window up briefly so a watcher can see the result.
    page.wait_for_timeout(5_000)
