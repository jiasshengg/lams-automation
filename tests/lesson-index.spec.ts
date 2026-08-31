import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import {
  configureAdvancedOptions,
  createLessonFromMostRecentDesign,
  selectCourseGrouping,
  selectMostRecentDesign
} from '../src/lams/lesson-index.js';

const ADD_LESSON_PAGE = `
  <div role="tablist">
    <button role="tab">Lesson</button>
    <button role="tab">Class</button>
    <button role="tab" onclick="document.getElementById('advanced').hidden = false">Advanced</button>
    <button role="tab">Conditions</button>
  </div>

  <ul id="recentlyUsedDesigns">
    <li onclick="document.getElementById('lessonName').value = 'FOM TBL06 030926 2026Y1'">FOM TBL06 030926 2026Y1</li>
    <li onclick="document.getElementById('lessonName').value = 'FOM TBL05 310826 2026Y1'">FOM TBL05 310826 2026Y1</li>
  </ul>
  <input id="lessonName" value="">

  <div id="advanced" hidden>
    <label><input type="checkbox" checked> Display activity scores on completion</label>
    <label><input type="checkbox" id="scheduling"> Enable scheduling</label>
    <input id="endDate" readonly value="">
  </div>

  <div id="groupings" hidden>
    <span>Course groupings</span>
    <label><input type="radio" name="preset" checked> None</label>
    <label><input type="radio" name="preset"> Y1 ALL</label>
  </div>

  <button onclick="document.getElementById('groupings').hidden = false">Next</button>
  <button onclick="document.body.dataset.added = 'true'">Add now</button>
`;

function baseConfig(overrides: Partial<LamsConfig['lessonIndex']> = {}): LamsConfig {
  return {
    lessonIndex: {
      courseGrouping: 'Y1 ALL',
      endDate: '2026-09-03',
      ...overrides
    },
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;
}

test('selects the top recently used design and confirms the lesson name', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const designTitle = await selectMostRecentDesign(page, baseConfig());

  expect(designTitle).toBe('FOM TBL06 030926 2026Y1');
  await expect(page.locator('#lessonName')).toHaveValue('FOM TBL06 030926 2026Y1');
});

test('refuses to continue when the most recent design is not the expected one', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const config = baseConfig({ expectedDesignTitle: 'FOM TBL05 310826 2026Y1' });

  await expect(selectMostRecentDesign(page, config)).rejects.toThrow(/most recent design is "FOM TBL06 030926 2026Y1"/);
  await expect(page.locator('#lessonName')).toHaveValue('');
});

test('advanced options hide scores, enable scheduling, and set the end time to 23:59', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const endDateTime = await configureAdvancedOptions(page, baseConfig());

  expect(endDateTime).toBe('2026-09-03 23:59');
  await expect(page.getByRole('checkbox', { name: 'Display activity scores on completion' })).not.toBeChecked();
  await expect(page.locator('#scheduling')).toBeChecked();
  await expect(page.locator('#endDate')).toHaveValue('2026-09-03 23:59');
});

test('honours an explicit end time instead of the 23:59 default', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const endDateTime = await configureAdvancedOptions(page, baseConfig({ endTime: '18:30' }));

  expect(endDateTime).toBe('2026-09-03 18:30');
  await expect(page.locator('#endDate')).toHaveValue('2026-09-03 18:30');
});

test('selects the configured course grouping preset', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const grouping = await selectCourseGrouping(page, baseConfig());

  expect(grouping).toBe('Y1 ALL');
  await expect(page.getByRole('radio', { name: 'Y1 ALL' })).toBeChecked();
});

test('dry run fills the form without clicking Add now', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const result = await createLessonFromMostRecentDesign(page, baseConfig(), { commit: false });

  expect(result).toMatchObject({
    designTitle: 'FOM TBL06 030926 2026Y1',
    endDateTime: '2026-09-03 23:59',
    courseGrouping: 'Y1 ALL',
    committed: false
  });
  await expect(page.locator('body')).not.toHaveAttribute('data-added');
});

test('commit clicks Add now after the form is complete', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const result = await createLessonFromMostRecentDesign(page, baseConfig(), { commit: true });

  expect(result.committed).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-added', 'true');
});
