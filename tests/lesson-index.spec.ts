import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import {
  configureAdvancedOptions,
  createLessonFromMostRecentDesign,
  resolveCourseGrouping,
  selectCourseGrouping,
  selectMostRecentDesign
} from '../src/lams/lesson-index.js';

/**
 * Mirrors the live Add Lesson markup captured from LAMS :: Add Lesson: the recent-designs
 * panel starts collapsed, selecting a design fills #lessonNameInput and swaps the footer
 * from #addButton to #btnNext, and the grouping radios share name="orgGroupingId".
 */
const ADD_LESSON_PAGE = `
  <ul>
    <li role="presentation"><a role="tab" href="#">Lesson</a></li>
    <li role="presentation"><a role="tab" href="#">Class</a></li>
    <li role="presentation"><a role="tab" href="#" onclick="document.getElementById('advanced').hidden = false">Advanced</a></li>
    <li role="presentation"><a role="tab" href="#">Conditions</a></li>
  </ul>

  <button id="recentToggleBtn" aria-expanded="false" aria-label="Show"
          onclick="document.getElementById('recentList').hidden = false; this.setAttribute('aria-expanded','true')">Show</button>
  <div id="recentList" hidden>
    <button type="button" class="btn access access-item" onclick="pick('FOM TBL06 030926 2026Y1')">FOM TBL06 030926 2026Y1</button>
    <button type="button" class="btn access access-item" onclick="pick('FOM TBL05 310826 2026Y1')">FOM TBL05 310826 2026Y1</button>
  </div>
  <input id="lessonNameInput" type="text" value="">

  <div id="advanced" hidden>
    <input id="gradebookOnCompleteField" name="gradebookOnComplete" type="checkbox" checked>
    <input id="schedulingEnableField" name="schedulingEnable" type="checkbox">
    <input id="schedulingEndDatetimeField" name="schedulingEndDatetime" type="text" class="hasDatepicker" value="">
  </div>

  <div id="groupings" hidden>
    <label><input type="radio" name="orgGroupingId" id="orgGroupingNone" checked> None</label>
    <label><input type="radio" name="orgGroupingId" id="orgGrouping1"> Y1 ALL</label>
    <label><input type="radio" name="orgGroupingId" id="orgGrouping2"> Y2 ALL</label>
  </div>

  <button id="btnCancel">Back</button>
  <button id="btnNext" hidden onclick="document.getElementById('groupings').hidden = false; this.hidden = true; document.getElementById('addButton').hidden = false">Next</button>
  <button id="addButton" onclick="document.body.dataset.added = 'true'">Add now</button>

  <script>
    function pick(title) {
      document.getElementById('lessonNameInput').value = title;
      document.getElementById('btnNext').hidden = false;
      document.getElementById('addButton').hidden = true;
    }
  </script>
`;

function baseConfig(overrides: Record<string, unknown> = {}): LamsConfig {
  return {
    lessonIndex: { courseGrouping: 'Y1 ALL', endDate: '2026-09-03', ...overrides },
    browser: { actionTimeoutMs: 3_000 }
  } as unknown as LamsConfig;
}

test('expands the collapsed panel and selects the top recently used design', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const designTitle = await selectMostRecentDesign(page, baseConfig());

  expect(designTitle).toBe('FOM TBL06 030926 2026Y1');
  await expect(page.locator('#lessonNameInput')).toHaveValue('FOM TBL06 030926 2026Y1');
});

test('refuses to continue when the most recent design is not the expected one', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const config = baseConfig({ expectedDesignTitle: 'FOM TBL05 310826 2026Y1' });

  await expect(selectMostRecentDesign(page, config)).rejects.toThrow(/most recent design is "FOM TBL06 030926 2026Y1"/);
  await expect(page.locator('#lessonNameInput')).toHaveValue('');
});

test('advanced options hide scores, enable scheduling, and set the end time to 23:59', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const endDateTime = await configureAdvancedOptions(page, baseConfig());

  expect(endDateTime).toBe('2026-09-03 23:59');
  await expect(page.locator('#gradebookOnCompleteField')).not.toBeChecked();
  await expect(page.locator('#schedulingEnableField')).toBeChecked();
  await expect(page.locator('#schedulingEndDatetimeField')).toHaveValue('2026-09-03 23:59');
});

test('honours an explicit end time instead of the 23:59 default', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const endDateTime = await configureAdvancedOptions(page, baseConfig({ endTime: '18:30' }));

  expect(endDateTime).toBe('2026-09-03 18:30');
  await expect(page.locator('#schedulingEndDatetimeField')).toHaveValue('2026-09-03 18:30');
});

test('leaves the end date untouched when scheduling is disabled', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  await configureAdvancedOptions(page, baseConfig({ enableScheduling: false }));

  await expect(page.locator('#schedulingEnableField')).not.toBeChecked();
  await expect(page.locator('#schedulingEndDatetimeField')).toHaveValue('');
});

test('selects the course grouping preset', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);
  await selectMostRecentDesign(page, baseConfig());

  const grouping = await selectCourseGrouping(page, baseConfig(), 'FOM TBL06 030926 2026Y1');

  expect(grouping).toBe('Y1 ALL');
  await expect(page.locator('#orgGrouping1')).toBeChecked();
});

test('reports the presets on offer when the wanted grouping is missing', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);
  await selectMostRecentDesign(page, baseConfig());

  const config = baseConfig({ courseGrouping: 'Y9 ALL' });

  await expect(selectCourseGrouping(page, config, 'FOM TBL06 030926 2026Y1')).rejects.toThrow(
    /Available presets: None, Y1 ALL, Y2 ALL/
  );
});

test('resolves the cohort year from the design title', () => {
  expect(resolveCourseGrouping('Y{{cohortYear}} ALL', 'FOM TBL06 030926 2026Y1')).toBe('Y1 ALL');
  expect(resolveCourseGrouping('Y{{cohortYear}} ALL', 'GIS TBL01a 100425 2024Y3')).toBe('Y3 ALL');
  expect(resolveCourseGrouping('Y1 ALL', 'title without a year token')).toBe('Y1 ALL');
  expect(() => resolveCourseGrouping('Y{{cohortYear}} ALL', 'no year here')).toThrow(/no cohort-year token/);
});

test('a cohort-year template picks the matching preset', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);
  await selectMostRecentDesign(page, baseConfig());

  const config = baseConfig({ courseGrouping: 'Y{{cohortYear}} ALL' });
  const grouping = await selectCourseGrouping(page, config, 'FOM TBL06 030926 2026Y2');

  expect(grouping).toBe('Y2 ALL');
  await expect(page.locator('#orgGrouping2')).toBeChecked();
});

test('skips the groupings step for a design that has no groupings', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE.replace('id="btnNext" hidden', 'id="btnNext" hidden data-never-shown'));
  await page.locator('#recentToggleBtn').click();
  await page.locator('#recentList button.access-item').first().click();
  await page.locator('#btnNext').evaluate((el) => { (el as HTMLElement).hidden = true; });

  const grouping = await selectCourseGrouping(page, baseConfig({ courseGrouping: 'None' }), 'FOM TBL06 030926 2026Y1');

  expect(grouping).toBe('None');
  await expect(page.locator('#groupings')).toBeHidden();
});

test('refuses when a preset is wanted but the design offers no groupings', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);
  await page.locator('#recentToggleBtn').click();
  await page.locator('#recentList button.access-item').first().click();
  await page.locator('#btnNext').evaluate((el) => { (el as HTMLElement).hidden = true; });

  await expect(selectCourseGrouping(page, baseConfig(), 'FOM TBL06 030926 2026Y1')).rejects.toThrow(
    /no grouping activities/
  );
});

test('dry run fills the form without clicking Add now', async ({ page }) => {
  await page.setContent(ADD_LESSON_PAGE);

  const result = await createLessonFromMostRecentDesign(page, baseConfig(), { commit: false });

  expect(result).toMatchObject({
    designTitle: 'FOM TBL06 030926 2026Y1',
    lessonTitle: 'FOM TBL06 030926 2026Y1',
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
