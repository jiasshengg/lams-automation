# Configuration

Use `configs/local.json` only for stable local environment values and fallback defaults. It is ignored by Git. Keep `configs/example.json` reusable and free of credentials. Pass changing request values through `--request-json`; do not edit a file for every lesson.

## Per-run input

Pass a compact JSON object as one shell-quoted argument:

```bash
npm run milestone1 -- --config configs/local.json --request-json '{"sourceFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"sourceLessonTitle":"[Jss] TEST LESSON A 280826","destinationFolderPath":["Courses","! My Courses","! Sample & Orientation Lessons"],"lessonTitle":"[Jss-Skill] TEST LESSON B 280826"}'
```

The scripts merge these permitted request values in memory and derive `destinationFolder` from `destinationFolderPath` when omitted. They reject attempts to override stable `baseUrl`, `workspaceCourse`, browser settings, or selectors.

## Copy fields

| Field | Meaning |
|---|---|
| `baseUrl` | Stable LAMS entry URL; keep in local configuration |
| `workspaceCourse` | Stable safety boundary; must remain exactly `DL Playground 2026/2027 [internal]` |
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
- one structured entry per question with title, type, content, mandatory state, font, size, and answers;
- exact answer correctness and weight, where correct weights total 100 and incorrect weights are zero;
- shuffle-answer, display-all-question, answer-justification, and confidence-level expectations.

Do not put this changing content in `configs/local.json`. Pass it in `--request-json`. Automatic parsing of a Source-of-Truth document is not implemented.

## Browser fields

Keep `headless` false during development. Store the persistent profile only under ignored `.playwright/`. The user completes authentication manually when needed.

For read-only AE inspection, `selectors.aeOpenActivity` is a stable local-environment selector for the Open control shown after selecting one exact AE SVG node. Discover it from authenticated DOM diagnostics; do not infer it from the training video. Keep it in ignored `configs/local.json`, not per-run JSON.

## AE SOT structural extraction

Run `npm run extract:ae-sot -- --sot-docx '<PATH>' [--out '<JSON_PATH>'] [--json]`. The read-only extractor:

- treats standalone `--- BREAK ---` paragraphs as the only node separators;
- stops at standalone `END` and ignores version tracking after it;
- derives AE node/gate counts and question ranges;
- inventories explicit marks, selectable/open-response types, detected answer keys, Case headings, and embedded images;
- reports warnings that require review.

Do not use page boundaries or Case headings as separators. Do not use generated suggested titles as exact LAMS names. The extractor does not fully preserve tables, images, links, rationales, or rich formatting in executable AE JSON.

## Structured AE preflight input

Pass the local path separately with `--ae-json`; do not merge AE question content into `--request-json`. Use `configs/ae-example.json` as the schema example. Required fields are:

- `sourceLabel`, `breakMarkerCount`, non-empty `nodes`, and `gates`;
- exact node titles and globally sequential question numbers;
- `mcq` or `essay` question type, prompt text, and MCQ options with exactly one `correct: true`;
- exact gate title, adjacent node titles, and the first question number after each gate.

`marks` defaults to 4. `attempts` defaults to 1 and `passingMark` to null; supply them only when the SoT explicitly overrides those defaults. `expectedTotalMarks` is optional but recommended.

## Configuration checks

Before running a committed copy or rename, reject the merged request when:

- the new title equals the source title;
- the new title contains a placeholder;
- a source or destination path is empty;
- the source lesson or destination is not exact;
- the destination already contains the new title;
- the workspace course differs from the approved playground.

For a rename, also reject the operation when the same folder already contains the new title. After saving, verify that the new title exists and the old title is absent.
