import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, requireIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { copyLesson, openSourceLesson } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  if (!process.argv.includes('--commit')) {
    throw new Error('The continuous copy → iRAT workflow requires --commit and exact per-run source, title, destination, and irat data.');
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
    await openSourceLesson(activePage, config);
    const copy = await copyLesson(activePage, config, { commit: true });
    const editor = new LamsIratEditor(activePage, irat, config.browser.actionTimeoutMs);
    const result = await executeIratAutomation(editor, irat, { commit: true });
    console.log('\nContinuous TBL workflow: COMPLETE');
    console.log(`Copied: ${copy.sourceTitle} → ${copy.newTitle}`);
    console.log(`Destination: ${copy.destinationFolderPath.join(' > ')}`);
    console.log(`iRAT questions updated: ${result.updatedQuestions.join(', ')}`);
    console.log('Verified: playground, copy destination, iRAT graph readiness, Print View, and post-save gate state.');
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'continuous-tbl-irat-failure').catch(() => undefined);
    if (directory) console.error(`Workflow diagnostics: ${directory}`);
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
