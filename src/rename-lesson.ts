import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLessonFromLibrary, renameLesson } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const commit = process.argv.includes('--commit');
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  if (config.baseUrl.includes('replace-with-your-lams-host.example')) {
    throw new Error(`Edit ${path.resolve(configPath)} and set the real LAMS baseUrl before running the rename flow.`);
  }

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.sourceFolderPath, config.sourceLessonTitle, config, {
      absentTitle: config.lessonTitle
    });
    const result = await renameLesson(activePage, config, { commit });

    console.log(`\nExisting-lesson rename: ${result.committed ? 'RENAMED AND SAVED' : 'DRY RUN PASS'}`);
    console.log(`Source: ${result.sourceTitle}`);
    console.log(`New title: ${result.newTitle}`);
    console.log(`Folder: ${result.folderPath.join(' > ')}`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'lesson-rename-failure').catch(() => undefined);
    if (directory) console.error(`Rename diagnostics: ${directory}`);
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
