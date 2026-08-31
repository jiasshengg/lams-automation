import type { Locator, Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { saveDiagnostics } from './diagnostics.js';
import { fromSpec } from './locators.js';
import { clickConfigured, SelectorRequiredError } from './navigation.js';

export interface AuthoringNode {
  name: string;
  type?: string;
  frameUrl: string;
}

export interface GraphNode {
  uiid: number;
  name: string;
  type: 'gate' | 'grouping' | 'tool' | 'unknown';
  grouped: boolean;
  groupingUiid: number | null;
  x: number | null;
  y: number | null;
  toolId: number | null;
  gateType: string | null;
  description: string | null;
  dynamicPassword: boolean | null;
  rotationSeconds: number | null;
  /** Gates only: "Stop students at preceding activity?" in the properties dialog. */
  stopAtPrecedingActivity: boolean | null;
  /** Tool activities only: the configured Gradebook output, e.g. "Last total score". */
  gradebookOutput: string | null;
}

export interface GraphTransition {
  uiid: number;
  fromUiid: number | null;
  toUiid: number | null;
}

export interface AuthoringGraph {
  rendering: 'svg';
  modelAvailable: boolean;
  nodes: GraphNode[];
  transitions: GraphTransition[];
}

export async function openAuthoring(page: Page, config: LamsConfig): Promise<Page> {
  const popupPromise = page.waitForEvent('popup', { timeout: config.browser.actionTimeoutMs }).catch(() => undefined);
  const authorLink = page.getByRole('link', { name: 'Author', exact: true });
  await authorLink.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await authorLink.click();
  const authoringPage = (await popupPromise) ?? page;
  await authoringPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  await authoringPage.locator('#openButton').waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await waitForAuthoringReady(authoringPage, config);
  console.log(`Authoring surface opened${authoringPage === page ? '' : ' in a new page'}.`);
  return authoringPage;
}

/**
 * LAMS paints the authoring toolbar and canvas behind a full-page spinner and only
 * hides #loadingOverlay once the design and tool palette have finished initialising.
 * Every toolbar button is visible and enabled underneath it for that whole period, so
 * waiting for a button is not proof that it can be clicked: the overlay swallows the
 * pointer event and the click times out.
 */
export async function waitForAuthoringReady(page: Page, config: LamsConfig): Promise<void> {
  const timeout = config.browser.readyTimeoutMs ?? config.browser.actionTimeoutMs;
  try {
    // A detached overlay also counts as hidden, so this is a no-op once LAMS removes it.
    await page.locator('#loadingOverlay').waitFor({ state: 'hidden', timeout });
  } catch (error) {
    const directory = await saveDiagnostics(page, 'authoring-loading-overlay-stuck');
    throw new Error(
      `The LAMS authoring loading overlay did not clear within ${timeout}ms. Diagnostics: ${directory}`,
      { cause: error }
    );
  }
}

export async function listAuthoringNodes(page: Page, config: LamsConfig): Promise<AuthoringNode[]> {
  const selector = config.selectors.authoringNode;
  if (!selector) {
    const directory = await saveDiagnostics(page, 'authoring-node-selector-required');
    throw new SelectorRequiredError('authoringNode', directory);
  }

  const nodes: AuthoringNode[] = [];
  for (const frame of page.frames()) {
    const locator = fromSpec(frame, selector.locator, config);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const node = locator.nth(index);
      if (!(await node.isVisible().catch(() => false))) continue;
      const name = await readNodeValue(node, selector.nameAttribute);
      if (!name) continue;
      const type = selector.typeAttribute ? await node.getAttribute(selector.typeAttribute) : undefined;
      nodes.push({ name, ...(type ? { type } : {}), frameUrl: frame.url() });
    }
  }
  return deduplicate(nodes);
}

export async function inspectAuthoringGraph(page: Page): Promise<AuthoringGraph> {
  return page.evaluate(() => {
    type RuntimeActivity = {
      uiid?: number;
      title?: string;
      toolID?: number;
      gateType?: string;
      description?: string;
      gateStopAtPrecedingActivity?: boolean;
      gradebookToolOutputDefinitionDescription?: string;
      passwordDynamic?: boolean | number | null;
      passwordDynamicSeconds?: number;
      grouping?: { uiid?: number; groupingUIID?: number };
      transitions?: {
        from?: Array<{
          uiid?: number;
          fromActivity?: { uiid?: number };
          toActivity?: { uiid?: number };
        }>;
      };
    };
    const runtimeWindow = window as typeof window & { layout?: { activities?: RuntimeActivity[] } };
    const activities = Array.isArray(runtimeWindow.layout?.activities) ? runtimeWindow.layout.activities : [];
    const modelByUiid = new Map<number, RuntimeActivity>();
    activities.forEach((activity) => {
      if (Number.isFinite(activity.uiid)) modelByUiid.set(Number(activity.uiid), activity);
    });

    const activityElements = Array.from(document.querySelectorAll<SVGGElement>('#canvas > svg > g.svg-activity'));
    const nodes = activityElements.map((element) => {
      const uiid = Number(element.getAttribute('uiid'));
      const model = modelByUiid.get(uiid);
      const type: GraphNode['type'] = element.classList.contains('svg-activity-gate')
        ? 'gate'
        : element.classList.contains('svg-activity-grouping')
          ? 'grouping'
          : element.classList.contains('svg-activity-tool')
            ? 'tool'
            : 'unknown';
      const domTitle = element.querySelector('.svg-activity-title-label')?.textContent?.trim() ?? '';
      const groupingUiid = model?.grouping?.uiid ?? model?.grouping?.groupingUIID ?? null;
      return {
        uiid,
        name: model?.title?.trim() || domTitle,
        type,
        grouped: Boolean(model?.grouping) || Boolean(element.querySelector('.svg-tool-activity-border-grouped')),
        groupingUiid,
        x: numberOrNull(element.getAttribute('data-x')),
        y: numberOrNull(element.getAttribute('data-y')),
        toolId: Number.isFinite(model?.toolID) ? Number(model?.toolID) : null,
        gateType: model?.gateType ?? null,
        description: typeof model?.description === 'string' ? model.description.trim() : null,
        dynamicPassword: model?.gateType === 'password' ? Boolean(model.passwordDynamic) : null,
        rotationSeconds:
          model?.gateType === 'password' && Number.isFinite(model.passwordDynamicSeconds)
            ? Number(model.passwordDynamicSeconds)
            : null,
        stopAtPrecedingActivity:
          type === 'gate' && typeof model?.gateStopAtPrecedingActivity === 'boolean'
            ? model.gateStopAtPrecedingActivity
            : null,
        gradebookOutput:
          typeof model?.gradebookToolOutputDefinitionDescription === 'string'
            ? model.gradebookToolOutputDefinitionDescription.trim()
            : null
      };
    });

    const transitionMap = new Map<number, { uiid: number; fromUiid: number | null; toUiid: number | null }>();
    activities.forEach((activity) => {
      for (const transition of activity.transitions?.from ?? []) {
        const uiid = Number(transition.uiid);
        if (!Number.isFinite(uiid) || transitionMap.has(uiid)) continue;
        transitionMap.set(uiid, {
          uiid,
          fromUiid: finiteOrNull(transition.fromActivity?.uiid),
          toUiid: finiteOrNull(transition.toActivity?.uiid)
        });
      }
    });
    if (transitionMap.size === 0) {
      document.querySelectorAll<SVGGElement>('#canvas > svg > g').forEach((element) => {
        if (!element.querySelector(':scope > path.svg-transition')) return;
        const uiid = Number(element.getAttribute('uiid'));
        if (Number.isFinite(uiid)) transitionMap.set(uiid, { uiid, fromUiid: null, toUiid: null });
      });
    }
    return {
      rendering: 'svg' as const,
      modelAvailable: activities.length > 0,
      nodes,
      transitions: [...transitionMap.values()]
    };

    function numberOrNull(value: string | null): number | null {
      if (value === null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function finiteOrNull(value: number | undefined): number | null {
      return Number.isFinite(value) ? Number(value) : null;
    }
  });
}

async function readNodeValue(locator: Locator, attribute?: string): Promise<string> {
  const raw = attribute ? await locator.getAttribute(attribute) : await locator.innerText();
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

function deduplicate(nodes: AuthoringNode[]): AuthoringNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = `${node.frameUrl}\u0000${node.name}\u0000${node.type ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The observed LAMS properties dialog has no close control - the only button in its
 * header deletes the activity - it ignores Escape, and it lingers over neighbouring
 * activities while still intercepting pointer events. A real pointer click on the next
 * activity is therefore swallowed by the dialog, so the click is dispatched straight to
 * the SVG activity instead, and the switch is confirmed from the dialog's own title
 * field rather than assumed.
 */
export async function openActivityProperties(
  page: Page,
  uiid: number,
  expectedTitle: string,
  config: LamsConfig
): Promise<void> {
  const node = page.locator(`#canvas > svg > g.svg-activity[uiid="${uiid}"]`);
  if ((await node.count()) !== 1) {
    throw new Error(`Runtime UIID ${uiid} did not resolve to one SVG activity.`);
  }
  await node.dispatchEvent('click');
  try {
    // Two things make this read awkward. The dialog holds one title field per activity
    // and renders only the active one, so a field that is not laid out is a stale
    // sibling. And the field is an <input> carrying .value for a gate but a <span>
    // carrying text for a tool activity, so both shapes have to be read.
    await page.waitForFunction(
      ([selector, title]) => {
        const fields = Array.from(document.querySelectorAll<HTMLElement>(selector!));
        return fields.some((field) => {
          if (field.getClientRects().length === 0) return false;
          const value = (field as HTMLInputElement).value;
          const label = typeof value === 'string' ? value : (field.textContent ?? '');
          return label.trim() === title;
        });
      },
      ['#propertiesDialog .propertiesContentFieldTitle', expectedTitle] as const,
      { timeout: config.browser.actionTimeoutMs }
    );
  } catch (error) {
    const directory = await saveDiagnostics(page, 'properties-dialog-not-switched');
    throw new Error(
      `The properties dialog did not switch to "${expectedTitle}". Diagnostics: ${directory}`,
      { cause: error }
    );
  }
}
