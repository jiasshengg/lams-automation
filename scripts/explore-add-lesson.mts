/**
 * Walks the Add Lesson wizard on the live site and snapshots each step so the index
 * selectors can be written against the real DOM.
 *
 * Deliberately stops before "Add now": it fills and inspects, but never creates a lesson.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { writeSnapshot } from './snapshot.mts';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/index.do';
const OUT_DIR = path.resolve('artifacts', 'explore');

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(path.resolve('.playwright/lams-profile'), {
    headless: false,
    viewport: null
  });
  context.setDefaultTimeout(20_000);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await writeSnapshot(page, OUT_DIR, '01-course-page');

    const addLesson = page.getByRole('button', { name: 'Add Lesson', exact: true }).first();
    await addLesson.waitFor({ state: 'visible' });
    await addLesson.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(2_000);
    await writeSnapshot(page, OUT_DIR, '02-add-lesson-lesson-tab');

    // Tabs may be links or buttons depending on the LAMS build; try both.
    for (const tabName of ['Class', 'Advanced', 'Conditions']) {
      const tab = page.getByRole('tab', { name: tabName, exact: true }).first();
      const fallback = page.getByRole('link', { name: tabName, exact: true }).first();
      const target = (await tab.count()) > 0 ? tab : fallback;
      if ((await target.count()) === 0) {
        console.log(`tab "${tabName}" not found by role`);
        continue;
      }
      await target.click().catch(() => undefined);
      await page.waitForTimeout(1_200);
      await writeSnapshot(page, OUT_DIR, `03-tab-${tabName.toLowerCase()}`);
      console.log(`captured tab: ${tabName}`);
    }

    console.log(`Snapshots written to ${OUT_DIR}. Leaving the browser open for inspection.`);
    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
