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
2. If an iRAT or AE SoT is supplied, extract its embedded media and review question associations. AE structural extraction remains evidence for reviewed AE JSON; browser mutation uses that reviewed JSON.
3. For copy-only work, use lesson management. For an existing lesson, skip copying and use the relevant focused skill.
4. For a requested new copy plus iRAT configuration, resolve the complete structured `irat` request following the iRAT skill, then run the combined workflow once:

   ```bash
   npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>'
   ```

   Do not separately copy first: the combined command already copies. It saves by default. `--dry-run` previews the copy and stops before iRAT editing; it is not a complete iRAT preflight. If the copy succeeds but a later phase fails, report the saved copy and resume against that existing lesson rather than blindly copying again.
5. For a complete copy, iRAT, and AE run, pass reviewed AE JSON to the continuous workflow:

   ```bash
   npx tsx src/run-tbl-irat.ts --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>'
   ```

   The AE stage writes existing exact Assessment nodes, adds missing AE Assessment nodes, permission gates, and reviewed linear transitions, removes exact direct transitions that bypass planned gates, and replaces exact planned gates whose verified type/settings are wrong. It does not delete questions or infer that unrelated nodes are extra.
6. Publishing the lesson to a cohort (deployment guide steps 81-92) is a **separate stage
   that runs after AE**, in its own entry point, and **only when the user explicitly asks
   for it**. `AGENTS.md` forbids making a copied lesson learner-facing otherwise, and the
   authoring commands contain no publishing code, so "continue the full flow" is an
   authoring instruction and never on its own authorization to publish.

   Once the AE stage has completed and been verified, and the user has asked for the lesson
   to be published:

   ```bash
   npx tsx src/index-monitoring.ts --config configs/local.json --request-json '<REQUEST_JSON>' --expect-design '<EXACT_TITLE_THE_AUTHORING_RUN_SAVED>' --commit
   ```

   It closes nothing and opens nothing in Author: it works from the cohort page, selects the
   most recent design, turns off "Display activity scores on completion", enables scheduling
   with the end date at 23:59, selects the course grouping, clicks Add now, and reads the
   5-digit lesson code. `--commit` is required; without it the form is filled and verified
   and "Add now" is never clicked. `--expect-design` refuses to publish unless the top
   "Recently used designs" entry is the lesson the authoring run just created. Add
   `--publish-code` to send the lesson code to the Kanban sheet.

   Publishing needs values only the user can supply, so **ask for anything they have not
   stated** before running it, and put the answers in the per-run `--request-json` rather
   than in `configs/local.json`:

   | Ask for | Field | If not stated |
   |---|---|---|
   | The date the lesson should close | `lessonIndex.endDate` (`YYYY-MM-DD`) | **Always ask.** Never reuse a date from a config, an example, or a previous run - a wrong one publishes a lesson that closes on the wrong day. |
   | The closing time, if not end of day | `lessonIndex.endTime` (`HH:MM`) | Defaults to `23:59`; confirm only if they want something else. |
   | Which student group | `lessonIndex.courseGrouping` | Only ask when the course offers more than one preset - the run names the available ones and stops. |

   Ask these together in one turn rather than one at a time, and repeat the end date back
   when reporting the result so the user can catch a wrong date before learners see it.

7. Inspect or validate the resulting authoring graph when required for the requested outcome, using expectations from the source/request rather than inventing values to match the observed graph.
8. Report completed stages, verified results, remaining mismatches, and any partial saved state.

The supported overall flow is authoring, not automatic completion of every TBL activity. AE writing and targeted verified graph repair are implemented. Arbitrary node deletion or rewiring outside the reviewed AE plan is not. Learner publishing is a separate explicitly requested stage run after AE through `lesson:index`; never append it to an authoring request. See [operation details](references/operations.md) when needed.
