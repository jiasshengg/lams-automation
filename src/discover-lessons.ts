import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

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
    const courses = dialog.getByRole('treeitem').filter({ hasText: /^\s*Courses\s*/ });
    if ((await courses.count()) !== 1) throw new Error(`Expected one Courses folder; found ${await courses.count()}.`);
    await courses.click();
    await activePage.waitForTimeout(750);
    const playground = dialog.getByRole('treeitem').filter({ hasText: /^\s*DL Playground 2026\/2027 \[internal\]\s*/ });
    if ((await playground.count()) !== 1) throw new Error(`Expected one approved playground folder; found ${await playground.count()}.`);
    await playground.click();
    await activePage.waitForTimeout(750);
    for (let expansion = 0; expansion < 100; expansion += 1) {
      const items = dialog.getByRole('treeitem');
      const metadata = await items.evaluateAll((elements) =>
        elements.map((element) => ({
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
          level: element.querySelectorAll(':scope > .indent').length,
          expanded: element.getAttribute('aria-expanded'),
          folder: element.classList.contains('tree-parent')
        }))
      );
      const playgroundIndex = metadata.findIndex((item) => item.text === config.workspaceCourse);
      if (playgroundIndex < 0) throw new Error('Approved playground disappeared during discovery.');
      const playgroundLevel = metadata[playgroundIndex]!.level;
      let expandableIndex = -1;
      for (let index = playgroundIndex + 1; index < metadata.length; index += 1) {
        const item = metadata[index]!;
        if (item.level <= playgroundLevel) break;
        if (item.folder && item.expanded === 'false') {
          expandableIndex = index;
          break;
        }
      }
      if (expandableIndex < 0) break;
      await items.nth(expandableIndex).click();
      await activePage.waitForTimeout(250);
    }
    const treeItems = await dialog.getByRole('treeitem').evaluateAll((elements) =>
      elements.map((element) => ({
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        expanded: element.getAttribute('aria-expanded'),
        level: element.querySelectorAll(':scope > .indent').length,
        id: element.id || null,
        className: element.getAttribute('class')
      }))
    );
    const directory = await saveDiagnostics(activePage, 'lesson-library-discovery');
    console.log('\nRead-only Authoring library discovery');
    console.log(`Visible tree items: ${treeItems.length}`);
    treeItems.forEach((item) => console.log(JSON.stringify(item)));
    console.log(`Diagnostics: ${directory}`);
    console.log('No lesson was opened or changed.');
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
