/**
 * Fourth discovery pass: fills the Advanced tab the way the real workflow does, then
 * advances past Next to capture the Course groupings step.
 *
 * Stops before the final commit: no lesson is created.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { writeSnapshot } from './snapshot.mts';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/home/addLesson.do?organisationID=509';
const OUT_DIR = path.resolve('artifacts', 'explore4');
const END_DATETIME = '2026-09-03 23:59';

const DUMP = `(() => {
  function rows(selector, map) {
    return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (el) {
      return el.offsetParent !== null;
    }).map(map).join('\\n');
  }
  return [
    '## radios',
    rows('input[type=radio]', function (r) {
      var label = r.closest('label') || r.parentElement;
      return [r.id || '(no id)', r.name || '', 'checked=' + r.checked,
        ((label && label.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 80)].join(' | ');
    }),
    '',
    '## buttons',
    rows('button', function (b) { return (b.id || '(no id)') + ' | ' + (b.textContent || '').trim().slice(0, 60); }),
    '',
    '## headings',
    rows('h1,h2,h3,h4,legend', function (h) { return (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80); })
  ].join('\\n');
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

    const toggle = page.locator('#recentToggleBtn');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.locator('#recentList button.access-item').first().click();
    await page.waitForTimeout(2_500);

    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await page.waitForTimeout(1_000);
    await page.locator('#gradebookOnCompleteField').uncheck();
    await page.locator('#schedulingEnableField').check();
    await page.waitForTimeout(1_000);

    const endField = page.locator('#schedulingEndDatetimeField');
    await endField.fill(END_DATETIME);
    await endField.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
    console.log(`end field value after fill: ${JSON.stringify(await endField.inputValue())}`);
    console.log(`scores toggle checked: ${await page.locator('#gradebookOnCompleteField').isChecked()}`);
    console.log(`scheduling toggle checked: ${await page.locator('#schedulingEnableField').isChecked()}`);

    await page.locator('#btnNext').click();
    await page.waitForTimeout(3_000);
    await writeSnapshot(page, OUT_DIR, '08-course-groupings');
    console.log('--- AFTER NEXT ---');
    console.log(await page.evaluate(DUMP));

    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
