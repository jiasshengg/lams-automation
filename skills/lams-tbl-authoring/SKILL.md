---
name: lams-tbl-authoring
description: Orchestrate LAMS TBL authoring across lesson copying, iRAT and AE writing, SOT image import, verified AE graph reconciliation, validation, and publishing the finished lesson to a cohort with its schedule and grouping. Use for an overall or multi-stage TBL authoring request. For one targeted operation, route to the matching focused skill. Does not delete arbitrary nodes.
---

# Overall TBL authoring workflow

Read [shared operating rules](references/shared.md). Use the existing scripts and coordinate only the stages needed for the user's requested outcome. A request to repair an existing lesson must not trigger a new copy.

## Route the work

| Request | Focused skill or guide |
|---|---|
| New computer, missing tools, or setup failure | [First-time setup](../../docs/first-time-setup.md) |
| Locate, copy, or rename a lesson | [lams-lesson-management](../lams-lesson-management/SKILL.md) |
| Inspect or update existing iRAT content/settings | [lams-irat-editing](../lams-irat-editing/SKILL.md) |
| Change one dynamic-password gate's rotation | [lams-gate-settings](../lams-gate-settings/SKILL.md) |
| Extract AE SoT/media, prepare AE JSON, inspect or write AE content/graph | [lams-ae-preparation](../lams-ae-preparation/SKILL.md) |
| Check nodes, connections, grouping, or gate expectations | [lams-authoring-validation](../lams-authoring-validation/SKILL.md) |

Read the relevant focused instructions directly; routing does not require a new task or subagent. These skills also work independently.

## Coordinate the requested flow

1. Resolve source documents, source lesson, intended new title/destination, and requested content changes. Use available context and read-only discovery before asking for missing information. File names and partial file names are accepted. If no copy destination is stated, use the source lesson folder without asking for confirmation.
2. If an iRAT or AE SoT is supplied, extract its embedded media and review question associations. AE structural extraction remains evidence for reviewed AE JSON; browser mutation uses that reviewed JSON. When reviewing, recognize a shared case/image spanning several adjacent questions by what the questions themselves depend on to make sense standalone, not by matching a fixed phrase — automated detection only catches the literal "Qxx-yy relate to this case" wording, and a real Source-of-Truth introduces this in many other ways (see [configuration](references/configuration.md)). Also tell apart a genuine shared case narrative (duplicate the image onto every question in the group) from two adjacent questions that just point at one image between them with complementary wording ("below"/"above") and no narrative at all (the image belongs once, to the earlier question) — the two look similar but need opposite handling, and automated duplication cannot distinguish them either, so flag which one applies to the user.
3. Do not run any preflight, preview, or separate inspection session before the combined run - there is no `preflight:tbl` step, and each extra launch costs a full browser start, sign-in check, and course/lesson navigation. Resolve decisions from the Source-of-Truth and request instead. Use [exact placeholder repairs](references/template-repair.md) for authorized placeholder removal.

   For copy-only work, use lesson management. For an existing lesson, skip copying and use the relevant focused skill.
4. For a requested new copy plus iRAT configuration, resolve the complete structured `irat` request following the iRAT skill, then run the combined workflow once:

   ```bash
   npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>'
   ```

   Do not separately copy first: the combined command already copies. It saves by default. `--dry-run` previews the copy and stops before iRAT editing. If the copy succeeds but a later phase fails, report the saved copy and resume against that existing lesson rather than blindly copying again.
5. For a complete copy, iRAT, and AE run, pass reviewed AE JSON to the continuous workflow. This is **one** command and **one** Chromium session: iRAT/tRAT and then AE run in the same browser and the same Author window. Never split it into `run:tbl-irat` followed by `apply:ae`, which closes Chromium and relaunches it for AE; `apply:ae` is only for an existing lesson whose iRAT is already done.

   ```bash
   npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>'
   ```

   The AE stage writes existing exact Assessment nodes, adds missing AE Assessment nodes, permission gates, and reviewed linear transitions, removes exact direct transitions that bypass planned gates, and replaces exact planned gates whose verified type/settings are wrong. It does not delete questions or infer that unrelated nodes are extra.
6. **Publishing is the last stage of the full flow.** Run it when the user asked for the
   full/end-to-end/complete flow, or asked for the lesson to be deployed, published, or made
   ready for the cohort. Do **not** run it when the request was only to author, copy, fix, or
   update a lesson. For the full flow, add `--publish` to the step 5 command so publishing
   and the Kanban code run in the same browser right after AE is saved and validated:

   ```bash
   npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>' --publish
   ```

   `--publish` needs `lessonIndex.endDate` in the request and refuses to start without it,
   before copying anything. It publishes only the design the run just saved. Use the
   standalone `lesson:index` command below only for a lesson that is already authored.

   Collect missing publishing information once alongside other required decisions. Continue authorized authoring while the date is pending; do not repeat the question on each progress update. Before publishing, put
   the answers in the per-run `--request-json` rather than in `configs/local.json`:

   | Ask for | Field | If not stated |
   |---|---|---|
   | The date the lesson should close | `lessonIndex.endDate` (`YYYY-MM-DD`) | **Ask once if missing.** Never reuse a date from a config, an example, or a previous run - a wrong one publishes a lesson that closes on the wrong day. |
   | The closing time, if not end of day | `lessonIndex.endTime` (`HH:MM`) | Defaults to `23:59`; confirm only if they want something else. |
   | Which student group | `lessonIndex.courseGrouping` | Only ask when the course offers more than one preset - the run names the available ones and stops. |

   Standalone, for an already-authored lesson:

   ```bash
   npx tsx src/index-monitoring.ts --config configs/local.json --request-json '<REQUEST_JSON>' --expect-design '<EXACT_TITLE_THE_AUTHORING_RUN_SAVED>' --commit
   ```

   It works from the cohort page: selects the most recent design, turns off "Display activity
   scores on completion", enables scheduling with the end date at 23:59, selects the course
   grouping, clicks Add now, reads the 5-digit lesson code, and records that code in the
   Kanban sheet, which completes the stage. `--commit` is required; without it the form is
   filled and verified and "Add now" is never clicked. `--expect-design` refuses to publish
   unless the top "Recently used designs" entry is the lesson the authoring run just created.

   The code is sent to the sheet automatically when the sheet credentials are configured in
   the environment. When they are not, the run prints the code for manual entry rather than
   failing, so report the code to the user in that case. `--no-publish-code` skips the send.
   The sheet matches on the lesson title exactly as it appears in its TBL/Quiz Details
   column, so an "Identifier not found" result means the title does not match that column,
   not that publishing failed - the lesson still exists.

   Report the 5-digit code and repeat the end date back when reporting the result, so the
   user can catch a wrong date before learners see it.

7. The combined run validates the resulting authoring graph against full-lesson expectations it derives from the copy (the reviewed template prefix plus the SoT) before reporting completion. SoT gate counts describe the gates between AE activities; include each reviewed, retained template entrance gate separately. Never set expectations merely to equal observed counts.
8. Report completed stages, verified results, remaining mismatches, and any partial saved state.

The supported overall flow is authoring, not automatic completion of every TBL activity. AE writing and targeted verified graph repair are implemented. Arbitrary node deletion or rewiring outside the reviewed AE plan is not. Learner publishing is the final stage of the full flow, run after AE in the same browser through `run:tbl --publish` (or `lesson:index` for an already-authored lesson); it needs the user's end date and is never appended to a request that only asks for authoring. See [operation details](references/operations.md) when needed.

Use documented defaults without another approval turn: missing AE marks are 4. The one exception is an AE question with more than one correct answer (for example A and B): before the run, ask the user once for the whole AE whether to split the credit between the correct answers (50/50 for two; `"multipleAnswerCredit": "split"`) or give every correct answer 100% (`"multipleAnswerCredit": "full"`), naming the affected questions, and set their answer at the AE JSON root. Never choose for them; `run:tbl` and `apply:ae` refuse such a plan until it is set. A second, absolute exception: when a question's correct answer is not marked explicitly in the Source-of-Truth (no uniformly bold/highlighted whole option, `Answer:`/`Correct answer:`/`Explanation -` line, or equivalent key — AE surfaces this as `TODO_answerKey`; iRAT has no automated check, so verify by hand), never infer, guess, or supply an answer from outside knowledge under any circumstance. Flag the exact question to the user and wait for their answer before authoring it, for both iRAT and AE. Resolve `_review` notes through source evidence and those defaults; ask only about genuine content ambiguity or missing authorization. Never offer publishing with a known unresolved placeholder as a substitute for completing the requested authoring.
