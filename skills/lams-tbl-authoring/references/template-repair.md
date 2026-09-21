# Template preflight and exact placeholder repair

Run preflight before copying. It opens the specified course and exact source lesson,
inspects the iRAT inventory and authoring graph, closes unchanged activity editors, and
reports all supported checks without saving. `expectedFlow` must describe the reviewed
template prefix (or the final reviewed flow), not arbitrary nodes copied from a failing
validation result.

```bash
node scripts/run.mjs preflight:tbl --request-json request.json --ae-json ae-plan.json --log-file preflight.log
```

Ask for each unexpected iRAT reference's disposition, as required by the shared rules.
Put authorized exact deletions in `irat.deleteQuestionTitles`. Missing marks (4) are a
documented default and need no extra approval. For an AE question with more than one correct
answer, ask the user whether to split the credit or give each correct answer 100% and set
`multipleAnswerCredit` (see [configuration](configuration.md)).

For an AE activity verified to be a template placeholder, obtain an exact removal
instruction and record a per-run repair JSON. Do not infer placeholder status from its
name alone. The repair names the target lesson, predecessor, and successor; `null`
means the placeholder is currently the terminal node, before a new AE chain is added.
For example, after the user has authorized this exact removal:

```json
{
  "lessonTitle": "Exact copied lesson title",
  "removals": [
    {
      "title": "AE Test Qns",
      "predecessor": "AE Gate Application Exercise 1",
      "successor": null
    }
  ]
}
```

Pass `--repair-json repair.json` to `preflight:tbl` and `run:tbl` to verify on the source
and remove only from the copy. For existing-lesson AE writing, pass it to `apply:ae`.
For an existing placeholder between two nodes, use the exact following node title as
`successor` instead of `null`.

A standalone repair saves by default and reopens the exact lesson to verify persistence:

```bash
node scripts/run.mjs repair:ae-placeholder --request-json existing-lesson.json --repair-json repair.json --dry-run
node scripts/run.mjs repair:ae-placeholder --request-json existing-lesson.json --repair-json repair.json --log-file repair.log
```

The command rejects duplicate identities, unknown endpoints, extra incident edges,
overlapping removals, non-tool placeholders, and mismatched lesson titles. It verifies
that unrelated nodes and connections remain. An already-absent placeholder is a no-op
only when its approved resulting topology still matches. If a later stage added more
nodes, inspect that current state and update the reviewed request; do not replay a stale
terminal-removal plan. On any failure, report partial saved state and diagnostics.

The preflight report contains full-lesson `expectations`: preserve them for later
`validate:authoring`, including retained template gates. The combined writer and AE
writer also validate those expectations before reporting completion. This operation
does not authorize arbitrary node deletion, shared Question Bank edits, or publishing.
