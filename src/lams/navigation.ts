import type { Locator, Page } from '@playwright/test';
import type { LamsConfig, LocatorSpec } from '../config.js';
import { saveDiagnostics } from './diagnostics.js';
import { fromSpec } from './locators.js';

export class SelectorRequiredError extends Error {
  constructor(
    public readonly selectorName: string,
    public readonly artifactDirectory: string
  ) {
    super(`Selector "${selectorName}" is not configured. Diagnostics saved to ${artifactDirectory}.`);
  }
}

export async function openLams(page: Page, config: LamsConfig): Promise<void> {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');
  console.log(`Opened LAMS: ${page.url()}`);
}

export async function verifyWorkspaceCourse(page: Page, config: LamsConfig): Promise<void> {
  const heading = page.getByRole('heading', { name: config.workspaceCourse, exact: true });
  await waitForUniqueVisible(heading, page, config, 'workspaceCourse', true);
  console.log(`Verified safe workspace: ${config.workspaceCourse}`);
}

export async function selectWorkspaceCourse(page: Page, config: LamsConfig): Promise<void> {
  const heading = page.getByRole('heading', { name: config.workspaceCourse, exact: true });
  if (await hasOneVisibleMatch(heading)) {
    console.log(`Verified safe workspace: ${config.workspaceCourse}`);
    return;
  }

  const toggle = page.getByRole('button', { name: 'Toggle course menu', exact: true });
  await (await waitForUniqueVisible(toggle, page, config, 'course menu', true)).click();

  const search = page.getByRole('searchbox', { name: 'Search for courses', exact: true });
  await (await waitForUniqueVisible(search, page, config, 'course search', false)).fill(config.workspaceCourse);

  // The observed course-search results expose each course as an exact-name button.
  // Only the configured safety-boundary course is eligible for selection here.
  const course = page.getByRole('button', { name: config.workspaceCourse, exact: true });
  await (await waitForUniqueVisible(course, page, config, 'workspace course result', false)).click();

  await waitForUniqueVisible(heading, page, config, 'workspaceCourse', false);
  console.log(`Selected and verified safe workspace: ${config.workspaceCourse}`);
}

export async function navigateToPreviousCohort(page: Page, config: LamsConfig): Promise<void> {
  await clickConfigured(page, config, 'previousCohort', config.selectors.previousCohort, true);
  await assertNextTarget(page, config, 'tbl', config.selectors.tbl);
}

export async function findAndOpenTbl(page: Page, config: LamsConfig): Promise<void> {
  await clickConfigured(page, config, 'tbl', config.selectors.tbl, false);
  if (config.selectors.openLesson) {
    await assertNextTarget(page, config, 'openLesson', config.selectors.openLesson);
    await clickConfigured(page, config, 'openLesson', config.selectors.openLesson, false);
  }
  await assertNextTarget(page, config, 'openAuthoring', config.selectors.openAuthoring);
}

export async function clickConfigured(
  page: Page,
  config: LamsConfig,
  name: string,
  spec: LocatorSpec | undefined,
  allowManualLogin: boolean
): Promise<void> {
  if (!spec) throw await missingSelector(page, name);
  const locator = fromSpec(page, spec, config);
  const target = await waitForUniqueVisible(locator, page, config, name, allowManualLogin);

  const previousUrl = page.url();
  await target.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log(`Completed ${name}; URL ${previousUrl === page.url() ? 'unchanged' : `changed to ${page.url()}`}.`);
}

export async function waitForUniqueVisible(
  locator: Locator,
  page: Page,
  config: LamsConfig,
  name: string,
  allowManualLogin: boolean
): Promise<Locator> {
  const timeout = allowManualLogin ? config.browser.manualLoginTimeoutMs : config.browser.actionTimeoutMs;
  if (allowManualLogin) {
    console.log(`Waiting up to ${Math.round(timeout / 1000)}s for "${name}". Log in manually if LAMS prompts you.`);
  }
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
  } catch (error) {
    const directory = await saveDiagnostics(page, `${name}-not-found`);
    throw new Error(`Could not find a visible "${name}" target. Diagnostics: ${directory}`, { cause: error });
  }
  const visible: Locator[] = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  if (visible.length !== 1) {
    const directory = await saveDiagnostics(page, `${name}-ambiguous`);
    throw new Error(`Expected one visible "${name}" target, found ${visible.length}. Diagnostics: ${directory}`);
  }
  return visible[0]!;
}

async function assertNextTarget(
  page: Page,
  config: LamsConfig,
  name: string,
  spec: LocatorSpec | undefined
): Promise<void> {
  if (!spec) throw await missingSelector(page, name);
  await waitForUniqueVisible(fromSpec(page, spec, config), page, config, name, false);
  console.log(`Verified expected next target: ${name}.`);
}

async function hasOneVisibleMatch(locator: Locator): Promise<boolean> {
  let visible = 0;
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible()) visible += 1;
  }
  return visible === 1;
}

async function missingSelector(page: Page, name: string): Promise<SelectorRequiredError> {
  const directory = await saveDiagnostics(page, `${name}-selector-required`);
  return new SelectorRequiredError(name, directory);
}
