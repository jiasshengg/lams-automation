import type { Locator, Page } from '@playwright/test';
import type { LamsConfig, LocatorSpec } from '../config.js';
import { saveDiagnostics } from './diagnostics.js';
import { fromSpec } from './locators.js';

/** Grace period for the dashboard heading to paint before re-selecting the course. */
const HEADING_SETTLE_MS = 1_000;

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

export async function selectWorkspaceCourse(page: Page, config: LamsConfig): Promise<void> {
  const exactHeading = page.getByRole('heading', { name: config.workspaceCourse, exact: true });
  const partialHeading = page.getByRole('heading', { name: config.workspaceCourse, exact: false });
  const toggle = page.getByRole('button', { name: 'Toggle course menu', exact: true });

  // The dashboard heading paints after domcontentloaded, so an instantaneous check can
  // miss an already-selected course and needlessly drive the course menu. Wait for the
  // menu toggle first, which ships in the same header and doubles as the manual-login
  // gate, then give the heading a short grace period before deciding the configured
  // course still has to be selected.
  const toggleTarget = await waitForVisibleTarget(toggle, page, config, 'course menu', true);
  await partialHeading.first().waitFor({ state: 'visible', timeout: HEADING_SETTLE_MS }).catch(() => undefined);
  const activeHeading = await preferExactUniqueMatch(exactHeading, partialHeading, page, 'active workspace course', false);
  if (activeHeading) {
    console.log(`Opened configured course: ${normaliseVisibleText(await activeHeading.innerText())}`);
    return;
  }

  await toggleTarget.click();

  const search = page.getByRole('searchbox', { name: 'Search for courses', exact: true });
  await (await waitForVisibleTarget(search, page, config, 'course search', false)).fill(config.workspaceCourse);

  // Each observed course entry is a <button> that overrides its implicit role with
  // role="listitem", so a button-role lookup alone never matches it. listitem takes no
  // name from its contents either, so that variant is matched on its label node.
  // Prefer one exact result; otherwise require exactly one partial result.
  const exactCourse = page
    .getByRole('button', { name: config.workspaceCourse, exact: true })
    .or(
      page
        .getByRole('listitem')
        .filter({ has: page.getByText(config.workspaceCourse, { exact: true }) })
    );
  const partialCourse = page
    .getByRole('button', { name: config.workspaceCourse, exact: false })
    .or(
      page
        .getByRole('listitem')
        .filter({ has: page.getByText(config.workspaceCourse, { exact: false }) })
    );
  await waitForVisibleTarget(partialCourse, page, config, 'workspace course result', false);
  const course = await preferExactUniqueMatch(exactCourse, partialCourse, page, 'workspace course result', true);
  if (!course) throw new Error(`No visible workspace course matches "${config.workspaceCourse}".`);
  const selectedCourseName = normaliseVisibleText(await course.innerText());
  await course.click();

  await waitForVisibleTarget(page.getByRole('heading', { name: selectedCourseName, exact: true }), page, config, 'workspaceCourse', false);
  console.log(`Opened configured course: ${selectedCourseName}`);
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
  const target = await waitForVisibleTarget(locator, page, config, name, allowManualLogin);

  const previousUrl = page.url();
  await target.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log(`Completed ${name}; URL ${previousUrl === page.url() ? 'unchanged' : `changed to ${page.url()}`}.`);
}

export async function waitForVisibleTarget(
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
    await locator.filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
  } catch (error) {
    const directory = await saveDiagnostics(page, `${name}-not-found`);
    throw new Error(`Could not find a visible "${name}" target. Diagnostics: ${directory}`, { cause: error });
  }
  // Repeated matching navigation controls use DOM order; missing controls still fail.
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error(`No visible "${name}" target remains.`);
}

async function assertNextTarget(
  page: Page,
  config: LamsConfig,
  name: string,
  spec: LocatorSpec | undefined
): Promise<void> {
  if (!spec) throw await missingSelector(page, name);
  await waitForVisibleTarget(fromSpec(page, spec, config), page, config, name, false);
  console.log(`Verified expected next target: ${name}.`);
}

async function preferExactUniqueMatch(
  exact: Locator,
  partial: Locator,
  page: Page,
  label: string,
  requirePartial: boolean
): Promise<Locator | undefined> {
  const exactMatches = await visibleMatches(exact);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) throw await ambiguousMatch(page, label, exactMatches);

  const partialMatches = await visibleMatches(partial);
  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length > 1) throw await ambiguousMatch(page, label, partialMatches);
  if (requirePartial) throw new Error(`No visible ${label} matches the supplied course search.`);
  return undefined;
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const matches: Locator[] = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) matches.push(candidate);
  }
  return matches;
}

async function ambiguousMatch(page: Page, label: string, matches: Locator[]): Promise<Error> {
  const names = await Promise.all(matches.map(async (match) => normaliseVisibleText(await match.innerText())));
  const directory = await saveDiagnostics(page, `${label.replaceAll(' ', '-')}-ambiguous`);
  return new Error(`Ambiguous ${label}; matched ${names.map((name) => `"${name}"`).join(', ')}. Diagnostics: ${directory}`);
}

function normaliseVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function missingSelector(page: Page, name: string): Promise<SelectorRequiredError> {
  const directory = await saveDiagnostics(page, `${name}-selector-required`);
  return new SelectorRequiredError(name, directory);
}
