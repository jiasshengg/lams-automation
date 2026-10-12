import { expect, test } from '@playwright/test';
import { waitForStableQuestionList } from '../src/lams/irat-editor.js';

// An iRAT of 25 questions was read as 7 and then 14 rows because the references table kept
// filling in after #authoringForm appeared; the Edit click then hit a replaced row.
test('waits for a references table that is still filling in to hold still', async ({ page }) => {
  await page.setContent(`
    <form id="authoringForm"><table id="referencesTable"><tbody></tbody></table></form>
    <script>
      let added = 0;
      const timer = setInterval(() => {
        added += 1;
        document.querySelector('#referencesTable tbody').insertAdjacentHTML('beforeend',
          '<tr><td><span class="fw-semibold">Question ' + added + '</span></td></tr>');
        if (added === 25) clearInterval(timer);
      }, 60);
    </script>`);
  await waitForStableQuestionList(page.mainFrame(), 10_000, 500);
  await expect(page.locator('#referencesTable tbody tr')).toHaveCount(25);
});

test('stops when the references table never holds still', async ({ page }) => {
  await page.setContent(`
    <table id="referencesTable"><tbody></tbody></table>
    <script>
      let added = 0;
      setInterval(() => {
        added += 1;
        document.querySelector('#referencesTable tbody').insertAdjacentHTML('beforeend',
          '<tr><td><span class="fw-semibold">Question ' + added + '</span></td></tr>');
      }, 100);
    </script>`);
  await expect(waitForStableQuestionList(page.mainFrame(), 1_500, 500)).rejects.toThrow('still changing');
});
