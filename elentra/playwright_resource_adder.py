# """
# playwright_resource_adder.py

# Visible-browser version of the LAMS resource-adding automation. Unlike
# the requests-based single-POST approach, this actually drives a real
# Chromium window through each wizard step — intended for use when QC staff
# need to watch the steps happen, not just see a final result.

# This is a SEPARATE script from elentra_client.py/main.py (which stay on
# the existing requests/BeautifulSoup approach for the iRA/AE fetch step).
# It has its own login handling since Playwright automating the SSO login
# itself was already tried and abandoned for this codebase — instead, you
# log in manually ONCE in a real browser window Playwright opens, and the
# session is saved and reused on later runs.

# Usage:
#     python playwright_resource_adder.py

#     That's it — one command. First run (no saved session yet) opens a
#     browser and prompts for a one-time manual SSO login, then continues
#     straight into the run. Later runs reuse the saved session
#     automatically. Add --login to force a fresh login (e.g. if the saved
#     session has expired).

# Requires: pip install playwright && playwright install chromium
# """

# import argparse
# import time
# from pathlib import Path

# from playwright.sync_api import sync_playwright, Page
# from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

# from kanban_reader import get_resource_ready_lessons

# BASE_URL = "https://ntu.elentra.cloud"
# AUTH_STATE_PATH = "auth_state.json"

# # Pause between visible actions so a QC reviewer watching the screen can
# # actually follow what's happening, rather than it flashing past.
# STEP_DELAY_SECONDS = 0.6


# def build_title(base_title: str, variant: str) -> str:
#     title = f"LAMS {base_title}"
#     return f"{title} (Facilitator/CE)" if variant == "monitoring" else title


# def login_interactive() -> None:
#     """Open a real browser, let the user log in via SSO by hand, save the session."""
#     with sync_playwright() as p:
#         browser = p.chromium.launch(headless=False)
#         context = browser.new_context()
#         page = context.new_page()
#         page.goto(BASE_URL)
#         input(
#             "Log in via Institutional Login (SSO) in the browser window, "
#             "then press Enter here once you're on the dashboard..."
#         )
#         context.storage_state(path=AUTH_STATE_PATH)
#         browser.close()
#     print(f"Session saved to {AUTH_STATE_PATH}. You can now run without --login.")


# def resource_link_exists(page: Page, event_id: str, link_url: str) -> bool:
#     """
#     True if link_url already appears as a resource's "link" field in this
#     event's resource list.

#     NOTE: the initial page HTML from page.goto() does NOT include the
#     resource list — it's fetched separately via this same
#     method=event_resources endpoint the live app itself uses to refresh
#     the list after changes (confirmed via earlier network capture). So
#     this hits that endpoint directly instead of checking page.content().

#     The response is JSON shaped like:
#         {"status": "success", "data": {"pre": [...], "during": [...],
#          "post": [...], "none": [[{...resource...}, ...]]}}
#     where each of pre/during/post/none is a list of lists of resource
#     dicts (grouped by section, even when there's only one ungrouped
#     section). This parses that structure properly and checks each
#     resource's "link" field — NOT a raw substring check against the
#     response text, since JSON encodes forward slashes as "\\/" (PHP's
#     default json_encode behavior), which would never match a normal
#     "https://..." URL in a plain text search.
#     """
#     resp = page.request.get(
#         f"{BASE_URL}/admin/events?section=api-resource-wizard&method=event_resources"
#         f"&event_id={event_id}&event_status=published"
#     )
#     try:
#         payload = resp.json()
#     except Exception:
#         print("  [DEBUG] Could not parse event_resources response as JSON — treating as not found")
#         return False

#     data = payload.get("data", {})
#     if not isinstance(data, dict):
#         # Seen at least once: "data" came back as something other than a
#         # dict (e.g. a plain string). Rather than crash, log what we
#         # actually got so the shape can be inspected, and treat it as
#         # "not found" — worst case this means we re-attempt adding a
#         # link that's already there, which resource_link_exists's own
#         # callers won't duplicate against blindly, but Elentra's own UI
#         # would show the duplicate on inspection.
#         print(f"  [DEBUG] Unexpected 'data' shape in event_resources response: {payload!r}")
#         return False
#     for group in data.values():  # pre / during / post / none
#         if not isinstance(group, list):
#             continue
#         for section in group:
#             if not isinstance(section, list):
#                 continue
#             for resource in section:
#                 if isinstance(resource, dict) and resource.get("link") == link_url:
#                     return True
#     return False


# def _fill_resource_wizard(page: Page, variant: str, title: str, link_url: str) -> None:
#     """
#     Fills in the Add Event Resource wizard steps (assumes the wizard
#     modal is already open on Step 1 — caller is responsible for opening
#     it via the toggle, or via "Attach another Resource" when chaining
#     multiple resources in one modal session). See add_both_links().

#     variant="monitoring": Optional, hidden from learners
#     variant="learner":    Required, visible to learners. Selecting
#                            "Required" reveals an extra "How much time (in
#                            minutes) should the learner spend on this
#                            resource?" field in Step 2 — confirmed via QC
#                            screenshot to be left blank/untouched, so it's
#                            deliberately not filled below.

#     All radio/input ids below (including the learner-variant ones) are
#     confirmed against the live learner-flow HTML.
#     """
#     # Step 1: resource type
#     page.locator("#event_resource_type_3").check()  # "Link"
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event-resource-next").first.click()
#     time.sleep(STEP_DELAY_SECONDS)

#     # Step 2: optional/required + timeframe (+ minutes field, learner only)
#     if variant == "monitoring":
#         page.locator("#event-resource-required-no").check()  # "Optional" — confirmed
#     else:
#         page.locator("#event-resource-required-yes").check()  # "Required" — confirmed
#         # Reveals the "minutes to spend" field — intentionally left blank.
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event-resource-timeframe-none").check()  # "No Timeframe"
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event-resource-next").first.click()
#     time.sleep(STEP_DELAY_SECONDS)

#     # Step 3: release / hidden-from-learners / publish status
#     page.locator("#resource_release_no").check()  # "accessible any time"
#     time.sleep(STEP_DELAY_SECONDS)
#     if variant == "monitoring":
#         page.locator("#resource_hidden_yes").check()  # "Hide from learners" — confirmed
#     else:
#         page.locator("#resource_hidden_no").check()  # "Allow learners to view" — confirmed
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#resource_draft_published").check()  # "Published"
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event-resource-next").first.click()
#     time.sleep(STEP_DELAY_SECONDS)

#     # Step 4: proxy / URL / title / description
#     page.locator("#event_resource_link_proxy_no").check()  # "No, the proxy isn't required to be enabled"
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event_resource_link_url").fill(link_url)
#     time.sleep(STEP_DELAY_SECONDS)
#     page.locator("#event-resource-link-title").fill(title)
#     time.sleep(STEP_DELAY_SECONDS)

#     # CKEditor's contenteditable body doesn't sync back to its hidden form
#     # field on a plain .fill() — it needs real keystroke-like events plus
#     # a blur. Also, the bare "iframe" locator matches 8 iframes on this
#     # page, so it must be scoped to this field's specific title.
#     description_frame = page.frame_locator('iframe[title="Editor, event-resource-link-description"]')
#     description_box = description_frame.get_by_role(
#         "textbox", name="Editor, event-resource-link-description"
#     )
#     description_box.click()
#     description_box.type(title, delay=20)
#     page.locator("#event-resource-link-title").click()  # blur to force CKEditor to sync
#     time.sleep(STEP_DELAY_SECONDS)

#     page.locator("#event-resource-next").first.click()  # "Save Resource"
#     # networkidle used to hang/timeout here too (same root cause as the
#     # earlier fix). We don't have confirmed markup for a definite
#     # post-save signal, so give the save round-trip a short, bounded
#     # pause instead of an indefinite/flaky network-silence wait. This is
#     # non-fatal even if it times out — the resource is typically saved
#     # server-side regardless, and add_both_links() already re-checks via
#     # resource_link_exists()/the close-button click, so this is just
#     # giving the UI a moment to settle before the next action.
#     try:
#         page.wait_for_load_state("networkidle", timeout=5_000)
#     except PlaywrightTimeoutError:
#         page.wait_for_timeout(1_000)


# def add_both_links(
#     page: Page,
#     event_id: str,
#     monitoring_title: str,
#     monitoring_link: str,
#     learner_title: str,
#     learner_link: str,
# ) -> None:
#     """
#     Adds whichever of the monitoring/learner links aren't already present
#     on this event — both within one open modal session if both are
#     needed. Navigates to the event page once, checks the rendered page
#     for each link_url (see resource_link_exists()), and skips anything
#     already there instead of adding a duplicate.

#     If something needs adding, the modal is opened once via the toggle;
#     a second resource (if also needed) is added via "Attach another
#     Resource" in the same modal session rather than a second page
#     reload/navigation.
#     """
#     page.goto(f"{BASE_URL}/admin/events?rid={event_id}&section=content&id={event_id}")
#     # networkidle used to hang/timeout here — Elentra's page never fully
#     # goes network-quiet (background polling/analytics), so wait for the
#     # actual element we need instead of network silence that may never come.
#     page.wait_for_selector("#event-resource-toggle", state="visible", timeout=30_000)
#     print(f"  [DEBUG] Landed on: {page.url}")

#     to_add = []
#     if resource_link_exists(page, event_id, monitoring_link):
#         print("  Monitoring link already exists — skipping")
#     else:
#         to_add.append(("monitoring", monitoring_title, monitoring_link))

#     if resource_link_exists(page, event_id, learner_link):
#         print("  Learner link already exists — skipping")
#     else:
#         to_add.append(("learner", learner_title, learner_link))

#     if not to_add:
#         print("  Both links already present — nothing to add.")
#         return

#     page.locator("#event-resource-toggle").click()
#     time.sleep(STEP_DELAY_SECONDS)

#     for i, (variant, title, link_url) in enumerate(to_add):
#         if i > 0:
#             page.locator("#event-resource-next").first.click()  # "Attach another Resource"
#             time.sleep(STEP_DELAY_SECONDS)
#         _fill_resource_wizard(page, variant, title, link_url)

#     # All needed resources are already saved at this point — closing the
#     # modal is just cleanup, so a hiccup here shouldn't fail the whole run.
#     try:
#         close_button = page.locator("#quick-add-resource-close")
#         close_button.wait_for(state="visible", timeout=10_000)
#         close_button.click()
#     except PlaywrightTimeoutError:
#         print("  Note: couldn't click Close on the confirmation modal (link(s) saved fine) — continuing")


# def main() -> None:
#     parser = argparse.ArgumentParser()
#     parser.add_argument(
#         "--login", action="store_true", help="Open the sign-in window first, even if the profile is already signed in"
#     )
#     parser.add_argument("--headless", action="store_true", help="Run headless (defeats the QC-visibility point, but available)")
#     args = parser.parse_args()

#     if args.login or not Path(AUTH_STATE_PATH).exists():
#         if not Path(AUTH_STATE_PATH).exists():
#             print("No saved session found — opening browser for login...")
#         login_interactive()

#     lessons = get_resource_ready_lessons()
#     print(f"Found {len(lessons)} ready lesson(s).")

#     with sync_playwright() as p:
#         browser = p.chromium.launch(headless=args.headless)
#         context = browser.new_context(storage_state=AUTH_STATE_PATH)
#         page = context.new_page()

#         # --- debug listeners ---
#         # These fire on ANY close/disconnect, including the perfectly normal
#         # browser.close() at the end of this function — so we track whether
#         # we're the ones closing it and only print when we're NOT, i.e. when
#         # it's genuinely unexpected.
#         closing_intentionally = False
#         page.on(
#             "close",
#             lambda: None if closing_intentionally else print("  [DEBUG] Page was closed unexpectedly"),
#         )
#         context.on(
#             "close",
#             lambda: None if closing_intentionally else print("  [DEBUG] Context was closed unexpectedly"),
#         )
#         browser.on(
#             "disconnected",
#             lambda: None if closing_intentionally else print("  [DEBUG] Browser disconnected"),
#         )
#         # --- end debug listeners ---

#         for lesson in lessons:
#             event_id = lesson["id"]
#             base_title = lesson["title"]
#             print(f"\n{event_id} — {base_title}")

#             print("  Adding monitoring + learner links...")
#             add_both_links(
#                 page,
#                 event_id,
#                 build_title(base_title, "monitoring"),
#                 lesson["monitoring_link"],
#                 build_title(base_title, "learner"),
#                 lesson["learner_link"],
#             )

#         if lessons:
#             input("\nAll done — check the results in the browser window. Press Enter here to close it...")
#         else:
#             print("\nNothing to do — closing browser.")

#         closing_intentionally = True
#         browser.close()

#     print("\nDone.")


# if __name__ == "__main__":
#     main()

"""
playwright_resource_adder.py

Visible-browser version of the LAMS resource-adding automation. Unlike
the requests-based single-POST approach, this actually drives a real
Chromium window through each wizard step — intended for use when QC staff
need to watch the steps happen, not just see a final result.

This is a SEPARATE script from elentra_client.py/main.py (which stay on
the existing requests/BeautifulSoup approach for the iRA/AE fetch step).
It has its own login handling since Playwright automating the SSO login
itself was already tried and abandoned for this codebase — instead, you
log in manually ONCE in a real browser window Playwright opens, and the
persistent Elentra browser profile keeps that sign-in for later runs.

Usage (from the repository root; npm run setup installs the Python runtime):
    npm run elentra:links -- --tab "<tab>" --event-id 42374 --dry-run
    npm run elentra:links -- --tab "<tab>" --event-id 42374

    The sign-in comes from npm run login:elentra (or setup) and lives in the
    persistent profile. With no sign-in on this computer yet this script opens
    the sign-in window first; a lapsed Elentra session is renewed silently
    through Microsoft, and one Microsoft will not renew stops the run instead
    of adding anything. --dry-run reports which links
    are missing without opening the wizard.
"""

import argparse
import time

from playwright.sync_api import sync_playwright, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from kanban_reader import get_resource_ready_lessons
from session import login_interactive, signed_in_profile
from settings import BASE_URL, LEGACY_AUTH_STATE_PATH, PROFILE_DIR

# Pause between visible actions so a QC reviewer watching the screen can
# actually follow what's happening, rather than it flashing past.
STEP_DELAY_SECONDS = 0.6


def build_title(base_title: str, variant: str) -> str:
    title = f"LAMS {base_title}"
    return f"{title} (Facilitator/CE)" if variant == "monitoring" else title


def resource_link_exists(page: Page, event_id: str, link_url: str) -> bool:
    """
    True if link_url already appears as a resource's "link" field in this
    event's resource list.

    NOTE: the initial page HTML from page.goto() does NOT include the
    resource list — it's fetched separately via this same
    method=event_resources endpoint the live app itself uses to refresh
    the list after changes (confirmed via earlier network capture). So
    this hits that endpoint directly instead of checking page.content().

    The response is JSON shaped like:
        {"status": "success", "data": {"pre": [...], "during": [...],
         "post": [...], "none": [[{...resource...}, ...]]}}
    where each of pre/during/post/none is a list of lists of resource
    dicts (grouped by section, even when there's only one ungrouped
    section). This parses that structure properly and checks each
    resource's "link" field — NOT a raw substring check against the
    response text, since JSON encodes forward slashes as "\\/" (PHP's
    default json_encode behavior), which would never match a normal
    "https://..." URL in a plain text search.

    Fails closed: any response that cannot be read as a resource list
    (expired session, error page, unfamiliar shape) raises instead of
    returning False, because "not found" would make the caller add a
    duplicate live resource.
    """
    resp = page.request.get(
        f"{BASE_URL}/admin/events?section=api-resource-wizard&method=event_resources"
        f"&event_id={event_id}&event_status=published"
    )
    if not resp.ok or "?url=" in resp.url:
        raise RuntimeError(
            f"Could not read event {event_id}'s resource list (HTTP {resp.status}, {resp.url}). "
            "The Elentra session may have expired; run npm run login:elentra. Nothing was added."
        )
    try:
        payload = resp.json()
    except Exception as exc:
        raise RuntimeError(
            f"Event {event_id}'s resource list was not JSON, so existing links cannot be checked. "
            "Nothing was added."
        ) from exc

    if not isinstance(payload, dict) or payload.get("status") != "success":
        raise RuntimeError(f"Unexpected event_resources response for event {event_id}: {payload!r}")
    data = payload.get("data")
    if data in (None, [], {}):
        return False  # PHP encodes an event with no resources as an empty array
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected 'data' shape in event_resources response for event {event_id}: {payload!r}")
    for group in data.values():  # pre / during / post / none
        if not isinstance(group, list):
            continue
        for section in group:
            if not isinstance(section, list):
                continue
            for resource in section:
                if isinstance(resource, dict) and resource.get("link") == link_url:
                    return True
    return False


def _fill_resource_wizard(page: Page, variant: str, title: str, link_url: str) -> None:
    """
    Fills in the Add Event Resource wizard steps (assumes the wizard
    modal is already open on Step 1 — caller is responsible for opening
    it via the toggle, or via "Attach another Resource" when chaining
    multiple resources in one modal session). See add_both_links().

    variant="monitoring": Optional, hidden from learners
    variant="learner":    Required, visible to learners. Selecting
                           "Required" reveals an extra "How much time (in
                           minutes) should the learner spend on this
                           resource?" field in Step 2 — confirmed via QC
                           screenshot to be left blank/untouched, so it's
                           deliberately not filled below.

    All radio/input ids below (including the learner-variant ones) are
    confirmed against the live learner-flow HTML.
    """
    # Step 1: resource type
    page.locator("#event_resource_type_3").check()  # "Link"
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event-resource-next").first.click()
    time.sleep(STEP_DELAY_SECONDS)

    # Step 2: optional/required + timeframe (+ minutes field, learner only)
    if variant == "monitoring":
        page.locator("#event-resource-required-no").check()  # "Optional" — confirmed
    else:
        page.locator("#event-resource-required-yes").check()  # "Required" — confirmed
        # Reveals the "minutes to spend" field — intentionally left blank.
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event-resource-timeframe-none").check()  # "No Timeframe"
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event-resource-next").first.click()
    time.sleep(STEP_DELAY_SECONDS)

    # Step 3: release / hidden-from-learners / publish status
    page.locator("#resource_release_no").check()  # "accessible any time"
    time.sleep(STEP_DELAY_SECONDS)
    if variant == "monitoring":
        page.locator("#resource_hidden_yes").check()  # "Hide from learners" — confirmed
    else:
        page.locator("#resource_hidden_no").check()  # "Allow learners to view" — confirmed
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#resource_draft_published").check()  # "Published"
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event-resource-next").first.click()
    time.sleep(STEP_DELAY_SECONDS)

    # Step 4: proxy / URL / title / description
    page.locator("#event_resource_link_proxy_no").check()  # "No, the proxy isn't required to be enabled"
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event_resource_link_url").fill(link_url)
    time.sleep(STEP_DELAY_SECONDS)
    page.locator("#event-resource-link-title").fill(title)
    time.sleep(STEP_DELAY_SECONDS)

    # CKEditor's contenteditable body doesn't sync back to its hidden form
    # field on a plain .fill() — it needs real keystroke-like events plus
    # a blur. Also, the bare "iframe" locator matches 8 iframes on this
    # page, so it must be scoped to this field's specific title.
    description_frame = page.frame_locator('iframe[title="Editor, event-resource-link-description"]')
    description_box = description_frame.get_by_role(
        "textbox", name="Editor, event-resource-link-description"
    )
    description_box.click()
    description_box.type(title, delay=20)
    page.locator("#event-resource-link-title").click()  # blur to force CKEditor to sync
    time.sleep(STEP_DELAY_SECONDS)

    page.locator("#event-resource-next").first.click()  # "Save Resource"
    # networkidle used to hang/timeout here too (same root cause as the
    # earlier fix). We don't have confirmed markup for a definite
    # post-save signal, so give the save round-trip a short, bounded
    # pause instead of an indefinite/flaky network-silence wait.
    # add_both_links() re-reads the resource list afterwards to verify
    # the save, so this is just giving the UI a moment to settle.
    try:
        page.wait_for_load_state("networkidle", timeout=5_000)
    except PlaywrightTimeoutError:
        page.wait_for_timeout(1_000)


def add_both_links(
    page: Page,
    event_id: str,
    monitoring_title: str,
    monitoring_link: str,
    learner_title: str,
    learner_link: str,
    dry_run: bool = False,
) -> list[str]:
    """
    Adds whichever of the monitoring/learner links aren't already present
    on this event — both within one open modal session if both are
    needed. Navigates to the event page once, checks the resource list
    for each link_url (see resource_link_exists()), and skips anything
    already there instead of adding a duplicate. With dry_run, reports
    what it would add and stops before opening the wizard.

    If something needs adding, the modal is opened once via the toggle;
    a second resource (if also needed) is added via "Attach another
    Resource" in the same modal session rather than a second page
    reload/navigation. Afterwards the resource list is read again and a
    link that did not persist raises.

    Returns the variants that were added (or would be, with dry_run).
    """
    page.goto(
        f"{BASE_URL}/admin/events?rid={event_id}&section=content&id={event_id}",
        wait_until="domcontentloaded",
    )
    print(f"  [DEBUG] Event page: {page.url} | {page.title()}")
    # networkidle used to hang/timeout here — Elentra's page never fully
    # goes network-quiet (background polling/analytics), so wait for the
    # actual element we need instead of network silence that may never come.
    try:
        page.wait_for_selector("#event-resource-toggle", state="visible", timeout=30_000)
    except PlaywrightTimeoutError as exc:
        raise RuntimeError(
            "The Elentra event page opened, but its Add Event Resource control was not visible. "
            "Check that this SSO account has Administrator View enabled and that the URL above "
            "is the expected event's admin content page."
        ) from exc

    to_add = []
    if resource_link_exists(page, event_id, monitoring_link):
        print("  Monitoring link already exists — skipping")
    else:
        to_add.append(("monitoring", monitoring_title, monitoring_link))

    if resource_link_exists(page, event_id, learner_link):
        print("  Learner link already exists — skipping")
    else:
        to_add.append(("learner", learner_title, learner_link))

    if not to_add:
        print("  Both links already present — nothing to add.")
        return []

    if dry_run:
        for variant, title, link_url in to_add:
            print(f"  DRY RUN: would add {variant} link '{title}' -> {link_url}")
        return [variant for variant, _, _ in to_add]

    page.locator("#event-resource-toggle").click()
    time.sleep(STEP_DELAY_SECONDS)

    for i, (variant, title, link_url) in enumerate(to_add):
        if i > 0:
            page.locator("#event-resource-next").first.click()  # "Attach another Resource"
            time.sleep(STEP_DELAY_SECONDS)
        _fill_resource_wizard(page, variant, title, link_url)

    # Closing the modal is just cleanup; whether the links saved is
    # verified from the resource list below, not from this click.
    try:
        close_button = page.locator("#quick-add-resource-close")
        close_button.wait_for(state="visible", timeout=10_000)
        close_button.click()
    except PlaywrightTimeoutError:
        print("  Note: couldn't click Close on the confirmation modal — verifying the saved links next")

    missing = [variant for variant, _, link_url in to_add if not resource_link_exists(page, event_id, link_url)]
    if missing:
        raise RuntimeError(
            f"Event {event_id}: the {' and '.join(missing)} link(s) did not appear in the resource "
            "list after saving. Check the event in the browser before rerunning."
        )
    for variant, _, _ in to_add:
        print(f"  VERIFIED {variant} link is now in the event's resource list")
    return [variant for variant, _, _ in to_add]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--login", action="store_true", help="Force a fresh login even if a saved session already exists"
    )
    parser.add_argument("--headless", action="store_true", help="Run headless (defeats the QC-visibility point, but available)")
    parser.add_argument("--tab", required=True, help="The Kanban tab to read, as the user named it (see kanban.py --tabs)")
    parser.add_argument("--event-id", help="Process only this Elentra Event ID")
    parser.add_argument("--lesson-id", help="Process only the Kanban row with this LAMS Lesson ID (the published 5-digit code)")
    parser.add_argument("--no-pause", action="store_true", help="Close automatically when done")
    parser.add_argument("--dry-run", action="store_true", help="Report which links would be added without adding them")
    args = parser.parse_args()

    if args.login or not (PROFILE_DIR.exists() or LEGACY_AUTH_STATE_PATH.exists()):
        if not args.login:
            print("No Elentra sign-in on this computer yet — opening browser for login...")
        login_interactive()

    lessons = get_resource_ready_lessons(args.tab)
    if args.event_id:
        lessons = [lesson for lesson in lessons if lesson["id"] == args.event_id]
    if args.lesson_id:
        lessons = [lesson for lesson in lessons if lesson["lesson_id"] == args.lesson_id]
        if not lessons:
            raise SystemExit(
                f"No ready Kanban row has Lesson ID {args.lesson_id}. Check that the row has status "
                "'Can start', that code in its Lesson ID column, and an Elentra Event ID. A code "
                "written moments ago can take a minute to appear in the sheet's export."
            )
    print(f"Found {len(lessons)} ready lesson(s).")
    if args.event_id and not lessons:
        raise SystemExit(
            f"No ready Kanban row matched Elentra Event ID {args.event_id}. "
            "Check that the row has status 'Can start', a Lesson ID in column M, "
            "and an Elentra Event ID in column P."
        )

    with sync_playwright() as p, signed_in_profile(p, headless=args.headless) as context:
        page = context.pages[0] if context.pages else context.new_page()

        # --- debug listeners ---
        # These fire on ANY close/disconnect, including the perfectly normal
        # browser.close() at the end of this function — so we track whether
        # we're the ones closing it and only print when we're NOT, i.e. when
        # it's genuinely unexpected.
        closing_intentionally = False
        page.on(
            "close",
            lambda: None if closing_intentionally else print("  [DEBUG] Page was closed unexpectedly"),
        )
        context.on(
            "close",
            lambda: None if closing_intentionally else print("  [DEBUG] Context was closed unexpectedly"),
        )
        # --- end debug listeners ---

        for lesson in lessons:
            event_id = lesson["id"]
            base_title = lesson["title"]
            print(f"\n{event_id} — {base_title}")

            print("  Checking monitoring + learner links...")
            add_both_links(
                page,
                event_id,
                build_title(base_title, "monitoring"),
                lesson["monitoring_link"],
                build_title(base_title, "learner"),
                lesson["learner_link"],
                dry_run=args.dry_run,
            )

        if lessons and not args.no_pause:
            input("\nAll done — check the results in the browser window. Press Enter here to close it...")
        elif not lessons:
            print("\nNothing to do — closing browser.")

        # signed_in_profile closes the profile normally, which saves its cookies.
        closing_intentionally = True

    print("\nDone.")


if __name__ == "__main__":
    main()
