import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { collectLessonCodeCandidates } from './lams/lesson-code.js';
import { openMonitoring } from './lams/monitoring.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

/**
 * Opens monitoring for the configured lesson and dumps every 5-digit value on the page
 * with the text around it, so the learner-facing code can be told apart from the lesson
 * ID and pinned exactly. Read-only: it changes nothing in LAMS.
 */
async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await openLams(page, config);
    await verifyWorkspaceCourse(page, config);
    const monitoring = await openMonitoring(page, config.lessonTitle, config);

    const candidates = (await Promise.all(page.frames().map(collectLessonCodeCandidates))).flat();
    const directory = await saveDiagnostics(page, 'lesson-code-discovery');
    await writeFile(path.join(directory, 'code-candidates.json'), JSON.stringify(candidates, null, 2), 'utf8');

    console.log(`\nLesson ID (not the learner code): ${monitoring.lessonId}`);
    console.log(`5-digit candidates: ${candidates.length}`);
    for (const candidate of candidates.slice(0, 40)) {
      console.log(`  ${candidate.labelled ? 'LABELLED' : 'plain   '} ${candidate.code}  <- ${candidate.source}  "${candidate.context}"`);
    }
    console.log(`\nFull dump and page HTML: ${directory}`);
  } catch (error) {
    const directory = await saveDiagnostics(page, 'lesson-code-discovery-failure').catch(() => undefined);
    if (directory) console.error(`Live failure diagnostics: ${directory}`);
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
