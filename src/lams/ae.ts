import type { Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { inspectAuthoringGraph } from './authoring.js';
import { saveDiagnostics } from './diagnostics.js';
import { waitForUniqueVisible } from './navigation.js';

export async function openExactAEActivity(page: Page, nodeTitle: string, config: LamsConfig): Promise<Page> {
  const graph = await inspectAuthoringGraph(page);
  const matches = graph.nodes.filter((node) => node.type === 'tool' && node.name === nodeTitle);
  if (matches.length !== 1) {
    const directory = await saveDiagnostics(page, `ae-node-${matches.length === 0 ? 'not-found' : 'ambiguous'}`);
    throw new Error(`Expected one AE tool node named "${nodeTitle}"; found ${matches.length}. Diagnostics: ${directory}`);
  }

  const node = page.locator(`#canvas > svg > g.svg-activity-tool[uiid="${matches[0]!.uiid}"]`);
  const target = await waitForUniqueVisible(node, page, config, `AE node: ${nodeTitle}`, false);
  const popupPromise = page
    .waitForEvent('popup', { timeout: Math.min(config.browser.actionTimeoutMs, 750) })
    .catch(() => undefined);
  await target.dblclick();
  const activityPage = (await popupPromise) ?? page;
  await activityPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log(`Opened exact AE activity: ${nodeTitle}${activityPage === page ? '' : ' in a new page'}.`);
  return activityPage;
}
