# """
# Orchestrates the pipeline:
#     Kanban Excel -> lesson IDs -> Elentra event page -> iRA/AE QA files -> local download

# Run locally with: python main.py

# Idempotent by design: reads the live Kanban Excel fresh every run, so
# brand-new rows added later are picked up automatically with no code
# changes. Already-downloaded lessons are skipped via a simple
# "does this lesson's folder already have files" check, so reruns
# don't re-fetch everything each time.
# """

# import os
# import re
# import requests
# # emily added
# import argparse 

# from dotenv import load_dotenv

# from kanban_reader import get_ready_lessons
# from elentra_client import ElentraClient

# load_dotenv()

# IRA_AE_PATTERN = re.compile(r"\b(iRA|AE)\b", re.IGNORECASE)


# def is_qa_resource(title: str) -> bool:
#     """
#     True if this resource title is an iRA/AE QA file — handling both
#     naming conventions seen in real data: the abbreviated "QA" (e.g.
#     Skin lessons: "iRA Faculty QA") and the fully spelled-out
#     "Questions and Answers" (e.g. MSK lessons: "iRA Faculty Questions
#     and Answers"). Explicitly excludes "Questions only" variants,
#     which have neither "QA" nor "Answers" in the title.
#     """
#     if not IRA_AE_PATTERN.search(title):
#         return False
#     t = title.lower()
#     if "only" in t:
#         return False
#     return "qa" in t or ("question" in t and "answer" in t)


# def find_qa_resources(soup):
#     """
#     Return (title, download_url) pairs for resources matching the
#     iRA/AE QA naming pattern (either "QA" or "Questions and Answers").

#     Confirmed real structure: each resource's title/link is an
#     <a class="resource-link" href="/file-event.php?id=N">Title</a> —
#     there's a second, unclassed anchor with the same href next to the
#     download icon, but selecting only .resource-link avoids picking
#     that duplicate up.
#     """
#     matches = []
#     for link in soup.select("a.resource-link"):
#         title = link.get_text(strip=True)
#         if is_qa_resource(title):
#             matches.append((title, link["href"]))
#     return matches


# def already_downloaded(lesson_dir: str) -> bool:
#     """True if this lesson's folder exists and already has files in it."""
#     return os.path.isdir(lesson_dir) and len(os.listdir(lesson_dir)) > 0


# def main():
#     download_dir = os.environ.get("DOWNLOAD_DIR", "./downloads")
#     os.makedirs(download_dir, exist_ok=True)

#     #emily added before get_ready_lessons()
#     parser = argparse.ArgumentParser()
#     parser.add_argument(
#         "--event-id",
#         help="Process only this Elentra Event ID",
#     )
#     args = parser.parse_args()

#     lessons = get_ready_lessons()
#     if args.event_id:
#         lessons = [lesson for lesson in lessons if lesson["id"] == args.event_id]

#     # lessons = get_ready_lessons()
#     print(f"Found {len(lessons)} lesson(s) with an Elentra Event ID")

#     client = ElentraClient(
#         username=os.environ["ELENTRA_USERNAME"],
#         password=os.environ["ELENTRA_PASSWORD"],
#     )
#     client.login()
#     # No admin-view toggle needed — confirmed hidden resources already
#     # show up for this admin-level account without one.

#     failed = []

#     for lesson in lessons:
#         lesson_dir = os.path.join(download_dir, lesson["id"])

#         if already_downloaded(lesson_dir):
#             print(f"Skipping {lesson['id']} — {lesson['title']} (already downloaded)")
#             continue

#         print(f"Processing {lesson['id']} — {lesson['title']}")
#         try:
#             soup = client.fetch_event_page(lesson["id"])
#         except PermissionError as e:
#             print(f"  Skipped: {e}")
#             continue
#         except requests.exceptions.HTTPError as e:
#             print(f"  Elentra returned an error for this event, skipping: {e}")
#             failed.append(lesson["id"])
#             continue
#         except requests.exceptions.RequestException as e:
#             print(f"  Network error fetching this event, skipping: {e}")
#             failed.append(lesson["id"])
#             continue

#         qa_resources = find_qa_resources(soup)
#         if not qa_resources:
#             print("  No iRA/AE QA resources found (not yet uploaded, or not applicable)")
#             continue

#         os.makedirs(lesson_dir, exist_ok=True)

#         for title, url in qa_resources:
#             safe_name = re.sub(r"[^\w\-. ]", "_", title)
#             try:
#                 dest_path = client.download_resource(url, lesson_dir, fallback_name=safe_name)
#                 print(f"  Downloaded: {title} -> {dest_path}")
#             except requests.exceptions.RequestException as e:
#                 print(f"  Failed to download '{title}': {e}")
#                 failed.append(lesson["id"])

#     if failed:
#         print(f"\n{len(failed)} lesson(s) had errors and were skipped: {', '.join(failed)}")
#         print("These weren't downloaded — rerun later to retry just these, or check them manually.")


# if __name__ == "__main__":
#     main()

"""Download iRA/AE QA resources using the saved Elentra SSO browser session."""

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from kanban_reader import get_ready_lessons
from elentra_client import ElentraClient
from session import signed_in_profile
from settings import DOWNLOAD_DIR, REPO_ROOT

MANIFEST_NAME = "sources.json"  # per event: which file is the iRAT and which the AE SoT
LATEST_NAME = "latest.json"  # per run: the events this run downloaded or confirmed

IRA_AE_PATTERN = re.compile(r"\b(iRA|AE)\b", re.IGNORECASE)


def is_qa_resource(title: str) -> bool:
    if not IRA_AE_PATTERN.search(title):
        return False
    lowered = title.lower()
    if "only" in lowered:
        return False
    return "qa" in lowered or ("question" in lowered and "answer" in lowered)


def find_qa_resources(soup: BeautifulSoup):
    matches = []
    for link in soup.select("a.resource-link"):
        title = link.get_text(strip=True)
        if is_qa_resource(title):
            matches.append((title, link["href"]))
    return matches



def sot_kind(title: str) -> str:
    """Which LAMS stage a QA file feeds, from its Elentra resource title."""
    is_irat = re.search(r"\biRA\b", title, re.IGNORECASE) is not None
    is_ae = re.search(r"\bAE\b", title, re.IGNORECASE) is not None
    if is_irat == is_ae:
        return "unknown"
    return "irat" if is_irat else "ae"


def _relative(path: Path) -> str:
    """Repository-relative path with forward slashes, usable on Windows and macOS."""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def read_manifest(lesson_dir: Path) -> dict | None:
    """The event's sources.json, only when every file it lists is still present."""
    try:
        manifest = json.loads((lesson_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not files or not all((lesson_dir / f.get("filename", "")).is_file() for f in files):
        return None
    return manifest


def write_latest(tab: str, manifests: list[dict]) -> Path:
    """
    sot-docs/latest.json names the Source-of-Truth files of this run's events, so the
    LAMS stages use exactly what was just downloaded unless the user supplies documents.
    """
    latest = {
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tab": tab,
        "events": manifests,
    }
    path = DOWNLOAD_DIR / LATEST_NAME
    path.write_text(json.dumps(latest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", required=True, help="The Kanban tab to read, as the user named it (see kanban.py --tabs)")
    parser.add_argument("--event-id", help="Process only this Elentra Event ID")
    args = parser.parse_args()

    lessons = get_ready_lessons(args.tab)
    if args.event_id:
        lessons = [lesson for lesson in lessons if lesson["id"] == args.event_id]
        # QA downloads only need the Event ID. If the downloader's sheet
        # reader points at a different workbook, still process the explicit
        # event selected by the green trigger.
        if not lessons:
            lessons = [{"id": args.event_id, "title": f"Elentra Event {args.event_id}"}]
            print("Event ID was not found in the named Kanban tab; processing the explicitly requested event anyway.")
    print(f"Found {len(lessons)} lesson(s) with an Elentra Event ID")
    if not lessons:
        print("No matching ready lesson in the named Kanban tab; skipping download.")
        return
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    failed = []
    ready = []  # manifests of this run's events whose files are all present

    with sync_playwright() as playwright, signed_in_profile(playwright, headless=True) as context:
        client = ElentraClient(context.request)
        client.login()
        for lesson in lessons:
            lesson_id = lesson["id"]
            lesson_dir = DOWNLOAD_DIR / lesson_id
            existing = read_manifest(lesson_dir)
            if existing:
                print(f"Skipping {lesson_id} — {lesson['title']} (already downloaded)")
                ready.append(existing)
                continue

            print(f"Processing {lesson_id} — {lesson['title']}")
            try:
                soup = client.fetch_event_page(lesson_id)
            except PermissionError as exc:
                print(f"  Skipped: {exc}")
                failed.append(lesson_id)
                continue
            except requests.exceptions.RequestException as exc:
                print(f"  Elentra/network error fetching this event, skipping: {exc}")
                failed.append(lesson_id)
                continue

            resources = find_qa_resources(soup)
            if not resources:
                print("  No iRA/AE QA resources found (not yet uploaded, or not applicable)")
                continue

            lesson_dir.mkdir(parents=True, exist_ok=True)
            files = []
            for title, url in resources:
                safe_name = re.sub(r"[^\w\-. ]", "_", title)
                try:
                    destination = Path(client.download_resource(url, str(lesson_dir), fallback_name=safe_name))
                    print(f"  Downloaded: {title} -> {destination}")
                    files.append({
                        "kind": sot_kind(title),
                        "title": title,
                        "filename": destination.name,
                        "path": _relative(destination),
                    })
                except requests.exceptions.RequestException as exc:
                    print(f"  Failed to download '{title}': {exc}")
                    failed.append(lesson_id)

            if lesson_id in failed:
                continue  # no manifest: the next run downloads this event again
            manifest = {
                "eventId": lesson_id,
                "title": lesson["title"],
                "sheetRow": lesson["row"] + 2 if "row" in lesson else None,
                "files": files,
            }
            (lesson_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            ready.append(manifest)

    if ready:
        latest = write_latest(args.tab, ready)
        print(f"\nSource-of-Truth for the LAMS stages (recorded in {_relative(latest)}):")
        for manifest in ready:
            for f in manifest["files"]:
                print(f"  event {manifest['eventId']} {f['kind']}: {f['path']}")

    if failed:
        # A nonzero exit lets run_pipeline.py and the agent report the step as failed.
        raise SystemExit(f"\n{len(failed)} lesson(s) had errors: {', '.join(sorted(set(failed)))}")


if __name__ == "__main__":
    main()
