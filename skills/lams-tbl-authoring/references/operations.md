# Operations and reporting

## Dry-run copy

Run `npm run milestone1 -- --config configs/local.json` before every committed copy. It must verify:

- the exact `DL Playground 2026/2027 [internal]` heading;
- every configured source folder;
- the exact source lesson;
- the Save As dialog;
- every configured destination folder;
- that no copy was saved.

If any state is missing or non-unique, stop without mutation.

## Committed copy

Run `npm run copy:lesson -- --config configs/local.json --commit` only after a successful dry run and an explicit user request to create the copy. Report the exact new title and verified destination. Never publish or start the copied lesson.

## Inspection and validation

`npm run inspect:authoring -- --config configs/local.json` prints SVG/runtime node information and transitions without modifying the graph.

`npm run validate:authoring -- --config configs/local.json` may exit with code `2` for a validly executed inspection whose expectations failed. Treat that as a validation result, not an automation crash. Report every failed check.

Current validation covers:

- exact configured node names;
- manual AE node and gate counts;
- a single configured linear transition chain;
- Team Setup grouping for tool activities, with gates exempt;
- gate-to-following-activity category correspondence;
- configured gate type, description, dynamic-password state, and rotation time.

It does not cover automatic Source-of-Truth parsing, branching/merging topology, or automatic correction.

## Failures

When the automation saves diagnostics, report the artifact directory. Diagnostics may include a screenshot, HTML, frame information, and a DOM summary. Do not include browser profiles, authentication material, or secrets in the report.
