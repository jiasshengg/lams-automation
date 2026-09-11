# Operations and reporting

## Dry-run copy

Run `npm run milestone1 -- --config configs/local.json --request-json '<REQUEST_JSON>'` for an optional copy preview. It must verify:

- the configured course heading;
- every configured source folder;
- the exact source lesson;
- the Save As dialog;
- every configured destination folder;
- that no copy was saved.

For an explicitly requested missing final destination folder, the dry run instead verifies the exact parent, confirms the final name is absent, and verifies the New Folder control is enabled. It must not open or accept the creation prompt.

For an explicitly requested final-folder rename, the dry run verifies the exact parent and old folder, confirms the new folder name is absent, and verifies Rename is enabled. It must not open or confirm the Rename dialog. For an explicitly identified read-only source, it may use **Open a copy** to obtain the unsaved writable authoring clone; this is not a saved library mutation.

If an expected state is missing, stop. Shared navigation uses the first visible match; content-specific checks still reject ambiguous lessons and nodes.

## Committed copy

Run `npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'` when the user requests the copy. A separate dry run is optional. Report the exact new title and verified destination. Never publish or start the copied lesson.

If the identical request includes `createDestinationFolder: true`, the committed run may create only the exact missing final segment. It must validate LAMS's observed native folder prompt, then reopen the full destination to verify both folder and copied lesson.

If the identical request includes `renameDestinationFolderFrom`, the committed run may rename only that exact final folder to the final `destinationFolderPath` segment. It must verify the old name disappears, preserve existing lessons, save the requested new copy inside the renamed folder, and reopen it to distinguish and verify the lesson even when the folder and lesson share a title.

## Existing-lesson rename

For an optional preview, run `npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --dry-run`. The dry run must verify the configured course, exact folder path, exact current lesson, inline title textbox, confirmation control, and cancellation without changing or saving the lesson.

Omit `--dry-run` to perform the requested rename. It updates the inline title, uses the normal Authoring Save control, then reopens the same folder and verifies that the new exact title exists and the old title is absent. It never moves, publishes, starts, or restructures the lesson.

## Inspection and validation

`npm run inspect:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'` prints SVG/runtime node information and transitions without modifying the graph.

`npm run validate:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'` may exit with code `2` for a validly executed inspection whose expectations failed. Treat that as a validation result, not an automation crash. Report every failed check.

Current validation covers:

- exact configured node names;
- manual AE node and gate counts;
- a single configured linear transition chain;
- Team Setup grouping for tool activities, with gates exempt;
- gate-to-following-activity category correspondence;
- configured gate type, description, dynamic-password state, and rotation time.

It does not cover branching/merging topology or automatic correction.

## AE SOT extraction

`npm run extract:ae-sot -- --sot-docx '<SOT_DOCX_PATH>' [--out '<ANALYSIS_JSON_PATH>'] [--json]` is local and non-mutating. It derives the AE node/gate counts from standalone break markers, groups sequential questions, stops at `END`, and emits the `requestVariables` needed by graph validation. Review all warnings and confirm exact node/gate titles before opening LAMS; this output is evidence for preparing reviewed AE JSON, not permission to create or restructure nodes.

## AE preflight

`npm run plan:ae -- --ae-json '<AE_JSON_PATH>'` is local and non-mutating. It validates break-derived node/gate counts, question numbering, marks, single- or multiple-answer MCQ correctness and weights, gate adjacency, and SoT-supported attempts/passing-mark overrides. It also emits normalized question HTML/options and the canonical activity settings when called with `--json`.

## AE settings inspection

`npm run inspect:ae -- --config configs/local.json --ae-json '<AE_JSON_PATH>' --node '<EXACT_AE_NODE_TITLE>' --request-json '<REQUEST_JSON>'` is read-only. It verifies the configured course, exact lesson, AE graph, and exact node before opening the activity and checking all required checkbox labels. It rejects `--commit` and never clicks the activity Save control.

An exit code of `2` means the browser inspection completed but the graph or activity settings did not match. A missing or ambiguous selector/control is an automation stop and must include diagnostics.

## SOT image extraction and import

`npm run extract:sot-media -- --sot-docx '<DOCX>' [--out-dir '<DIRECTORY>']` extracts embedded images locally and writes a manifest with relationship IDs, question assignments, dimensions, hashes, and alt text. Numbered AE questions are matched directly; unnumbered iRAT questions are assigned by marked-question order. Review every unassigned image.

Set `sourceDocx` in reviewed iRAT or AE input to import all images assigned to each question. The live adapter uploads each image to the active Assessment content folder, inserts the returned same-origin URL into CKEditor, and verifies iRAT images in Print View. Per-question `images` can add explicit local image files.

## AE writing and verified graph reconciliation

`npm run apply:ae -- --config configs/local.json --ae-json '<AE_JSON>' --request-json '<REQUEST_JSON>'` writes an existing lesson. `--dry-run` reports the graph diff without saving. A committed run:

- updates existing AE question rows as new question-bank versions;
- creates missing MCQ or essay questions;
- applies marks, Answer required, options/weights, attempts/passing mark, and canonical AE settings;
- imports SOT and explicit local images;
- associates every AE Assessment node with the exact Team Setup;
- creates missing Assessment nodes and permission gates;
- adds missing transitions in the reviewed linear AE flow;
- saves and verifies the resulting graph.

The reconciler removes an exact direct transition that bypasses a planned gate, replaces an exact planned gate whose verified type/settings are wrong, and then creates the reviewed linear transitions. It does not delete extra questions, infer that unrelated nodes are extra, or resolve ambiguous/non-gate title conflicts destructively.

## iRAT preflight

`npm run prepare:irat -- --config configs/local.json --request-json '<REQUEST_JSON>'` opens the exact copied lesson and verifies the existing Team Setup, iRAT Gate, iRAT node, gate-to-iRAT connection, and Team Setup association. It prints the configured gate, question, advanced-setting, Print View, and save plan. It never applies those changes and rejects `--commit`.

## Continuous copy and iRAT

`npm run run:tbl-irat -- --config configs/local.json --request-json '<REQUEST_JSON>'` keeps one Playwright context open for the full operation. It opens the configured course, copies the exact source lesson, updates the iRAT Gate, Team Setup association, multiple-choice questions and answer weights, mandatory flags, advanced settings, Print View, and saves the tool and copied design.

The command requires resolved copy targets and the structured `irat` request. It saves by default. `--dry-run` previews the copy and stops before iRAT editing. It stops on unsupported question/distribution types and saves diagnostics on failure. It never deletes, restructures, publishes, or starts a lesson.

Pass `--ae-json '<AE_JSON>'` or use the `run:tbl` alias to continue in the same browser context through AE writing and verified graph reconciliation after iRAT is saved.

## Failures

When the automation saves diagnostics, report the artifact directory. Diagnostics may include a screenshot, HTML, frame information, and a DOM summary. Do not include browser profiles, authentication material, or secrets in the report.
