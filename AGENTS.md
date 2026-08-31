# LAMS Automation Repository Instructions

## Project purpose

Build and verify a reusable Playwright + TypeScript automation layer for the initial LAMS TBL authoring workflow, with a vendor-neutral Agent Skill that orchestrates the tested scripts. Source-of-Truth parsing remains out of scope until the browser automation is reliable.

## LAMS safety boundary

- Perform all development and live UI testing only inside the LAMS course **DL Playground 2026/2027 [internal]**.
- Before any live LAMS action, verify that this exact course heading is visible.
- Do not modify content in another course, cohort, folder, or production area.
- Treat navigation and DOM inspection as read-only.
- Do not create, copy, rename, move, save, publish, delete, or restructure a lesson unless the user has supplied the exact source lesson, new title, and destination and has asked for that operation.
- Never delete or automatically restructure authoring nodes.
- Never publish or start a copied lesson as a learner-facing lesson unless explicitly requested.
- Stop before a consequential action if the target is ambiguous or the UI state cannot be verified.

## Current implementation scope

Work incrementally.

### First box: lesson copy workflow

1. Verify the playground course.
2. Open the global LAMS **Author** interface.
3. Find the configured previous-academic-year TBL sequence in the Authoring library.
4. Open the exact sequence.
5. Use **Save As**.
6. Apply the configured new lesson title.
7. Save into the configured destination folder.
8. Verify the copied sequence exists at the expected destination.

Do not infer an exact source sequence from only a module or TBL number when multiple matches exist.

### Later scope

- Inspect and list Authoring nodes.
- Determine whether the Authoring surface uses HTML, SVG, canvas, iframes, or another representation.
- Validate required nodes, counts, connections, Team Setup associations, and gate names.
- Parse the AE Source of Truth only after the Playwright layer is reliable.
- Extend the vendor-neutral skill only with behavior already supported by the reusable automation.

## Browser automation rules

- Use Playwright with TypeScript.
- Keep the browser headed during development.
- Prefer `getByRole`, `getByLabel`, `getByText`, and stable data/test attributes.
- Use CSS only as an evidence-backed fallback.
- Do not guess LAMS-specific selectors. Inspect the real DOM first and record why a selector is stable.
- Avoid positional selectors such as `nth-child` unless no stable alternative exists and the limitation is documented.
- Require a unique visible match before clicking.
- Verify the resulting page, dialog, folder, title, or other expected state after every action.
- Handle new tabs, popups, and iframes explicitly when observed.
- If the UI structure is unknown, stop without mutation and capture diagnostics: screenshot, HTML, frame URLs, accessible controls, and relevant data attributes.
- Do not bypass authentication, CAPTCHA, browser warnings, or permission prompts.

## Configuration and credentials

- Keep lesson-specific and cohort-specific values in JSON configuration, not source code.
- Use `configs/local.json` for local live testing; it is ignored by Git.
- Keep the reusable schema/example in `configs/example.json` free of real credentials.
- Never store LAMS passwords, session cookies, tokens, OTPs, or browser profile contents in the repository.
- The local persistent browser profile belongs under `.playwright/`, which must remain ignored by Git.

## Code organization

- `src/main.ts`: workflow entry point and orchestration.
- `src/config.ts`: configuration types, loading, and validation.
- `src/lams/navigation.ts`: LAMS and Authoring-library navigation.
- `src/lams/lesson-copy.ts`: Save As, rename, destination selection, and copy verification.
- `src/lams/authoring.ts`: Authoring-page inspection and node extraction.
- `src/lams/validation.ts`: later validation rules and reporting.
- `src/lams/diagnostics.ts`: non-mutating DOM and screenshot evidence.
- `skills/lams-tbl-authoring/`: canonical cross-agent skill and operational references.
- `.agents/skills/lams-tbl-authoring/`: Codex discovery adapter.
- `.claude/skills/lams-tbl-authoring/`: Claude Code discovery adapter.

Keep UI mechanics separate from workflow orchestration so later validation and Source-of-Truth parsing can reuse the same browser layer.

## Required verification

After code changes, run:

```bash
npm run build
npm test
```

For a live headed run, use:

```bash
npm run milestone1 -- --config configs/local.json
```

This command is a dry run and must not save a copy. The final Save action requires both exact configured targets and the explicit `--commit` flag:

```bash
npm run copy:lesson -- --config configs/local.json --commit
```

A live run is not considered successful merely because a click completed. Report which expected states were verified and where diagnostics were saved when it stops.
