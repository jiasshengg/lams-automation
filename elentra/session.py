"""
Elentra SSO sign-in kept in a persistent browser profile: interactive sign-in and a no-input check.

Usage:
    python session.py --login   # open a browser, sign in by hand (detected automatically), verify
    python session.py --check   # verify the sign-in without opening a window

Automating the SSO form itself was tried and abandoned for this codebase, so the user signs
in by hand once. Every run reuses the one profile folder in settings.PROFILE_DIR, as the LAMS
automation does. Elentra's own session cookies end with the browser, but Microsoft's "Stay
signed in" cookie stays in the profile, so each run renews the Elentra session through
Institutional Login without any input. Only when Microsoft itself asks for credentials does
the user sign in again.
"""

import argparse
import json
import sys
import time
from contextlib import contextmanager
from urllib.parse import urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import BrowserContext, sync_playwright

from settings import BASE_URL, LEGACY_AUTH_STATE_PATH, PROFILE_DIR, launch_options

LOGIN_TIMEOUT_SECONDS = 10 * 60
POLL_SECONDS = 3
# How long a silent sign-in may take to come back from Microsoft before it counts as needing input.
SILENT_SSO_TIMEOUT_SECONDS = 45
SSO_LOGIN_URL = f"{BASE_URL}/?action=ssologin&url=%2Fadmin%2Fevents"
NOT_SIGNED_IN = "Elentra sign-in needed: Microsoft asked for credentials. Run: npm run login:elentra"


def _admin_page_opens(context: BrowserContext) -> bool:
    """
    True only if this profile can actually load an admin page. A dead session is bounced to
    /?url=%2Fadmin... (the login page). The request shares the profile's cookies without
    touching any page the user may be working in.
    """
    resp = context.request.get(f"{BASE_URL}/admin/events", timeout=30_000)
    return "/admin/" in resp.url and "?url=" not in resp.url


def _all_tabs_on_elentra(context: BrowserContext) -> bool:
    # While any tab is on the identity provider (Microsoft/ADFS) or blank, the user is
    # mid-sign-in, so no probe is sent that could disturb the SSO round trip.
    host = urlparse(BASE_URL).hostname
    return bool(context.pages) and all(urlparse(page.url).hostname == host for page in context.pages)


def _asks_for_credentials(context: BrowserContext) -> bool:
    """A sign-in form (account name or password) is showing, so the SSO round trip needs a person."""
    for page in context.pages:
        if urlparse(page.url).hostname == urlparse(BASE_URL).hostname:
            continue
        try:
            if page.locator("input[type=password]:visible, input[name=loginfmt]:visible").count():
                return True
        except PlaywrightError:
            pass  # the page is navigating; look again on the next poll
    return False


def _seed_from_legacy_snapshot(context: BrowserContext) -> None:
    """Carry the sign-in saved by earlier versions into a new profile, then remove the snapshot."""
    if not LEGACY_AUTH_STATE_PATH.exists():
        return
    try:
        cookies = json.loads(LEGACY_AUTH_STATE_PATH.read_text(encoding="utf-8")).get("cookies", [])
        if cookies:
            context.add_cookies(cookies)
    except (OSError, ValueError, PlaywrightError) as exc:
        print(f"Note: the earlier Elentra session file could not be read ({exc}); sign in once with npm run login:elentra.")
        return
    LEGACY_AUTH_STATE_PATH.unlink()
    print("Moved the earlier saved Elentra sign-in into the browser profile.")


def open_profile(p, headless: bool) -> BrowserContext:
    """The persistent Elentra browser profile. Close it with context.close() so cookies are flushed."""
    PROFILE_DIR.parent.mkdir(parents=True, exist_ok=True)
    fresh = not PROFILE_DIR.exists()
    context = p.chromium.launch_persistent_context(str(PROFILE_DIR), **launch_options(headless=headless))
    if fresh:
        _seed_from_legacy_snapshot(context)
    return context


def renew_session(context: BrowserContext) -> bool:
    """
    True once the profile can open an admin page. When Elentra's own session has lapsed, it
    goes through Institutional Login, which Microsoft answers from its saved "Stay signed in"
    cookie. Returns False as soon as a sign-in form appears, without typing anything.
    """
    if _admin_page_opens(context):
        return True
    page = context.pages[0] if context.pages else context.new_page()
    page.goto(SSO_LOGIN_URL)
    deadline = time.monotonic() + SILENT_SSO_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            if _all_tabs_on_elentra(context) and _admin_page_opens(context):
                return True
            if _asks_for_credentials(context):
                return False
        except PlaywrightError:
            pass  # a redirect mid-check; try again
        time.sleep(1)
    return False


@contextmanager
def signed_in_profile(p, headless: bool):
    """The Elentra profile, signed in without input, or a stop that names the sign-in command."""
    context = open_profile(p, headless)
    try:
        if not renew_session(context):
            raise SystemExit(NOT_SIGNED_IN)
        yield context
    finally:
        context.close()


def session_ok() -> bool:
    """True only if the profile can load an admin page now, renewing Elentra's session silently."""
    with sync_playwright() as p:
        context = open_profile(p, headless=True)
        try:
            return renew_session(context)
        finally:
            context.close()


def login_interactive() -> None:
    """Open the profile in a window; if Microsoft needs the user, let them sign in there by hand."""
    with sync_playwright() as p:
        context = open_profile(p, headless=False)
        try:
            if renew_session(context):
                print("Elentra is already signed in in the browser profile; nothing to type.")
            else:
                _wait_for_manual_sign_in(context)
        finally:
            # Closing the profile normally flushes its cookies to disk; never kill this browser.
            context.close()

    if not session_ok():
        raise SystemExit(
            "FAIL Elentra sign-in was not verified: the browser profile cannot open the admin "
            "events page after a restart. Run npm run login:elentra and sign in again. The account "
            "needs Elentra administrator access to events."
        )
    print(f"PASS Elentra sign-in verified after a browser restart. Profile: {PROFILE_DIR}.")


def _wait_for_manual_sign_in(context: BrowserContext) -> None:
    page = context.pages[0] if context.pages else context.new_page()
    if urlparse(page.url).hostname == urlparse(BASE_URL).hostname:
        page.goto(BASE_URL)
    print(f"Opened Elentra in a browser window: {BASE_URL}")
    print(
        "Sign in with Institutional Login (SSO) in that window yourself. If Microsoft asks "
        '"Stay signed in?", choose Yes if organisational policy permits. The sign-in is '
        f"detected automatically; waiting up to {LOGIN_TIMEOUT_SECONDS // 60} minutes."
    )
    deadline = time.monotonic() + LOGIN_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            if not context.pages:
                raise SystemExit("FAIL The Elentra window was closed before sign-in was detected.")
            if _all_tabs_on_elentra(context) and _admin_page_opens(context):
                print("Sign-in detected. Closing the window so the profile is saved...")
                return
            context.pages[0].wait_for_timeout(POLL_SECONDS * 1000)
        except PlaywrightError as exc:
            if not context.pages:
                raise SystemExit("FAIL The Elentra browser closed before sign-in was detected.") from exc
            time.sleep(POLL_SECONDS)  # a tab closing or navigating mid-check; try again
    raise SystemExit(
        f"FAIL Elentra sign-in was not detected within {LOGIN_TIMEOUT_SECONDS // 60} minutes. "
        "Run npm run login:elentra to try again."
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--login", action="store_true", help="Sign in by hand if Microsoft needs it")
    mode.add_argument("--check", action="store_true", help="Verify the sign-in without input")
    args = parser.parse_args()

    if args.login:
        login_interactive()
        return
    if not session_ok():
        sys.exit("FAIL Elentra sign-in needed (Microsoft asked for credentials). Run: npm run login:elentra")
    print("PASS Elentra sign-in verified without manual input.")


if __name__ == "__main__":
    main()
