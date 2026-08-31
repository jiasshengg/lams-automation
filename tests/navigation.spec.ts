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

test('waits for the approved workspace heading before opening the course menu', async ({ page }) => {
  // The dashboard heading paints a moment after domcontentloaded. An instantaneous
  // check misses it and needlessly re-opens the course menu for an active course.
  await page.setContent(`
    <button aria-label="Toggle course menu" onclick="document.body.dataset.menuOpened = 'true'">Menu</button>
    <h2 hidden>${workspaceCourse}</h2>
    <script>
      setTimeout(function () { document.querySelector('h2').hidden = false; }, 400);
    </script>
  `);

  await selectWorkspaceCourse(page, config());
  await expect(page.getByRole('heading', { name: workspaceCourse })).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-menu-opened');
});

test('selects a course result that overrides its button role with listitem', async ({ page }) => {
  // Observed live: each course entry is a <button> carrying role="listitem", so a
  // button-role lookup can never match it.
  await page.setContent(`
    <button aria-label="Toggle course menu" onclick="document.querySelector('[role=dialog]').hidden = false">Menu</button>
    <div role="dialog" hidden>
      <input type="search" aria-label="Search for courses">
      <button type="button" role="listitem"
        onclick="this.closest('[role=dialog]').hidden = true; document.querySelector('h2').hidden = false">
        <span>${workspaceCourse}</span>
        <i class="fa-solid fa-star" aria-hidden="true"></i>
      </button>
    </div>
    <h2 hidden>${workspaceCourse}</h2>
  `);

  await selectWorkspaceCourse(page, config());
  await expect(page.getByRole('heading', { name: workspaceCourse })).toBeVisible();
});

function config(): LamsConfig {
  return {
    workspaceCourse,
    browser: { manualLoginTimeoutMs: 2_000, actionTimeoutMs: 2_000, readyTimeoutMs: 2_000 }
  } as LamsConfig;
}
