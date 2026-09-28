"""
Saved Elentra SSO session: interactive sign-in and a no-input check.

Usage:
    python session.py --login   # open a browser, sign in by hand (detected automatically), save and verify
    python session.py --check   # verify the saved session without opening a window

Automating the SSO form itself was tried and abandoned for this codebase, so
the user signs in by hand once; the session is saved and reused on later runs.
"""

import argparse
import sys
import time
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from settings import AUTH_STATE_PATH, BASE_URL, launch_options

LOGIN_TIMEOUT_SECONDS = 10 * 60
POLL_SECONDS = 3


def _admin_page_opens(p, storage_state) -> bool:
    """Whether these cookies can load an admin page; same rule as session_ok()."""
    request = p.request.new_context(storage_state=storage_state)
    try:
        resp = request.get(f"{BASE_URL}/admin/events", timeout=30_000)
        return "/admin/" in resp.url and "?url=" not in resp.url
    finally:
        request.dispose()


def _all_tabs_on_elentra(context) -> bool:
    # While any tab is on the identity provider (Microsoft/ADFS) or blank, the user is
    # mid-sign-in, so no probe is sent that could disturb the SSO round trip.
    host = urlparse(BASE_URL).hostname
    return bool(context.pages) and all(urlparse(page.url).hostname == host for page in context.pages)


def session_ok() -> bool:
    """
    True only if the saved session can actually load an admin page.
    A dead session gets bounced to /?url=%2Fadmin... (the login page).
    """
    if not AUTH_STATE_PATH.exists():
        return False
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_options(headless=True))
        try:
            context = browser.new_context(storage_state=str(AUTH_STATE_PATH))
            resp = context.request.get(f"{BASE_URL}/admin/events", timeout=30_000)
            return "/admin/" in resp.url and "?url=" not in resp.url
        finally:
            browser.close()


def login_interactive() -> None:
    """Open a real browser, let the user sign in via SSO by hand, save and verify the session."""
    AUTH_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_options(headless=False))
        context = browser.new_context()
        page = context.new_page()
        page.goto(BASE_URL)
        print(f"Opened Elentra in a browser window: {BASE_URL}")
        print(
            "Sign in with Institutional Login (SSO) in that window yourself. The sign-in is "
            f"detected automatically; waiting up to {LOGIN_TIMEOUT_SECONDS // 60} minutes."
        )
        # The cookies are tested through a separate request context, so a probe made before
        # sign-in completes never redirects or changes the page the user is working in.
        deadline = time.monotonic() + LOGIN_TIMEOUT_SECONDS
        signed_in = False
        while time.monotonic() < deadline:
            try:
                if not context.pages:
                    raise SystemExit("FAIL The Elentra window was closed before sign-in was detected.")
                if _all_tabs_on_elentra(context) and _admin_page_opens(p, context.storage_state()):
                    signed_in = True
                    break
                context.pages[0].wait_for_timeout(POLL_SECONDS * 1000)
            except PlaywrightError as exc:
                if not browser.is_connected():
                    raise SystemExit("FAIL The Elentra browser closed before sign-in was detected.") from exc
                time.sleep(POLL_SECONDS)  # a tab closing or navigating mid-check; try again
        if not signed_in:
            browser.close()
            raise SystemExit(
                f"FAIL Elentra sign-in was not detected within {LOGIN_TIMEOUT_SECONDS // 60} minutes. "
                "Run npm run login:elentra to try again."
            )
        print("Sign-in detected. Saving the session and closing the window...")
        context.storage_state(path=str(AUTH_STATE_PATH))
        browser.close()

    if not session_ok():
        raise SystemExit(
            "FAIL Elentra sign-in was not verified: the saved session cannot open the admin "
            "events page. Run npm run login:elentra and sign in again. The account needs "
            "Elentra administrator access to events."
        )
    print(f"PASS Elentra sign-in verified. Session saved to {AUTH_STATE_PATH}.")


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--login", action="store_true", help="Sign in by hand and save the session")
    mode.add_argument("--check", action="store_true", help="Verify the saved session without input")
    args = parser.parse_args()

    if args.login:
        login_interactive()
        return
    if not session_ok():
        sys.exit("FAIL Elentra session missing or expired. Run: npm run login:elentra")
    print("PASS Saved Elentra session verified without manual input.")


if __name__ == "__main__":
    main()
