import { expect, test } from '@playwright/test';
import {
  applyTratAdvancedSettings,
  DEFAULT_TRAT_ADVANCED_SETTINGS
} from '../src/lams/trat-settings.js';

function tratMarkup(): string {
  return `
    <button role="tab" onclick="document.querySelector('#advanced').hidden=false">Advanced</button>
    <section id="advanced" hidden>
      <label><input id="shuffle-items" type="checkbox" checked>Shuffle questions</label>
      <label><input id="require-all-answers" type="checkbox" checked>Require to reveal all correct answers before proceeding</label>
      <label><input id="reveal-on-double-click" type="checkbox" checked>Require double click to reveal an answer</label>
      <label><input id="show-scratchies-in-results" type="checkbox">Teams' answer selection</label>
      <label><input id="scores" type="checkbox">Scores</label>
      <label><input id="burning-questions-enabled" type="checkbox">Enable burning questions</label>
      <label><input id="discussion-sentiment-enabled" type="checkbox">Enable discussion sentiment voting</label>
      <label><input id="question-etherpad-enabled" type="checkbox" checked>Include discussion pad for questions</label>
      <label><input id="data-import" type="checkbox">Imports confidence levels or VSAs responses data from other Assessment activities (for instance an iRAT) to display in this activity.</label>
      <label for="display-confidence-levels-activities">
        <input id="display-confidence-levels-activities" type="checkbox">Show confidence levels from
        <select id="confidence-levels-activity" disabled>
          <option>Other Assessment</option><option>iRAT</option>
        </select>
      </label>
      <label><input id="display-activities-providing-vsa-answers" type="checkbox" checked>Show VSA answers from</label>
      <label><input id="confidence-levels-anonymous" type="checkbox" checked>Do not display students' names with confidence level (anonymous)</label>
    </section>
    <script>
      document.querySelector('#display-confidence-levels-activities').addEventListener('change', event => {
        document.querySelector('#confidence-levels-activity').disabled = !event.target.checked;
      });
    </script>`;
}

test('restores tRAT defaults and enables confidence display from iRAT', async ({ page }) => {
  await page.setContent(tratMarkup());

  const report = await applyTratAdvancedSettings(
    page.mainFrame(),
    'iRAT',
    { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
    { commit: true, timeoutMs: 2_000 }
  );

  expect(report.passed).toBe(true);
  expect(report.confidenceSourceActivityName).toBe('iRAT');
  for (const [key, expected] of Object.entries(DEFAULT_TRAT_ADVANCED_SETTINGS)) {
    expect(report.checks.find((check) => check.key === key)?.actual, key).toBe(expected);
  }
  await expect(page.locator('#confidence-levels-activity')).toHaveValue('iRAT');
});

test('tRAT post-save verification reports mismatches without changing them', async ({ page }) => {
  await page.setContent(tratMarkup());
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await page.locator('#confidence-levels-activity').evaluate((select: HTMLSelectElement) => {
    select.disabled = false;
    select.value = 'iRAT';
  });

  const report = await applyTratAdvancedSettings(
    page.mainFrame(),
    'iRAT',
    { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
    { commit: false, timeoutMs: 2_000 }
  );

  expect(report.passed).toBe(false);
  await expect(page.locator('#shuffle-items')).toBeChecked();
});

test('stops when a required tRAT setting is missing', async ({ page }) => {
  await page.setContent(tratMarkup());
  await page.locator('#scores').evaluate((element) => element.remove());

  await expect(applyTratAdvancedSettings(
    page.mainFrame(),
    'iRAT',
    { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
    { commit: true, timeoutMs: 100 }
  )).rejects.toThrow('Expected one tRAT checkbox "Scores"; found 0.');
});
