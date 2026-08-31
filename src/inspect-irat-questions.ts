import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';
import { MAX_MARK_INPUT, QUESTION_EDITOR_IFRAME, QUESTION_TITLE, QUESTION_TYPE_BADGE, REQUIRED_TOGGLE } from './lams/irat-editor.js';

/**
 * Read-only listing of one exact iRAT activity's existing question rows.
 *
 * The iRAT editor matches questions by exact title and requires the observed count to
 * equal the request, so the exact existing titles must be known before a committed run.
 * This opens the activity dialog, reads #referencesTable, and cancels without saving.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--commit')) throw new Error('inspect:irat-questions is read-only and does not accept --commit.');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const source = process.argv.includes('--source');
  const folderPath = source ? config.sourceFolderPath : config.destinationFolderPath;
  const lessonTitle = source ? config.sourceLessonTitle : config.lessonTitle;
  const activityName = readArgument('--node') ?? 'iRAT';

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
    await openLessonFromLibrary(activePage, folderPath, lessonTitle, config);

    const graph = await inspectAuthoringGraph(activePage);
    console.log(`\nLesson: ${lessonTitle}`);
    console.log(`Folder: ${folderPath.join(' > ')}`);
    console.log(`Graph: ${graph.nodes.map((node) => `${node.name} [${node.type}]`).join(' -> ')}`);

    const matches = graph.nodes.filter((node) => node.name === activityName && node.type === 'tool');
    if (matches.length !== 1) throw new Error(`Expected one tool node named "${activityName}"; found ${matches.length}.`);
    const activity = matches[0]!;

    await activePage.locator(`#canvas > svg > g.svg-activity[uiid="${activity.uiid}"]`).dblclick({ delay: 80 });
    const iframe = activePage.locator('iframe[id^="dialogActivity"]:visible');
    await iframe.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    const frame = await (await iframe.elementHandle())?.contentFrame();
    if (!frame) throw new Error(`The authoring iframe for "${activityName}" was not available.`);
    await frame.locator('#authoringForm').waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

    const rows = frame.locator('#referencesTable tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    const count = await rows.count();
    console.log(`\nExisting questions in "${activityName}": ${count}`);
    const titles: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const title = (await row.locator(QUESTION_TITLE).innerText()).replace(/\s+/g, ' ').trim();
      const type = (await row.locator(QUESTION_TYPE_BADGE).innerText()).replace(/\s+/g, ' ').trim();
      const mandatory = await row.locator(REQUIRED_TOGGLE).evaluate((element) => element.classList.contains('text-danger'));
      const mark = await row.locator(MAX_MARK_INPUT).inputValue();
      titles.push(title);
      console.log(`${index + 1}. ${JSON.stringify(title)} — ${type} — mark ${mark}${mandatory ? ' — mandatory' : ''}`);
    }

    const dumpTitle = readArgument('--dump-question');
    if (dumpTitle) {
      const targets = titles.map((title, index) => ({ title, index })).filter((entry) => entry.title === dumpTitle);
      if (targets.length !== 1) throw new Error(`Expected one question named "${dumpTitle}"; found ${targets.length}.`);
      await rows.nth(targets[0]!.index).locator('.edit-reference-link').click();
      const editor = frame.locator(QUESTION_EDITOR_IFRAME);
      await editor.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
      const questionFrame = await (await editor.elementHandle())?.contentFrame();
      if (!questionFrame) throw new Error('The question editor iframe was visible but unavailable.');
      await questionFrame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

      const optionCount = await questionFrame.locator('.single-option-table').count();
      console.log(`
Question editor for "${dumpTitle}": ${optionCount} options, default grade ${await questionFrame.locator('#maxMark').inputValue()}`);
      console.log(`Save visible: ${await questionFrame.locator('#saveButton').isVisible()}; "Save as new version" visible: ${await questionFrame.locator('#saveAsButton').isVisible()}`);

      // Nothing is submitted here. The title is typed and reverted purely to learn which
      // save control LAMS exposes for a dirty question: an in-place question-bank save
      // would rewrite the shared question that the source sample lesson still uses.
      const titleField = questionFrame.locator('#title');
      const original = await titleField.inputValue();
      await titleField.fill(`${original} `);
      await titleField.blur();
      await activePage.waitForTimeout(1000);
      console.log(`After an edit — Save visible: ${await questionFrame.locator('#saveButton').isVisible()}; "Save as new version" visible: ${await questionFrame.locator('#saveAsButton').isVisible()}`);
      await titleField.fill(original);

      const directory = await saveDiagnostics(activePage, 'irat-question-editor-readonly');
      console.log(`Question editor DOM captured for "${dumpTitle}": ${directory}`);
    }

    console.log('\nRead-only inspection complete; nothing was saved.');
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'irat-question-inspection-failure').catch(() => undefined);
    if (directory) console.error(`Inspection diagnostics: ${directory}`);
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
