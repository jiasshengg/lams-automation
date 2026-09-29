"""
Shared locations and browser options for the Elentra scripts.

Everything is anchored to the repository root rather than the working
directory, so the scripts behave the same whether they are started through
`npm run elentra:*`, `node scripts/run.mjs`, or directly with the venv's
Python from any folder.
"""

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

BASE_URL = os.environ.get("ELENTRA_BASE_URL", "https://ntu.elentra.cloud")

# The saved Elentra SSO session holds live cookies, so it lives with the LAMS
# browser profile under the ignored .playwright/ folder, never in the source tree.
AUTH_STATE_PATH = REPO_ROOT / ".playwright" / "elentra-auth.json"

# QA files are Source-of-Truth material: keep them in the project's sot-docs/ folder
# (ignored by Git, created on first download), one subfolder per Elentra event. The LAMS
# commands find inputs there by filename or partial filename. pathlib keeps this correct
# on both Windows and macOS.
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR") or REPO_ROOT / "sot-docs")

LOCAL_CONFIG_PATH = REPO_ROOT / "configs" / "local.json"


def _local_config_value(section: str, key: str) -> str | None:
    """A non-empty string at configs/local.json[section][key], or None."""
    try:
        parsed = json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    block = parsed.get(section) if isinstance(parsed, dict) else None
    value = block.get(key) if isinstance(block, dict) else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def browser_channel() -> str | None:
    """
    The installed Chrome/Edge that setup recorded as browser.channel in
    configs/local.json when Playwright's bundled Chromium is unsupported on
    this OS. None means the bundled Chromium. Mirrors readBrowserChannel()
    in scripts/setup/local-config.mjs so both runtimes drive the same browser.
    """
    return _local_config_value("browser", "channel")


def kanban_sheet_id() -> str:
    """
    The Kanban spreadsheet to read: sheet.spreadsheetId in configs/local.json, the id in
    its docs.google.com/spreadsheets/d/<id>/ URL. KANBAN_SHEET_ID overrides it. The code
    webhook writes to the spreadsheet its Apps Script is bound to, so keep both on the
    same spreadsheet when switching sheets.
    """
    sheet_id = os.environ.get("KANBAN_SHEET_ID", "").strip() or _local_config_value("sheet", "spreadsheetId")
    if not sheet_id:
        raise RuntimeError(
            'Set sheet.spreadsheetId in configs/local.json to the Kanban spreadsheet id '
            '(the part after /spreadsheets/d/ in its URL).'
        )
    return sheet_id


def launch_options(headless: bool) -> dict:
    """Keyword arguments for chromium.launch(); use this for every Elentra browser."""
    options = {"headless": headless}
    channel = browser_channel()
    if channel:
        options["channel"] = channel
    return options
