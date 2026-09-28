"""
Choose Kanban rows to run. Read-only: it never edits the sheet.

Usage (from the repository root):
    npm run elentra:kanban -- --tabs                                  # list the sheet's tabs
    npm run elentra:kanban -- --tab "<tab name>"                      # every "Can start" row
    npm run elentra:kanban -- --tab "<tab name>" --details "<text>"   # the row matching TBL/Quiz Details

Add --json for machine-readable output. The tab name may be partial if it matches one
tab. --details matches the whole TBL/Quiz Details cell or one of its lines exactly
(case and spacing ignored), else whole words within it. It exits successfully only when
exactly one "Can start" row is chosen: several matches of which exactly one is "Can
start" choose that one (the others are printed); otherwise it prints the candidates or
the row's actual status and exits unsuccessfully.
"""

import argparse
import json
import sys

from kanban_reader import KanbanError, find_rows, list_rows, list_tabs


def _show(row: dict) -> str:
    parts = [
        f"row {row['sheet_row']}",
        row["status"] or "(no status)",
        row["module"] or "(no module)",
        row["details"],
        row["date"] or "(no date)",
        f"Elentra event {row['event_id'] or '(none)'}",
        f"Lesson ID {row['lesson_id'] or '(none)'}",
    ]
    return " | ".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tabs", action="store_true", help="List the sheet's tab names")
    parser.add_argument("--tab", help="The Kanban tab to read, as the user named it")
    parser.add_argument("--details", help="TBL/Quiz Details text identifying one row")
    parser.add_argument("--json", action="store_true", help="Print JSON")
    args = parser.parse_args()

    try:
        if args.tabs:
            names = [name for name, _ in list_tabs()]
            print(json.dumps(names, indent=2) if args.json else "\n".join(names))
            return
        if not args.tab:
            raise KanbanError("Name the Kanban tab to read with --tab, or use --tabs to list them.")

        if args.details is None:
            rows = list_rows(args.tab)
            if args.json:
                print(json.dumps(rows, indent=2, ensure_ascii=False))
            else:
                print(f"{len(rows)} \"Can start\" row(s) in {rows[0]['tab'] if rows else args.tab}:")
                for row in rows:
                    print("  " + _show(row))
            return

        matches = find_rows(args.tab, args.details)
        ready = [row for row in matches if row["can_start"]]
        if len(matches) > 1 and len(ready) == 1:
            # The other matches are finished rows or blank-status sub-rows of the same session.
            if not args.json:
                for row in matches:
                    if row is not ready[0]:
                        print("Also matched, not \"Can start\": " + _show(row))
            matches = ready
        if args.json:
            print(json.dumps(matches, indent=2, ensure_ascii=False))
        if len(matches) == 1 and matches[0]["can_start"]:
            if not args.json:
                print("Matched: " + _show(matches[0]))
            return
        if not matches:
            sys.exit(f'No row\'s TBL/Quiz Details match "{args.details}".')
        if len(matches) > 1:
            listing = "\n".join("  " + _show(row) for row in matches)
            sys.exit(f'"{args.details}" matches {len(matches)} rows; name one exactly:\n{listing}')
        sys.exit(f'The matching row is not ready to start (status "{matches[0]["status"]}"):\n  {_show(matches[0])}')
    except KanbanError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
