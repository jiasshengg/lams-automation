# LAMS automation

This project contains the reusable Playwright layer for the LAMS TBL authoring workflow. It selects and verifies the safe playground course, opens LAMS Authoring, traverses configurable folder paths, copies exact source designs with Save As, and can rename an exact existing design in place. It also carries an incremental AE foundation: validate structured AE data before opening LAMS, normalize question text and options into a deterministic execution plan, compare exact AE node/gate names and connections with the authoring graph, and inspect AE-level checkbox settings without saving. It does not parse a Source-of-Truth `.docx`, import questions, edit question rows, restructure nodes, or save AE changes yet.

## Agent skill

The repository includes one vendor-neutral skill at `skills/lams-tbl-authoring/`. Thin discovery adapters expose the same instructions to both supported coding agents:

- Codex: invoke `$lams-tbl-authoring` or describe a matching LAMS copy/validation request.
- Claude Code: invoke `/lams-tbl-authoring` or describe a matching request.

For example:

```text
Copy the exact lesson "FOM TBL06 2025Y1" from Courses > Cohort_2025Y1 > FOM,
rename it to "FOM TBL06 030926 2026Y1", save it in
Courses > Cohort_2026Y1 > FOM, then validate the supplied linear flow with
5 AE nodes and 4 AE gates.
```

The agent passes changing lesson values directly to the scripts as per-run JSON, runs the safe dry run first, and calls the existing Playwright commands. It does not rewrite `configs/local.json` for every lesson. That ignored file holds stable local LAMS/browser settings and fallback defaults. The skill requires exact copy targets and explicit authorization before the committed Save action. Automatic Source-of-Truth parsing and automatic node correction remain out of scope.

## Setup

```bash
npm install
npm run install:browsers
cp configs/example.json configs/local.json
```

Edit `configs/local.json` once with the real LAMS URL, approved workspace, browser settings, and valid fallback values. The browser runs visibly and uses `.playwright/lams-profile`, so you can sign in manually and reuse that local browser session. Passwords are never read from configuration and `.playwright/` is ignored by Git.

For individual operations, pass changing lesson values without editing the file:

```bash
npm run milestone1 -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"sourceLessonTitle":"[Jss] TEST LESSON A 280826","destinationFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"lessonTitle":"[Jss-Skill] TEST LESSON B 280826"}'
```

The skill constructs this per-run JSON automatically from the user's prompt. The command opens and verifies the source lesson, Save As dialog, and requested destination, but does not save.

After a successful dry run, reuse the identical request JSON and explicitly enable the final Save action with:

```bash
npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
```

`--commit` refuses to run when the new title matches the source or still contains a placeholder such as `REPLACE`.
It also refuses to overwrite an existing destination title and reopens the destination after saving to verify the copy exists.

When the user explicitly requests one missing final destination folder, add `"createDestinationFolder": true` and include that exact folder name as the final `destinationFolderPath` segment. The dry run verifies the parent is writable, the folder is absent, and the live New Folder control is enabled without opening or accepting its prompt. The committed run validates the exact native prompt, creates only that final folder, then verifies the folder and copied lesson by reopening the destination. It refuses an existing final folder or a read-only parent.

For an explicitly identified read-only source, add `"openSourceAsCopy": true`; the workflow uses LAMS's observed **Open a copy** control and verifies that the writable, unsaved source clone opens. If the same approved operation must rename an existing destination folder, set `"renameDestinationFolderFrom"` to its exact current name and make the final `destinationFolderPath` segment the exact new name. The dry run verifies that the old folder exists, the new name is absent, and Rename is enabled. The committed run renames that folder, preserves its contents, saves the lesson copy inside it, and reopens the destination to verify the lesson. Folder creation and folder rename flags cannot be combined.

Correct one password gate's dynamic-password rotation to the value the deployment guide
requires. The dry run reports the current and intended rotation without touching the
design; the committed run changes only that select, verifies nothing else about the gate
moved, saves, and reopens the lesson to confirm the value persisted:

```bash
npm run fix:gate -- --config configs/local.json --gate "iRAT Gate" --rotation-seconds 10 --request-json '<REQUEST_JSON>'
npm run fix:gate -- --config configs/local.json --gate "iRAT Gate" --rotation-seconds 10 --request-json '<REQUEST_JSON>' --commit
```

It refuses a gate that is not an exact unique match or is not a dynamic-password gate, and
exits without changes when the rotation is already correct. This is the one place the
automation edits a gate, and only when explicitly asked; validation itself stays read-only.

Dry-run an in-place rename of an already-duplicated lesson:

```bash
npm run rename:lesson -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","DL Playground 2026/2027 [internal]","FOM"],"sourceLessonTitle":"FOM TBL06 old title","lessonTitle":"FOM TBL06 new title"}'
```

The dry run opens and cancels the inline title editor without changing the lesson. After it passes, reuse the identical request JSON and explicitly save the rename:

```bash
npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
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

Run the full copy → iRAT workflow only with exact per-run values and an explicit commit:

```bash
npm run run:tbl-irat -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
```

The live adapter uses the observed authoring-canvas controls and the stable Assessment authoring IDs from the official LAMS v4.8 source. It updates the password gate, Team Setup association, configured multiple-choice questions as new versions, answer weights, mandatory state, advanced settings, Print View verification, the iRAT tool, and finally the design. It deliberately refuses non-multiple-choice questions and non-`all questions` distribution settings until an exact configuration model exists for those alternatives.

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

## AE preflight and read-only inspection

Convert the SoT into reviewed structured JSON matching [`configs/ae-example.json`](configs/ae-example.json). This conversion is intentionally outside the current automation until a real SoT `.docx` is available for parser fixtures. Preflight the JSON locally before launching a browser:

```bash
npm run plan:ae -- --ae-json configs/ae-example.json
```

The preflight refuses invalid data and derives a deterministic plan that:

- requires AE nodes = `breakMarkerCount + 1` and AE gates = `breakMarkerCount`;
- requires question numbers to be globally sequential from 1;
- defaults each question to 4 marks and checks `expectedTotalMarks` when supplied;
- removes `[X marks]`/numeric mark annotations and typed `A)`/`A.` option prefixes;
- emits bold-underlined `Case X` and required blank paragraphs in `promptHtml`;
- assigns 100% to exactly one MCQ answer and 0% to the others;
- sets Answer required, sequential-letter answer prefixes, Save as new version, and latest-version selection in the plan;
- fixes all video-specified AE activity settings, with optional SoT overrides only for attempts and passing mark;
- checks every gate against its adjacent AE nodes and following question number.

To inspect one exact AE activity in the playground without saving, first add an evidence-backed `selectors.aeOpenActivity` to ignored `configs/local.json`. Then run:

```bash
npm run inspect:ae -- --config configs/local.json --ae-json <AE_JSON> --node "<EXACT_AE_NODE_TITLE>" --request-json '<REQUEST_JSON>'
```

The command verifies the exact playground heading, destination lesson, complete AE graph, and exact node title before opening the activity. It compares all 14 required checkbox settings and exits with code 2 on a content mismatch. The command rejects `--commit`; no AE settings are saved. If a node, selector, or checkbox is missing or ambiguous, it stops and saves diagnostics under `artifacts/`.

The next implementation gate is authenticated DOM evidence for the question table, rich-text editor, Advanced question settings, version selector, and final Save action. Do not add selectors for those controls from the video alone.

## Lesson index and monitoring

Run these with `npx tsx` directly, not `npm run -- --flag`: npm strips the flag *names*
from forwarded arguments on Windows, so `--config X` arrives as a bare `X` and the run
falls back to `configs/example.json`.

Create the lesson from the design the authoring workflow just saved, then read back its
monitoring ID. The end time defaults to `23:59`, matching the TBL convention.

```bash
npx tsx src/index-monitoring.ts --config configs/local.json --request-json '{"lessonIndex":{"endDate":"2026-09-03"}}'
```

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

Monitoring then reads the learner-facing 5-digit code and prints it. Add `--publish-code`
to POST it to the Kanban sheet in the same run:

```bash
npx tsx src/index-monitoring.ts --monitor-only --publish-code --config configs/local.json
```

A lesson ID is five digits too (`41276`), and monitoring prints it in links and hidden
inputs many times, so the reader only accepts a 5-digit value whose surrounding text names
it as a code (`join`/`access`/`lesson`/`class` + `code`/`key`/`pin`/`passcode`) and excludes
the known lesson ID outright. Two different labelled codes, or none, stops rather than
guessing. Failing to read the code does not fail the run - the lesson has already been made.

If the reader cannot find it on your LAMS skin, dump every 5-digit value with its context:

```bash
npm run discover:lesson-code -- --config configs/local.json
```

That is read-only and writes `code-candidates.json` plus the page HTML under `artifacts/`,
which is what is needed to pin the exact element.

## Publishing the 5-digit code to the Kanban sheet

The Google Apps Script Web App writes a lesson's 5-digit code into the Kanban sheet, keyed
on **TBL/Quiz Details (column G)**. That column holds the same string this automation already
carries as `config.lessonTitle` (for example `FOM TBL06 030926 2026Y1`), so that value is sent
as `identifier`; no new ID or row number is introduced.

The endpoint and shared secret are read from the environment, never from a config file:

```bash
cp .env.example .env   # then fill in both values
export LAMS_SHEET_WEBHOOK_URL=... LAMS_SHEET_SECRET=...
```

```bash
npm run send:code -- --code 12345 --config configs/local.json          # identifier from config.lessonTitle
npm run send:code -- --code 12345 --identifier "FOM TBL06 030926 2026Y1"
npm run send:code -- --code 12345 --dry-run                            # print, send nothing
```

`sendCodeToSheet` in `src/sheets/code-sink.ts` POSTs `{ code, identifier, secret }` as JSON,
rejects anything that is not exactly five digits before the request, retries a transient
network failure twice, and throws unless the Apps Script answers `{"status":"ok"}` — an HTML
sign-in page instead of JSON is reported as a Web App access-setting problem. Call it from any
workflow once that workflow has the code in hand.

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
