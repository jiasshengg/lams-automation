import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

interface TreeItem {
  text: string;
  level: number;
  expanded: string | null;
  folder: boolean;
}

/**
 * Read-only locator for an exact lesson title in the Authoring library. It expands
 * one candidate top-level folder at a time and stops as soon as the exact title is
 * visible, so it never walks the whole tree. It opens nothing and changes nothing.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--commit')) throw new Error('find:lesson is read-only and does not accept --commit.');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const title = readArgument('--title');
  if (!title) throw new Error('find:lesson requires an exact --title.');
  const roots = (readArgument('--roots') ?? '').split('|').map((part) => part.trim()).filter(Boolean);
  if (roots.length === 0) throw new Error('find:lesson requires --roots as a "|"-separated list of top-level folder names.');

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

    await clickExactItem(dialog, activePage, 'Courses');
    for (const root of roots) {
      console.log(`\nExpanding candidate root: ${root}`);
      await clickExactItem(dialog, activePage, root);
      const found = await expandUntilFound(dialog, activePage, root, title);
      if (found) {
        console.log(`\nFound "${title}" at: Courses > ${found.join(' > ')}`);
        console.log('Nothing was opened or changed.');
        return;
      }
      console.log(`Not present under "${root}".`);
      await clickExactItem(dialog, activePage, root); // collapse before trying the next root
    }
    throw new Error(`Exact lesson "${title}" was not found under: ${roots.join(', ')}`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'find-lesson-failure').catch(() => undefined);
    if (directory) console.error(`find:lesson diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

/** Expands every folder beneath `root` breadth-first, checking for the exact title after each step. */
async function expandUntilFound(
  dialog: ReturnType<import('@playwright/test').Page['getByRole']>,
  page: import('@playwright/test').Page,
  root: string,
  title: string
): Promise<string[] | undefined> {
  for (let step = 0; step < 400; step += 1) {
    const items = await readTree(dialog);
    const rootIndex = items.findIndex((item) => item.text === root);
    if (rootIndex < 0) throw new Error(`Candidate root "${root}" disappeared during discovery.`);
    const rootLevel = items[rootIndex]!.level;

    const matchIndex = items.findIndex((item, index) => index > rootIndex && item.text === title && !item.folder);
    if (matchIndex >= 0) return pathTo(items, rootIndex, matchIndex);

    let expandableIndex = -1;
    for (let index = rootIndex + 1; index < items.length; index += 1) {
      if (items[index]!.level <= rootLevel) break;
      if (items[index]!.folder && items[index]!.expanded === 'false') {
        expandableIndex = index;
        break;
      }
    }
    if (expandableIndex < 0) return undefined;
    await dialog.getByRole('treeitem').nth(expandableIndex).click();
    await page.waitForTimeout(250);
  }
  throw new Error(`Expansion budget exhausted under "${root}" without locating "${title}".`);
}

/** Rebuilds the folder chain from the candidate root down to the matched lesson. */
function pathTo(items: TreeItem[], rootIndex: number, matchIndex: number): string[] {
  const chain: string[] = [items[matchIndex]!.text];
  let level = items[matchIndex]!.level;
  for (let index = matchIndex - 1; index >= rootIndex; index -= 1) {
    if (items[index]!.level < level) {
      chain.unshift(items[index]!.text);
      level = items[index]!.level;
    }
  }
  return chain;
}

async function readTree(dialog: ReturnType<import('@playwright/test').Page['getByRole']>): Promise<TreeItem[]> {
  return dialog.getByRole('treeitem').evaluateAll((elements) =>
    elements.map((element) => ({
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      level: element.querySelectorAll(':scope > .indent').length,
      expanded: element.getAttribute('aria-expanded'),
      folder: element.classList.contains('tree-parent')
    }))
  );
}

async function clickExactItem(
  dialog: ReturnType<import('@playwright/test').Page['getByRole']>,
  page: import('@playwright/test').Page,
  text: string
): Promise<void> {
  const items = await readTree(dialog);
  const matches = items.map((item, index) => ({ item, index })).filter((entry) => entry.item.text === text);
  if (matches.length !== 1) throw new Error(`Expected one tree item named "${text}"; found ${matches.length}.`);
  await dialog.getByRole('treeitem').nth(matches[0]!.index).click();
  await page.waitForTimeout(600);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
