# """
# Elentra client: login + event page fetching.

# Login flow ported from the reminder bot's working elentra_client.py
# (plain username/password auth over a requests.Session with an
# ssobypass flag — SSO/Playwright/SAML was already tried there and
# doesn't work, so this deliberately avoids that route).
# """

# import os
# import re
# import time
# import requests
# from bs4 import BeautifulSoup

# BASE_URL = os.environ.get("ELENTRA_BASE_URL", "https://ntu.elentra.cloud")


# class ElentraClient:
#     def __init__(self, username: str, password: str):
#         self.username = username
#         self.password = password
#         self.session = requests.Session()
#         self.session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": BASE_URL})
#         self.jwt_token = None
#         self._logged_in = False

#     def login(self) -> bool:
#         try:
#             login_page = self.session.get(f"{BASE_URL}/", timeout=10)
#         except requests.exceptions.Timeout:
#             raise Exception("ELENTRA_TIMEOUT")
#         except requests.exceptions.ConnectionError:
#             raise Exception("ELENTRA_UNREACHABLE")

#         soup = BeautifulSoup(login_page.text, "html.parser")
#         csrf_input = soup.find("input", {"name": "_token"})
#         csrf_token = csrf_input["value"] if csrf_input else ""

#         try:
#             post_resp = self.session.post(f"{BASE_URL}/", data={
#                 "action": "login", "ssobypass": "1",
#                 "username": self.username, "password": self.password,
#                 "_token": csrf_token,
#             }, timeout=10)
#         except requests.exceptions.Timeout:
#             raise Exception("ELENTRA_TIMEOUT")
#         except requests.exceptions.ConnectionError:
#             raise Exception("ELENTRA_UNREACHABLE")

#         jwt_match = re.search(r"var JWT\s*=\s*'([^']+)'", post_resp.text)
#         if jwt_match:
#             self.jwt_token = jwt_match.group(1)
#         else:
#             try:
#                 dashboard = self.session.get(f"{BASE_URL}/", timeout=10)
#                 jwt_match = re.search(r"var JWT\s*=\s*'([^']+)'", dashboard.text)
#                 if jwt_match:
#                     self.jwt_token = jwt_match.group(1)
#             except requests.exceptions.Timeout:
#                 raise Exception("ELENTRA_TIMEOUT")
#             except requests.exceptions.ConnectionError:
#                 raise Exception("ELENTRA_UNREACHABLE")

#         try:
#             test = self.session.get(f"{BASE_URL}/api/events-calendar.api.php", params={
#                 "dtype": "week", "dstamp": int(time.time()),
#                 "local_timezone": "Asia/Singapore", "viewtype": "list",
#                 "parentonly": "no", "pv": "1",
#             }, timeout=10)
#         except requests.exceptions.Timeout:
#             raise Exception("ELENTRA_TIMEOUT")
#         except requests.exceptions.ConnectionError:
#             raise Exception("ELENTRA_UNREACHABLE")

#         try:
#             data = test.json()
#         except Exception:
#             if test.status_code in (200, 302) and "login" in test.text.lower():
#                 raise Exception("INVALID_CREDENTIALS")
#             raise Exception("ELENTRA_UNSTABLE")

#         if "events" not in data:
#             raise Exception("INVALID_CREDENTIALS")

#         self._logged_in = True
#         return True

#     def fetch_event_page(self, event_id: str) -> BeautifulSoup:
#         if not self._logged_in:
#             raise RuntimeError("Call login() before fetching pages")

#         url = f"{BASE_URL}/events?id={event_id}"
#         resp = self.session.get(url)
#         resp.raise_for_status()

#         soup = BeautifulSoup(resp.text, "html.parser")

#         if "do not have access" in resp.text.lower():
#             raise PermissionError(f"No access to event {event_id} (access-denied page)")

#         return soup

#     def download_resource(self, resource_url: str, dest_dir: str, fallback_name: str) -> str:
#         if resource_url.startswith("/"):
#             resource_url = BASE_URL + resource_url

#         os.makedirs(dest_dir, exist_ok=True)

#         resp = self.session.get(resource_url)
#         resp.raise_for_status()

#         filename = fallback_name
#         disposition = resp.headers.get("Content-Disposition", "")
#         match = re.search(r'filename="?([^";]+)"?', disposition)
#         if match:
#             filename = match.group(1)

#         dest_path = os.path.join(dest_dir, filename)
#         with open(dest_path, "wb") as f:
#             f.write(resp.content)
#         return dest_path

"""Elentra client using the authenticated Playwright browser session."""

import os
import re
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from playwright.sync_api import APIRequestContext, Error as PlaywrightError

from settings import BASE_URL

SESSION_EXPIRED = "Elentra SSO session expired; run: npm run login:elentra"


class ElentraClient:
    def __init__(self, request: APIRequestContext):
        # This request context belongs to the persistent Elentra browser profile, so it shares
        # the cookies of the user's SSO sign-in.
        self.request = request
        self._logged_in = False

    def _get(self, url: str):
        try:
            response = self.request.get(url, timeout=30_000)
        except PlaywrightError as exc:
            raise requests.exceptions.ConnectionError(str(exc)) from exc
        if not response.ok:
            raise requests.exceptions.HTTPError(f"Elentra returned HTTP {response.status} for {url}")
        return response

    def login(self) -> bool:
        # A dead session is redirected from an admin page to /?url=%2Fadmin... (the login page),
        # which the older login|sso|okta URL check did not recognise.
        response = self._get(f"{BASE_URL}/admin/events")
        if "/admin/" not in response.url or "?url=" in response.url:
            raise PermissionError(SESSION_EXPIRED)
        self._logged_in = True
        return True

    def fetch_event_page(self, event_id: str) -> BeautifulSoup:
        if not self._logged_in:
            raise RuntimeError("Call login() before fetching pages")
        response = self._get(f"{BASE_URL}/events?id={event_id}")
        html = response.text()
        if re.search(r"login|sso|okta", response.url, re.IGNORECASE) or "?url=" in response.url:
            raise PermissionError(SESSION_EXPIRED)
        if "do not have access" in html.lower():
            raise PermissionError(f"No access to event {event_id} (access-denied page)")
        return BeautifulSoup(html, "html.parser")

    def download_resource(self, resource_url: str, dest_dir: str, fallback_name: str) -> str:
        if resource_url.startswith("/"):
            resource_url = BASE_URL + resource_url
        response = self._get(resource_url)
        os.makedirs(dest_dir, exist_ok=True)
        filename = fallback_name
        disposition = response.headers.get("content-disposition", "")
        match = re.search(r'filename="?([^";]+)"?', disposition)
        if match:
            # Keep only the final name component so a header can never write outside dest_dir.
            filename = os.path.basename(match.group(1).replace("\\", "/")) or fallback_name
        dest_path = os.path.join(dest_dir, filename)
        with open(dest_path, "wb") as output_file:
            output_file.write(response.body())
        return dest_path
