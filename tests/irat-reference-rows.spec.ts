import { expect, test } from '@playwright/test';
import { MAX_MARK_INPUT, QUESTION_TITLE, QUESTION_TYPE_BADGE, readRequiredState, REQUIRED_TOGGLE } from '../src/lams/irat-editor.js';

interface ReferenceRow {
  title: string;
  mark: string;
  /** The stored value, as the server renders it into the btn-outline-* class. */
  required: boolean;
  /** A text-danger/text-muted class stamped later by toggleQuestionRequired's callback. */
  stamped?: boolean;
}

/**
 * Markup copied from the authenticated LAMS Assessment authoring iframe of a real TBL
 * lesson. The second cell is the display order, the title sits in a bold span, the type
 * is a Bootstrap badge, and "answer required" state lives on the toggle BUTTON — the
 * inline handler reads and writes text-danger there, not on the inner <i> icon.
 *
 * The server draws the stored value as btn-outline-danger/btn-outline-secondary; the
 * toggle's AJAX callback stamps text-danger/text-muted on top of it afterwards.
 */
function referenceRows(rows: ReferenceRow[]): string {
  const body = rows
    .map((row, index) => {
      const stamp = row.stamped === undefined ? '' : row.stamped ? ' text-danger' : ' text-muted';
      return `
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
          <button type="button" class="btn btn-sm ${row.required ? 'btn-outline-danger' : 'btn-outline-secondary'}${stamp}"
                  onclick="javascript:toggleQuestionRequired(this)" aria-label="Answer required">
            <i class="fa-solid fa-asterisk"></i>
          </button>
          <button type="button" class="btn btn-outline-secondary btn-sm edit-reference-link" aria-label="Edit"></button>
        </td>
      </tr>`;
    })
    .join('');
  return `<table id="referencesTable"><tbody>${body}</tbody></table>`;
}

const readToggle = (locator: import('@playwright/test').Locator) => locator.locator(REQUIRED_TOGGLE).evaluate(readRequiredState);

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
      { title: 'Question 1', mark: '1.0', required: true, stamped: true },
      { title: 'Question 2', mark: '1.0', required: false, stamped: false }
    ])
  );

  const rows = page.locator('#referencesTable tbody tr');

  expect(await readToggle(rows.nth(0))).toBe(true);
  expect(await readToggle(rows.nth(1))).toBe(false);
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

test('the freshly rendered state is read without clicking the toggle', async ({ page }) => {
  // Nothing has been toggled yet, so only the server's btn-outline-* class states the
  // stored value. Treating that as unknown is what made the workflow click a question
  // whose flag was already correct.
  await page.setContent(
    referenceRows([
      { title: 'Question 1', mark: '1.0', required: true },
      { title: 'Question 2', mark: '1.0', required: false }
    ])
  );

  const rows = page.locator('#referencesTable tbody tr');

  expect(await readToggle(rows.nth(0))).toBe(true);
  expect(await readToggle(rows.nth(1))).toBe(false);
});

test('a stamped class outranks the class the row was rendered with', async ({ page }) => {
  // toggleQuestionRequired stamps the confirmed new value without redrawing the row, so
  // the stamp is newer than btn-outline-* and must win in both directions.
  await page.setContent(
    referenceRows([
      { title: 'Question 1', mark: '1.0', required: false, stamped: true },
      { title: 'Question 2', mark: '1.0', required: true, stamped: false }
    ])
  );

  const rows = page.locator('#referencesTable tbody tr');

  expect(await readToggle(rows.nth(0))).toBe(true);
  expect(await readToggle(rows.nth(1))).toBe(false);
});

test('a toggle carrying neither class family reads as unknown', async ({ page }) => {
  await page.setContent(
    '<table id="referencesTable"><tbody><tr><td>' +
      '<button type="button" class="btn btn-sm" onclick="javascript:toggleQuestionRequired(this)"></button>' +
      '</td></tr></tbody></table>'
  );

  expect(await readToggle(page.locator('#referencesTable tbody tr').first())).toBeNull();
});
