import { expect, test } from '@playwright/test';
import { MAX_MARK_INPUT, QUESTION_TITLE, QUESTION_TYPE_BADGE, REQUIRED_TOGGLE } from '../src/lams/irat-editor.js';

/**
 * Markup copied from the authenticated LAMS Assessment authoring iframe of a real TBL
 * lesson. The second cell is the display order, the title sits in a bold span, the type
 * is a Bootstrap badge, and "answer required" state lives on the toggle BUTTON — the
 * inline handler reads and writes text-danger there, not on the inner <i> icon.
 */
function referenceRows(rows: { title: string; mark: string; required: boolean }[]): string {
  const body = rows
    .map(
      (row, index) => `
      <tr>
        <td class="text-center text-muted"><i class="fa-solid fa-grip-vertical drag-handle"></i></td>
        <td class="reference-display-order text-muted fw-semibold">${index + 1})</td>
        <td>
          <input type="hidden" name="sequenceId${index}" value="${index}" class="reference-sequence-id">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="fw-semibold">${row.title}</span>
            <span class="badge bg-primary-subtle text-primary ms-auto">Multiple choice</span>
          </div>
        </td>
        <td class="text-end">
          <div class="input-group input-group-sm ms-auto">
            <input name="maxMark" value="${row.mark}" class="form-control text-end max-mark-input" type="number" min="0" step="0.01">
          </div>
        </td>
        <td class="text-end">
          <button type="button" class="btn btn-sm btn-outline-secondary${row.required ? ' text-danger' : ''}"
                  onclick="javascript:toggleQuestionRequired(this)" aria-label="Answer required">
            <i class="fa-solid fa-asterisk"></i>
          </button>
          <button type="button" class="btn btn-outline-secondary btn-sm edit-reference-link" aria-label="Edit"></button>
        </td>
      </tr>`
    )
    .join('');
  return `<table id="referencesTable"><tbody>${body}</tbody></table>`;
}

test('the title selector reads the question name, not the display-order cell', async ({ page }) => {
  await page.setContent(referenceRows([{ title: 'Question 1', mark: '1.0', required: false }]));

  const row = page.locator('#referencesTable tbody tr').first();

  expect((await row.locator(QUESTION_TITLE).innerText()).trim()).toBe('Question 1');
  expect((await row.locator('td').nth(1).innerText()).trim()).toBe('1)');
});

test('the type badge and mark selectors read the live row controls', async ({ page }) => {
  await page.setContent(referenceRows([{ title: 'Question 10', mark: '2.0', required: false }]));

  const row = page.locator('#referencesTable tbody tr').first();

  expect((await row.locator(QUESTION_TYPE_BADGE).innerText()).trim()).toBe('Multiple choice');
  expect(await row.locator(MAX_MARK_INPUT).inputValue()).toBe('2.0');
  expect(await row.locator('.question-type-alert').count()).toBe(0);
});

test('required state is read from the toggle button rather than the asterisk icon', async ({ page }) => {
  await page.setContent(
    referenceRows([
      { title: 'Question 1', mark: '1.0', required: true },
      { title: 'Question 2', mark: '1.0', required: false }
    ])
  );

  const rows = page.locator('#referencesTable tbody tr');
  const readToggle = (index: number) =>
    rows.nth(index).locator(REQUIRED_TOGGLE).evaluate((element) => element.classList.contains('text-danger'));

  expect(await readToggle(0)).toBe(true);
  expect(await readToggle(1)).toBe(false);
  // The inner icon never carries the state, so the old selector cannot distinguish them.
  const iconState = await rows.nth(0).locator('.fa-asterisk').evaluate((element) => element.classList.contains('text-danger'));
  expect(iconState).toBe(false);
});

test('each exact question title matches exactly one row', async ({ page }) => {
  const titles = Array.from({ length: 25 }, (_, index) => `Question ${index + 1}`);
  await page.setContent(referenceRows(titles.map((title) => ({ title, mark: '1.0', required: false }))));

  const rows = page.locator('#referencesTable tbody tr');
  expect(await rows.count()).toBe(25);

  for (const title of ['Question 1', 'Question 2', 'Question 25']) {
    const matches = await rows.filter({ has: page.locator(`${QUESTION_TITLE}:text-is("${title}")`) }).count();
    expect(matches).toBe(1);
  }
});

test('an unrendered required state is probed rather than assumed', async ({ page }) => {
  // LAMS ships the toggle with neither text-danger nor text-muted, so the stored value is
  // unknown until the AJAX callback stamps one of them on. Reading the raw class as "false"
  // is what would invert the flag on a re-run.
  await page.setContent(referenceRows([{ title: 'Question 1', mark: '1.0', required: false }]));

  const toggle = page.locator('#referencesTable tbody tr').first().locator(REQUIRED_TOGGLE);
  const state = await toggle.evaluate((element) =>
    element.classList.contains('text-danger') ? true : element.classList.contains('text-muted') ? false : null
  );

  expect(state).toBeNull();
});

test('a stamped required state reads back as the stored value', async ({ page }) => {
  await page.setContent(referenceRows([{ title: 'Question 1', mark: '1.0', required: true }]));

  const toggle = page.locator('#referencesTable tbody tr').first().locator(REQUIRED_TOGGLE);
  const state = await toggle.evaluate((element) =>
    element.classList.contains('text-danger') ? true : element.classList.contains('text-muted') ? false : null
  );

  expect(state).toBe(true);
});
