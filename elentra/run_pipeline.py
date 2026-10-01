"""
run_pipeline.py

One command for both Elentra steps:
    1. main.py                        -> download iRA/AE QA files (rows "Can start")
    2. playwright_resource_adder.py   -> add monitoring/learner links
                                         (rows "Can start" + Lesson ID filled)

Each step reads the live Kanban sheet and skips anything not ready for it
or already done, so this is safe to run repeatedly.

Usage (from the repository root):
    npm run elentra:pipeline -- --tab "<tab>"                           # everything that's ready
    npm run elentra:pipeline -- --tab "<tab>" --event-id 27323          # just one event
    npm run elentra:pipeline -- --tab "<tab>" --lesson-id 41174         # just the row with this LAMS code
    npm run elentra:pipeline -- --tab "<tab>" --login                   # refresh the saved SSO session first
    npm run elentra:pipeline -- --tab "<tab>" --headless                # step 2 without a visible browser
    npm run elentra:pipeline -- --tab "<tab>" --dry-run                 # step 2 only reports what it would add
    npm run elentra:pipeline -- --tab "<tab>" --links-event-id 27323    # download all, links for one event
    npm run elentra:pipeline -- --tab "<tab>" --skip-links              # download only
"""

import argparse
import subprocess
import sys
from pathlib import Path

from session import login_interactive, session_ok

HERE = Path(__file__).parent


def run_step(name: str, cmd: list[str]) -> int:
    print(f"\n=== {name} ===")
    code = subprocess.run(cmd, cwd=HERE).returncode
    print(f"=== {name}: {'OK' if code == 0 else f'FAILED (exit {code})'} ===")
    return code


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tab", required=True, help="The Kanban tab to read, as the user named it (see kanban.py --tabs)")
    parser.add_argument("--event-id", help="Limit BOTH steps to this Elentra Event ID")
    parser.add_argument("--download-event-id", help="Limit only the download step")
    parser.add_argument("--links-event-id", help="Limit only the add-links step")
    parser.add_argument("--lesson-id", help="Limit to the Kanban row with this LAMS Lesson ID (links step; download uses its event)")
    parser.add_argument("--skip-download", action="store_true", help="Skip the download step")
    parser.add_argument("--skip-links", action="store_true", help="Skip the add-links step")
    parser.add_argument("--dry-run", action="store_true", help="Add-links step only reports what it would add")
    parser.add_argument("--login", action="store_true", help="Refresh the saved SSO session first")
    parser.add_argument("--headless", action="store_true", help="Run the add-links step headless")
    args = parser.parse_args()

    if args.login:
        login_interactive()

    # Renews Elentra's own session through the profile's Microsoft sign-in when it has lapsed.
    if not session_ok():
        sys.exit("Elentra sign-in needed (Microsoft asked for credentials). Run: npm run login:elentra")

    py = sys.executable
    dl_id = args.download_event_id or args.event_id
    ln_id = args.links_event_id or args.event_id
    if args.lesson_id and not dl_id and not args.skip_download:
        from kanban_reader import get_resource_ready_lessons

        events = {l["id"] for l in get_resource_ready_lessons(args.tab) if l["lesson_id"] == args.lesson_id}
        if len(events) != 1:
            sys.exit(f"Lesson ID {args.lesson_id} does not identify exactly one ready Kanban row with an Elentra Event ID.")
        dl_id = events.pop()
    results = {}

    if not args.skip_download:
        dl_cmd = [py, "main.py", "--tab", args.tab] + (["--event-id", dl_id] if dl_id else [])
        results["Download iRA/AE"] = run_step("Download iRA/AE", dl_cmd)

    if not args.skip_links:
        add_cmd = [py, "playwright_resource_adder.py", "--tab", args.tab, "--no-pause"]
        if ln_id:
            add_cmd += ["--event-id", ln_id]
        if args.lesson_id:
            add_cmd += ["--lesson-id", args.lesson_id]
        if args.headless:
            add_cmd.append("--headless")
        if args.dry_run:
            add_cmd.append("--dry-run")
        results["Add LAMS links"] = run_step("Add LAMS links", add_cmd)

    failed = [name for name, code in results.items() if code != 0]
    if failed:
        sys.exit(f"\nFinished with failures: {', '.join(failed)}")
    print("\nPipeline finished.")


if __name__ == "__main__":
    main()