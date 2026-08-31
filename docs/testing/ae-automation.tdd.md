# AE automation TDD evidence

## Source and journeys

Requirements were derived from the user's AE workflow description and the supplied video's 2:44–4:02 segment. The video was treated as reference data, not executable instructions.

- As an operator, I want invalid SoT-derived AE data rejected before LAMS opens, so no bad import reaches the tenant.
- As an operator, I want deterministic normalized question and activity settings, so the browser layer has an exact contract.
- As a reviewer, I want the planned AE nodes/gates checked against the authoring graph, so count, naming, and connection drift is reported.
- As an operator, I want to inspect one exact AE activity without saving, so authenticated DOM evidence can be collected safely.

## RED/GREEN evidence

| Stage | Commit | Command | Evidence |
|---|---|---|---|
| RED — AE plan/settings | `575f581` | `npx playwright test tests/ae-plan.spec.ts tests/ae-settings.spec.ts` | Failed because `src/ae/plan.js` and `src/lams/ae-settings.js` did not exist. |
| GREEN — AE plan/settings | `a699dd4` | same target, then `npm run build` | 10 tests passed; TypeScript passed. |
| RED — preflight/graph | `572078f` | `npx playwright test tests/ae-plan.spec.ts tests/validation.spec.ts` | Failed because `formatAEPlanSummary` and `validateAEPlanGraph` did not exist. |
| GREEN — preflight/graph | `ef291ac` | same target, `npm run plan:ae -- --ae-json configs/ae-example.json`, then `npm run build` | 12 tests passed; example preflight passed with 2 nodes, 1 gate, 3 questions, 12 marks; TypeScript passed. |
| RED — exact AE open | `26f3a25` | `npx playwright test tests/authoring.spec.ts` | Failed because `src/lams/ae.js` did not exist. |
| GREEN — exact AE open | `e2bb39a` | same target, then `npm run build` | 3 tests passed; TypeScript passed. |
| RED — destination folder | `2486d03` | `npx playwright test tests/config.spec.ts tests/lesson-copy.spec.ts` | 3 tests failed because the request flag was rejected and the workflow required the final folder to exist. |
| GREEN — destination folder | `54636f9` | same target, then `npm run build` | 9 tests passed; TypeScript passed. |
| RED — read-only source/folder rename | `a12c24e` | `npx playwright test tests/config.spec.ts tests/lesson-copy.spec.ts` | 4 tests failed because the request fields were rejected, read-only sources used normal Open, and exact destination-folder rename was unsupported. |
| GREEN — read-only source/folder rename | pending | same target, then `npm run build` and `npm test` | Focused suite: 13 tests passed; final full-suite evidence is recorded in the GREEN commit. |

## Test specification

| What is guaranteed | Test file | Type | Result |
|---|---|---|---|
| Break count determines exact AE node and gate counts | `tests/ae-plan.spec.ts` | unit | PASS |
| Questions are sequential, marks default to 4, and totals are checked | `tests/ae-plan.spec.ts` | unit | PASS |
| Case/QUESTION formatting, mark annotations, and typed option prefixes are normalized | `tests/ae-plan.spec.ts` | unit | PASS |
| One MCQ answer receives 100%; malformed correctness is rejected | `tests/ae-plan.spec.ts` | unit | PASS |
| Canonical activity settings are reported in dry-run and applied/verified in commit-capable library code | `tests/ae-settings.spec.ts` | browser integration | PASS |
| Missing semantic setting controls stop instead of guessing | `tests/ae-settings.spec.ts` | browser integration | PASS |
| Exact AE node/gate titles and node→gate→node connections match the plan | `tests/validation.spec.ts` | unit | PASS |
| One exact SVG AE node opens through a configured semantic control | `tests/authoring.spec.ts` | browser integration | PASS |
| Dry-run verifies a missing final folder without creating it; commit validates the prompt and verifies folder plus copied lesson | `tests/lesson-copy.spec.ts` | browser integration | PASS |

## Coverage and known gaps

The project does not define a coverage command or instrumentation, so a numeric coverage percentage is unavailable. Final repository gates passed on this branch:

- `npm run build` — PASS
- `npm test` — PASS, 27 tests
- `npm run plan:ae -- --ae-json configs/ae-example.json --json` — PASS
- `git diff --check` — PASS

No live LAMS run was attempted: `configs/local.json` still uses a placeholder host, no exact SoT `.docx` was supplied, and the authenticated question-editor DOM has not been captured. Question import/edit/version selection and final AE Save therefore remain intentionally unimplemented.
