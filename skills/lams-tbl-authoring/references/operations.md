# Operations and reporting

## Dry-run copy

Run `npm run milestone1 -- --config configs/local.json --request-json '<REQUEST_JSON>'` before every committed copy. It must verify:

- the exact `DL Playground 2026/2027 [internal]` heading;
- every configured source folder;
- the exact source lesson;
- the Save As dialog;
- every configured destination folder;
- that no copy was saved.

If any state is missing or non-unique, stop without mutation.

## Committed copy

Run `npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit` only after a successful dry run and an explicit user request to create the copy. Use the same request JSON for both commands. Report the exact new title and verified destination. Never publish or start the copied lesson.

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

## iRAT preflight

`npm run prepare:irat -- --config configs/local.json --request-json '<REQUEST_JSON>'` opens the exact copied lesson and verifies the existing Team Setup, iRAT Gate, iRAT node, gate-to-iRAT connection, and Team Setup association. It prints the configured gate, question, advanced-setting, Print View, and save plan. It never applies those changes and rejects `--commit`.

## Continuous copy and iRAT

`npm run run:tbl-irat -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit` keeps one Playwright context open for the full operation. It verifies the playground, copies the exact source lesson, updates the iRAT Gate, Team Setup association, multiple-choice questions and answer weights, mandatory flags, advanced settings, Print View, and saves the tool and copied design.

The command refuses to run without `--commit`, exact copy targets, and the structured `irat` request. It stops on unsupported question/distribution types and saves diagnostics on failure. It never deletes, restructures, publishes, or starts a lesson.

## Failures

When the automation saves diagnostics, report the artifact directory. Diagnostics may include a screenshot, HTML, frame information, and a DOM summary. Do not include browser profiles, authentication material, or secrets in the report.
