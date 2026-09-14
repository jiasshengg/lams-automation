import { expect, test } from '@playwright/test';
import { findClearCanvasPoint } from '../src/lams/irat-editor.js';

/**
 * LAMS keeps the activity Properties panel on the canvas at reduced opacity instead of
 * removing it, so a fixed dismissal click can land on the panel and change nothing.
 */
const canvasWithPanel = (panelCss: string) => `
  <style>
    body { margin: 0; }
    #canvas { position: absolute; left: 0; top: 0; width: 600px; height: 400px; background: #eee; }
    #drawing { position: absolute; left: 0; top: 0; }
    .svg-activity { position: absolute; width: 80px; height: 60px; background: #999; }
    #propertiesDialog { position: absolute; ${panelCss} background: #fff; opacity: 0.3; }
  </style>
  <div id="canvas"><svg id="drawing" width="600" height="400"></svg><div class="svg-activity" style="left: 200px; top: 150px;"></div></div>
  <div id="propertiesDialog"></div>`;

test('finds a canvas point that the properties panel does not cover', async ({ page }) => {
  await page.setContent(canvasWithPanel('left: 0; top: 0; width: 450px; height: 300px;'));

  const point = await findClearCanvasPoint(page);

  expect(point).not.toBeNull();
  // The canvas is filled by its own drawing surface, which is what a real click hits.
  const topmost = await page.evaluate((target) => document.elementFromPoint(target!.x, target!.y)?.id, point);
  expect(topmost).toBe('drawing');
});

test('skips activities as well as the panel', async ({ page }) => {
  await page.setContent(canvasWithPanel('left: 0; top: 0; width: 450px; height: 300px;'));

  const point = await findClearCanvasPoint(page);

  const onActivity = await page.evaluate(
    (target) => document.elementFromPoint(target!.x, target!.y)?.classList.contains('svg-activity'),
    point
  );
  expect(onActivity).toBe(false);
});

test('returns null when the canvas is completely covered', async ({ page }) => {
  await page.setContent(canvasWithPanel('left: 0; top: 0; width: 600px; height: 400px;'));

  expect(await findClearCanvasPoint(page)).toBeNull();
});

test('returns null when there is no canvas at all', async ({ page }) => {
  await page.setContent('<div>no canvas here</div>');

  expect(await findClearCanvasPoint(page)).toBeNull();
});
