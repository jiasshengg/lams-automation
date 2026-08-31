import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { inspectPageSurface, saveDiagnostics } from './lams/diagnostics.js';
import { createLessonFromMostRecentDesign } from './lams/lesson-index.js';
import { openMonitoring } from './lams/monitoring.js';
import { clickConfigured, openLams, SelectorRequiredError, verifyWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/example.json';
  const commit = process.argv.includes('--commit');
  const monitorOnly = process.argv.includes('--monitor-only');
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

    if (!monitorOnly) {
      await clickConfigured(page, config, 'openAddLesson', config.selectors.openAddLesson, false);
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
    }

    const monitoring = await openMonitoring(page, config);
    console.log(`\nMonitoring workflow: OK`);
    console.log(`Lesson ID (5 digits): ${monitoring.lessonId}`);
  } catch (error) {
    if (error instanceof SelectorRequiredError) {
      console.error(`\nIndex workflow paused: ${error.message}`);
      console.error('Inspect page.png, page.html, and dom-summary.json, then add the selector to your config.');
      console.error(JSON.stringify(await inspectPageSurface(page), null, 2));
      process.exitCode = 2;
    } else {
      const directory = await saveDiagnostics(page, 'index-monitoring-failure').catch(() => undefined);
      if (directory) console.error(`Live failure diagnostics: ${directory}`);
      throw error;
    }
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
