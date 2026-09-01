import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { createLessonFromMostRecentDesign, openAddLesson } from './lams/lesson-index.js';
import { openMonitoring } from './lams/monitoring.js';
import { sendCodeToSheet } from './sheets/code-sink.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/example.json';
  const commit = process.argv.includes('--commit');
  const monitorOnly = process.argv.includes('--monitor-only');
  const publishCode = process.argv.includes('--publish-code');
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  if (config.baseUrl.includes('replace-with-your-lams-host.example')) {
    throw new Error(`Edit ${path.resolve(configPath)} and set the real LAMS baseUrl before running the index workflow.`);
  }

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await openLams(page, config);
    await verifyWorkspaceCourse(page, config);

    if (monitorOnly) {
      const monitoring = await openMonitoring(page, config.lessonTitle, config);
      console.log('\nMonitoring workflow: OK');
      console.log(`Lesson ID (the 5-digit code): ${monitoring.lessonId}`);
      await reportLessonCode(config.lessonTitle, monitoring.lessonId, publishCode);
      return;
    }

    await openAddLesson(page, config);
    const result = await createLessonFromMostRecentDesign(page, config, { commit });
    console.log(`\nIndex workflow: ${result.committed ? 'LESSON CREATED' : 'DRY RUN PASS'}`);
    console.log(`Design: ${result.designTitle}`);
    console.log(`Lesson title: ${result.lessonTitle}`);
    console.log(`Ends: ${result.endDateTime}`);
    console.log(`Course grouping: ${result.courseGrouping}`);
    if (!result.committed) {
      console.log('\nSkipping monitoring: no lesson was created in this dry run. Re-run with --commit.');
      return;
    }

    await openLams(page, config);
    const monitoring = await openMonitoring(page, result.lessonTitle, config);
    console.log('\nMonitoring workflow: OK');
    console.log(`Lesson ID (the 5-digit code): ${monitoring.lessonId}`);
    await reportLessonCode(result.lessonTitle, monitoring.lessonId, publishCode);
  } catch (error) {
    const directory = await saveDiagnostics(page, 'index-monitoring-failure').catch(() => undefined);
    if (directory) console.error(`Live failure diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * The 5-digit code the Kanban sheet wants is the lesson ID from the monitoring URL
 * (monitorLesson.do?lessonID=41192), which openMonitoring has already read and confirmed
 * against the URL the browser actually landed on. With --publish-code it goes to the sheet.
 */
async function reportLessonCode(identifier: string, code: string, publish: boolean): Promise<void> {
  if (!publish) {
    console.log('Pass --publish-code to send this code to the Kanban sheet.');
    return;
  }

  // The lesson exists by this point, so a sheet that is unreachable or rejects the
  // identifier is reported rather than allowed to fail the whole run.
  try {
    await sendCodeToSheet(code, identifier);
    console.log(`Sent code ${code} for "${identifier}" to the Kanban sheet.`);
  } catch (error) {
    console.error(`Kanban sheet not updated: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
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
