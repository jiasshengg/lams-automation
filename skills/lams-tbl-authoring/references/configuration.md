# Configuration

Use `configs/local.json` for live values. It is ignored by Git. Keep `configs/example.json` reusable and free of credentials.

## Copy fields

| Field | Meaning |
|---|---|
| `baseUrl` | LAMS entry URL |
| `workspaceCourse` | Must remain exactly `DL Playground 2026/2027 [internal]` for live development |
| `sourceFolderPath` | Ordered folder names leading to the source lesson |
| `sourceLessonTitle` | Exact existing lesson title |
| `destinationFolderPath` | Ordered folder names for the new copy |
| `lessonTitle` | Exact new copy title |
| `previousCohort`, `currentCohort`, `module`, `tbl` | Prompt-derived workflow metadata; do not leave misleading example values |
| `destinationFolder` | Human-readable destination used in reporting |

Folder paths are variable-length arrays. Do not assume a fixed number of folders.

## Validation fields

`expectedFlow` contains the exact node names in their expected linear order. Do not populate it from the observed graph merely to make validation pass.

`expectedAENodes` and `expectedAEGates` are manual expectations. Source-of-Truth parsing is not part of this skill version.

Use `expectedGateProperties` for exact gate requirements:

```json
{
  "expectedGateProperties": [
    {
      "name": "iRAT Gate",
      "type": "password",
      "description": "iRAT Gate",
      "dynamicPassword": true,
      "rotationSeconds": 10
    },
    {
      "name": "tRAT Gate",
      "type": "permission",
      "description": "tRAT Gate"
    }
  ]
}
```

Every property except `name` is optional. Only add an expectation when it came from the user's request or an established workflow rule.

## Browser fields

Keep `headless` false during development. Store the persistent profile only under ignored `.playwright/`. The user completes authentication manually when needed.

## Configuration checks

Before running a committed copy, reject configuration when:

- the new title equals the source title;
- the new title contains a placeholder;
- a source or destination path is empty;
- the source lesson or destination is not exact;
- the destination already contains the new title;
- the workspace course differs from the approved playground.
