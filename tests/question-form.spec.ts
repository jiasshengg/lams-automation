import { expect, test } from '@playwright/test';
import { waitForQuestionFormIdle } from '../src/lams/question-form.js';

test('holds the save until LAMS finishes its new-version check', async ({ page }) => {
  // Mirrors qb-question.js: the form points at the check URL while a check is in flight.
  await page.setContent(`<form id="assessmentQuestionForm" action="/checkQuestionNewVersion.do"></form>
    <script>
      window.CHECK = '/checkQuestionNewVersion.do';
      window.isVersionCheck = function () {
        return document.getElementById('assessmentQuestionForm').getAttribute('action') === window.CHECK;
      };
      setTimeout(function () {
        document.getElementById('assessmentQuestionForm').setAttribute('action', '/saveQuestion.do');
        window.checkFinished = Date.now();
      }, 400);
    </script>`);
  const started = Date.now();

  await waitForQuestionFormIdle(page.mainFrame(), 5000);

  expect(await page.evaluate(() => (window as unknown as { checkFinished?: number }).checkFinished)).toBeGreaterThanOrEqual(started);
});

test('does not wait on an editor without the version check', async ({ page }) => {
  await page.setContent('<form id="assessmentQuestionForm" action="/saveQuestion.do"></form>');
  await waitForQuestionFormIdle(page.mainFrame(), 1000);
});

test('commits a still-focused field first, so its check cannot start on the Save click', async ({ page }) => {
  // The field's change event starts the check; it only fires on blur, i.e. on the Save click.
  await page.setContent(`<form id="assessmentQuestionForm" action="/saveQuestion.do"><input id="maxMark" value="1"></form>
    <script>
      window.CHECK = '/checkQuestionNewVersion.do';
      var form = document.getElementById('assessmentQuestionForm');
      window.isVersionCheck = function () { return form.getAttribute('action') === window.CHECK; };
      form.addEventListener('change', function () {
        form.setAttribute('action', window.CHECK);
        setTimeout(function () { form.setAttribute('action', '/saveQuestion.do'); window.checks = (window.checks || 0) + 1; }, 300);
      });
    </script>`);
  await page.locator('#maxMark').fill('4');

  await waitForQuestionFormIdle(page.mainFrame(), 5000);

  expect(await page.evaluate(() => (window as unknown as { checks?: number }).checks)).toBe(1);
  expect(await page.locator('#assessmentQuestionForm').getAttribute('action')).toBe('/saveQuestion.do');
});

test('asks LAMS for its version check so a quickly filled question is offered Save as new version', async ({ page }) => {
  const { requestNewVersionCheck } = await import('../src/lams/question-form.js');
  // Mirrors qb-question.js: the quick check posts, then afterVersionCheck reveals the button.
  await page.setContent(`<form id="assessmentQuestionForm" action="/saveQuestion.do"></form>
    <button id="saveAsButton" style="display:none">Save as new version</button>
    <script>
      var form = document.getElementById('assessmentQuestionForm');
      window.isVersionCheck = function () { return form.getAttribute('action') === '/check.do'; };
      window.checkQuestionNewVersion = function (quick) {
        if (!quick) return;
        form.setAttribute('action', '/check.do');
        setTimeout(function () {
          form.setAttribute('action', '/saveQuestion.do');
          document.getElementById('saveAsButton').style.display = '';
        }, 300);
      };
    </script>`);

  await requestNewVersionCheck(page.mainFrame(), 5000);

  await expect(page.locator('#saveAsButton')).toBeVisible();
});
