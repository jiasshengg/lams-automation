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
6. The same command continues into deployment guide steps 81-92 whenever the request
   carries a `lessonIndex` block. It closes the Author screen, opens Add Lesson on the
   cohort page already in the browser, selects the most recent design, turns off "Display
   activity scores on completion", enables scheduling with the end date at 23:59, selects
   the course grouping, clicks Add now, and reads the 5-digit lesson code.

   `lessonIndex.endDate` is the one field that must be right for the specific lesson.
   Confirm it against the user's stated event date - never carry a date over from an
   example, a previous run, or whatever the config happens to hold. A wrong end date
   publishes a lesson that closes on the wrong day.

   Publishing makes the lesson visible to learners and cannot be undone from this tool, so
   `--dry-run` previews the whole Add Lesson form and stops before "Add now", and a
   committed run refuses to publish unless the top "Recently used designs" entry is the
   lesson this run just created. `--skip-index` stops after authoring. `--publish-code`
   additionally sends the lesson code to the Kanban sheet.

7. Inspect or validate the resulting authoring graph when required for the requested outcome, using expectations from the source/request rather than inventing values to match the observed graph.
8. Report completed stages, verified results, remaining mismatches, and any partial saved state.

The supported overall flow is authoring, not automatic completion of every TBL activity. AE writing and targeted verified graph repair are implemented. Arbitrary node deletion or rewiring outside the reviewed AE plan is not. Learner publishing runs in the same command whenever a `lessonIndex` block is supplied; confirm the end date before committing such a run. See [operation details](references/operations.md) when needed.
