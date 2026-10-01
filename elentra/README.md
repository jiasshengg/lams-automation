# Elentra QA files and LAMS links

Python scripts for the Elentra side of the LAMS deployment pipeline at NTU LKC. They are
driven by the live LAMS Kanban Google Sheet (the tab you name with `--tab`, read as a CSV export), so there
is no local file to keep in sync. The agent skill that runs them is
[lams-elentra-resources](../skills/lams-elentra-resources/SKILL.md).

## Setup

Nothing to install by hand. `npm run setup` (or `Setup Windows.cmd` / `Setup Mac.command`)
downloads a pinned, checksummed Python 3.13 into `.tools/`, creates `.venv/` from it,
installs the exact versions in `requirements.txt` and the Python browser, and then opens
Elentra for you to sign in. Nothing needs to be typed in the terminal. On a computer that was set up before these scripts existed, run
`npm run setup:elentra` once.

Every command below runs the `.venv` interpreter directly (that is all activating a venv
does), so you never activate it yourself. No Elentra username or password is stored: you
sign in once in a browser window, and the sign-in is kept in the persistent browser profile
`.playwright/elentra-profile/`, which Git ignores, just as LAMS keeps its sign-in in
`.playwright/lams-profile/`. Elentra's own session still expires between runs; each run then
renews it through Institutional Login from Microsoft's "Stay signed in" cookie in that profile,
with nothing to type. You sign in again only when Microsoft itself asks. Never commit, copy,
or share the profile folder; it is equivalent to a live login. A computer that used the older
`.playwright/elentra-auth.json` snapshot moves it into the new profile on its first run and
deletes it.

## Commands

Run from the repository root. Every command that reads the sheet needs `--tab "<tab name>"`: the sheet has many tabs, including retired copies with the same columns, so none is assumed. The name can be partial if it matches exactly one tab.

| Command | What it does |
|---|---|
| `npm run login:elentra` | Open Elentra and sign in with Institutional Login (SSO) yourself; the sign-in is detected automatically, then saved and verified |
| `npm run elentra:check` | Verify the sign-in without opening a window (renewing Elentra's session silently if it has lapsed) |
| `npm run elentra:kanban -- --tabs` | List the sheet's tab names |
| `npm run elentra:kanban -- --tab "<tab>"` | List the tab's **Can start** rows (`--json` for details) |
| `npm run elentra:kanban -- --tab "<tab>" --details "<TBL/Quiz Details text>"` | Find the one row whose TBL/Quiz Details match |
| `npm run elentra:download -- --tab "<tab>" --event-id 27323` | Download the event's iRA/AE QA files into `sot-docs/27323/` |
| `npm run elentra:links -- --tab "<tab>" --lesson-id 41174 --dry-run` | Report which LAMS links the lesson's Elentra event is missing |
| `npm run elentra:links -- --tab "<tab>" --lesson-id 41174` | Add the missing monitoring and learner links, then verify them |
| `npm run elentra:pipeline -- --tab "<tab>" --event-id 27323` | Check the session, then download and add links for that event |
| `npm run elentra:sandbox-test` | Add test links to the sandbox event `42374` only (`-- --dry-run` to preview) |
| `npm run test:elentra` | Offline unit tests |

Agents should prefer `node scripts/run.mjs elentra:links --tab "<tab>" --lesson-id 41174` (same
arguments), which keeps the real exit status in PowerShell.

Without `--event-id` or `--lesson-id`, `download`, `links`, and `pipeline` process every
row that is ready.

## Feature 1: download iRA/AE QA files

For each row whose `w` status is **Can start** and which has an Elentra Event ID, reads the
event page and downloads the hidden, admin-only iRA/AE Faculty QA resources into
`sot-docs/<event id>/` (created when missing). It records which file is the iRAT and
which the AE Source-of-Truth in `sot-docs/<event id>/sources.json`, and the events of the
latest run in `sot-docs/latest.json`; the LAMS stages use those files by default unless
documents are supplied. An event is skipped on rerun only when every file its
`sources.json` lists is present, so an interrupted download is fetched again.

## Feature 2: add the LAMS monitoring and learner links

For each row that is **Can start** and also has a Lesson ID, adds two Link resources to its
Elentra event, both titled `LAMS <lesson title>` (the lesson title from TBL/Quiz Details, prefixed with
`<Module> - ` only when it does not already start with the module code):

- monitoring (`.../monitorLesson.do?lessonID=<id>`): Optional, hidden from learners, and
  suffixed ` (Facilitator/CE)`;
- learner (`.../learner.do?lessonID=<id>`): Required and visible to learners.

It deliberately drives a visible browser through the real **Add Event Resource** wizard so
QC staff can watch each step. It skips a link whose URL is already on the event, stops
without adding anything if the event's resource list cannot be read, and afterwards re-reads
the list and fails unless each new link is there (`VERIFIED` lines). `--dry-run` only
reports what is missing. It never removes or edits resources.

In the full LAMS flow this runs after the publishing stage has recorded the lesson's 5-digit
code in the Kanban sheet, limited to that code with `--lesson-id`.

## Notes

- `kanban_reader.py` has two readiness functions: `get_ready_lessons()` (Feature 1, needs an
  Elentra Event ID) and `get_resource_ready_lessons()` (Feature 2, also needs a Lesson ID).
  A lesson can pass the first without yet passing the second.
- The "TBL/Quiz Details" cell sometimes has a second line (red text in the sheet). When
  present, that second line is the real title; `_resolve_title()` handles this.
- The sheet is read with Python's `csv` module rather than pandas, because Windows Smart App
  Control blocks pandas' unsigned compiled modules.
- Elentra's access-denied pages return HTTP 200, so the scripts check page content and
  redirects, not just the status code. An expired session redirects admin pages to
  `/?url=...`.
- Test changes to Feature 2 only against the sandbox event "TBL - Trial Test 01 by Digital
  Learning (please ignore)" (`42374`). A real, QC'd lesson would get a duplicate live
  resource.
- Downloaded files keep the name from Elentra's `Content-Disposition` header, reduced to its
  final path component; two resources with the same file name overwrite each other.
- Paths in `sources.json` and `latest.json` are relative to the repository root with forward
  slashes, so the same files work on Windows and macOS.
