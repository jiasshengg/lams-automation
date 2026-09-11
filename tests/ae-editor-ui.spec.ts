import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { applyAEAnswerScoring, expandAuthoringSections, resizeOptions } from '../src/lams/ae-editor.js';

// Reproduces qb-option.js: removeOption() gates the deletion behind confirm(), and the
// delete control stays hidden until its option row is expanded. resizeOptions attaches
// its dialog handler to frame.page(), so these run in a real child frame, not the page.
function optionMarkup(count: number): string {
  const tables = Array.from({ length: count }, (_, index) => `
    <table id="option-table-${index}" class="single-option-table">
      <tbody><tr><td>
        <button type="button" class="delete-button option-settings-hidden"
                onclick="removeOption(Number('${index}'))" style="display: none;">x</button>
      </td></tr></tbody>
    </table>`).join('');
  return `${tables}
    <a onclick="addOption()" style="display:block">Add option</a>
    <script>
      function removeOption(idx) {
        if (confirm('Delete this answer?')) document.getElementById('option-table-' + idx).remove();
      }
      function addOption() {
        const next = document.querySelectorAll('.single-option-table').length;
        const table = document.createElement('table');
        table.id = 'option-table-' + next;
        table.className = 'single-option-table';
        table.innerHTML = '<tbody><tr><td>Answer ' + (next + 1) + '</td></tr></tbody>';
        document.querySelector('a[onclick*="addOption"]').before(table);
      }
    </script>`;
}

async function childFrameWith(page: Page, html: string): Promise<Frame> {
  await page.setContent(`<iframe id="activity" srcdoc="${html.replace(/"/g, '&quot;')}"></iframe>`);
  const frame = page.frame({ url: /about:srcdoc/ }) ?? page.frames()[1];
  if (!frame) throw new Error('test harness did not create a child frame');
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

test('removes surplus answer options by accepting the deletion confirm', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(4));
  await resizeOptions(frame, 3, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(3);
});

test('removes several surplus options in one pass', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(5));
  await resizeOptions(frame, 2, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(2);
});

test('adds missing answer options and leaves a matching count alone', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(2));
  await resizeOptions(frame, 4, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(4);
  await resizeOptions(frame, 4, 5000);
  expect(await frame.locator('.single-option-table').count()).toBe(4);
});

test('does not leave a dialog handler attached to the page', async ({ page }) => {
  const frame = await childFrameWith(page, optionMarkup(4));
  await resizeOptions(frame, 3, 5000);
  // A leaked handler would keep swallowing later confirms; with none attached
  // Playwright reverts to auto-dismiss, so the option survives.
  await frame.locator('.single-option-table').first().locator('.delete-button')
    .evaluate((element: HTMLElement) => element.click());
  await page.waitForTimeout(250);
  expect(await frame.locator('.single-option-table').count()).toBe(3);
});

// The attempts and passing-mark controls sit in an accordion that loads collapsed.
const ACCORDION = `
  <div id="advancedCollapse" style="display: none;">
    <input type="radio" id="attemptsAllowedRadio">
    <select id="attemptsAllowed"><option value="1">1</option></select>
  </div>
  <button id="expandAllButton" onclick="document.getElementById('advancedCollapse').style.display = 'block'">Expand all</button>`;

test('expands collapsed authoring sections so attempt settings become actionable', async ({ page }) => {
  const frame = await childFrameWith(page, ACCORDION);
  await expect(frame.locator('#attemptsAllowed')).toBeHidden();
  await expandAuthoringSections(frame, 5000);
  await expect(frame.locator('#attemptsAllowed')).toBeVisible();
  await frame.locator('#attemptsAllowedRadio').check();
  await frame.locator('#attemptsAllowed').selectOption('1');
});

test('fails loudly when the expand control is missing', async ({ page }) => {
  const frame = await childFrameWith(page, '<div id="advancedCollapse" style="display:none"></div>');
  await expect(expandAuthoringSections(frame, 1000)).rejects.toThrow();
});

test('sets and verifies multiple-answer mode with fractional option weights', async ({ page }) => {
  const frame = await childFrameWith(page, `
    <select id="multipleAnswersAllowed">
      <option value="false">One answer only</option>
      <option value="true">Multiple answers allowed</option>
    </select>
    <input id="optionMaxMark0" type="hidden">
    <input id="optionMaxMark1" type="hidden">
    <input id="optionMaxMark2" type="hidden">
  `);

  await applyAEAnswerScoring(frame, {
    title: 'Question 2',
    multipleAnswersAllowed: true,
    options: [
      { text: 'First', creditPercent: 50 },
      { text: 'Second', creditPercent: 50 },
      { text: 'Third', creditPercent: 0 }
    ]
  });

  expect(await frame.locator('#multipleAnswersAllowed').inputValue()).toBe('true');
  expect(await frame.locator('[id^="optionMaxMark"]').evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value)
  )).toEqual(['0.5', '0.5', '0']);
});
