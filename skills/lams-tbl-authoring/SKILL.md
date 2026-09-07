---
name: lams-tbl-authoring
description: Orchestrate LAMS TBL authoring across lesson copying, iRAT and AE writing, SOT image import, append-only AE graph reconciliation, and validation. Use for an overall or multi-stage TBL authoring request. For one targeted operation, route to the matching focused skill. Does not publish learner lessons or delete/rewire nodes.
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
   npm run run:tbl-irat -- --config configs/local.json --request-json '<REQUEST_JSON>'
   ```

   Do not separately copy first: the combined command already copies. It saves by default. `--dry-run` previews the copy and stops before iRAT editing; it is not a complete iRAT preflight. If the copy succeeds but a later phase fails, report the saved copy and resume against that existing lesson rather than blindly copying again.
5. For a complete copy, iRAT, and AE run, pass reviewed AE JSON to the continuous workflow:

   ```bash
   npm run run:tbl -- --config configs/local.json --request-json '<REQUEST_JSON>' --ae-json '<AE_JSON>'
   ```

   The AE stage writes existing exact Assessment nodes and adds missing AE Assessment nodes, permission gates, and reviewed linear transitions. It does not delete questions/nodes or remove/rewire transitions. A direct transition that bypasses a planned gate stops the run and is reported.
6. Inspect or validate the resulting authoring graph when required for the requested outcome, using expectations from the source/request rather than inventing values to match the observed graph.
6. Report completed stages, verified results, remaining mismatches, and any partial saved state.

The supported overall flow is authoring, not automatic completion of every TBL activity. AE writing and append-only graph reconciliation are implemented; deletion and rewiring are not. Learner publishing is a separate explicit operation. See [operation details](references/operations.md) when needed.
