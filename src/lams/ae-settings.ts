import type { Frame, Locator, Page } from '@playwright/test';

export interface AECheckboxRequirement {
  key: string;
  label: string;
  expected: boolean;
}

export const AE_ACTIVITY_CHECKBOXES: readonly AECheckboxRequirement[] = Object.freeze([
  { key: 'shuffleQuestions', label: 'Shuffle questions', expected: false },
  { key: 'shuffleAnswers', label: 'Shuffle answers', expected: false },
  { key: 'questionNumbering', label: "Enable questions' numbering", expected: false },
  {
    key: 'displayAllAfterCompletion',
    label: 'Display all questions and answers once the student finishes.',
    expected: true
  },
  {
    key: 'questionFeedback',
    label: 'Allow students to see question feedback after each question',
    expected: false
  },
  {
    key: 'discloseAnswersInMonitor',
    label: "Disclose student's and other groups' answers in monitor",
    expected: true
  },
  { key: 'peerRating', label: "Allow students to rate peers' answers", expected: false },
  { key: 'answerJustification', label: 'Enable answer justification', expected: true },
  { key: 'burningQuestions', label: 'Enable burning questions', expected: false },
  { key: 'focusTracking', label: 'Enable focus tracking', expected: false },
  { key: 'discussionNotepad', label: 'Include discussion notepad for questions', expected: false },
  { key: 'discussionSentimentVoting', label: 'Enable discussion sentiment voting', expected: true },
  { key: 'confidenceLevel', label: 'Enable confidence level', expected: false },
  { key: 'useSelectLeaderToolLeaders', label: 'Use leaders from Select Leader tool', expected: true }
]);

export interface AEActivitySettingCheck {
  key: string;
  label: string;
  expected: boolean;
  actual: boolean;
  changed: boolean;
  frameUrl: string;
}

export interface AEActivitySettingsReport {
  passed: boolean;
  commit: boolean;
  changesRequired: number;
  changesApplied: number;
  checks: AEActivitySettingCheck[];
}

export interface ApplyAEActivitySettingsOptions {
  commit: boolean;
  actionTimeoutMs: number;
}

export async function applyAEActivitySettings(
  page: Page,
  options: ApplyAEActivitySettingsOptions
): Promise<AEActivitySettingsReport> {
  const checks: AEActivitySettingCheck[] = [];

  for (const requirement of AE_ACTIVITY_CHECKBOXES) {
    const match = await findUniqueCheckbox(page, requirement.label, options.actionTimeoutMs);
    const actual = await match.locator.isChecked();
    let changed = false;
    if (options.commit && actual !== requirement.expected) {
      await match.locator.setChecked(requirement.expected);
      const verified = await match.locator.isChecked();
      if (verified !== requirement.expected) {
        throw new Error(`Checkbox "${requirement.label}" did not remain ${requirement.expected ? 'enabled' : 'disabled'}`);
      }
      changed = true;
    }
    checks.push({
      key: requirement.key,
      label: requirement.label,
      expected: requirement.expected,
      actual: options.commit && changed ? requirement.expected : actual,
      changed,
      frameUrl: match.frame.url()
    });
  }

  const changesRequired = checks.filter((check) => !check.changed && check.actual !== check.expected).length +
    checks.filter((check) => check.changed).length;
  const changesApplied = checks.filter((check) => check.changed).length;
  return {
    passed: checks.every((check) => check.actual === check.expected),
    commit: options.commit,
    changesRequired,
    changesApplied,
    checks
  };
}

export async function findUniqueCheckbox(
  page: Page,
  label: string,
  timeoutMs: number
): Promise<{ locator: Locator; frame: Frame }> {
  const deadline = Date.now() + timeoutMs;
  do {
    const matches: Array<{ locator: Locator; frame: Frame }> = [];
    for (const frame of page.frames()) {
      const locator = frame.getByLabel(label, { exact: false });
      for (let index = 0; index < (await locator.count()); index += 1) {
        const candidate = locator.nth(index);
        const type = await candidate.getAttribute('type');
        const role = await candidate.getAttribute('role');
        if (type === 'checkbox' || role === 'checkbox') matches.push({ locator: candidate, frame });
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Could not find exactly one checkbox labelled "${label}"; found ${matches.length}`);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  throw new Error(`Could not find exactly one checkbox labelled "${label}"; found 0`);
}
