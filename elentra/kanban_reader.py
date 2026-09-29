"""
Reads the live LAMS Kanban Google Sheet directly over HTTP (CSV export).
No local file, no syncing — always reads whatever is currently live in the sheet.

The tab is always named by the user for each run (--tab); nothing is assumed:
the sheet holds many tabs, including retired copies with
the same columns, so no tab is assumed. resolve_tab() turns the name into the tab's
gid using the sheet's public tab list.

Readiness functions, kept deliberately separate:
  - get_ready_lessons(tab): "Can start" + Elentra Event ID, for the fetch/download
    step (elentra_client.py/main.py).
  - get_resource_ready_lessons(tab): same filter PLUS a filled-in "Lesson ID", for
    the resource-linking step (playwright_resource_adder.py).
A lesson can pass the first without yet passing the second. list_rows(tab) and
find_rows(tab, details) describe every row for choosing what to run (kanban.py).

Confirmed real columns (Sep 2026): "Elentra Event ID" holds the raw 5-digit ID used
to navigate to an event's admin page. "Lesson ID" is a separate id, used only to
build the LAMS monitoring/learner links. The "w" column doubles as both
week-section header rows ("Wk29", "Week 58" — dividers, not lessons) and the actual
per-lesson status ("Done", "WIP", "Pending Final QC", "Can start", "Exam Verify in
Progress"). Only "Can start" rows are processed.

"TBL/Quiz Details" (column G) can hold a second line (red text in the sheet). When
present it is the LAMS lesson title, which is
also the identifier the LAMS publishing stage uses to write the code into the row.

Note: multiple rows can share the same Elentra Event ID (e.g. several quiz modules
living on one shared Elentra event) — this is fine, since filtering happens per-row.
"""

import codecs
import csv
import io
import re

import requests

from settings import kanban_sheet_id

READY_STATUS = "can start"  # matched case-insensitively, see below

# Base URLs to build the two links from — the sheet does NOT store full
# links; it stores just the raw lesson id in the "Lesson ID" column
# (distinct from "Elentra Event ID", which is a different id used to
# navigate to the event's admin page).
MONITORING_LINK_BASE = "https://ilams.lamsinternational.com/lams/monitoring/monitoring/monitorLesson.do?lessonID="
LEARNER_LINK_BASE = "https://ilams.lamsinternational.com/lams/home/learner.do?lessonID="
LESSON_ID_COL = "Lesson ID"
DETAILS_COL = "TBL/Quiz Details"

# The public view of the sheet lists every tab as {name: "...", pageUrl: "...gid=N"}.
_TAB_PATTERN = re.compile(r'\{name: "((?:[^"\\]|\\.)*)", pageUrl: "(?:[^"\\]|\\.)*?gid=(\d+)')


class KanbanError(Exception):
    """A tab or row the user named could not be resolved to exactly one match."""


def _sheet_csv_url(gid: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{kanban_sheet_id()}/export?format=csv&gid={gid}"


def _normalize(text: str) -> str:
    return " ".join(str(text).split()).casefold()


def _normalize_tab(text: str) -> str:
    """Tab names also treat "_" as a space: "INTERNS Kanban" names "INTERNS_Kanban"."""
    return _normalize(str(text).replace("_", " "))


def list_tabs() -> list[tuple[str, str]]:
    """(tab name, gid) for every tab, in the sheet's order."""
    resp = requests.get(f"https://docs.google.com/spreadsheets/d/{kanban_sheet_id()}/htmlview", timeout=30)
    resp.raise_for_status()
    tabs = []
    for raw_name, gid in _TAB_PATTERN.findall(resp.text):
        # Names are JavaScript string literals: "\/" and "\x26" style escapes.
        name = codecs.decode(raw_name.replace("\\/", "/"), "unicode_escape")
        tabs.append((name, gid))
    if not tabs:
        raise KanbanError("Could not read the Kanban sheet's tab list. Check that the sheet is still shared by link.")
    return tabs


def resolve_tab(name: str) -> tuple[str, str]:
    """
    The (exact tab name, gid) the user meant. An exact name wins (case, spacing, and
    underscores-as-spaces ignored); otherwise one tab whose name contains the text.
    Anything else raises with the candidates, so a similarly named retired tab is never
    picked silently.
    """
    if not name or not name.strip():
        raise KanbanError("Name the Kanban tab to read with --tab. Run the kanban operation with --tabs to list them.")
    tabs = list_tabs()
    wanted = _normalize_tab(name)
    exact = [tab for tab in tabs if _normalize_tab(tab[0]) == wanted]
    if len(exact) == 1:
        return exact[0]
    partial = [tab for tab in tabs if wanted in _normalize_tab(tab[0])]
    if len(partial) == 1:
        return partial[0]
    names = ", ".join(f'"{tab[0]}"' for tab in (partial or tabs))
    problem = "matches several tabs" if partial else "matches no tab"
    raise KanbanError(f'"{name}" {problem}. Choose one of: {names}')


def _read_sheet(gid: str) -> tuple[list[str], list[dict]]:
    """
    Reads one tab's CSV export as (column names, rows). Uses the standard
    library rather than pandas: Windows Smart App Control blocks pandas'
    unsigned compiled modules, and a CSV read is all this needs.
    When a header repeats, the first column with that name wins (as pandas did).
    """
    resp = requests.get(_sheet_csv_url(gid), timeout=30)
    resp.raise_for_status()
    records = list(csv.reader(io.StringIO(resp.content.decode("utf-8-sig"))))
    if not records:
        return [], []
    header = records[0]
    first_index = {}
    for i, name in enumerate(header):
        first_index.setdefault(name, i)
    rows = [
        {name: (record[i] if i < len(record) else "") for name, i in first_index.items()}
        for record in records[1:]
    ]
    return header, rows


def _filled(value) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _as_id(value) -> str | None:
    """A numeric id cell as digits: "27662" and "27662.0" both give "27662"."""
    text = str(value).strip() if value is not None else ""
    try:
        text = str(int(float(text)))
    except (ValueError, OverflowError):
        pass
    return text if text.isdigit() else None


def _detail_lines(details_cell) -> list[str]:
    if not isinstance(details_cell, str):
        return []
    return [line.strip() for line in details_cell.split("\n") if line.strip()]


def _resolve_title(details_cell: str) -> str:
    """
    Column G ("TBL/Quiz Details") sometimes has a second line within the
    same cell — when it does, that second line is the one to use as the
    title (it shows as red text in the sheet's UI, but the underlying
    rule is just "is there a second line", which CSV export preserves
    fine via embedded newlines). If there's only one line, use it as-is.
    """
    lines = _detail_lines(details_cell)
    return lines[-1] if lines else ""  # the 2nd line if present, else the only line


def _read_tab(tab: str) -> tuple[str, list[str], list[dict]]:
    tab_name, gid = resolve_tab(tab)
    columns, rows = _read_sheet(gid)
    missing = [c for c in ("w", DETAILS_COL, "Elentra Event ID", LESSON_ID_COL) if c not in columns]
    if missing:
        raise KanbanError(f'Tab "{tab_name}" has no {", ".join(repr(c) for c in missing)} column; it is not a Kanban tab.')
    return tab_name, columns, rows


def _iter_ready_rows(tab: str, required_cols):
    """
    Yields (tab_name, idx, row) for every row of the named tab where the "w"
    status column says "Can start" and every column in required_cols is filled
    in. idx is the 0-based data row (header excluded).
    """
    tab_name, _, rows = _read_tab(tab)
    for idx, row in enumerate(rows):
        if row["w"].strip().lower() != READY_STATUS:
            continue
        if all(_filled(row[col]) for col in required_cols):
            yield tab_name, idx, row


def _build_event_id(row) -> str | None:
    return _as_id(row["Elentra Event ID"])


def _build_title(row) -> str:
    module = row.get("Module", "")
    if not isinstance(module, str):
        module = ""
    details = _resolve_title(row.get(DETAILS_COL, ""))
    return f"{module.strip()} - {details}".strip(" -")


def describe_row(tab_name: str, idx: int, row: dict) -> dict:
    """Everything the flow needs to choose and start one row."""
    lines = _detail_lines(row.get(DETAILS_COL, ""))
    return {
        "tab": tab_name,
        "sheet_row": idx + 2,  # the row number shown in Google Sheets (header is row 1)
        "status": row["w"].strip(),
        "can_start": row["w"].strip().lower() == READY_STATUS,
        "module": " ".join(row.get("Module", "").split()),
        "details": " / ".join(lines),
        "session": lines[0] if lines else "",
        "lesson_title": lines[1] if len(lines) > 1 else None,
        "date": row.get("Date", "").strip(),
        "event_id": _build_event_id(row),
        "lesson_id": _as_id(row.get(LESSON_ID_COL)),
    }


def list_rows(tab: str, ready_only: bool = True) -> list[dict]:
    """Rows of the named tab (only "Can start" ones by default), described for choosing."""
    tab_name, _, rows = _read_tab(tab)
    described = [describe_row(tab_name, idx, row) for idx, row in enumerate(rows) if _detail_lines(row.get(DETAILS_COL, ""))]
    return [row for row in described if row["can_start"]] if ready_only else described


def find_rows(tab: str, details: str) -> list[dict]:
    """
    Rows whose TBL/Quiz Details match what the user typed, whatever their status:
    the whole cell or any one of its lines exactly (case and spacing ignored), else
    every row containing the text. The caller decides what several matches mean.
    """
    wanted = _normalize(details)
    if not wanted:
        raise KanbanError("Give the TBL/Quiz Details text of the row to run.")
    rows = list_rows(tab, ready_only=False)

    def texts(row):
        return [row["details"].replace(" / ", " ")] + [row["session"]] + ([row["lesson_title"]] if row["lesson_title"] else [])

    exact = [row for row in rows if any(_normalize(text) == wanted for text in texts(row))]
    if exact:
        return exact
    # Whole words only, so "TBL 1" does not also match "TBL 10".
    pattern = re.compile(r"(?<!\w)" + re.escape(wanted) + r"(?!\w)")
    return [row for row in rows if any(pattern.search(_normalize(text)) for text in texts(row))]


def get_ready_lessons(tab: str) -> list[dict]:
    """
    Returns a list of dicts like:
        {"id": "27662", "title": "<Module> - <TBL/Quiz Details>", "sheet": "<tab name>", "row": 12}

    One entry per row of the named tab where the "w" status column says "Can
    start" (case-insensitive, whitespace-trimmed) AND the Elentra Event ID is
    filled in. Used by the fetch/download step (elentra_client.py/main.py) —
    this readiness definition intentionally does NOT require a Lesson ID, since
    a lesson can be fetch-ready before its LAMS Lesson ID exists.
    """
    lessons = []
    for tab_name, idx, row in _iter_ready_rows(tab, required_cols=("Elentra Event ID",)):
        event_id = _build_event_id(row)
        if not event_id:
            continue
        lessons.append({
            "id": event_id,
            "title": _build_title(row),
            "sheet": tab_name,
            "row": idx,
        })
    return lessons


def get_resource_ready_lessons(tab: str) -> list[dict]:
    """
    Returns a list of dicts like:
        {
            "id": "27662",
            "lesson_id": "41174",
            "title": "<Module> - <TBL/Quiz Details>",
            "monitoring_link": "https://ilams.../monitorLesson.do?lessonID=41174",
            "learner_link": "https://ilams.../learner.do?lessonID=41174",
            "sheet": "<tab name>",
            "row": 12,
        }

    Same "Can start" + Elentra Event ID filter as get_ready_lessons(), PLUS
    requires a numeric "Lesson ID" (used to build both links). Rows without one
    are skipped here (not an error, just not ready for this step). Used only by
    playwright_resource_adder.py and run_pipeline.py.
    """
    lessons = []
    for tab_name, idx, row in _iter_ready_rows(tab, required_cols=("Elentra Event ID", LESSON_ID_COL)):
        event_id = _build_event_id(row)
        if not event_id:
            continue

        lesson_id = _as_id(row.get(LESSON_ID_COL))
        if not lesson_id:
            continue  # Lesson ID cell filled but not a usable numeric id

        lessons.append({
            "id": event_id,
            "lesson_id": lesson_id,
            "title": _build_title(row),
            "monitoring_link": f"{MONITORING_LINK_BASE}{lesson_id}",
            "learner_link": f"{LEARNER_LINK_BASE}{lesson_id}",
            "sheet": tab_name,
            "row": idx,
        })
    return lessons
