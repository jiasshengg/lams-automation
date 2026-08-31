import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { inspectAuthoringGraph, listAuthoringNodes } from '../src/lams/authoring.js';

test('lists visible authoring node names and types from a configured DOM shape', async ({ page }) => {
  await page.setContent(`
    <style>[data-node] { width: 100px; height: 40px; }</style>
    <main data-authoring-root>
      <div data-node data-node-name="Team Setup" data-node-type="grouping"></div>
      <div data-node data-node-name="iRAT Gate" data-node-type="gate"></div>
      <div data-node data-node-name="iRAT" data-node-type="assessment"></div>
      <div data-node data-node-name="Hidden node" data-node-type="assessment" hidden></div>
    </main>
  `);

  const config = {
    selectors: {
      authoringNode: {
        locator: { by: 'css', css: '[data-node]' },
        nameAttribute: 'data-node-name',
        typeAttribute: 'data-node-type'
      }
    }
  } as LamsConfig;

  const nodes = await listAuthoringNodes(page, config);
  expect(nodes.map(({ name, type }) => ({ name, type }))).toEqual([
    { name: 'Team Setup', type: 'grouping' },
    { name: 'iRAT Gate', type: 'gate' },
    { name: 'iRAT', type: 'assessment' }
  ]);
});

test('extracts SVG nodes, grouping associations, and transition endpoints', async ({ page }) => {
  await page.setContent(`
    <div id="canvas">
      <svg>
        <g class="svg-activity svg-activity-grouping" uiid="6" data-x="40" data-y="40">
          <text class="svg-activity-title-label">Team Setup</text>
        </g>
        <g class="svg-activity svg-activity-tool" uiid="8" data-x="40" data-y="160">
          <rect class="svg-tool-activity-border-grouped"></rect>
          <text class="svg-activity-title-label">iRAT</text>
        </g>
        <g uiid="14"><path class="svg-transition"></path></g>
      </svg>
    </div>
  `);
  await page.evaluate(() => {
    (window as typeof window & { layout?: unknown }).layout = {
      activities: [
        {
          uiid: 6,
          title: 'Team Setup',
          transitions: { from: [{ uiid: 14, fromActivity: { uiid: 6 }, toActivity: { uiid: 8 } }] }
        },
        { uiid: 8, title: 'iRAT', toolID: 5, grouping: { uiid: 6 }, transitions: { from: [] } }
      ]
    };
  });

  const graph = await inspectAuthoringGraph(page);
  expect(graph.modelAvailable).toBe(true);
  expect(graph.nodes).toEqual([
    expect.objectContaining({ uiid: 6, name: 'Team Setup', type: 'grouping', grouped: false }),
    expect.objectContaining({ uiid: 8, name: 'iRAT', type: 'tool', grouped: true, groupingUiid: 6 })
  ]);
  expect(graph.transitions).toEqual([{ uiid: 14, fromUiid: 6, toUiid: 8 }]);
});
