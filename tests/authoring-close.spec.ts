import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { closeAuthoring } from '../src/lams/authoring.js';

/**
 * Step 81 of the deployment guide. The Author toolbar is reproduced with the same id
 * convention as the live one (#openButton/#saveButton/#closeButton), and authoring is
 * exercised both as its own popup and as the course page itself.
 */
const AUTHOR_PAGE = `
  <button id="openButton">Open</button>
  <button id="saveButton">Save</button>
  <button id="closeButton" onclick="document.body.dataset.closed = 'true'">Close</button>
  <div id="canvas"></div>
`;

const AUTHOR_PAGE_WITHOUT_CLOSE = `
  <button id="openButton">Open</button>
  <button id="saveButton">Save</button>
`;

function baseConfig(overrides: Record<string, unknown> = {}): LamsConfig {
  return {
    browser: { actionTimeoutMs: 3_000 },
    selectors: { ...overrides }
  } as unknown as LamsConfig;
}

test('clicks Close and closes the separate authoring popup', async ({ context, page }) => {
  await page.setContent('<h1>Cohort_2026Y1</h1>');
  const authoringPage = await context.newPage();
  await authoringPage.setContent(AUTHOR_PAGE);

  await closeAuthoring(authoringPage, page, baseConfig());

  expect(authoringPage.isClosed()).toBe(true);
  expect(page.isClosed()).toBe(false);
});

test('clicks Close when authoring shares the course page', async ({ page }) => {
  await page.setContent(AUTHOR_PAGE);

  await closeAuthoring(page, page, baseConfig());

  expect(page.isClosed()).toBe(false);
  await expect(page.locator('body')).toHaveAttribute('data-closed', 'true');
});

test('honours a configured Close selector', async ({ page }) => {
  await page.setContent(`
    <button id="lamsCloseBtn" onclick="document.body.dataset.closed = 'custom'">Close</button>
  `);

  await closeAuthoring(page, page, baseConfig({ closeAuthoring: '#lamsCloseBtn' }));

  await expect(page.locator('body')).toHaveAttribute('data-closed', 'custom');
});

test('falls back to closing the popup when no Close control is present', async ({ context, page }) => {
  await page.setContent('<h1>Cohort_2026Y1</h1>');
  const authoringPage = await context.newPage();
  await authoringPage.setContent(AUTHOR_PAGE_WITHOUT_CLOSE);

  await closeAuthoring(authoringPage, page, baseConfig());

  expect(authoringPage.isClosed()).toBe(true);
});

test('an already closed authoring page is a no-op', async ({ context, page }) => {
  await page.setContent('<h1>Cohort_2026Y1</h1>');
  const authoringPage = await context.newPage();
  await authoringPage.close();

  await closeAuthoring(authoringPage, page, baseConfig());

  expect(page.isClosed()).toBe(false);
});

test('a same-page authoring surface with no Close control fails loudly', async ({ page }) => {
  await page.setContent(AUTHOR_PAGE_WITHOUT_CLOSE);

  await expect(closeAuthoring(page, page, baseConfig())).rejects.toThrow(
    /No authoring Close control matched "#closeButton"/
  );
});
