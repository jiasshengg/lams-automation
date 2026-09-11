---
name: lams-lesson-management
description: Locate, copy with Save As, or rename a LAMS authoring lesson, including supported final destination-folder creation or rename during copying. Use for lesson-level changes without rerunning iRAT or AE work. Do not use for question edits, node repairs, or publishing.
---

# Lesson management

Read [shared operating rules](../lams-tbl-authoring/references/shared.md) and the copy/rename fields in [configuration](../lams-tbl-authoring/references/configuration.md).

Resolve the source lesson and folder, requested new title, and copy destination from the user's request and available evidence. An existing-lesson rename uses `sourceFolderPath`, `sourceLessonTitle`, and `lessonTitle` and stays in the same folder. Local filename lookup is separate from LAMS library folder resolution.

If the exact lesson title or folder is unknown, use read-only discovery. Users may supply course, module, TBL number, and academic year rather than exact internal fields:

```bash
npm run discover:lessons -- --config configs/local.json --request-json '{"workspaceCourse":"<COURSE_QUERY>"}' --query 'FOM TBL06 2025'
```

This selects an exact course match when available, otherwise requires one unique case-insensitive partial match. It opens the global Authoring library and searches all accessible folders under `Courses`; it is not limited to that course's folder. Every whitespace-separated lesson-query term must occur somewhere in the combined title and folder path, case-insensitively. Do not invent a calendar year for an ambiguous “last year”; resolve it from context or ask. Omit `--query` to list all lessons. Optional `--roots '<ROOT_A>|<ROOT_B>'` limits traversal to exact direct child folders under `Courses`; these folder names need not equal the course name. `--max-expansions` defaults to 1000; hitting the limit fails rather than presenting partial results as complete.

The output lists every matching candidate with `sourceLessonTitle` and `sourceFolderPath`. Resolve the intended candidate from the request and evidence; ask the user to choose when several plausible matches remain. Pass the resolved fields to the write command. Never choose the first match automatically or claim that discovery itself copies a lesson.

The older exact-title locator remains available when the title and candidate roots are already known:

```bash
npm run find:lesson -- --config configs/local.json --title '<EXACT_TITLE>' --roots '<ROOT_A>|<ROOT_B>'
```

Unlike `discover:lessons`, `find:lesson` uses only the course in local configuration and returns the first exact title found. It does not prove uniqueness across the library.

```bash
npm run copy:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
npm run rename:lesson -- --config configs/local.json --request-json '<REQUEST_JSON>'
```

Choose one command for the requested operation. Both save by default; append `--dry-run` for a requested preview. `milestone1` is a copy preview alias. No mandatory preview or additional approval turn is needed for an already requested operation.

Copying may create only the explicitly requested final destination folder with `createDestinationFolder: true`, or rename that final folder using `renameDestinationFolderFrom`; never combine those flags. `openSourceAsCopy: true` uses the observed Open a copy control for a read-only source. These are copy options, not standalone folder management commands.

Report the source, new title, destination, and verified existence after reopening. For a rename, also verify the old title is absent. Preserve the existing duplicate-title and placeholder checks. Never publish, start, or restructure a lesson as part of this skill. See [copy and rename outcomes](../lams-tbl-authoring/references/operations.md) for failure handling.

When a copy destination is omitted, save in the resolved source lesson folder without asking for destination confirmation. Copy commands derive `destinationFolderPath` and its display label from `sourceFolderPath`, overriding stale destination defaults in local configuration. An explicit per-run `destinationFolderPath` wins. Folder creation/rename still requires its requested target path. Existing-lesson edits and renames save in place; their destination fields identify the existing lesson rather than move it.
