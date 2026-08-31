# Operations and reporting

## Dry-run copy

Run `npm run milestone1 -- --config configs/local.json --request-json '<REQUEST_JSON>'` before every committed copy. It must verify:

- the exact `DL Playground 2026/2027 [internal]` heading;
- every configured source folder;
- the exact source lesson;
- the Save As dialog;
- every configured destination folder;
- that no copy was saved.

For an explicitly requested missing final destination folder, the dry run instead verifies the exact parent, confirms the final name is absent, and verifies the New Folder control is enabled. It must not open or accept the creation prompt.

For an explicitly requested final-folder rename, the dry run verifies the exact parent and old folder, confirms the new folder name is absent, and verifies Rename is enabled. It must not open or confirm the Rename dialog. For an explicitly identified read-only source, it may use **Open a copy** to obtain the unsaved writable authoring clone; this is not a saved library mutation.

If any state is missing or non-unique, stop without mutation.

## Committed copy

Run `npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit` only after a successful dry run and an explicit user request to create the copy. Use the same request JSON for both commands. Report the exact new title and verified destination. Never publish or start the copied lesson.

If the identical request includes `createDestinationFolder: true`, the committed run may create only the exact missing final segment. It must validate LAMS's observed native folder prompt, then reopen the full destination to verify both folder and copied lesson.

If the identical request includes `renameDestinationFolderFrom`, the committed run may rename only that exact final folder to the final `destinationFolderPath` segment. It must verify the old name disappears, preserve existing lessons, save the requested new copy inside the renamed folder, and reopen it to distinguish and verify the lesson even when the folder and lesson share a title.

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

It does not cover automatic Source-of-Truth parsing, branching/merging topology, or automatic correction.

## AE preflight

`npm run plan:ae -- --ae-json '<AE_JSON_PATH>'` is local and non-mutating. It validates break-derived node/gate counts, question numbering, marks, MCQ correctness, gate adjacency, and SoT-supported attempts/passing-mark overrides. It also emits normalized question HTML/options and the canonical activity settings when called with `--json`.

## AE settings inspection

`npm run inspect:ae -- --config configs/local.json --ae-json '<AE_JSON_PATH>' --node '<EXACT_AE_NODE_TITLE>' --request-json '<REQUEST_JSON>'` is read-only. It verifies the approved course, exact lesson, AE graph, and exact node before opening the activity and checking all required checkbox labels. It rejects `--commit` and never clicks the activity Save control.

An exit code of `2` means the browser inspection completed but the graph or activity settings did not match. A missing or ambiguous selector/control is an automation stop and must include diagnostics. Question content/version inspection and AE mutation remain unsupported until authenticated DOM evidence is captured.

## Failures

When the automation saves diagnostics, report the artifact directory. Diagnostics may include a screenshot, HTML, frame information, and a DOM summary. Do not include browser profiles, authentication material, or secrets in the report.
