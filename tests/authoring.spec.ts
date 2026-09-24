import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { inspectAuthoringGraph, listAuthoringNodes, openActivityProperties, waitForAuthoringReady } from '../src/lams/authoring.js';
import { openExactAEActivity } from '../src/lams/ae.js';

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
        <g class="svg-activity svg-activity-gate" uiid="7" data-x="40" data-y="100"></g>
        <g class="svg-activity svg-activity-tool" uiid="8" data-x="40" data-y="160">
          <rect class="svg-tool-activity-border-grouped"></rect>
          <text class="svg-activity-title-label">iRAT</text>
        </g>
        <g uiid="14"><path class="svg-transition"></path></g>
        <g uiid="15"><path class="svg-transition"></path></g>
      </svg>
    </div>
  `);
  await page.evaluate(() => {
    (window as typeof window & { layout?: unknown }).layout = {
      activities: [
        {
          uiid: 6,
          title: 'Team Setup',
          transitions: { from: [{ uiid: 14, fromActivity: { uiid: 6 }, toActivity: { uiid: 7 } }] }
        },
        {
          uiid: 7,
          title: 'iRAT Gate',
          description: 'iRAT Gate',
          gateType: 'password',
          passwordDynamic: 1,
          passwordDynamicSeconds: 10,
          transitions: { from: [{ uiid: 15, fromActivity: { uiid: 7 }, toActivity: { uiid: 8 } }] }
        },
        { uiid: 8, title: 'iRAT', toolID: 5, grouping: { uiid: 6 }, transitions: { from: [] } }
      ]
    };
  });

  const graph = await inspectAuthoringGraph(page);
  expect(graph.modelAvailable).toBe(true);
  expect(graph.nodes).toEqual([
    expect.objectContaining({ uiid: 6, name: 'Team Setup', type: 'grouping', grouped: false }),
    expect.objectContaining({
      uiid: 7,
      name: 'iRAT Gate',
      type: 'gate',
      gateType: 'password',
      description: 'iRAT Gate',
      dynamicPassword: true,
      rotationSeconds: 10
    }),
    expect.objectContaining({ uiid: 8, name: 'iRAT', type: 'tool', grouped: true, groupingUiid: 6 })
  ]);
  expect(graph.transitions).toEqual([
    { uiid: 14, fromUiid: 6, toUiid: 7 },
    { uiid: 15, fromUiid: 7, toUiid: 8 }
  ]);
});

test('opens one exact AE activity by double-clicking its SVG node', async ({ page }) => {
  await page.setContent(`
    <div id="canvas">
      <svg width="500" height="300">
        <g class="svg-activity svg-activity-tool" uiid="21" ondblclick="document.querySelector('#ae-editor').hidden = false">
          <rect width="120" height="50"></rect>
          <text class="svg-activity-title-label" x="5" y="20">AE Case 1</text>
        </g>
      </svg>
    </div>
    <section id="ae-editor" hidden><h1>Assessment editor</h1></section>
  `);
  const config = {
    browser: { actionTimeoutMs: 2_000 },
    selectors: {}
  } as LamsConfig;

  const activityPage = await openExactAEActivity(page, 'AE Case 1', config);

  expect(activityPage).toBe(page);
  await expect(page.getByRole('heading', { name: 'Assessment editor' })).toBeVisible();
});

test('opens activity properties through an overlaying dialog and confirms the switch', async ({ page }) => {
  // The dialog covers the canvas and cannot be closed, so a real click never lands.
  await page.setContent(`
    <style>#propertiesDialog { position: fixed; inset: 0; }</style>
    <div id="canvas"><svg>
      <g class="svg-activity" uiid="7"></g>
      <g class="svg-activity" uiid="8"></g>
    </svg></div>
    <div id="propertiesDialog"><input class="propertiesContentFieldTitle" value="iRAT Gate"></div>
    <script>
      document.querySelectorAll('#canvas > svg > g.svg-activity').forEach(function (node) {
        node.addEventListener('click', function () {
          document.querySelector('.propertiesContentFieldTitle').value =
            node.getAttribute('uiid') === '8' ? 'iRAT' : 'iRAT Gate';
        });
      });
    </script>
  `);

  await openActivityProperties(page, 8, 'iRAT', 2_000);
  await expect(page.locator('.propertiesContentFieldTitle')).toHaveValue('iRAT');
});

test('reports a properties dialog that never shows the requested activity', async ({ page }) => {
  await page.setContent(`
    <div id="canvas"><svg><g class="svg-activity" uiid="7"></g></svg></div>
    <div id="propertiesDialog"><input class="propertiesContentFieldTitle" value="iRAT Gate"></div>
  `);

  await expect(
    openActivityProperties(page, 7, 'iRAT', 1_000)
  ).rejects.toThrow(/did not switch to "iRAT"/);
});

test('ignores stale hidden title fields from other activities', async ({ page }) => {
  // Observed live: the dialog carries one title field per activity and renders only
  // the active one, so the first match is a stale sibling.
  await page.setContent(`
    <div id="canvas"><svg><g class="svg-activity" uiid="8"></g></svg></div>
    <div id="propertiesDialog">
      <div style="display: none"><input class="propertiesContentFieldTitle" value="iRAT Gate"></div>
      <div><input class="propertiesContentFieldTitle" value="stale"></div>
    </div>
    <script>
      document.querySelector('g.svg-activity').addEventListener('click', function () {
        document.querySelectorAll('.propertiesContentFieldTitle')[1].value = 'iRAT';
      });
    </script>
  `);

  await openActivityProperties(page, 8, 'iRAT', 2_000);
  await expect(page.locator('.propertiesContentFieldTitle').nth(1)).toHaveValue('iRAT');
});

test('exposes gate stop-at-preceding and tool gradebook output from the runtime model', async ({ page }) => {
  // Runtime field names confirmed live: gateStopAtPrecedingActivity and
  // gradebookToolOutputDefinitionDescription ("Last total score").
  await page.setContent(`
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-gate" uiid="7"></g>
      <g class="svg-activity svg-activity-tool" uiid="8"></g>
    </svg></div>
    <script>
      window.layout = { activities: [
        { uiid: 7, title: 'AE Gate AE Case 3 Q3-6', gateType: 'permission', gateStopAtPrecedingActivity: true },
        { uiid: 8, title: 'AE Case 3 Q3-6', toolID: 19, gradebookToolOutputDefinitionDescription: 'Last total score' }
      ] };
    </script>
  `);

  const graph = await inspectAuthoringGraph(page);
  expect(graph.nodes.find((node) => node.uiid === 7)?.stopAtPrecedingActivity).toBe(true);
  expect(graph.nodes.find((node) => node.uiid === 8)?.gradebookOutput).toBe('Last total score');
});

test('confirms a tool activity whose dialog title is a span, not an input', async ({ page }) => {
  // Observed live: a gate's properties title is an <input> carrying .value, but a tool
  // activity's is a <span> whose text is the title, so reading .value alone never matches.
  await page.setContent(`
    <div id="canvas"><svg><g class="svg-activity" uiid="8"></g></svg></div>
    <div id="propertiesDialog"><span class="propertiesContentFieldTitle">Team Setup</span></div>
    <script>
      document.querySelector('g.svg-activity').addEventListener('click', function () {
        document.querySelector('.propertiesContentFieldTitle').textContent = 'iRAT';
      });
    </script>
  `);

  await openActivityProperties(page, 8, 'iRAT', 2_000);
  await expect(page.locator('.propertiesContentFieldTitle')).toHaveText('iRAT');
});

test('a floating toast or help widget no longer swallows an authoring click', async ({ page }) => {
  // Both overlays were observed intercepting the iRAT question Delete control: LAMS's own
  // "Design autosaved" toast, and the help widget the page embeds. Neither is part of the design.
  await page.setContent(`
    <div id="loadingOverlay" style="display: none"></div>
    <button id="deleteQuestion" style="position: fixed; top: 20px; right: 20px; width: 120px; height: 40px">Delete</button>
    <div id="authoringToastContainer" class="toast-container position-fixed top-0 end-0 p-3" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px; background: rgba(0,0,0,.1)">
      <div class="toast-body">Design autosaved</div>
    </div>
    <button id="gitbook-widget-button" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px"></button>
    <script>document.getElementById('deleteQuestion').addEventListener('click', () => { window.deleted = true; });</script>
  `);
  const config = { browser: { actionTimeoutMs: 2000 } } as LamsConfig;

  await waitForAuthoringReady(page, config);

  await page.locator('#deleteQuestion').click({ timeout: 2000 });
  expect(await page.evaluate(() => (window as unknown as { deleted?: boolean }).deleted)).toBe(true);
  // The toast still shows what LAMS wants to say; it just cannot take the click.
  await expect(page.locator('#authoringToastContainer')).toBeVisible();
});

test('the click-through rule survives the navigation that opening a lesson performs', async ({ page }) => {
  const blockers = `
    <div id="loadingOverlay" style="display: none"></div>
    <button id="target" style="position: fixed; top: 20px; right: 20px; width: 120px; height: 40px">Print</button>
    <button id="gitbook-widget-button" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px"></button>
    <script>document.getElementById('target').addEventListener('click', () => { window.clicked = true; });</script>
  `;
  await page.route('**/openAuthoring.do*', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<html><head></head><body>${blockers}</body></html>` })
  );
  await page.goto('https://lams.test/authoring/openAuthoring.do');
  const config = { browser: { actionTimeoutMs: 2000 } } as LamsConfig;
  await waitForAuthoringReady(page, config);

  // Opening a lesson reloads the authoring page; the rule has to come back with it.
  await page.goto('https://lams.test/authoring/openAuthoring.do?lesson=2');

  await page.locator('#target').click({ timeout: 2000 });
  expect(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked)).toBe(true);
});

test('a help widget inside a shadow root is made click-through too', async ({ page }) => {
  // The embedded widget renders in a shadow root, where a page stylesheet cannot reach it, so the
  // element itself has to be told not to take pointer events.
  await page.setContent(`
    <div id="loadingOverlay" style="display: none"></div>
    <button id="target" style="position: fixed; top: 20px; right: 20px; width: 120px; height: 40px">Print</button>
    <div id="widget-host"></div>
    <script>
      const host = document.getElementById('widget-host').attachShadow({ mode: 'open' });
      host.innerHTML = '<button data-color-scheme="light" id="gitbook-widget-button" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px"></button>';
      document.getElementById('target').addEventListener('click', () => { window.clicked = true; });
    </script>
  `);

  await waitForAuthoringReady(page, { browser: { actionTimeoutMs: 2000 } } as LamsConfig);

  await page.locator('#target').click({ timeout: 2000 });
  expect(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked)).toBe(true);
});

test('the help widget iframe and its wrapper stop taking clicks, whatever they are named', async ({ page }) => {
  // The widget is injected as a bare <iframe> with no id or class, inside its own wrapper, and
  // only its URL identifies it. Playwright reports the button inside it as the interceptor.
  await page.route('**/~gitbook/embed*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button id="gitbook-widget-button" style="width:100%;height:100%"></button>' })
  );
  await page.route('**/openAuthoring.do*', (route) =>
    route.fulfill({ contentType: 'text/html', body: `
      <div id="loadingOverlay" style="display: none"></div>
      <button id="target" style="position: fixed; top: 20px; right: 20px; width: 120px; height: 40px">Print</button>
      <div id="wrapper" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px">
        <iframe style="width: 300px; height: 200px; border: 0" src="/lams/~gitbook/embed?theme=light"></iframe>
      </div>
      <script>document.getElementById('target').addEventListener('click', () => { window.clicked = true; });</script>` })
  );
  await page.goto('https://lams.test/authoring/openAuthoring.do');

  await waitForAuthoringReady(page, { browser: { actionTimeoutMs: 2000 } } as LamsConfig);

  await page.locator('#target').click({ timeout: 2000 });
  expect(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked)).toBe(true);
});

test('the help widget is found by the frame it loads, not by any attribute on the page', async ({ page }) => {
  // The real widget's iframe has no src attribute: the page hands it its document, so only the
  // browser's frame list knows where it came from.
  await page.route('**/~gitbook/embed*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<button id="gitbook-widget-button" style="width:100%;height:100%"></button>' })
  );
  await page.route('**/openAuthoring.do*', (route) =>
    route.fulfill({ contentType: 'text/html', body: `
      <div id="loadingOverlay" style="display: none"></div>
      <button id="target" style="position: fixed; top: 20px; right: 20px; width: 120px; height: 40px">Print</button>
      <div id="wrapper" style="position: fixed; top: 0; right: 0; width: 300px; height: 200px"><iframe style="width:300px;height:200px;border:0"></iframe></div>
      <script>
        document.getElementById('target').addEventListener('click', () => { window.clicked = true; });
        document.querySelector('iframe').contentWindow.location.replace('/lams/~gitbook/embed?theme=light');
      </script>` })
  );
  await page.goto('https://lams.test/authoring/openAuthoring.do');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.location.href.includes('gitbook'));

  await waitForAuthoringReady(page, { browser: { actionTimeoutMs: 2000 } } as LamsConfig);

  await page.locator('#target').click({ timeout: 2000 });
  expect(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked)).toBe(true);
});
