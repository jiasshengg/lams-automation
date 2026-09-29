import { launchLamsBrowser } from '../scripts/setup/browser-profile.mjs';
import { browserLaunchOptions, loadConfig } from './config.js';
import { openAuthoringLibrary } from './lams/authoring.js';
import { discoverLessons } from './lams/lesson-discovery.js';
import { saveDiagnostics } from './lams/diagnostics.js';

/** Read-only full-title lookup across the supplied library roots. */
async function main(): Promise<void> {
  if (process.argv.includes('--commit')) throw new Error('find:lesson is read-only and does not accept --commit.');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const title = readArgument('--title');
  if (!title) throw new Error('find:lesson requires an exact --title.');
  const roots = (readArgument('--roots') ?? '').split('|').map((part) => part.trim()).filter(Boolean);
  if (roots.length === 0) throw new Error('find:lesson requires --roots as a "|"-separated list of top-level folder names.');

  const config = await loadConfig(configPath);
  const context = await launchLamsBrowser(config.browser.userDataDir, browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    activePage = await openAuthoringLibrary(page, config);
    const candidates = await discoverLessons(activePage, {
      roots, exactTitle: title, timeoutMs: config.browser.actionTimeoutMs,
      onProgress: message => console.log(message)
    });
    if (candidates.length === 0) throw new Error(`Lesson "${title}" was not found under: ${roots.join(', ')}`);
    if (candidates.length > 1) {
      throw new Error(`Ambiguous lesson "${title}":\n${candidates.map(candidate =>
        [...candidate.sourceFolderPath, candidate.sourceLessonTitle].join(' > ')).join('\n')}`);
    }
    const candidate = candidates[0]!;
    console.log(`Found "${candidate.sourceLessonTitle}" at: ${candidate.sourceFolderPath.join(' > ')}`);
    console.log('Nothing was opened or changed.');
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'find-lesson-failure').catch(() => undefined);
    if (directory) console.error(`find:lesson diagnostics: ${directory}`);
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
