import type { Frame, Locator } from '@playwright/test';

export interface TratAdvancedSettings {
  shuffleQuestions: boolean;
  requireAllCorrectAnswers: boolean;
  doubleClickReveal: boolean;
  teamsAnswerSelection: boolean;
  scores: boolean;
  burningQuestions: boolean;
  discussionSentimentVoting: boolean;
  discussionPad: boolean;
  dataImport: boolean;
  showConfidenceLevels: boolean;
  showVsaAnswers: boolean;
  anonymousConfidenceLevels: boolean;
}

/**
 * LAMS Scratchie (tRAT) defaults shown by the current authoring UI. Confidence display
 * is the one deliberate override, and data import is enabled because it is the parent
 * control that makes the confidence-source controls actionable.
 */
export const DEFAULT_TRAT_ADVANCED_SETTINGS: Readonly<TratAdvancedSettings> = Object.freeze({
  shuffleQuestions: false,
  requireAllCorrectAnswers: false,
  doubleClickReveal: false,
  teamsAnswerSelection: true,
  scores: true,
  burningQuestions: true,
  discussionSentimentVoting: true,
  discussionPad: false,
  dataImport: true,
  showConfidenceLevels: true,
  showVsaAnswers: false,
  anonymousConfidenceLevels: false
});

interface TratCheckboxRequirement {
  key: keyof TratAdvancedSettings;
  selector?: string;
  label: string;
}

// The IDs are from LAMS's Scratchie authoring JSP. Labels cover controls added by the
// current deployment and make the intent readable when a required control is missing.
const TRAT_CHECKBOXES: readonly TratCheckboxRequirement[] = Object.freeze([
  { key: 'shuffleQuestions', selector: '#shuffle-items', label: 'Shuffle questions' },
  {
    key: 'requireAllCorrectAnswers',
    selector: '#require-all-answers',
    label: 'Require to reveal all correct answers before proceeding'
  },
  {
    key: 'doubleClickReveal',
    selector: '#reveal-on-double-click',
    label: 'Require double click to reveal an answer'
  },
  {
    key: 'teamsAnswerSelection',
    selector: '#show-scratchies-in-results',
    label: "Teams' answer selection"
  },
  { key: 'scores', label: 'Scores' },
  {
    key: 'burningQuestions',
    selector: '#burning-questions-enabled',
    label: 'Enable burning questions'
  },
  {
    key: 'discussionSentimentVoting',
    selector: '#discussion-sentiment-enabled',
    label: 'Enable discussion sentiment voting'
  },
  {
    key: 'discussionPad',
    selector: '#question-etherpad-enabled',
    label: 'Include discussion pad for questions'
  },
  {
    key: 'dataImport',
    label: 'Imports confidence levels or VSAs responses data from other Assessment activities'
  },
  {
    key: 'showConfidenceLevels',
    selector: '#display-confidence-levels-activities',
    label: 'Show confidence levels from'
  },
  {
    key: 'showVsaAnswers',
    selector: '#display-activities-providing-vsa-answers',
    label: 'Show VSA answers from'
  },
  {
    key: 'anonymousConfidenceLevels',
    selector: '#confidence-levels-anonymous',
    label: "Do not display students' names with confidence level (anonymous)"
  }
]);

export interface TratSettingsCheck {
  key: keyof TratAdvancedSettings;
  expected: boolean;
  actual: boolean;
  changed: boolean;
}

export interface TratSettingsReport {
  passed: boolean;
  changesApplied: number;
  confidenceSourceActivityName: string;
  checks: TratSettingsCheck[];
}

export async function applyTratAdvancedSettings(
  frame: Frame,
  confidenceSourceActivityName: string,
  settings: TratAdvancedSettings = { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
  options: { commit: boolean; timeoutMs: number } = { commit: true, timeoutMs: 15_000 }
): Promise<TratSettingsReport> {
  await openAdvancedSettings(frame, options.timeoutMs);
  const checks: TratSettingsCheck[] = [];

  for (const requirement of TRAT_CHECKBOXES) {
    const toggle = await uniqueCheckbox(frame, requirement, options.timeoutMs);
    const before = await toggle.isChecked();
    const expected = settings[requirement.key];
    if (options.commit && before !== expected) await toggle.setChecked(expected);
    const actual = await toggle.isChecked();
    if (options.commit && actual !== expected) {
      throw new Error(`tRAT advanced setting "${requirement.label}" did not remain ${expected ? 'enabled' : 'disabled'}.`);
    }
    checks.push({ key: requirement.key, expected, actual, changed: options.commit && before !== actual });
  }

  const source = frame.locator('#confidence-levels-activity');
  if ((await source.count()) !== 1) {
    throw new Error(`Expected one tRAT confidence-level source selector; found ${await source.count()}.`);
  }
  if (options.commit) await source.selectOption({ label: confidenceSourceActivityName });
  const selectedSource = normalizeText(await source.locator('option:checked').textContent() ?? '');
  if (selectedSource !== normalizeText(confidenceSourceActivityName)) {
    throw new Error(
      `tRAT confidence source is "${selectedSource}"; expected "${confidenceSourceActivityName}".`
    );
  }

  return {
    passed: checks.every((check) => check.actual === check.expected),
    changesApplied: checks.filter((check) => check.changed).length,
    confidenceSourceActivityName,
    checks
  };
}

async function openAdvancedSettings(frame: Frame, timeoutMs: number): Promise<void> {
  const firstSetting = frame.locator('#shuffle-items');
  if (await firstSetting.isVisible().catch(() => false)) return;

  const tabs = frame.getByRole('tab', { name: 'Advanced', exact: true });
  const links = frame.getByRole('link', { name: 'Advanced', exact: true });
  const buttons = frame.getByRole('button', { name: 'Advanced', exact: true });
  const candidates = [tabs, links, buttons];
  for (const candidate of candidates) {
    if ((await candidate.count()) === 1 && await candidate.isVisible()) {
      await candidate.click();
      await firstSetting.waitFor({ state: 'visible', timeout: timeoutMs });
      return;
    }
  }
  throw new Error('Could not reveal the tRAT Advanced settings panel from its accessible control.');
}

async function uniqueCheckbox(
  frame: Frame,
  requirement: TratCheckboxRequirement,
  timeoutMs: number
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  do {
    const byId = requirement.selector ? frame.locator(requirement.selector) : undefined;
    if (byId && (await byId.count()) === 1) return byId;
    const byLabel = frame.getByLabel(requirement.label, { exact: false });
    const checkboxes: Locator[] = [];
    for (let index = 0; index < (await byLabel.count()); index += 1) {
      const candidate = byLabel.nth(index);
      if ((await candidate.getAttribute('type')) === 'checkbox' || (await candidate.getAttribute('role')) === 'checkbox') {
        checkboxes.push(candidate);
      }
    }
    if (checkboxes.length === 1) return checkboxes[0]!;
    if (checkboxes.length > 1 || (byId && (await byId.count()) > 1)) {
      throw new Error(`Expected one tRAT checkbox "${requirement.label}"; found multiple.`);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`Expected one tRAT checkbox "${requirement.label}"; found 0.`);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
