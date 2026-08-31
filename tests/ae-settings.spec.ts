import { expect, test } from '@playwright/test';
import { AE_ACTIVITY_CHECKBOXES, applyAEActivitySettings } from '../src/lams/ae-settings.js';

function settingsMarkup(): string {
  return AE_ACTIVITY_CHECKBOXES.map(
    ({ label, expected }, index) =>
      `<label><input id="setting-${index}" type="checkbox" ${expected ? '' : 'checked'}>${label}<span>Detailed help for this setting.</span></label>`
  ).join('\n');
}

test('AE settings dry run reports every mismatch without changing the page', async ({ page }) => {
  await page.setContent(settingsMarkup());

  const report = await applyAEActivitySettings(page, { commit: false, actionTimeoutMs: 2_000 });

  expect(report.passed).toBe(false);
  expect(report.changesRequired).toBe(AE_ACTIVITY_CHECKBOXES.length);
  expect(report.checks.every((check) => check.actual !== check.expected)).toBe(true);
  await expect(page.locator('input').first()).toBeChecked();
});

test('AE settings commit applies and verifies the canonical checkbox state', async ({ page }) => {
  await page.setContent(settingsMarkup());

  const report = await applyAEActivitySettings(page, { commit: true, actionTimeoutMs: 2_000 });

  expect(report.passed).toBe(true);
  expect(report.changesApplied).toBe(AE_ACTIVITY_CHECKBOXES.length);
  for (const { label, expected } of AE_ACTIVITY_CHECKBOXES) {
    expect(await page.getByLabel(label, { exact: false }).isChecked()).toBe(expected);
  }
});

test('AE settings stop when a required labelled control is missing', async ({ page }) => {
  const markup = settingsMarkup().replace(AE_ACTIVITY_CHECKBOXES[0]!.label, 'Different label');
  await page.setContent(markup);

  await expect(
    applyAEActivitySettings(page, { commit: false, actionTimeoutMs: 100 })
  ).rejects.toThrow(`Could not find exactly one checkbox labelled "${AE_ACTIVITY_CHECKBOXES[0]!.label}"`);
});
