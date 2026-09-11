# LAMS Automation Repository Instructions

## Project purpose

Build and verify a reusable Playwright + TypeScript automation layer for the LAMS TBL authoring workflow, with a vendor-neutral Agent Skill that orchestrates the tested scripts. Structural/media extraction from Source-of-Truth DOCX files and reviewed iRAT/AE browser mutation are supported when reliable DOM evidence exists.

## LAMS safety boundary

- Find, open, and verify the course specified by `workspaceCourse` before opening the Author interface.
- Treat navigation and DOM inspection as read-only.
- When a lesson is in scope for a requested workflow, automatically fix any supported, verified issues found within that lesson; the user does not need to request the fixes separately. Resolve the source lesson and any requested new title from the request or verified context. If no destination is stated, save in the source lesson's current folder; do not ask the user to restate that folder. An explicitly requested destination takes precedence. Existing-lesson edits and renames stay in place by default.
- Automatically remove exact gate-bypass transitions and replace exact planned AE gates whose verified type/settings are wrong. Delete or rewire only elements that the reviewed plan proves must change; never infer that unrelated nodes are extra.
- Never publish or start a copied lesson as a learner-facing lesson unless explicitly requested.
- Stop before a consequential action if the target is ambiguous or the UI state cannot be verified.

## Current implementation scope

Work incrementally.

### First box: lesson copy workflow

1. Open the configured course.
2. Open the global LAMS **Author** interface.
3. Find the configured previous-academic-year TBL sequence in the Authoring library.
4. Open the exact sequence.
5. Use **Save As**.
6. Apply the configured new lesson title.
7. Save into the configured destination folder.
8. Verify the copied sequence exists at the expected destination.

Do not infer an exact source sequence from only a module or TBL number when multiple matches exist.

### Extended authoring scope

- Inspect and list Authoring nodes.
- Determine whether the Authoring surface uses HTML, SVG, canvas, iframes, or another representation.
- Validate required nodes, counts, connections, Team Setup associations, and gate names.
- Extract embedded DOCX images with question associations and import them through the observed CKEditor upload endpoint.
- Write reviewed AE MCQ/essay questions and canonical activity settings.
- Reconcile missing AE Assessment nodes, permission gates, Team Setup associations, and reviewed linear transitions; remove exact gate-bypass transitions and replace exact misconfigured planned AE gates when verified.
- Extend the vendor-neutral skill only with behavior already supported by the reusable automation.

## Browser automation rules

- Use Playwright with TypeScript.
- Keep the browser headed during development.
- Prefer `getByRole`, `getByLabel`, `getByText`, and stable data/test attributes.
- Use CSS only as an evidence-backed fallback.
- Do not guess LAMS-specific selectors. Inspect the real DOM first and record why a selector is stable.
- Avoid positional selectors such as `nth-child` unless no stable alternative exists and the limitation is documented.
- Shared navigation uses the first visible matching control in DOM order. Missing controls still stop the workflow. Content-specific lesson and graph checks remain in place.
- Verify the resulting page, dialog, folder, title, or other expected state after every action.
- Handle new tabs, popups, and iframes explicitly when observed.
- If the UI structure is unknown, stop without mutation and capture diagnostics: screenshot, HTML, frame URLs, accessible controls, and relevant data attributes.
- Do not bypass authentication, CAPTCHA, browser warnings, or permission prompts.

## Configuration and credentials

- Keep lesson-specific and cohort-specific values in the per-run `--request-json` input, not source code.
- Use `configs/local.json` only for stable local environment values and fallback defaults; it is ignored by Git and should not be rewritten for each request.
- Keep the reusable schema/example in `configs/example.json` free of real credentials.
- Never store LAMS passwords, session cookies, tokens, OTPs, or browser profile contents in the repository.
- The local persistent browser profile belongs under `.playwright/`, which must remain ignored by Git.

## First-time computer setup

- If Node.js 22 or newer and npm are already available, run `npm run setup` from the repository root.
- If Node.js/npm are missing or too old, run `bash "./Setup Mac.command"` on macOS or `Setup Windows.cmd` on Windows. These launchers install a pinned, checksummed Node.js 24 runtime inside the ignored `.tools/` directory, then install dependencies and Playwright Chromium and run the local doctor checks. They do not require a system-wide Node installation.
- If Playwright's bundled Chromium is unsupported on the OS version (for example macOS 13), setup probes an installed Chrome, then Edge, and records the working one as `browser.channel` in `configs/local.json`. All entry points read launch options through `browserLaunchOptions` in `src/config.ts`, so add new browser launches through that helper rather than inlining `chromium.launchPersistentContext` options.
- First-time setup installs and verifies the local runtime, then opens the configured LAMS URL in the headed persistent automation browser so the user can sign in. Never request or handle credentials. Verify sign-in only from the authenticated course-menu control, report runtime and login checks separately, and do not open or change any lesson during setup.
- Do not bypass operating-system or organisation security controls. If downloads, PowerShell, or project-local executables are prohibited, report that IT must provide an approved Node.js 24 installation.

## Code organization

- `src/main.ts`: workflow entry point and orchestration.
- `src/config.ts`: configuration types, loading, and validation.
- `src/lams/navigation.ts`: LAMS and Authoring-library navigation.
- `src/lams/lesson-copy.ts`: Save As, rename, destination selection, and copy verification.
- `src/lams/authoring.ts`: Authoring-page inspection and node extraction.
- `src/lams/validation.ts`: later validation rules and reporting.
- `src/lams/ae-editor.ts`: AE Assessment question/settings mutation.
- `src/lams/ae-graph.ts`: verified AE node/gate/transition reconciliation and targeted graph repair.
- `src/docx/`: DOCX archive, embedded-media, and question-assignment handling.
- `src/lams/diagnostics.ts`: non-mutating DOM and screenshot evidence.
- `skills/lams-tbl-authoring/`: overall workflow skill and shared operational references.
- `skills/lams-*/`: focused lesson-management, iRAT-editing, gate-settings, AE-preparation, and authoring-validation skills.
- `.agents/skills/lams-*/`: Codex discovery adapters for every canonical skill.
- `.claude/skills/lams-*/`: Claude Code discovery adapters for every canonical skill.

Keep UI mechanics separate from workflow orchestration so later validation and Source-of-Truth parsing can reuse the same browser layer.

## Required verification

After code changes, run:

```bash
npm run build
npm test
```

For a live headed run, use:

```bash
npm run milestone1 -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

This command is a dry run and must not save a copy. Write commands save by default for the requested operation; `--commit` remains accepted for compatibility. Use `--dry-run` to preview copy, rename, gate-fix, or iRAT work:

```bash
npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

A live run is not considered successful merely because a click completed. Report which expected states were verified and where diagnostics were saved when it stops.

Local input files may be supplied by filename or partial filename. Resolve DOCX and JSON inputs through `src/input-file.ts`; ask the user to choose a listed candidate when multiple files match. Do not require a full path when a name resolves uniquely.
