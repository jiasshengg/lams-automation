import type { Frame, Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';

/**
 * Reads the 5-digit code learners type to join a lesson, from the monitoring page.
 *
 * The hazard here is that a LAMS lesson ID is also five digits (41276), and monitoring
 * prints it in links, hrefs and hidden inputs many times over. A bare /\d{5}/ scan over
 * the page would therefore return the lesson ID with total confidence. So a candidate
 * only counts when its surrounding text names it as a code, and the known lesson ID is
 * excluded outright.
 */

/** Words LAMS and its skins use next to the learner-facing code. */
const CODE_LABEL = /\b(join|access|lesson|class|entry)?\s*(code|key|pin|passcode)\b/i;

/** Attributes worth reading a code out of when the element renders no text. */
const VALUE_ATTRIBUTES = ['value', 'data-code', 'data-join-code', 'title', 'aria-label'];

export interface LessonCodeCandidate {
  code: string;
  /** Trimmed text around the match, for both matching and failure messages. */
  context: string;
  source: string;
  labelled: boolean;
}

export interface LessonCodeResult {
  code: string;
  candidate: LessonCodeCandidate;
}

/**
 * Picks the code from harvested candidates, or explains why it will not guess.
 * Labelled candidates win outright; unlabelled ones are never promoted, because the
 * only thing distinguishing a code from a lesson ID on this page is its label.
 */
export function selectLessonCode(candidates: LessonCodeCandidate[], excludeIds: string[] = []): LessonCodeResult {
  const excluded = new Set(excludeIds);
  const usable = candidates.filter((candidate) => !excluded.has(candidate.code));
  const labelled = usable.filter((candidate) => candidate.labelled);

  if (labelled.length === 0) {
    const seen = unique(usable.map((candidate) => `${candidate.code} (${candidate.source})`));
    throw new Error(
      'No labelled 5-digit lesson code found on the monitoring page. ' +
        (seen.length > 0
          ? `Unlabelled 5-digit values seen: ${seen.slice(0, 10).join(', ')}. `
          : 'No 5-digit values were present at all. ') +
        'Run `npm run discover:lesson-code` and share the dump so the exact element can be pinned.'
    );
  }

  const distinct = unique(labelled.map((candidate) => candidate.code));
  if (distinct.length > 1) {
    throw new Error(
      `Found ${distinct.length} different labelled 5-digit codes (${distinct.join(', ')}); refusing to guess. ` +
        `Contexts: ${labelled.map((candidate) => `"${candidate.context}"`).slice(0, 6).join(' | ')}`
    );
  }

  return { code: distinct[0]!, candidate: labelled[0]! };
}

/** Harvests every 5-digit candidate, with the visible text around it, from one frame. */
export async function collectLessonCodeCandidates(frame: Frame): Promise<LessonCodeCandidate[]> {
  const raw = await frame
    .evaluate((attributes: string[]) => {
      const found: { code: string; context: string; source: string }[] = [];
      const push = (code: string, context: string, source: string) => {
        found.push({ code, context: context.replace(/\s+/g, ' ').trim().slice(0, 200), source });
      };

      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (element.children.length === 0) {
          const text = (element.textContent ?? '').trim();
          for (const match of text.matchAll(/\b\d{5}\b/g)) {
            // The parent's text carries the label that a bare <span>12345</span> lacks.
            const context = `${element.parentElement?.textContent ?? ''} ${text}`;
            push(match[0], context, describe(element));
          }
        }
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          if (!value) continue;
          for (const match of value.matchAll(/\b\d{5}\b/g)) {
            push(match[0], `${element.parentElement?.textContent ?? ''} ${attribute}=${value}`, describe(element));
          }
        }
      }
      return found;

      function describe(element: HTMLElement): string {
        const id = element.id ? `#${element.id}` : '';
        const cls = element.className && typeof element.className === 'string'
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
        return `${element.tagName.toLowerCase()}${id}${cls}`;
      }
    }, VALUE_ATTRIBUTES)
    .catch(() => [] as { code: string; context: string; source: string }[]);

  return raw.map((item) => ({ ...item, labelled: CODE_LABEL.test(item.context) }));
}

/**
 * Reads the lesson code from an already-open monitoring page. Monitoring renders parts
 * of itself in child frames, so every frame is harvested before deciding.
 */
export async function readLessonCode(page: Page, config: LamsConfig, excludeIds: string[] = []): Promise<LessonCodeResult> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // The code paints with the lesson tab rather than on load; give it a moment to arrive.
  await page
    .locator('body')
    .filter({ hasText: CODE_LABEL })
    .first()
    .waitFor({ state: 'attached', timeout: config.browser.actionTimeoutMs })
    .catch(() => undefined);

  const perFrame = await Promise.all(page.frames().map(collectLessonCodeCandidates));
  return selectLessonCode(perFrame.flat(), excludeIds);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
