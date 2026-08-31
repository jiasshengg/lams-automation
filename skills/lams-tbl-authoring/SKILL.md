---
name: lams-tbl-authoring
description: Configure and run the repository's Playwright automation to locate, copy, rename, inspect, or validate LAMS TBL authoring lessons inside the approved playground. Use for LAMS lesson Save As workflows and authoring-graph checks. Do not use for learner publishing, production courses, Source-of-Truth parsing, or automatic node restructuring.
---

# LAMS TBL authoring

Operate the reusable Playwright layer in this repository. Keep natural-language interpretation separate from browser mechanics: translate the user's request into `configs/local.json`, then call the existing npm scripts.

## Establish scope

Read the repository `AGENTS.md` and follow its LAMS safety boundary. Locate the repository root containing `package.json`, `configs/example.json`, and `src/` before running commands.

Choose only the modes requested by the user:

- **Dry-run copy:** verify the source lesson, Save As dialog, and destination without saving.
- **Commit copy:** create the exact requested copy after a successful dry run.
- **Inspect:** list the copied lesson's graph without validating expectations.
- **Validate:** compare the graph with manually configured expectations.

Do not parse an AE Source of Truth. Do not create, delete, publish, start, move, or restructure authoring nodes.

## Resolve inputs

For an actual copy, require all of the following before mutation:

- exact source folder path;
- exact source lesson title;
- exact new lesson title;
- exact destination folder path;
- an explicit request to create/save the copy.

For validation, require the exact expected linear flow and manual AE node/gate counts. Gate-property expectations are optional. If a consequential target or expectation is ambiguous, stop and ask for the missing value instead of inferring it from similar lessons.

Read [references/configuration.md](references/configuration.md) when creating or changing configuration. Preserve credentials outside the repository and never place passwords, cookies, tokens, or OTPs in JSON.

## Execute safely

1. Create or update ignored `configs/local.json` from `configs/example.json`. Change only values supported by the user's request.
2. Run `npm run build` and `npm test` after repository code changes. Ordinary configuration-only runs do not require rebuilding unless code changed.
3. For every requested copy, run the dry run first:

   ```bash
   npm run milestone1 -- --config configs/local.json
   ```

4. Confirm the output verifies the exact playground course, source lesson, new title, and destination. A completed click is not sufficient evidence.
5. Run the actual copy only when the user explicitly requested it and every target is exact:

   ```bash
   npm run copy:lesson -- --config configs/local.json --commit
   ```

6. Inspect or validate only when requested:

   ```bash
   npm run inspect:authoring -- --config configs/local.json
   npm run validate:authoring -- --config configs/local.json
   ```

Read [references/operations.md](references/operations.md) for command outcomes, stopping conditions, and reporting requirements.

## Interpret validation

- Tool activities after Team Setup must be double boxed and associated with Team Setup.
- Gate nodes are exempt from double boxing.
- The default expected iRAT Gate is a password gate with a dynamic password rotating every 10 seconds, unless the user explicitly supplies another approved expectation.
- The validator is read-only. Report mismatches; never correct a gate or node automatically.
- `expectedFlow` is currently one linear chain. If the requested lesson branches or merges, report that the current validator cannot prove that topology instead of flattening it.

## Report

Return the operation performed, exact source/title/destination, states verified, validation PASS/FAIL, and each mismatch. If execution stops, include the reason and diagnostics directory when one was produced. Never claim success solely because a command exited without an exception.
