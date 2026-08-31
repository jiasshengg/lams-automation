import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, requireIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

/**
 * Applies the structured iRAT request to a lesson that already exists in the approved
 * playground. The continuous workflow copies and then configures in one pass; this entry
 * point covers the case where the copy is already saved, so re-copying would be rejected.
 * It never copies, renames, publishes, starts, or restructures a lesson.
 */
async function main(): Promise<void> {
  if (!process.argv.includes('--commit')) {
    throw new Error('apply:irat requires --commit and an exact per-run lesson, destination, and irat data.');
  }
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const irat = requireIratRequest(config);

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    await openLams(page, config);
    await verifyWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);

    const editor = new LamsIratEditor(activePage, irat, config.browser.actionTimeoutMs);
    const result = await executeIratAutomation(editor, irat, { commit: true });

    console.log('\niRAT application: COMPLETE');
    console.log(`Lesson: ${config.lessonTitle}`);
    console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
    console.log(`Questions updated (${result.updatedQuestions.length}): ${result.updatedQuestions.join(', ')}`);
    console.log('Verified: playground, exact lesson, iRAT graph readiness, Print View, and post-save gate state.');
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'apply-irat-failure').catch(() => undefined);
    if (directory) console.error(`iRAT diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
