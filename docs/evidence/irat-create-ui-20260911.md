# iRAT creation discovery and SoT baseline — 11 September 2026

## Live UI evidence

Browser control was used before implementing the creation path. The configured course heading was verified as DL Playground 2026/2027 [internal]. A fresh Author window opened the exact recently used design `[Jss] TEST LESSON A 280826`, then its iRAT activity. The existing list contained three MCQs.

Observed sequence:

1. `Create question` button (`#createQuestionDropdown`) expands the type menu.
2. `Multiple choice` button opens `#qb-question-authoring-modal.show`.
3. The modal iframe uses `initNewReference.do`, unlike existing questions' `editReference.do` iframe.
4. `#assessmentQuestionForm` contains `#title`, the description editor, and four initial answer options. Answer editors/weights use `optionNameN` and `optionMaxMarkN`.
5. `Advanced settings` reveals the default grade (`#maxMark`), answer mode (`#multipleAnswersAllowed`), and answer-letter checkbox (`#prefixAnswersWithLetters`). The form also exposes `Feedback for students (optional)` and `#feedback`.
6. New questions expose `#saveButton` labelled `Save`, without `Save as new version`. Clicking Save on the empty form displayed required title/description/answer/100%-credit validation messages.
7. The question editor's Cancel is a **link**. Cancel hid the modal; the question count remained three. Closing the activity and selecting Continue discarded the inspection.

The initial stale Author window showed a blank activity and an autosave error. Reopening the activity later also returned an empty body with a script redirecting to the LAMS index page. Exploration stopped there; the screenshot is recorded in the task and HTML/frame evidence is in the ignored `artifacts/irat-create-ui-20260911` directory. Temporary exploration tabs were closed.

No completed question, activity, or design was explicitly saved during this exploration. LAMS reported a design autosave on opening the activity. The new script's committed workflow has **not** been validated end-to-end against live LAMS; UI fixture tests verify its successful save/reference-refresh branch.

## Local SoT baseline

`sot/iRAT SoT for interns.docx` supplies 25 one-mark MCQs, each with five answers and an answer key/rationale. It also contains scientific sub/superscripts and one embedded graph for question 23. These are baseline requirements, not fixed automation limits.

- Missing questions are created; existing exact titles are updated as new versions. Empty activities are supported.
- Option counts are variable; tests cover two, five, and six, including split credit across multiple correct options.
- Optional `feedback` carries reviewed rationale text. Optional `prefixAnswersWithLetters` controls answer labels. Omitting either preserves existing values / new-form defaults.
- Content, answers, and feedback retain basic inline sub/superscript and emphasis tags without attributes.
- The existing DOCX media resolver remains responsible for images. Question 6 places `(mark 1)` mid-sentence; the extractor previously missed this marker and assigned the graph to question 22. Marker detection now handles that position. Re-extraction verified question 23, one image, and no unassigned images in `artifacts/irat-sot-baseline-verified/manifest.json`.
- Source question text and keys still require a reviewed request. This change does not introduce automatic medical content interpretation, DOCX question parsing, arbitrary rich Word layout, or question deletion/reordering. Missing questions append in request order.

## Verification

`npm run build` and the complete `npm test` suite pass (175 tests). New regression coverage exercises creation, existing-version protection, duplicate/extra/type preflight guards, dry runs, a 25-question run, option resizing, feedback, basic scientific formatting, and mid-sentence mark/image association. Tests use synthetic question text rather than copying the SoT content.
