import path from 'node:path';
import { chromium } from '@playwright/test';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { loadEnvFile } from './load-env.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { createLessonFromMostRecentDesign, openAddLesson } from './lams/lesson-index.js';
import { openMonitoring } from './lams/monitoring.js';
import { sendCodeToSheet } from './sheets/code-sink.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

loadEnvFile();

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/example.json';
  const commit = process.argv.includes('--commit');
  const monitorOnly = process.argv.includes('--monitor-only');
  // Recording the code in the Kanban sheet is the last step of the publishing stage, so it
  // runs by default once the sheet is configured. --no-publish-code skips it; the older
  // --publish-code is still accepted and additionally demands that the sheet be configured.
  const forceCode = process.argv.includes('--publish-code');
  const publishCode = !process.argv.includes('--no-publish-code');
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  if (config.baseUrl.includes('replace-with-your-lams-host.example')) {
    throw new Error(`Edit ${path.resolve(configPath)} and set the real LAMS baseUrl before running the index workflow.`);
  }

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);

    if (monitorOnly) {
      const monitoring = await openMonitoring(page, config.lessonTitle, config);
      console.log('\nMonitoring workflow: OK');
      console.log(`Lesson ID (the 5-digit code): ${monitoring.lessonId}`);
      await reportLessonCode(config.lessonTitle, monitoring.lessonId, publishCode, forceCode);
      return;
    }

    await openAddLesson(page, config);
    // The skill runs this stage straight after AE, so --expect-design carries the title the
    // authoring run saved. "Recently used designs" is ordered by LAMS rather than by that
    // run, so without this the wrong design could be published if anything else was
    // authored in between.
    const expectDesign = readArgument('--expect-design');
    const result = await createLessonFromMostRecentDesign(page, config, {
      commit,
      ...(expectDesign !== undefined ? { expectedDesignTitle: expectDesign } : {})
    });
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
    await reportLessonCode(result.lessonTitle, monitoring.lessonId, publishCode, forceCode);
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
 * against the URL the browser actually landed on.
 *
 * Recording it completes the publishing stage, so it is sent by default. A machine with no
 * sheet credentials simply reports the code for manual entry rather than failing a run whose
 * LAMS-side work already succeeded, unless --publish-code asked for the send explicitly.
 */
async function reportLessonCode(identifier: string, code: string, publish: boolean, force: boolean): Promise<void> {
  if (!publish) {
    console.log('Kanban sheet not updated: --no-publish-code was passed. Record this code manually.');
    return;
  }
  if (!force && !sheetConfigured()) {
    console.log('Kanban sheet not configured (LAMS_SHEET_WEBHOOK_URL / LAMS_SHEET_SECRET); record this code manually.');
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

function sheetConfigured(): boolean {
  return Boolean(process.env.LAMS_SHEET_WEBHOOK_URL && process.env.LAMS_SHEET_SECRET);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
