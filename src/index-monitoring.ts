import { launchLamsBrowser } from '../scripts/setup/browser-profile.mjs';
import path from 'node:path';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { loadEnvFile } from './load-env.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openMonitoring } from './lams/monitoring.js';
import { publishLesson, reportLessonCode } from './lams/publish.js';
import { openCoursePage } from './lams/navigation.js';

loadEnvFile();

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const commit = process.argv.includes('--commit');
  const monitorOnly = process.argv.includes('--monitor-only');
  // Recording the code in the Kanban sheet is the last step of the publishing stage, so it
  // runs by default once the sheet is configured. --no-publish-code skips it; the older
  // --publish-code is still accepted and additionally demands that the sheet be configured.
  const codeOptions = {
    forceCode: process.argv.includes('--publish-code'),
    publishCode: !process.argv.includes('--no-publish-code')
  };
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  if (config.baseUrl.includes('replace-with-your-lams-host.example')) {
    throw new Error(`Edit ${path.resolve(configPath)} and set the real LAMS baseUrl before running the index workflow.`);
  }

  const context = await launchLamsBrowser(config.browser.userDataDir, browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    if (monitorOnly) {
      await openCoursePage(page, config);
      const monitoring = await openMonitoring(page, config.lessonTitle, config);
      console.log('\nMonitoring workflow: OK');
      console.log(`Lesson ID (the 5-digit code): ${monitoring.lessonId}`);
      await reportLessonCode(config.lessonTitle, monitoring.lessonId, codeOptions, config);
      return;
    }

    // --expect-design carries the title the authoring run saved. "Recently used designs" is
    // ordered by LAMS rather than by that run, so without this the wrong design could be
    // published if anything else was authored in between.
    const expectDesign = readArgument('--expect-design');
    await publishLesson(page, config, {
      commit,
      ...codeOptions,
      ...(expectDesign !== undefined ? { expectedDesignTitle: expectDesign } : {})
    });
  } catch (error) {
    const directory = await saveDiagnostics(page, 'index-monitoring-failure').catch(() => undefined);
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
