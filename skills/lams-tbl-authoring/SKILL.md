---
name: lams-tbl-authoring
description: Configure and run the repository's Playwright automation to locate, copy, rename, inspect, or validate LAMS TBL authoring lessons inside the approved playground. Use for LAMS lesson Save As workflows and authoring-graph checks. Do not use for learner publishing, production courses, Source-of-Truth parsing, or automatic node restructuring.
---

# LAMS TBL authoring

Operate the reusable Playwright layer in this repository. Keep natural-language interpretation separate from browser mechanics: translate the user's changing lesson values into a per-run JSON object, then pass it to the existing npm scripts with `--request-json`. Do not rewrite `configs/local.json` for each request.

## Establish scope

Read the repository `AGENTS.md` and follow its LAMS safety boundary. Locate the repository root containing `package.json`, `configs/example.json`, and `src/` before running commands.

Choose only the modes requested by the user:

- **Dry-run copy:** verify the source lesson, Save As dialog, and destination without saving.
- **Commit copy:** create the exact requested copy after a successful dry run.
- **Dry-run rename:** open an exact existing lesson, verify its inline title controls, and cancel without changing it.
- **Commit rename:** rename and save an exact existing lesson after a successful rename dry run.
- **Inspect:** list the copied lesson's graph without validating expectations.
- **Validate:** compare the graph with manually configured expectations.
- **AE preflight:** validate already-structured, human-reviewed AE JSON and produce the deterministic execution plan without opening LAMS.
- **AE inspect:** compare one exact AE activity's graph and checkbox settings without saving.

Do not parse an AE Source of Truth. The AE preflight input must already be structured and reviewed. Do not create, delete, publish, start, move, save, or restructure authoring nodes during AE inspection.

## Resolve inputs

For an actual copy, require all of the following before mutation:

- exact source folder path;
- exact source lesson title;
- exact new lesson title;
- exact destination folder path;
- an explicit request to create/save the copy.

For validation, require the exact expected linear flow and manual AE node/gate counts. Gate-property expectations are optional. If a consequential target or expectation is ambiguous, stop and ask for the missing value instead of inferring it from similar lessons.

For AE preflight, require an exact local `--ae-json` path. For AE inspection, additionally require the exact destination folder path, destination lesson title, and exact AE node title. Reject `--commit`.

For an existing-lesson rename, require the exact folder path, exact current title, exact new title, and an explicit request to rename/save it. The folder is both the source and destination; never move the lesson as part of a rename.

Read [references/configuration.md](references/configuration.md) when preparing per-run inputs or changing the one-time environment configuration. Preserve credentials outside the repository and never place passwords, cookies, tokens, or OTPs in JSON.

## Execute safely

1. Ensure ignored `configs/local.json` contains the one-time LAMS URL, approved workspace, browser settings, and valid fallback values. Do not edit it merely because the requested lesson changes.
2. Build a compact per-run JSON object containing only prompt-supported request fields. Pass it as one shell-quoted argument to `--request-json`. Never include `baseUrl`, `workspaceCourse`, `browser`, or `selectors`; the scripts reject those overrides.
3. Run `npm run build` and `npm test` after repository code changes. Ordinary requests do not require rebuilding.
4. For every requested copy, run the dry run first:

   ```bash
   npm run milestone1 -- --config configs/local.json --request-json '<REQUEST_JSON>'
   ```

5. Confirm the output verifies the exact playground course, source lesson, new title, and destination. A completed click is not sufficient evidence.
6. Run the actual copy only when the user explicitly requested it and every target is exact. Reuse the identical request JSON from the successful dry run:

   ```bash
   npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
   ```

7. Inspect or validate only when requested:

   ```bash
   npm run inspect:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
   npm run validate:authoring -- --config configs/local.json --request-json '<REQUEST_JSON>'
   ```

8. Preflight structured AE JSON locally before any AE browser inspection:

   ```bash
   npm run plan:ae -- --ae-json '<AE_JSON_PATH>'
   ```

9. Inspect one exact AE node only after preflight succeeds and `aeOpenActivity` has been captured from the real DOM:

   ```bash
   npm run inspect:ae -- --config configs/local.json --ae-json '<AE_JSON_PATH>' --node '<EXACT_AE_NODE_TITLE>' --request-json '<REQUEST_JSON>'
   ```

   This command is read-only and rejects `--commit`. A validation mismatch may exit with code `2`.

10. For an existing-lesson rename, run the non-mutating dry run first, then reuse the identical request JSON with `--commit` only when explicitly authorized:

   ```bash
   npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
   npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>' --commit
   ```

   The committed command must verify the new exact title in the same folder and that the old title is absent. It must not move, publish, start, or restructure the lesson.

Read [references/operations.md](references/operations.md) for command outcomes, stopping conditions, and reporting requirements.

## Interpret validation

- Tool activities after Team Setup must be double boxed and associated with Team Setup.
- Gate nodes are exempt from double boxing.
- The default expected iRAT Gate is a password gate with a dynamic password rotating every 10 seconds, unless the user explicitly supplies another approved expectation.
- The validator is read-only. Report mismatches; never correct a gate or node automatically.
- `expectedFlow` is currently one linear chain. If the requested lesson branches or merges, report that the current validator cannot prove that topology instead of flattening it.

## Report

Return the operation performed, exact source/title/destination, states verified, validation PASS/FAIL, and each mismatch. If execution stops, include the reason and diagnostics directory when one was produced. Never claim success solely because a command exited without an exception.
