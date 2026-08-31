/**
 * Confirms the monitoring URL that openMonitorLesson(id) resolves to, by hovering the
 * lesson row (the action buttons only render on hover) and clicking Monitor.
 *
 * Read-only: monitoring is a view, and nothing is edited or submitted.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/index.do';

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(path.resolve('.playwright/lams-profile'), {
    headless: false,
    viewport: null
  });
  context.setDefaultTimeout(30_000);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Read what openMonitorLesson actually does, so the URL can be built without clicking.
    const source = await page.evaluate(
      `typeof openMonitorLesson === 'function' ? openMonitorLesson.toString() : 'NOT A FUNCTION'`
    );
    console.log('--- openMonitorLesson SOURCE ---');
    console.log(source);

    const link = page.locator('a[aria-label="Monitor"]').first();
    const row = link.locator('xpath=ancestor::tr[1]');
    await row.hover().catch(() => undefined);
    await page.waitForTimeout(1_000);

    const popupPromise = page.waitForEvent('popup', { timeout: 25_000 }).catch(() => undefined);
    await link.click({ force: true });
    const monitoringPage = (await popupPromise) ?? page;
    await monitoringPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await monitoringPage.waitForTimeout(5_000);

    console.log('--- MONITORING PAGE ---');
    console.log(`popup: ${monitoringPage !== page}`);
    console.log(`url: ${monitoringPage.url()}`);
    console.log(`title: ${await monitoringPage.title()}`);

    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
