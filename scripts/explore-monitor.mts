/**
 * Discovery pass for the monitoring step: reads the lesson id straight out of each
 * Monitor link, then opens one to confirm the resulting monitoring URL.
 *
 * Read-only: monitoring is a view, and nothing is edited or submitted.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { writeSnapshot } from './snapshot.mts';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/index.do';
const OUT_DIR = path.resolve('artifacts', 'explore-monitor');

const DUMP_ROWS = `(() => {
  return Array.prototype.slice.call(document.querySelectorAll('a[aria-label="Monitor"]'))
    .slice(0, 5)
    .map(function (a) {
      var row = a.closest('tr') || a.closest('.list-group-item') || a.parentElement;
      var name = row ? row.querySelector('.sequence-name-link') : null;
      return [
        (a.getAttribute('href') || ''),
        name ? (name.textContent || '').replace(/\\s+/g, ' ').trim() : '(no name)'
      ].join('  ->  ');
    })
    .join('\\n');
})()`;

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
    console.log('--- MONITOR LINKS -> LESSON NAME ---');
    console.log(await page.evaluate(DUMP_ROWS));

    const popupPromise = page.waitForEvent('popup', { timeout: 20_000 }).catch(() => undefined);
    await page.locator('a[aria-label="Monitor"]').first().click();
    const monitoringPage = (await popupPromise) ?? page;
    await monitoringPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await monitoringPage.waitForTimeout(6_000);

    console.log(`--- MONITORING PAGE ---`);
    console.log(`opened in popup: ${monitoringPage !== page}`);
    console.log(`url: ${monitoringPage.url()}`);
    console.log(`title: ${await monitoringPage.title()}`);
    await writeSnapshot(monitoringPage, OUT_DIR, '09-monitoring');

    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
