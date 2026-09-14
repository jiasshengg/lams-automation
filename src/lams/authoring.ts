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
  timeoutMs: number
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
      { timeout: timeoutMs }
    );
  } catch (error) {
    const directory = await saveDiagnostics(page, 'properties-dialog-not-switched');
    throw new Error(
      `The properties dialog did not switch to "${expectedTitle}". Diagnostics: ${directory}`,
      { cause: error }
    );
  }
}

/**
 * Step 81 of the deployment guide: leave the Author screen once the design is saved.
 *
 * The toolbar's Close control follows the same id convention as #openButton and
 * #saveButton, so it is addressed as #closeButton and overridable through
 * selectors.closeAuthoring for a LAMS build that renames it. Authoring usually opens in
 * its own popup; when the button is genuinely absent there, closing that page leaves the
 * course page exactly where the button would have. A same-page authoring surface has no
 * such fallback, so a missing button is an error rather than a silent no-op.
 *
 * Closing an authoring page with unsaved work raises a confirm, and every caller here has
 * already saved and verified, so the handler accepts it rather than stranding the run.
 */
export async function closeAuthoring(
  authoringPage: Page,
  coursePage: Page,
  config: LamsConfig
): Promise<void> {
  if (authoringPage.isClosed()) {
    console.log('Authoring page was already closed.');
    return;
  }

  const timeout = config.browser.actionTimeoutMs;
  const selector = config.selectors.closeAuthoring ?? '#closeButton';
  const closeButton = authoringPage.locator(selector).first();
  const hasButton = await closeButton.isVisible().catch(() => false);
  const separatePage = authoringPage !== coursePage;

  if (!hasButton && !separatePage) {
    const directory = await saveDiagnostics(authoringPage, 'authoring-close-button-missing');
    throw new Error(
      `No authoring Close control matched "${selector}" and authoring is not a separate page to close. Diagnostics: ${directory}`
    );
  }

  const dialogHandler = async (dialog: { accept(): Promise<void> }) => dialog.accept();
  authoringPage.on('dialog', dialogHandler);
  try {
    if (hasButton) {
      // A LAMS modal left open over the toolbar (#ldStoreDialog after an Open/Save As, for
      // one) keeps intercepting pointer events, so a real click retries until it times out.
      // The inline handler runs either way, so an intercepted click is dispatched instead.
      try {
        await closeButton.click({ timeout: Math.min(timeout, 5_000) });
      } catch {
        await closeButton.dispatchEvent('click');
      }
      if (separatePage) {
        await authoringPage.waitForEvent('close', { timeout }).catch(() => undefined);
      } else {
        await authoringPage.waitForURL((url) => !/authoring/i.test(url.href), { timeout }).catch(() => undefined);
      }
    }
    if (separatePage && !authoringPage.isClosed()) await authoringPage.close();
  } finally {
    if (!authoringPage.isClosed()) authoringPage.off('dialog', dialogHandler);
  }

  await coursePage.bringToFront().catch(() => undefined);
  console.log(`Authoring closed via ${hasButton ? selector : 'the authoring page itself'}.`);
}
