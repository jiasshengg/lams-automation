---
name: lams-authoring-validation
description: Inspect or validate a LAMS lesson authoring graph, node counts, linear connections, Team Setup associations, gate properties, and gradebook expectations. Use when node setup looks wrong or the user requests a structural check. Read-only; does not add, delete, or reconnect nodes.
---

# Authoring graph inspection and validation

Read [shared operating rules](../lams-tbl-authoring/references/shared.md). Resolve the existing lesson using `destinationFolderPath` and `lessonTitle`.

```bash
npm run inspect:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
npm run validate:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

Inspection lists observed nodes and transitions. Validation compares those observations against the reviewed fields in [configuration](../lams-tbl-authoring/references/configuration.md). Both are read-only. If the expected graph is unknown, inspect and describe what is present; do not populate expectations from observations just to produce PASS.

Check exact expected node names, reviewed AE node/gate counts, linear connections, Team Setup associations and double boxes for tool activities, configured gate properties, and gradebook output expectations. Gates are exempt from double boxing. `expectedFlow` describes a linear chain; the validator cannot prove arbitrary branching or merging. Report runtime model unavailability as an evidence limitation.

Counts may come from reviewed [AE preparation](../lams-ae-preparation/SKILL.md), but names must come from the requested naming convention or verified lesson. Exit code 2 is a validation mismatch, not necessarily a browser failure.

Report expected versus observed values for each failure. Do not automatically delete, create, reconnect, or restructure nodes. For a requested password-rotation correction, use [gate settings](../lams-gate-settings/SKILL.md). For iRAT content changes, use [iRAT editing](../lams-irat-editing/SKILL.md); a missing Team Setup association may block that adapter rather than be repaired by it.
