# LAMS automation

This project contains the reusable Playwright layer for the LAMS TBL authoring workflow. It selects and verifies the configured course, copies or renames exact designs, writes iRAT and AE Assessment questions, imports embedded DOCX images into CKEditor, applies activity settings and Team Setup associations, and reconciles AE Assessment nodes, permission gates, and reviewed linear transitions. It can remove an exact transition that bypasses a planned gate and replace an exact planned gate with verified incorrect settings. It does not infer that unrelated nodes are extra, delete arbitrary nodes/questions, or publish learner lessons.

## Agent skills

Use `lams-tbl-authoring` for the overall supported authoring flow. Focused skills handle targeted operations without automatically copying or rerunning the full lesson workflow.

| Skill | Use it for |
|---|---|
| [lams-tbl-authoring](skills/lams-tbl-authoring/SKILL.md) | Coordinate copy, iRAT configuration, AE preparation, and validation |
| [lams-lesson-management](skills/lams-lesson-management/SKILL.md) | Locate, copy, or rename a lesson |
| [lams-irat-editing](skills/lams-irat-editing/SKILL.md) | Inspect or update existing iRAT content and settings |
| [lams-gate-settings](skills/lams-gate-settings/SKILL.md) | Change one dynamic-password gate's rotation interval |
| [lams-ae-preparation](skills/lams-ae-preparation/SKILL.md) | Extract AE SoT/media, preflight data, inspect settings, or write/reconcile AE |
| [lams-authoring-validation](skills/lams-authoring-validation/SKILL.md) | Check nodes, connections, grouping, and gate expectations |

Canonical instructions live under `skills/`. Thin adapters under `.agents/skills/` and `.claude/skills/` expose every skill to Codex and Claude Code. Invoke `$lams-irat-editing` in Codex or `/lams-irat-editing` in Claude Code, for example, or describe the matching task naturally.

Examples: “Copy this TBL and configure its iRAT” uses the overall skill; “Set the iRAT Gate rotation to 10 seconds” uses gate settings; “Check why Team Setup is wrong” uses graph validation. “Correct question 3” routes to iRAT editing, whose current bulk adapter still requires complete current data and a compatible write scope. AE reconciliation adds missing reviewed nodes/gates/transitions, removes exact gate-bypass transitions, and replaces exact misconfigured planned gates.

All skills use [shared operating rules](skills/lams-tbl-authoring/references/shared.md). Changing request data stays in `--request-json`; local input files accept filenames and partial names. Saving remains the default for supported authoring write commands, with optional `--dry-run`. An overall authoring request does not implicitly publish the lesson.

## Setup

New to developer tools? Follow [first-time setup](docs/first-time-setup.md) and open `Setup Mac.command` or `Setup Windows.cmd`. If Node.js is missing or too old, the launcher downloads a pinned official Node.js 24 LTS archive, verifies its checksum, and keeps it inside the ignored `.tools` folder. Homebrew, administrator access, and a system-wide Node installation are not required.

With Node/npm already available, run:

```bash
npm run setup
```

Setup replaces local dependencies using the lockfile, installs Chromium, preserves existing local configuration, and checks actual esbuild/tsx execution, the build, and a headed browser launch. If Playwright no longer ships Chromium for the computer's OS version (for example macOS 13), setup instead probes an installed Google Chrome or Microsoft Edge and records the working one as `browser.channel` in `configs/local.json`; every automation command then drives that browser. Delete the setting to return to the bundled Chromium after an OS upgrade. It creates the example local configuration only if missing. After the runtime checks pass, it opens LAMS in the persistent automation browser and waits up to five minutes for the user to sign in. Run `npm run doctor` later to repeat only the runtime checks, or `npm run login:lams` to reopen the sign-in flow.

The shared LAMS URL defaults to `https://ilams.lamsinternational.com/lams/index.do`; `baseUrl` can still be set explicitly for another deployment. The course is job-specific: supply `workspaceCourse` in each job's `--request-json` when it differs from the fallback in `configs/local.json`. The user enters credentials only in the opened browser window, and setup verifies the authenticated course menu without opening or changing a lesson. After sign-in, setup closes the browser gracefully and reopens the same profile and browser to check that the course menu appears again without manual sign-in. Do not sign in during this automatic restart check. Choose **Yes** at Microsoft’s **Stay signed in?** prompt during initial login if organisational policy permits. A successful restart check does not guarantee a particular session duration or exemption from future MFA. If verification fails, retry `npm run login:lams`; Microsoft or organisational session policy may require reauthentication. Runtime readiness and login verification are reported separately. Relative `browser.userDataDir` paths are anchored to the repository root in setup and all automation commands; absolute paths are preserved. Browser launches print the resolved profile path and browser channel for troubleshooting. Do not distribute `node_modules` or saved login profiles with the project.

### Find a lesson without its exact title or folder

Use read-only discovery with partial details:

```bash
npm run discover:lessons -- --config configs/local.json --query 'FOM TBL06 2025'
npm run discover:lessons -- --config configs/local.json --exact-title '[Jss-Demo-Test]'
```

The command opens the global Authoring library directly and searches under `Courses`. Every search term must occur in the lesson title or its folder path (case-insensitive); `--exact-title` checks title equality instead. Omit both search options to list all lessons, or use `--roots 'Exact folder A|Exact folder B'` to restrict the search to direct child folders under `Courses`. There is no hardcoded playground folder.

Results contain the exact `sourceLessonTitle` and `sourceFolderPath` needed by later commands. The agent resolves these for the user; multiple plausible matches require a choice. Discovery never opens or changes a lesson. Traversal is limited to 1000 folder expansions by default; `--max-expansions` changes the limit. A limit, unknown tree state, or missing root produces an error and diagnostics rather than a misleading complete result.

For individual operations, pass changing lesson values without editing the file:

```bash
npm run milestone1 -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"sourceLessonTitle":"[Jss] TEST LESSON A 280826","destinationFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"lessonTitle":"[Jss-Skill] TEST LESSON B 280826"}'
```

The skill constructs this per-run JSON automatically from the user's prompt. The command opens and verifies the source lesson, Save As dialog, and requested destination, but does not save.

Copy, rename, gate-fix, and iRAT commands save by default. Add `--dry-run` for an optional preview; `--commit` is accepted for compatibility. `milestone1` always previews. To save a copy:

```bash
npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

Saving is refused when the new title matches the source or still contains a placeholder such as `REPLACE`.
It also refuses to overwrite an existing destination title and reopens the destination after saving to verify the copy exists.

When the user explicitly requests one missing final destination folder, add `"createDestinationFolder": true` and include that exact folder name as the final `destinationFolderPath` segment. The dry run verifies the parent is writable, the folder is absent, and the live New Folder control is enabled without opening or accepting its prompt. The committed run validates the exact native prompt, creates only that final folder, then verifies the folder and copied lesson by reopening the destination. It refuses an existing final folder or a read-only parent.

For an explicitly identified read-only source, add `"openSourceAsCopy": true`; the workflow uses LAMS's observed **Open a copy** control and verifies that the writable, unsaved source clone opens. If the same approved operation must rename an existing destination folder, set `"renameDestinationFolderFrom"` to its exact current name and make the final `destinationFolderPath` segment the exact new name. The dry run verifies that the old folder exists, the new name is absent, and Rename is enabled. The committed run renames that folder, preserves its contents, saves the lesson copy inside it, and reopens the destination to verify the lesson. Folder creation and folder rename flags cannot be combined.

Correct one password gate's dynamic-password rotation to the value the deployment guide
requires. The dry run reports the current and intended rotation without touching the
design; the committed run changes only that select, verifies nothing else about the gate
moved, saves, and reopens the lesson to confirm the value persisted:

```bash
npm run fix:gate -- --config configs/local.json --gate "iRAT Gate" --rotation-seconds 10 --request-json '<REQUEST_JSON>' --dry-run
npm run fix:gate -- --config configs/local.json --gate "iRAT Gate" --rotation-seconds 10 --request-json '<REQUEST_JSON>'
```

It refuses a gate that is not an exact unique match or is not a dynamic-password gate, and
exits without changes when the rotation is already correct. This is the one place the
automation edits a gate, and only when explicitly asked; validation itself stays read-only.

Dry-run an in-place rename of an already-duplicated lesson:

```bash
npm run rename:lesson -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","DL Playground 2026/2027 [internal]","FOM"],"sourceLessonTitle":"FOM TBL06 old title","lessonTitle":"FOM TBL06 new title"}' --dry-run
```

The optional dry run opens and cancels the inline title editor without changing the lesson. Omit `--dry-run` to save the requested rename:

```bash
npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

The committed rename saves in the same folder, then verifies the new exact title exists and the old one is absent. It does not move, publish, start, or restructure the lesson.

Inspect the copied lesson's SVG graph without changing it:

```bash
npm run inspect:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

This prints each activity's UIID, name, type, Team Setup grouping association, and every transition endpoint available from the LAMS runtime model.

Validate the copied lesson against the exact manually configured reference flow:

```bash
npm run validate:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

Prepare the iRAT work as a read-only preflight:

```bash
npm run prepare:irat -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

The request supplies a changing `irat` object with the exact gate, Team Setup, question content, answer correctness/weights, formatting, and advanced-setting expectations. The preflight opens the exact copied lesson, verifies one iRAT Gate and one iRAT node, proves the gate-to-iRAT transition and Team Setup association, and prints every planned change without writing to LAMS. Correct-answer weights must total 100 for each question; incorrect answers must have zero weight.

Run the full copy → iRAT workflow only with exact per-run values and the requested structured iRAT data:

```bash
npm run run:tbl-irat -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

The live adapter uses the observed authoring-canvas controls and the stable Assessment authoring IDs from the official LAMS v4.8 source. It updates the password gate, Team Setup association, existing multiple-choice questions as new versions, missing questions through Create question → Multiple choice → Save, answer weights, mandatory state, advanced settings, Print View verification, the iRAT tool, and finally the design. It accepts empty question lists, verifies each resulting reference row and the saved question inventory, and reports created and updated questions separately. Complete requests must include all existing questions; duplicate titles and type mismatches stop before mutation. Optional per-question `feedback` imports supplied rationales and `prefixAnswersWithLetters` controls answer labels. Basic inline sub/superscript and emphasis markup is preserved. Missing questions append; existing questions are not reordered. It deliberately refuses non-multiple-choice questions and non-`all questions` distribution settings until an exact configuration model exists for those alternatives.

iRAT question titles default to `Question N`, no font or size is ever written (the editor is verified to be at the LAMS default after each write), and when `irat.sourceDocx` is set the SoT document's italic/bold/underline/sub/superscript formatting is applied to the request text before writing. To import embedded iRAT images, set `irat.sourceDocx` and optionally override a question's one-based source position with `sourceQuestionNumber`. Extract and review the media mapping independently with:

```bash
npm run extract:sot-media -- --sot-docx "iRAT SOT.docx"
```

For one continuous copy → iRAT → AE run, include reviewed AE JSON:

```bash
npm run run:tbl -- --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>'
```

Authoring stops after the design is saved and the Author screen is closed. Publishing the
lesson to its cohort is the final stage of the full flow and runs as a separate command -
see [Lesson index and monitoring](#lesson-index-and-monitoring). Keeping it out of the
authoring entry points is deliberate: `AGENTS.md` requires a learner-facing lesson to be
explicitly requested, so a request to author, copy, or fix a lesson never publishes it,
while a request for the full end-to-end flow does include this stage. The end date always
comes from the user, so publishing cannot happen without their involvement.

To watch a run, add `--slow-mo`:

```bash
npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>' --slow-mo 500
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Stop after the copy preview; nothing is authored. |
| `--slow-mo <ms>` | Pause before every action and force a visible browser, to watch a run. |

### `npm run` drops flags in PowerShell

npm's PowerShell shim strips `--flag` names from `npm run <script> -- --flag value`, leaving
only the values, so the script silently falls back to its defaults. Verified with npm 10.9.2
on Windows; Git Bash and cmd are unaffected. Either run the entry point directly, which
always works:

```bash
npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>'
```

or run the `npm run` form from Git Bash rather than PowerShell. If a run reports missing
configuration you are sure you passed, check the echoed command line for dropped flags.

Gate settings can also be validated without opening or changing the gate property dialogs. Add exact expectations to the per-run request JSON:

```json
{
  "expectedGateProperties": [
    {
      "name": "iRAT Gate",
      "type": "password",
      "description": "iRAT Gate",
      "dynamicPassword": true,
      "rotationSeconds": 10
    },
    {
      "name": "tRAT Gate",
      "type": "permission",
      "description": "tRAT Gate"
    }
  ]
}
```

Each property is optional, so different lessons can validate only the settings they require. A mismatch is reported as a validation failure; the script never corrects or saves the gate automatically.

## AE extraction, writing, and graph reconciliation

First extract the structural evidence from the supplied SoT DOCX:

```bash
npm run extract:ae-sot -- --sot-docx "/absolute/path/AE SOT.docx"
npm run extract:ae-sot -- --sot-docx "/absolute/path/AE SOT.docx" --out /tmp/ae-sot-analysis.json --json
npm run extract:ae-sot -- --sot-docx "/absolute/path/AE SOT.docx" --draft /tmp/ae-plan-draft.json
```

The extractor treats only a standalone literal `--- BREAK ---` paragraph as an AE boundary. It derives `expectedAENodes = breaks + 1`, `expectedAEGates = breaks`, inventories the question ranges, explicit marks, selectable/open-response types, detected answer keys, and embedded-image counts, and stops at a standalone `END`. Page boundaries and `Case` headings never create nodes.

`Case` headings do name the nodes. A node inside one case is titled `AE Case 3 Q3-6` (or `AE Case 3 Q4` for a single question); a node spanning two cases is titled `AE Case 1 Q1 to Case 2 Q2`. A heading stays in effect across break markers, so a node that continues the previous case keeps that case number. Questions outside any numbered `Case` heading fall back to `AE Q<range>` and raise a warning. Suggested titles are review aids, not authority for exact names in LAMS.

`--draft` writes a reviewable AE plan JSON transcribed from the document: those node titles, the case narrative that opens each node, every stem and option with the bold, italic, underline, superscript, and subscript the document uses, detected answer keys, explicit marks, and gates. Retyping the document by hand is what makes titles, emphasis, and figure order drift, so always start from the draft and resolve its `_review` notes and `TODO_` keys.

The draft follows the document's layout, while the paragraph format and font stay at the LAMS defaults:

- each Word paragraph is one line, and each blank line is an empty line — whether the document typed an empty paragraph or left a visible gap (6pt or more) with paragraph spacing;
- a figure printed inside the case text is held in place by a `{{image}}` line and written exactly there;
- Word lettered lists (`A.`, `B.`, …) get the letters Word prints, so they read as answer options;
- text that follows a page break inside a node, such as the next part of a case, opens the next question's prompt;
- tables keep their printed width, column proportions, and centred or right-aligned cells.

`plan:ae`, `apply:ae`, and `run:tbl` re-read `sourceDocx` before anything reaches LAMS and refuse an AE JSON whose node titles, prompts, tables, or options differ from the document. Answer keys, marks, and weights are not compared. Pass `--skip-sot-check` only for a confirmed, intentional difference.

Extract the embedded images and inspect their question assignments:

```bash
npm run extract:sot-media -- --sot-docx "AE SOT.docx"
```

Each image records the question it belongs to, the caption line printed under it, and whether the document printed it above or below the stem. A figure under a new `Case` heading illustrates the question that follows it, not the previous one; cover art before the first section stays unassigned.

Review the extraction warnings, then confirm the draft against [`configs/ae-example.json`](configs/ae-example.json). Exact node/gate names, missing marks, multiple-select scoring, tables, links, and question content must be confirmed before browser use. Set root-level `sourceDocx` to import embedded images by question number, or add explicit local `images` (each accepting `placement` and `caption`) to individual questions. Preflight the reviewed JSON locally:

```bash
npm run plan:ae -- --ae-json configs/ae-example.json
```

The preflight refuses invalid data and derives a deterministic plan that:

- requires AE nodes = `breakMarkerCount + 1` and AE gates = `breakMarkerCount`;
- requires question numbers to be globally sequential from 1;
- defaults each question to 4 marks and checks `expectedTotalMarks` when supplied;
- removes `[X marks]`/numeric mark annotations and typed `A)`/`A.` option prefixes, while leaving option text that opens with its own identifier, such as `I:1 and I:2`, intact;
- keeps `<strong>`, `<em>`, `<u>`, `<sup>`, and `<sub>` in prompts and options so emphasis matches the Source-of-Truth, and escapes every other tag;
- emits bold-underlined `Case X` and required blank paragraphs in `promptHtml`, unless the Source-of-Truth already styled that heading;
- leaves the AE activity description empty: the node title alone identifies it;
- enables LAMS multiple-answer mode when an MCQ has several correct options, assigns equal correct-answer weights by default, and accepts explicit positive weights totaling 100%;
- sets Answer required, sequential-letter answer prefixes, Save as new version, and latest-version selection in the plan;
- fixes all video-specified AE activity settings, with optional SoT overrides only for attempts and passing mark;
- checks every gate against its adjacent AE nodes and following question number.

To inspect one exact AE activity in the configured course without saving, first add an evidence-backed `selectors.aeOpenActivity` to ignored `configs/local.json`. Then run:

```bash
npm run inspect:ae -- --config configs/local.json --ae-json <AE_JSON> --node "<EXACT_AE_NODE_TITLE>" --request-json '<REQUEST_JSON>'
```

The command verifies the configured course heading, destination lesson, complete AE graph, and exact node title before opening the activity. It compares all 14 required checkbox settings and exits with code 2 on a content mismatch. The command rejects `--commit`; no AE settings are saved. If a node, selector, or checkbox is missing or ambiguous, it stops and saves diagnostics under `artifacts/`.

Write the reviewed AE plan to an existing lesson, creating missing Assessment nodes, permission gates, questions, and linear transitions when required:

```bash
npm run apply:ae -- --config configs/local.json --ae-json <AE_JSON> --request-json '<REQUEST_JSON>'
```

Add `--dry-run` to report missing nodes, gates, connections, and gate-bypass edges without mutation. A committed run updates existing questions as new versions, creates missing MCQ/essay questions, imports images and their captions on the side of the stem the Source-of-Truth printed them, applies canonical AE settings, associates Team Setup, saves the design, and verifies the resulting graph. Print View verification fails when an imported image or its caption is missing. It stops rather than deleting extra questions/nodes or removing a direct transition that would bypass a planned gate.

## Lesson index and monitoring

Run these with `npx tsx` directly, not `npm run -- --flag`: npm strips the flag *names*
from forwarded arguments on Windows, so `--config X` arrives as a bare `X` and the run
falls back to `configs/example.json`.

This is the stage that runs **after** AE, as its own command, and only when publishing has
been explicitly requested: `AGENTS.md` forbids making a copied lesson learner-facing
otherwise, and the authoring entry points contain no publishing code.

Create the lesson from the design the authoring workflow just saved, then read back its
monitoring ID. The end time defaults to `23:59`, matching the TBL convention.

```bash
npx tsx src/index-monitoring.ts --config configs/local.json   --request-json '{"lessonIndex":{"endDate":"2026-09-30"}}'   --expect-design 'FOM TBL06 030926 2026Y1' --commit
```

`--expect-design` refuses to publish unless the top "Recently used designs" entry is that
exact lesson. "Recently used" is ordered by LAMS rather than by your run, so without it a
design authored in between would be published instead.

`endDate` must be the real closing date for that lesson and is supplied per run. It is
deliberately not carried in `configs/local.json` or `configs/example.json`, and the run
fails with a message naming what to ask for when it is missing, rather than defaulting.

The run is a dry run by default: it selects the top entry of "Recently used designs",
opens the Advanced tab, turns *Display activity scores on completion* off, turns
*Enable scheduling* on, sets the end date/time, advances to Course groupings and selects
the preset — then stops without clicking **Add now**. Add `--commit` to create the lesson
and continue into monitoring.

`lessonIndex` fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `courseGrouping` | no | Exact preset name, only needed when a course offers more than one. Normally omit it. |
| `endDate` | yes | `YYYY-MM-DD`. |
| `endTime` | no | `HH:MM`, defaults to `23:59`. |
| `displayScoresOnCompletion` | no | Defaults to `false`. |
| `enableScheduling` | no | Defaults to `true`. |

Course grouping needs no configuration. Y1 and Y2 run as a whole class, so a design that
uses groupings offers exactly one preset besides `None` and it is selected automatically.
A design with no grouping activities gets no Course groupings step at all — LAMS keeps
Next hidden and commits straight from Add now — and the run publishes as-is, reporting
`None`. If a course ever offers more than one preset the run stops and lists them rather
than guessing; set `courseGrouping` to pick one.

Monitoring resolves the lesson by exact title on the course page (each row is
`div.j-single-lesson` carrying `data-name` and the lesson ID as its element `id`), opens
`/lams/home/monitorLesson.do?lessonID=...`, and confirms the ID against the resulting URL
before printing it. To read the ID for a lesson that already exists, skip the index
steps:

```bash
npx tsx src/index-monitoring.ts --monitor-only --config configs/local.json
```

Recording the code in the Kanban sheet is the last step of the publishing stage, so it
happens in the same run whenever the sheet credentials are set in the environment. Pass
`--no-publish-code` to skip it:

```bash
npx tsx src/index-monitoring.ts --monitor-only --no-publish-code --config configs/local.json
```

The 5-digit code is the LAMS lesson ID, read from the monitoring URL
(`monitorLesson.do?lessonID=41192`). `openMonitoring` already confirms it against the URL the
browser actually landed on, so no extra scraping is involved. The identifier sent alongside it
is the lesson title, which matches the sheet's TBL/Quiz Details column.

On a machine with no sheet credentials the run prints the code for manual entry instead of
failing, since the LAMS-side work has already succeeded by then. `--publish-code` still
forces the send and treats missing credentials as an error. A configured sheet that is
unreachable or rejects the identifier is reported and exits non-zero, so the failure is never
silent.

Sheet credentials are stable per machine, so they belong in the ignored
`configs/local.json` alongside the other environment values:

```json
{
  "sheet": {
    "webhookUrl": "<the Apps Script /exec URL>",
    "secret": "<the shared secret>"
  }
}
```

`configs/local.json` is ignored by Git, so these never reach the repository. Put them there
and every entry point picks them up with no further setup. `LAMS_SHEET_WEBHOOK_URL` and
`LAMS_SHEET_SECRET` still work and take precedence, so an existing `.env` or an exported
shell variable keeps behaving as before and CI can override the file. `sheet` is not a
`--request-json` field: it is environment, not per-run data, and keeping it out of the
request input means a secret cannot travel through a shell command line.

Never put these in `configs/example.json` or any other tracked file. A secret committed to
Git stays in its history even after deletion.

## Selector discovery workflow

No LAMS-specific selector has been guessed. The example config only uses the supplied visible cohort and TBL text. Selectors use one of these forms:

```json
{ "by": "role", "role": "button", "name": "Authoring", "exact": true }
{ "by": "label", "label": "Open authoring", "exact": true }
{ "by": "text", "text": "{{tbl}}", "exact": false }
{ "by": "testId", "testId": "open-authoring" }
{ "by": "css", "css": "[data-purpose='authoring-node']" }
```

Prefer role, label, text, or a stable test ID. CSS is the escape hatch for a stable attribute when LAMS exposes no accessible locator.

When an unknown selector is reached, the run stops without changing LAMS and writes an `artifacts/<timestamp>-.../` directory containing:

- `page.png`: full-page screenshot
- `page.html`: top-level document HTML (plus separate HTML files for serializable child frames)
- `dom-summary.json`: frames, iframe/canvas/SVG counts, SVG text, data-attribute names, and visible control names

Collect the following from the actual LAMS page before adding the remaining selectors:

1. The accessible role/name or stable attribute for opening the lesson after selecting the TBL, if a separate action is required.
2. The accessible role/name or stable attribute for opening LAMS Authoring.
3. Whether Authoring is in the main page, a popup/new tab, or an iframe. If it is an iframe, record its `title`, `name`, or stable attribute.
4. Whether nodes are HTML, SVG, or canvas-rendered. For HTML/SVG, record one repeated node element's outer HTML and which child/attribute contains its name and type. For canvas, DOM selectors cannot enumerate nodes; record any accompanying model/network data or accessibility tree exposed by LAMS.
5. One example each for Team Setup, a gate, iRAT/tRAT, Leader Selection, and AE, including stable classes/data attributes and displayed text.
6. In one AE activity, the accessible role/name or stable attribute for its property-panel Open control (`selectors.aeOpenActivity`), question rows, per-question Edit, marks, Answer required, Advanced settings, Save as new version, latest-version selector, activity Advanced section, and final Save.

Once known, add `openLesson`, `openAuthoring`, `authoringRoot`, and `authoringNode` under `selectors`. For example (illustrative only, not a LAMS selector):

```json
{
  "selectors": {
    "openAuthoring": { "by": "role", "role": "button", "name": "Authoring" },
    "authoringNode": {
      "locator": { "by": "css", "css": "[data-purpose='authoring-node']" },
      "nameAttribute": "data-node-name",
      "typeAttribute": "data-node-type"
    }
  }
}
```

The final block is only a schema example. Replace it with evidence from the DOM diagnostics.

## Filename lookup

`--sot-docx`, `--ae-json`, and `--config` accept paths, filenames, or case-insensitive parts of filenames:

```bash
npm run extract:ae-sot -- --sot-docx 'FOM TBL01'
npm run plan:ae -- --ae-json 'ae-example'
```

Lookup searches the current project, Documents, Downloads, and Desktop recursively. Hidden and generated directories and symlink entries are skipped. Exact filenames take priority; multiple remaining matches are listed for selection. In conversation, choose a candidate by number or distinguishing name and the agent passes its resolved path. Outputs such as `--out` still use literal paths.

The course is configurable through `workspaceCourse` in `--request-json`; there is no playground allowlist. An exact course match wins, otherwise navigation accepts one unique case-insensitive partial match and stops on ambiguity. The global Authoring library may expose folders outside the selected course. The shared navigation helper uses the first visible matching control in DOM order for non-course navigation. Content-specific lesson and graph checks remain. Learner-facing `lesson:index` retains its separate `--commit` requirement.

Copies default to the source lesson folder when `destinationFolderPath` is omitted from the per-run request, even if local configuration has another destination. Supply `destinationFolderPath` only to save elsewhere. Existing-lesson edits and renames save in place.
