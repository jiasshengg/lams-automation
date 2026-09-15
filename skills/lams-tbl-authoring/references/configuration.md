# Configuration

Use `configs/local.json` only for stable local environment values and fallback defaults. It is ignored by Git. Keep `configs/example.json` reusable and free of credentials. Pass changing request values through `--request-json`; do not edit a file for every lesson.

## Per-run input

Pass a compact JSON object as one shell-quoted argument:

```bash
npm run milestone1 -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"sourceLessonTitle":"[Jss] TEST LESSON A 280826","destinationFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"lessonTitle":"[Jss-Skill] TEST LESSON B 280826"}'
```

The scripts merge these permitted request values in memory and derive `destinationFolder` from `destinationFolderPath` when omitted. They reject attempts to override stable `baseUrl`, browser settings, or selectors.

## Resolving lesson identity

Users need not supply an exact source title or folder if they can be resolved from library evidence. `npm run discover:lessons -- --config configs/local.json --query 'FOM TBL06 2025'` searches title and folder-path terms across accessible folders under `Courses`. The command opens the global Authoring library directly because selecting a workspace course does not restrict that library. Use `--exact-title '<TITLE>'` when title equality is required. Discovery reads the lazy-folder endpoint sequentially, falls back to rendered-tree traversal when that endpoint is not JSON, and reports progress; it still completes the full requested scope before marking results complete. Optional `--roots 'Folder A|Folder B'` narrows the search to exact direct child folders under `Courses`. Use the returned candidate's exact title/path in the mutation request; ask for a choice when ambiguous. No automatic first-match selection occurs.

## Copy fields

| Field | Meaning |
|---|---|
| `baseUrl` | Stable LAMS entry URL; keep in local configuration |
| `workspaceCourse` | Course search to open; an exact match wins, otherwise one unique case-insensitive partial match is accepted |
| `sourceFolderPath` | Ordered folder names leading to the source lesson |
| `sourceLessonTitle` | Exact existing lesson title |
| `openSourceAsCopy` | Optional explicit instruction to use LAMS's **Open a copy** control for a read-only source |
| `destinationFolderPath` | Ordered folder names for the new copy |
| `createDestinationFolder` | Optional explicit permission to create only the missing final path segment |
| `renameDestinationFolderFrom` | Optional exact current name of the final destination folder to rename before saving |
| `lessonTitle` | Exact new copy title |
| `previousCohort`, `currentCohort`, `module`, `tbl` | Optional prompt-derived overrides when the request supplies them |
| `destinationFolder` | Human-readable destination used in reporting |

Folder paths are variable-length arrays. Do not assume a fixed number of folders.

When `createDestinationFolder` is true, `destinationFolderPath` must contain a parent path and exact final folder name. The workflow refuses to create intermediate folders, refuses an existing final folder, and refuses a read-only parent.

When `renameDestinationFolderFrom` is supplied, `destinationFolderPath` must contain the same parent path and a different exact final folder name. The workflow refuses an existing target folder, requires one exact current folder and an enabled Rename control, and preserves the folder's contents. Do not combine it with `createDestinationFolder`. Use `openSourceAsCopy: true` only when the exact selected source exposes LAMS's read-only **Open a copy** action.

## Existing-lesson rename fields

Use `sourceFolderPath` for the exact folder containing the existing lesson, `sourceLessonTitle` for its exact current title, and `lessonTitle` for the exact new title. A rename stays in the same folder and does not use `destinationFolderPath`.

## Validation fields

`expectedFlow` contains the exact node names in their expected linear order. Do not populate it from the observed graph merely to make validation pass.

`expectedAENodes` and `expectedAEGates` are reviewed expectations. When an AE SOT DOCX is available, derive the initial values with `npm run extract:ae-sot -- --sot-docx '<PATH>'`; the command returns them under `requestVariables`. Confirm the break markers before browser use.

Use `expectedGateProperties` for exact gate requirements:

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

Every property except `name` is optional. Only add an expectation when it came from the user's request or an established workflow rule.

## iRAT fields

Use the per-run `irat` object for the changing iRAT Source-of-Truth data. It contains:

- exact gate name, description, password type, dynamic-password state, and rotation seconds;
- exact iRAT and Team Setup node names;
- optional `deleteQuestionTitles`, containing only exact existing iRAT activity-reference titles the user explicitly authorizes removing after a prior inspection reports them; this never authorizes using a Question Bank edit/delete control or endpoint, an inspection that first discovers extra rows stops before all writes and asks for a per-title direction (keep untouched, update with the title unchanged, update with an exact new title, delete, or another exact instruction), titles may not overlap the intended final inventory, duplicates are rejected, and already-absent authorized titles are safe no-ops;
- one structured entry per question with type, content, mandatory state, and answers; `title` is optional and defaults to `Question N` from `sourceQuestionNumber` (or the one-based position), which is the required LAMS naming;
- exact answer correctness and weight, where correct weights total 100 and incorrect weights are zero;
- `advanced` toggles: `shuffleQuestions`, `shuffleAnswers`, `questionsNumbering`, `displayAllQuestions` (Advanced card question distribution = all questions), `displayAllAfterCompletion` (Feedback & Results: "Display all questions and answers once the student finishes"), `answerJustification`, and `confidenceLevels`. Every toggle defaults to `true`, matching deployment guide step 5, so only a deliberate deviation needs to be spelled out.
- `trat.activityName` is the exact matching Scratchie node title (default `tRAT`) and `trat.confidenceSourceActivityName` is the exact Assessment activity selected by **Show confidence levels from** (default: `activityName`). Every question-save prompt and the final iRAT-save prompt are accepted so question versions, formatting, and required flags sync. Afterward, the tRAT advanced panel is reset to the LAMS defaults shown in the current authoring UI, with the single deliberate override **Show confidence levels from** enabled and sourced from the configured iRAT; the saved tRAT settings are then reopened and verified.

Do not put this changing content in `configs/local.json`. Pass it in `--request-json`. Automatic parsing of a Source-of-Truth document is not implemented.

Optional question fields `feedback` (string, including empty to clear) and `prefixAnswersWithLetters` (boolean) write rationale feedback and answer-letter display. When omitted, existing values are preserved and new questions retain LAMS defaults. Content, answer text and feedback accept basic inline `sub`, `sup`, `strong`, `b`, `em`, `i`, `u`, and `br` tags without attributes. No font family or size is ever written: every iRAT field is left at the LAMS editor default, and the adapter reads the saved editor HTML back after each write and stops if a font, size, heading, or block format is present or an inline tag was lost. Legacy `fontFamily`/`fontSize` fields are ignored. The complete question list may include missing titles to create; unexpected existing or duplicate titles are rejected.

Optional image fields are `irat.sourceDocx` for embedded images assigned by question order, per-question `sourceQuestionNumber` to override the default one-based source position, and per-question `images` containing local `{ "path", "altText"?, "widthPx"? }` files. Question text/answer parsing from an iRAT Source-of-Truth document is not implemented; image extraction is.

When `irat.sourceDocx` is set, inline formatting also comes from the SoT: before any browser work, each question's content, answers, and feedback are located in the document by their plain text (inside the matching numbered question first, then anywhere) and rewritten with the document's own italic (`em`), bold (`strong`), underline (`u`), and sub/superscript marks, replacing whatever tags the request carried. Only direct run formatting counts; formatting inherited from Word styles is not detected. Text that cannot be found prints a `SoT formatting warning` and keeps the request's tags — treat such a warning as a transcription to re-check, and always supply `sourceDocx` for iRAT jobs so italics and similar styling never depend on manual transcription.

## Browser fields

Keep `headless` false during development. Store the persistent profile only under ignored `.playwright/`. Configure one stable `browser.userDataDir` per computer and use that exact resolved directory for `npm run setup`, `npm run login:lams`, and all workflow entry points. Do not use a temporary/incognito profile, generate a new profile per run, copy an authenticated profile between computers, or force-kill the browser after login. The user completes authentication manually and chooses **Yes** when Microsoft asks **Stay signed in?** if organisational policy permits. After the authenticated LAMS course-menu control appears, close the Playwright context normally to flush cookies and storage, then verify persistence with a second launch. A repeated Microsoft prompt despite these steps can be required by tenant, Conditional Access, or browser session policy and must be reported rather than bypassed.

For read-only AE inspection, `selectors.aeOpenActivity` is a stable local-environment selector for the Open control shown after selecting one exact AE SVG node. Discover it from authenticated DOM diagnostics; do not infer it from the training video. Keep it in ignored `configs/local.json`, not per-run JSON.

## AE SOT structural extraction

Run `npm run extract:ae-sot -- --sot-docx '<PATH>' [--out '<JSON_PATH>'] [--draft '<JSON_PATH>'] [--json]`. The read-only extractor:

- treats standalone `--- BREAK ---` paragraphs as the only node separators;
- stops at standalone `END` and ignores version tracking after it;
- derives AE node/gate counts and question ranges;
- names each node from its Case headings and question range (see below);
- preserves the bold, italic, underline, superscript, and subscript observed in each stem and option;
- inventories explicit marks, selectable/open-response types, detected answer keys, Case headings, and embedded images;
- reports warnings that require review.

Do not use page boundaries as separators. Case headings are not separators either, but they do name the nodes. Rationales are not carried into executable AE JSON.

`--draft` additionally writes a reviewable AE plan JSON transcribed from the document: node titles, case context, stems and options with their emphasis, detected answer keys, explicit marks, and gates. Hand transcription is where titles, emphasis, and figure order drift from the Source-of-Truth, so always generate the draft; never retype it. It is still a draft: resolve every `_review` note and `TODO_` key before `plan:ae` or `apply:ae`.

## AE layout follows the Source-of-Truth

Prompts follow the document's layout while the paragraph format (Normal) and font stay at the LAMS defaults:

- one prompt line per Word paragraph; an empty line is a blank line, from either a typed empty paragraph or paragraph spacing of 6pt or more (contextual spacing between same-style paragraphs is honoured);
- a `{{image}}` line marks where a figure printed inside the case text is written; an unfilled slot is dropped;
- Word lettered and Roman lists receive the labels Word prints, so they parse as answer options; decimal lists are left alone so they never read as question stems;
- text after a page break inside a node, when it is not an option, answer key, or rationale, opens the next question's prompt;
- tables keep their printed width (grid twips / 15 px, at most 1200 px), column percentages, and `center`/`right` cell alignment.

## Source-of-Truth check

`plan:ae`, `apply:ae`, and `run:tbl` re-read `sourceDocx`, rebuild the plan the document produces, and stop before opening the browser when node count, node titles, question placement, question types, prompts, or option text differ. Answer keys, marks, and weights are not compared. An AE JSON without `sourceDocx` is refused. `--skip-sot-check` bypasses the check for a difference the user has confirmed is intentional.

## AE node title convention

- One case: `AE Case <n> Q<first>-<last>`, or `AE Case <n> Q<n>` for a single question — for example `AE Case 3 Q3-6`.
- Spanning cases: `AE Case <first> Q<first> to Case <last> Q<last>` — for example `AE Case 1 Q1 to Case 2 Q2`.
- A case heading stays in effect across break markers, so a node that continues the previous case is still titled with that case number.
- Questions outside any numbered Case heading fall back to `AE Q<range>` and raise a warning.

Suggested titles are still not authority for existing LAMS nodes; confirm them against the graph.

## Structured AE preflight input

Pass the local path separately with `--ae-json`; do not merge AE question content into `--request-json`. Use `configs/ae-example.json` as the schema example. Required fields are:

- `sourceLabel`, `breakMarkerCount`, non-empty `nodes`, and `gates`;
- exact node titles and globally sequential question numbers;
- `mcq` or `essay` question type, prompt text, and MCQ options with one or more `correct: true` values;
- exact gate title, adjacent node titles, and the first question number after each gate.

Nodes carry no description by default: AE activities are identified by their title alone, and `apply:ae` clears any description the copied lesson left behind. Supply an optional `description` only when the Source-of-Truth calls for one. MCQ options may supply `weight` percentages. If omitted, correct options split 100% equally; if any correct weight is explicit, every correct option needs a positive weight and those weights must total 100. Incorrect options have zero weight. More than one correct option enables LAMS's multiple-answer mode. MCQ questions always have the sequential answer-letter prefix enabled and essays always have it disabled; neither is configurable. Optional AE media fields are `sourceDocx` at the document root, `sourceQuestionNumber` and `images` on each question, and optional question `title` (default `Question N`). Embedded images are assigned by source question number and uploaded into the active LAMS Assessment content folder during `apply:ae` or `run:tbl`.

Each image records where the document printed it. A figure that follows the stem is written below it; a figure printed under a Case heading before the stem belongs to the question that follows and is written above it. The caption line directly under a figure is imported with it and rendered below the image, keeping its emphasis. Explicit `images` entries accept `placement` (`before` or `after`, default `after`) and `caption`. Print View verification fails when an imported image or its caption is missing.

## Inline formatting in AE content

Question prompts and MCQ option text accept `<strong>`/`<b>`, `<em>`/`<i>`, `<u>`, `<sup>`, and `<sub>`; `<br>` reads as a space. Every other tag is escaped and shown literally, so reviewed JSON cannot inject markup into the authoring surface. Emphasis must match the Source-of-Truth exactly, which is what the `--draft` output already does.

A `Case ...` line that carries no formatting of its own is written bold and underlined; one the Source-of-Truth already styled keeps its own emphasis. Word marks an answer key by emboldening the whole correct option, so a uniformly bold option is written to LAMS without that bold and never reveals the answer.

`marks` defaults to 4. `attempts` defaults to 1 and `passingMark` to null; supply them only when the SoT explicitly overrides those defaults. `expectedTotalMarks` is optional but recommended.

## Configuration checks

Before running a committed copy or rename, reject the merged request when:

- the new title equals the source title;
- the new title contains a placeholder;
- a source or destination path is empty;
- the source lesson or destination is not exact;
- the destination already contains the new title;

For a rename, also reject the operation when the same folder already contains the new title. After saving, verify that the new title exists and the old title is absent.

When a copy destination is omitted, save in the resolved source lesson folder without asking for destination confirmation. Copy commands derive `destinationFolderPath` and its display label from `sourceFolderPath`, overriding stale destination defaults in local configuration. An explicit per-run `destinationFolderPath` wins. Folder creation/rename still requires its requested target path. Existing-lesson edits and renames save in place; their destination fields identify the existing lesson rather than move it.

## Kanban sheet endpoint

Recording the lesson code completes the publishing stage. Its endpoint and shared secret are
stable per machine, so they live in the ignored `configs/local.json`:

```json
{
  "sheet": {
    "webhookUrl": "<the Apps Script /exec URL>",
    "secret": "<the shared secret>"
  }
}
```

`LAMS_SHEET_WEBHOOK_URL` and `LAMS_SHEET_SECRET` still work and take precedence over the
file. `sheet` is deliberately not a `--request-json` field, so a secret never travels
through a shell command line. Never write these values into `configs/example.json` or any
other tracked file; `configs/local.json` is ignored by Git and is the only place for them.
When they are absent the publishing stage prints the lesson code for manual entry instead of
failing, so report that code to the user.
