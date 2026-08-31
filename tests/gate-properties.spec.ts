import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { setGateRotationSeconds } from '../src/lams/gate-properties.js';

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
