import type { Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { inspectAuthoringGraph, openActivityProperties } from './authoring.js';
import { saveDiagnostics } from './diagnostics.js';

export interface GateRotationChange {
  gateName: string;
  previousSeconds: number | null;
  seconds: number;
}

/**
 * Narrowly set one password gate's dynamic-password rotation. Everything else about the
 * gate is left alone: only the rotation select is touched, and the runtime model is
 * re-read afterwards to prove the value stuck and that nothing else moved. This is a
 * deliberate, explicitly requested correction; the validator itself never edits a gate.
 */
export async function setGateRotationSeconds(
  page: Page,
  config: LamsConfig,
  gateName: string,
  seconds: number
): Promise<GateRotationChange> {
  const before = gateNode(await inspectAuthoringGraph(page), gateName);
  if (before.gateType !== 'password' || before.dynamicPassword !== true) {
    throw new Error(
      `"${gateName}" is not a dynamic-password gate (type ${before.gateType ?? 'unknown'}, dynamic ${before.dynamicPassword}); refusing to change its rotation.`
    );
  }

  await openActivityProperties(page, before.uiid, gateName, config);
  const select = page.locator('#propertiesDialog .propertiesContentFieldPasswordDynamicSeconds').first();
  await select.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await select.selectOption(String(seconds));
  await select.blur();

  const after = gateNode(await inspectAuthoringGraph(page), gateName);
  if (after.rotationSeconds !== seconds) {
    const directory = await saveDiagnostics(page, 'gate-rotation-not-applied');
    throw new Error(
      `"${gateName}" did not retain a ${seconds}s rotation; found ${after.rotationSeconds ?? 'unavailable'}. Diagnostics: ${directory}`
    );
  }
  for (const [label, previous, current] of [
    ['title', before.name, after.name],
    ['description', before.description, after.description],
    ['type', before.gateType, after.gateType],
    ['dynamic password', before.dynamicPassword, after.dynamicPassword]
  ] as const) {
    if (previous !== current) {
      throw new Error(`Changing the rotation also altered the ${label} of "${gateName}": ${previous} -> ${current}.`);
    }
  }

  return { gateName, previousSeconds: before.rotationSeconds, seconds };
}

function gateNode(graph: Awaited<ReturnType<typeof inspectAuthoringGraph>>, gateName: string) {
  const matches = graph.nodes.filter((node) => node.name === gateName && node.type === 'gate');
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one gate named "${gateName}"; found ${matches.length}.`);
  }
  return matches[0]!;
}
