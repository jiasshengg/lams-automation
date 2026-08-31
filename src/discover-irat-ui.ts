import path from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { loadConfig } from './config.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { traverseFolderPath } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse, waitForUniqueVisible } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath);
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
    await activePage.locator('#openButton').click();
    const dialog = activePage.getByRole('dialog', { name: 'Open design', exact: true });
    await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    await traverseFolderPath(dialog, ['Courses', config.workspaceCourse], activePage, config);

    const candidates = await directLessonCandidates(dialog, config.workspaceCourse);
    const tblCandidates = candidates.filter((candidate) => /\bTBL/i.test(candidate));
    if (tblCandidates.length !== 1) {
      const directory = await saveDiagnostics(activePage, 'irat-representative-ambiguous');
      throw new Error(`Expected one TBL representative in the playground; found ${tblCandidates.length}: ${tblCandidates.join(', ') || 'none'}. Diagnostics: ${directory}`);
    }
    const lessonTitle = tblCandidates[0]!;
    const lesson = dialog.getByRole('treeitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(lessonTitle)}\\s*$`) });
    await waitForUniqueVisible(lesson, activePage, config, `representative lesson: ${lessonTitle}`, false);
    await lesson.click();
    const openButton = dialog.locator('#ldStoreDialogOpenButton');
    if (!(await openButton.isEnabled())) throw new Error(`Open remained disabled for "${lessonTitle}".`);
    await openButton.click();
    await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
    await activePage.getByText(lessonTitle, { exact: true }).filter({ visible: true }).first().waitFor({
      state: 'visible',
      timeout: config.browser.actionTimeoutMs
    });

    const graph = await inspectAuthoringGraph(activePage);
    console.log(`Representative lesson: ${lessonTitle}`);
    console.log(`Graph nodes: ${graph.nodes.map((node) => node.name).join(' -> ')}`);
    const gateDirectory = await inspectNodeControls(activePage, graph, 'iRAT Gate', 'irat-gate-controls', config.browser.actionTimeoutMs);
    const activityDirectory = await inspectNodeControls(activePage, graph, 'iRAT', 'irat-activity-controls', config.browser.actionTimeoutMs);
    console.log(`iRAT Gate diagnostics: ${gateDirectory}`);
    console.log(`iRAT activity diagnostics: ${activityDirectory}`);
    console.log('Read-only discovery complete; no Save action was used.');
  } finally {
    await context.close();
  }
}

async function directLessonCandidates(dialog: Locator, parentName: string): Promise<string[]> {
  const items = await dialog.getByRole('treeitem').evaluateAll((elements) =>
    elements.map((element) => ({
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      level: element.querySelectorAll(':scope > .indent').length,
      folder: element.classList.contains('tree-parent')
    }))
  );
  const parentIndex = items.findIndex((item) => item.text === parentName);
  if (parentIndex < 0) return [];
  const parentLevel = items[parentIndex]!.level;
  const candidates: string[] = [];
  for (let index = parentIndex + 1; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.level <= parentLevel) break;
    if (item.level === parentLevel + 1 && !item.folder) candidates.push(item.text);
  }
  return candidates;
}

async function inspectNodeControls(
  page: Page,
  graph: Awaited<ReturnType<typeof inspectAuthoringGraph>>,
  nodeName: string,
  label: string,
  timeoutMs: number
): Promise<string> {
  const matches = graph.nodes.filter((node) => node.name === nodeName);
  if (matches.length !== 1) {
    const directory = await saveDiagnostics(page, `${label}-node-not-unique`);
    throw new Error(`Expected one ${nodeName} runtime node; found ${matches.length}. Diagnostics: ${directory}`);
  }
  const node = page.locator(`#canvas > svg > g.svg-activity[uiid="${matches[0]!.uiid}"]`);
  if ((await node.count()) !== 1) throw new Error(`Runtime UIID ${matches[0]!.uiid} did not resolve to one SVG activity.`);
  await node.click();
  await page.waitForTimeout(Math.min(timeoutMs, 1_000));
  return saveDiagnostics(page, label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
