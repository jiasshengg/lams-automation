import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { selectWorkspaceCourse } from '../src/lams/navigation.js';

const workspaceCourse = 'DL Playground 2026/2027 [internal]';

test('keeps the already-selected approved workspace', async ({ page }) => {
  await page.setContent(`
    <button aria-label="Toggle course menu" onclick="document.body.dataset.menuOpened = 'true'">Menu</button>
    <h2>${workspaceCourse}</h2>
  `);

  await selectWorkspaceCourse(page, config());
  await expect(page.getByRole('heading', { name: workspaceCourse })).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-menu-opened');
});

test('searches for and selects only the approved workspace', async ({ page }) => {
  await page.setContent(`
    <button aria-label="Toggle course menu" onclick="document.querySelector('[role=dialog]').hidden = false">Menu</button>
    <div role="dialog" hidden>
      <input type="search" aria-label="Search for courses">
      <button onclick="this.closest('[role=dialog]').hidden = true; document.querySelector('h2').hidden = false">
        ${workspaceCourse}
      </button>
      <button>Another course</button>
    </div>
    <h2 hidden>${workspaceCourse}</h2>
  `);

  await selectWorkspaceCourse(page, config());
  await expect(page.getByRole('heading', { name: workspaceCourse })).toBeVisible();
  await expect(page.locator('input[aria-label="Search for courses"]')).toHaveValue(workspaceCourse);
});

function config(): LamsConfig {
  return {
    workspaceCourse,
    browser: { manualLoginTimeoutMs: 2_000, actionTimeoutMs: 2_000 }
  } as LamsConfig;
}
