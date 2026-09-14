import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { plannedGateRotations, setGateRotationSeconds } from '../src/lams/gate-properties.js';

import { copyLesson } from '../src/lams/lesson-copy.js';

/** Canvas + properties dialog shaped like the observed authoring surface. */
const SURFACE = `
  <div id="canvas"><svg>
    <g class="svg-activity svg-activity-gate" uiid="7"></g>
  </svg></div>
  <div id="propertiesDialog" style="display: block">
    <input class="propertiesContentFieldTitle" value="iRAT Gate">
    <select class="propertiesContentFieldPasswordDynamicSeconds">
      <option value="10">10</option>
      <option value="15" selected>15</option>
    </select>
  </div>
  <script>
    window.layout = { activities: [
      { uiid: 7, title: 'iRAT Gate', description: 'iRAT Gate', gateType: 'password',
        passwordDynamic: 1, passwordDynamicSeconds: 15 }
    ] };
    document.querySelector('.propertiesContentFieldPasswordDynamicSeconds')
      .addEventListener('change', function (event) {
        window.layout.activities[0].passwordDynamicSeconds = Number(event.target.value);
      });
  </script>
`;

function config(): LamsConfig {
  return { browser: { actionTimeoutMs: 2_000, readyTimeoutMs: 2_000 } } as LamsConfig;
}

test('sets the dynamic password rotation and confirms the runtime model changed', async ({ page }) => {
  await page.setContent(SURFACE);

  const result = await setGateRotationSeconds(page, config(), 'iRAT Gate', 10);

  expect(result).toEqual({ gateName: 'iRAT Gate', previousSeconds: 15, seconds: 10 });
  await expect(page.locator('.propertiesContentFieldPasswordDynamicSeconds')).toHaveValue('10');
});

test('reports a rotation that does not stick', async ({ page }) => {
  // Dialog accepts the selection but the runtime model keeps the old value.
  await page.setContent(SURFACE.replace(/window\.layout\.activities\[0\]\.passwordDynamicSeconds = Number\(event\.target\.value\);/, ''));

  await expect(setGateRotationSeconds(page, config(), 'iRAT Gate', 10)).rejects.toThrow(
    /did not retain a 10s rotation/
  );
});

test('refuses a gate that is not an exact unique match', async ({ page }) => {
  await page.setContent(SURFACE);

  await expect(setGateRotationSeconds(page, config(), 'tRAT Gate', 10)).rejects.toThrow(
    /Expected exactly one gate named "tRAT Gate"/
  );
});

test('rejects conflicting rotation requests before any mutation', async ({ page }) => {
  await page.setContent(SURFACE);
  const request = { ...config(), expectedGateProperties: [
    { name: 'iRAT Gate', rotationSeconds: 10 }, { name: 'iRAT Gate', rotationSeconds: 15 }
  ] };
  await expect(plannedGateRotations(page, request)).rejects.toThrow('Conflicting rotation');
  await expect(page.locator('select')).toHaveValue('15');
});

for (const source of ['expectedGateProperties', 'irat'] as const) {
for (const persists of [true, false]) {
  test(`copy applies rotation and verifies saved state (${source}, persists=${persists})`, async ({ page }) => {
    await page.setContent(SURFACE + `
      <h1>Source</h1><span id="ldDescriptionFieldModified" hidden>*</span>
      <button id="saveDropButton">Menu</button>
      <a href="#" onclick="document.querySelector('#save-dialog').hidden=false">Save as</a>
      <div id="save-dialog" role="dialog" aria-label="Save design" hidden>
        <div role="treeitem">Courses</div>
        <input aria-label="Type the learning design name to save">
        <button id="ldStoreDialogSaveButton" onclick="this.parentElement.hidden=true;document.querySelector('h1').textContent='Copy';document.querySelector('#copy-row').textContent='Copy'">Save</button>
      </div>
      <button id="openButton" onclick="document.querySelector('#open-dialog').hidden=false">Open</button>
      <div id="open-dialog" role="dialog" aria-label="Open design" hidden>
        <div role="treeitem">Courses</div><div id="copy-row" role="treeitem"></div>
        <button id="ldStoreDialogOpenButton" onclick="this.parentElement.hidden=true;window.layout.activities[0].passwordDynamicSeconds=window.persisted">Open</button>
        <button id="ldStoreDialogCancelButton" onclick="this.parentElement.hidden=true">Cancel</button>
      </div>
      <button id="saveButton" onclick="setTimeout(()=>{${persists ? 'window.persisted=window.layout.activities[0].passwordDynamicSeconds;' : ''}document.querySelector('#ldDescriptionFieldModified').hidden=true},150)">Save</button>
      <script>
        window.persisted=15;
        document.querySelector('select').addEventListener('change',()=>document.querySelector('#ldDescriptionFieldModified').hidden=false);
      </script>
    `);
    const request = { ...config(), sourceLessonTitle: 'Source', lessonTitle: 'Copy',
      destinationFolderPath: ['Courses'], openSourceAsCopy: true,
      ...(source === 'expectedGateProperties'
        ? { expectedGateProperties: [{ name: 'iRAT Gate', rotationSeconds: 10 }] }
        : { irat: { gate: { name: 'iRAT Gate', dynamicPassword: true, rotationSeconds: 10 } } }) } as LamsConfig;
    if (persists) {
      expect((await copyLesson(page, request, { commit: true })).committed).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { persisted: number }).persisted)).toBe(10);
      await expect(page.locator('#ldDescriptionFieldModified')).toBeHidden();
    } else {
      await expect(copyLesson(page, request, { commit: true })).rejects.toThrow('Saved copy did not retain');
    }
  });
}
}
