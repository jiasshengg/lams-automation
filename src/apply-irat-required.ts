import { launchLamsBrowser } from '../scripts/setup/browser-profile.mjs';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { resolveIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

/**
 * Sets "answer required" for every question in an existing iRAT activity and saves, without
 * rewriting any question. The full apply re-versions all 25 questions, which is a long run
 * to repeat when only this flag is wrong — and each question save rebuilds the reference
 * list, which is what loses the flag in the first place. Question content, answers, marks,
 * gate, grouping, and advanced settings are left exactly as they are.
 */
async function main(): Promise<void> {
  const commit = !process.argv.includes('--dry-run');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const irat = await resolveIratRequest(config);

  const context = await launchLamsBrowser(config.browser.userDataDir, browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);

    // inspect() is deliberately skipped: it leaves an activity properties dialog open,
    // which then intercepts the double-click that opens the iRAT activity.
    const editor = new LamsIratEditor(activePage, irat, config.browser.actionTimeoutMs);
    const changed = await editor.applyAnswerRequired(irat.questions, { commit });
    if (!commit) {
      console.log(`\nWould change (${changed.length}): ${changed.join(', ') || 'none'}`);
      console.log('Read-only preview: no flags were toggled or saved.');
      return;
    }
    await editor.save();
    console.log('\nAnswer required: APPLIED');
    console.log(`Lesson: ${config.lessonTitle}`);
    console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
    console.log(`Changed (${changed.length}): ${changed.join(', ') || 'none'}`);
    console.log(`Save prompts confirmed (${editor.confirmedDialogs.length}): ${editor.confirmedDialogs.join(' | ') || 'none raised'}`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'apply-irat-required-failure').catch(() => undefined);
    if (directory) console.error(`Diagnostics: ${directory}`);
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
