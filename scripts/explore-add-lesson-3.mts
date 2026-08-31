/**
 * Third discovery pass: selects the most recent design and inspects what that reveals —
 * the lesson name/description fields, and whether the footer offers "Next" (course
 * groupings) or goes straight to "Add now".
 *
 * Stops before "Add now": no lesson is created.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { writeSnapshot } from './snapshot.mts';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/home/addLesson.do?organisationID=509';
const OUT_DIR = path.resolve('artifacts', 'explore3');

const DUMP_FIELDS = `(() => {
  function rows(selector, map) {
    return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (el) {
      return el.offsetParent !== null;
    }).map(map).join('\\n');
  }
  return [
    '## text inputs / textareas',
    rows('input[type=text], textarea', function (i) {
      return [i.id || '(no id)', i.name || '', i.readOnly ? 'readonly' : '', JSON.stringify((i.value || '').slice(0, 80))].join(' | ');
    }),
    '',
    '## buttons',
    rows('button', function (b) { return (b.id || '(no id)') + ' | ' + (b.textContent || '').trim().slice(0, 60); }),
    '',
    '## radios',
    rows('input[type=radio]', function (r) {
      return [r.id || '(no id)', r.name || '', 'checked=' + r.checked, (r.closest('label') || r.parentElement || {}).textContent || ''].join(' | ').replace(/\\s+/g, ' ').slice(0, 160);
    })
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
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
      await page.waitForTimeout(1_000);
    }

    const entries = page.locator('#recentList button.access-item');
    const count = await entries.count();
    console.log(`recent designs: ${count}`);
    for (let index = 0; index < count; index += 1) {
      console.log(`  [${index}] ${(await entries.nth(index).innerText()).trim()}`);
    }

    await entries.first().click();
    await page.waitForTimeout(3_000);
    await writeSnapshot(page, OUT_DIR, '06-design-selected');
    console.log('--- AFTER SELECTING MOST RECENT DESIGN ---');
    console.log(await page.evaluate(DUMP_FIELDS));

    console.log('--- FOOTER AFTER ADVANCED TAB ---');
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await page.waitForTimeout(1_000);
    await page.locator('#schedulingEnableField').check().catch(() => undefined);
    await page.waitForTimeout(1_000);
    await writeSnapshot(page, OUT_DIR, '07-advanced-scheduling');
    console.log(await page.evaluate(DUMP_FIELDS));

    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
