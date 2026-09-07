---
name: lams-gate-settings
description: Inspect and change the password rotation interval of one existing dynamic-password LAMS gate. Use for targeted gate rotation fixes without rewriting iRAT questions. Does not change arbitrary gate types, create gates, or repair graph connections.
---

# Targeted gate rotation

Read [shared operating rules](../lams-tbl-authoring/references/shared.md).

Resolve the existing lesson through `destinationFolderPath` and `lessonTitle`, the exact gate name, and the requested positive integer rotation interval in seconds. The established default iRAT expectation is 10 seconds when the user requests that convention; preserve an explicitly requested different value.

```bash
npm run fix:gate -- --config configs/local.json --gate '<EXACT_GATE_NAME>' --rotation-seconds 10 --request-json '<REQUEST_JSON>'
```

Replace the example interval with the requested value. This command saves by default; add `--dry-run` for a preview. It reports a no-op if the interval already matches. The mutation adapter requires one exact dynamic-password gate, changes the rotation control, checks other gate properties remain unchanged, saves the design, and reopens it to verify persistence.

Report previous and persisted intervals, lesson/folder, or the stopping condition and diagnostics. This targeted command does not support changing gate type, description, dynamic-password mode, stop-at-preceding behavior, or connections. Use [authoring validation](../lams-authoring-validation/SKILL.md) to inspect those mismatches; broader gate settings are written only within the complete [iRAT adapter](../lams-irat-editing/SKILL.md), whose write scope must fit the request.
