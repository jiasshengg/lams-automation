---
name: lams-elentra-resources
description: Work from the live LAMS Kanban sheet (a tab the user names) and each lesson's Elentra event - list or pick Can start rows, download its iRA/AE QA files (Source-of-Truth material), add the LAMS monitoring and learner links after the lesson is published, check or refresh the Elentra sign-in. Use for Elentra requests and as the final step of a full/deploy TBL flow. Never deletes or edits existing Elentra resources.
---

# Elentra QA files and LAMS links

Read [shared operating rules](../lams-tbl-authoring/references/shared.md). Elentra (`https://ntu.elentra.cloud`) is a separate system with its own SSO session. These operations run the project's Python scripts in `elentra/` through the `.venv` that `npm run setup` creates, so no manual venv activation is needed. Use `node scripts/run.mjs <operation> ...` as for LAMS operations.

Every operation except sign-in reads the live LAMS Kanban Google Sheet, from the one tab the user named for this run: pass it as `--tab '<TAB>'` (required; exact name, or a partial name matching one tab). Never assume a tab or reuse one from configuration or an earlier run; ask, and list the names with `node scripts/run.mjs elentra:kanban --tabs`. A row is processed only when its `w` status column says **Can start** and its Elentra Event ID is filled in; the links step also needs its **Lesson ID** (the 5-digit LAMS code the publishing stage records). None of these commands edit the sheet.

## Choose rows

```bash
node scripts/run.mjs elentra:kanban --tabs
node scripts/run.mjs elentra:kanban --tab '<TAB>' --json
node scripts/run.mjs elentra:kanban --tab '<TAB>' --details '<TBL/QUIZ DETAILS TEXT>' --json
```

Without `--details` it lists every **Can start** row. With it, it matches the TBL/Quiz Details cell or one of its lines exactly, else whole words within it, and succeeds only when exactly one **Can start** row is chosen; otherwise it prints the candidates or the row's status. Each row reports `sheet_row` (the row number in Google Sheets), `status`, `module`, `session` (first line of TBL/Quiz Details), `lesson_title` (its second line, when present), `date`, `event_id`, and `lesson_id`. The [overall workflow](../lams-tbl-authoring/SKILL.md) uses these to start a full flow from the sheet.

## Sign-in

| Need | Command |
|---|---|
| Unattended check that the saved session still works | `node scripts/run.mjs elentra:check` |
| Sign in again (the user types their own credentials) | `npm run login:elentra` |

The session is saved at `.playwright/elentra-auth.json`; never copy, print, or commit it. `login:elentra` opens a browser window, detects the finished sign-in automatically (up to 10 minutes), saves the session, and verifies it can open Elentra's admin events page. The agent can run it, including in the background; the user only signs in in the window. Tell the user to sign in with **Institutional Login (SSO)**; never enter credentials for them. An `elentra:check` failure means the next step is `login:elentra`, not a retry of the failed operation. The Elentra account needs administrator access to events.

## Download iRA/AE QA files (read-only in Elentra)

```bash
node scripts/run.mjs elentra:download --tab '<TAB>' --event-id <ELENTRA_EVENT_ID>
```

Downloads the event's iRA/AE QA resources (titles naming iRA or AE plus QA or questions and answers, excluding titles containing "only") into `sot-docs/<event id>/` (the folder is created when missing). Each file is classified from its resource title as `irat` (iRA) or `ae` (AE), or `unknown` when the title names both or neither. The event's `sources.json` lists them, and `sot-docs/latest.json` lists every event this run downloaded or confirmed; the run ends by printing each event's `irat` and `ae` paths. These are the documents the LAMS stages use by default, with documents the user supplies taking precedence; see "Which Source-of-Truth the LAMS stages use" in the [overall workflow](../lams-tbl-authoring/SKILL.md). An event is skipped only when its `sources.json` exists and every file it lists is present, so an interrupted download is fetched again on the next run. To refresh an event deliberately, delete only that event's folder. Without `--event-id` it processes every **Can start** row, so pass it unless the user asks for all ready lessons. An event ID absent from the sheet is still fetched when given explicitly. Use this when the user gives an Elentra Event ID instead of a Source-of-Truth file; still review the downloaded document exactly as any other Source-of-Truth, including the never-guess-an-answer rule.

## Add the LAMS monitoring and learner links (learner-facing)

For each ready row the links step adds two Link resources to the Elentra event:

| Link | Title | Settings |
|---|---|---|
| Monitoring | `LAMS <Module> - <TBL/Quiz Details> (Facilitator/CE)` | Optional, hidden from learners, published, no timeframe |
| Learner | `LAMS <Module> - <TBL/Quiz Details>` | Required, visible to learners, published, no timeframe |

The learner link is visible to students, so treat this step like publishing:

- Run it only when the user asks for Elentra links, or as the last stage of a full/end-to-end/deploy request, after `lesson:index --commit` has published the lesson and recorded its code. Never run it for a request that only authors, copies, fixes, or updates a lesson.
- Limit it to the lesson in scope. After publishing, pass the code the publishing stage printed:

  ```bash
  node scripts/run.mjs elentra:links --tab '<TAB>' --lesson-id <5-DIGIT_CODE> --dry-run
  node scripts/run.mjs elentra:links --tab '<TAB>' --lesson-id <5-DIGIT_CODE> --no-pause
  ```

  `--event-id` limits to one event instead; an event can hold several rows (for example several quizzes), each with its own Lesson ID, so prefer `--lesson-id` when a code is known. Run without either only when the user asks for every ready lesson.
- The dry run reads the event's resource list and reports which links are missing; it does not open the wizard. It is cheap, so run it first and include its result in the report.
- The step skips a link whose exact URL is already on the event, so rerunning never duplicates. If the resource list cannot be read (expired session, error page, unfamiliar response) it stops before adding anything. After saving, it reads the resource list again and fails unless each added link is there; report the `VERIFIED` lines as the evidence.
- The browser is visible by default so QC staff can watch; `--headless` is available but only when the user asks. `--no-pause` closes the window when done instead of waiting for Enter; use it for agent runs.
- "No ready Kanban row has Lesson ID ..." right after publishing usually means the sheet export has not caught up; wait about a minute and retry once. If it persists, report that the row needs status **Can start**, that code in its Lesson ID column, and an Elentra Event ID. Never edit the sheet to force a match.
- To test changes to this step, use only the sandbox event `42374` ("TBL - Trial Test 01 by Digital Learning (please ignore)"): `node scripts/run.mjs elentra:sandbox-test --dry-run`, then without `--dry-run`. Never test against a real, QC'd lesson.

The script cannot remove or edit Elentra resources. If a wrong link was added, report its title and event and let the user remove it in Elentra.

## Both steps at once

```bash
node scripts/run.mjs elentra:pipeline --tab '<TAB>' --lesson-id <5-DIGIT_CODE> --dry-run
node scripts/run.mjs elentra:pipeline --tab '<TAB>' --event-id <ELENTRA_EVENT_ID>
```

The pipeline checks the session, then runs the download step and the links step (with `--no-pause`). `--skip-download` or `--skip-links` runs one step; `--download-event-id` and `--links-event-id` limit each step separately; `--dry-run` applies to the links step only; `--login` signs in first. It exits unsuccessfully if either step fails; report which.

## Report

Report the Kanban tab and sheet rows used, the event and lesson IDs processed, the files downloaded and their paths, the links added (`VERIFIED`) or already present, anything skipped and why, and any failure message. The Elentra operations have no diagnostics folder; quote the failing output. For setup problems (Python, packages, or the Elentra browser), run `npm run doctor`, then `npm run setup:elentra`; see [first-time setup](../../docs/first-time-setup.md).
