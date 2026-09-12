---
name: lams-irat-editing
description: Inspect, update, or create missing multiple-choice questions with answer weights, marks, mandatory flags, feedback, and supported settings in an existing LAMS iRAT activity. Use for iRAT content or settings changes without copying the lesson. The adapter requires a complete iRAT request, not a single-question patch.
---

# iRAT inspection and updates

Read [shared operating rules](../lams-tbl-authoring/references/shared.md) and the iRAT fields in [configuration](../lams-tbl-authoring/references/configuration.md).

Use `destinationFolderPath` and `lessonTitle` for the existing lesson. Resolve the exact activity, Team Setup, gate, and question titles. Inspect existing question rows when needed:

```bash
npm run inspect:irat-questions -- --config configs/local.json --node '<IRAT_NODE>' --request-json '<REQUEST_JSON>'
```

`--source` inspects the configured source lesson instead. `--dump-question '<EXACT_QUESTION_TITLE>'` provides additional read-only question-editor evidence. Do not infer a correct answer from an existing answer key when the user says that key is wrong; use supplied corrected content or reviewed source evidence.

## Match the adapter's actual scope

The current `apply:irat` command requires a complete `irat` object and a complete inventory of the intended questions. It updates existing questions as new versions and creates missing multiple-choice questions through Create question → Multiple choice → Save, including an initially empty activity. Duplicate titles, unexpected existing questions, and type mismatches stop before writes. It also updates the gate, Team Setup association, and advanced settings. It is not a minimal single-question patch endpoint.

For a targeted correction, preserve unrelated values from reliable current evidence or a current reviewed full request; never fill them from arbitrary example/default data. Only use the bulk adapter when its complete write scope fits the user's request. If that cannot be established, explain the specific missing data or that a narrower adapter is needed; do not claim this skill adds unsupported patching capability.

Question titles default to `Question N` (from `sourceQuestionNumber` or position); do not invent other titles. Fonts and sizes are never set — every field stays at the LAMS default and the adapter verifies that after each write. Supply `irat.sourceDocx` so italics, bold, underline, and sub/superscript are copied from the SoT document onto the request text; review any `SoT formatting warning` it prints. Optional per-question `feedback` writes a supplied rationale to general feedback; omission preserves existing feedback. Optional `prefixAnswersWithLetters` controls answer-letter prefixes. Basic inline HTML (`sub`, `sup`, `strong`, `b`, `em`, `i`, `u`, `br`) is retained in content, answers, and feedback; attributes and other tags are removed. DOCX text/rationale parsing is still manual/reviewed; `sourceDocx` imports associated images only. Missing questions append in request order; this operation does not reorder existing questions.

Only multiple-choice questions and `displayAllQuestions=true` are supported by the live adapter. Correct answer weights must total 100; incorrect answers have zero weight. Preflight can reject an incorrect Team Setup association before the association-writing step, so this is not a general repair path for missing grouping or broken graph structure.

```bash
npm run prepare:irat -- --config configs/local.json --request-json '<REQUEST_JSON>'
npm run apply:irat -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

`prepare:irat` is an optional read-only graph preflight. `apply:irat` saves by default and has its own preflight; append `--dry-run` for an inspection-only preview. Do not run the combined copy workflow for an existing lesson.

Saving the iRAT raises a prompt asking whether to apply the same changes to the matching tRAT. Always confirm it; never cancel or dismiss it. The adapter accepts that prompt automatically and reports every confirmed prompt message. Report the affected questions/settings, Print View comparison, and post-save checks actually performed. On failure, report any phases already saved and diagnostics; the workflow is not transactional. Route structural mismatches to [authoring validation](../lams-authoring-validation/SKILL.md) and rotation-only fixes to [gate settings](../lams-gate-settings/SKILL.md).
