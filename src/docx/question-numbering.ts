/**
 * How a Source-of-Truth marks its structure. The AE extractor, image assignment, and SoT
 * formatting all number questions through this module so the three always agree.
 */

/** `--- BREAK ---`, or the starred `***** BREAK *****` some SoTs use for the same boundary. */
export const BREAK_MARKER = /^(?:-{3,}|\*{3,})\s*BREAK\s*(?:-{3,}|\*{3,})$/i;
export const CASE_HEADING = /^Case\s+(\d+)\b/i;
/** A new section opens the narrative for the question that follows it. */
export const SECTION_BOUNDARY = new RegExp(`${BREAK_MARKER.source}|^Case\\s+\\d+\\b`, 'i');

/**
 * A stem numbered with punctuation: `7. …`, `7) …`, or `Q16. …`. The `Q` form needs its
 * punctuation so a reference such as "Q16 to 20 relate to this case" is never a stem.
 */
export const NUMBERED_STEM = /^\s*(?:Q\s?(\d+)[.):]|(\d+)[.)])\s+\S/i;
/** `3 Increased LDH…`: a stem whose full stop was dropped. Only trusted as the next number. */
const UNPUNCTUATED_STEM = /^\s*(\d+)\s+[A-Za-z]/;
/** Mark annotations can sit mid-sentence, so they are matched anywhere in the paragraph. */
const MARK_ANNOTATION = /(?:\(\s*(?:mark\s*\d+|\d+\s*marks?)\s*\)|\[\s*\d+\s*marks?\s*\])/i;

export const OPTION_LINE = /^([A-Z])[.)]\s+\S/;
/** Answer keys, explanations, and rationales follow a question; they never open one. */
export const ANSWER_OR_RATIONALE = /^(?:Answer|Rationale|Explanation|Reason|Faculty Notes)\b/i;
/** Roman-numeral statements (`I. …`, `IV. …`) that a stem lists before its lettered options. */
const ROMAN_STATEMENT = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X)[.)]\s+\S/;
const CAPTION_PREFIX = /^(?:fig(?:ure)?|table|chart|diagram|image|illustration)\b/i;
/** The first option of a list, including one Word collapsed onto a single line: "A x B y C z D w". */
const OPENS_OPTION_LIST = /^A[.)]\s+\S|^A\s+\S.*?\sB\s+\S.*?\sC\s+\S.*?\sD\s+\S/;

/**
 * The number a stem opens, or null. An unpunctuated number is trusted only when it is the next
 * in sequence and the paragraph is visibly answered, by an answer key or an option list that
 * follows it; "2 weeks later, the patient…" is narrative, not question 2.
 */
export function numberedStem(text: string, expectedNext: number, nextText = ''): number | null {
  const punctuated = text.match(NUMBERED_STEM);
  if (punctuated) return Number(punctuated[1] ?? punctuated[2]);
  const bare = text.match(UNPUNCTUATED_STEM);
  if (!bare || Number(bare[1]) !== expectedNext) return null;
  return ANSWER_OR_RATIONALE.test(nextText) || isOptionLine(nextText) ? expectedNext : null;
}

export function isStructuralLine(text: string): boolean {
  return (
    OPTION_LINE.test(text) || OPENS_OPTION_LIST.test(text) || ANSWER_OR_RATIONALE.test(text) || SECTION_BOUNDARY.test(text)
  );
}

export function isOptionLine(text: string): boolean {
  return OPTION_LINE.test(text) || OPENS_OPTION_LIST.test(text);
}

export interface NumberingOptions {
  /**
   * Also number unnumbered questions: a paragraph carrying a mark annotation, or the paragraph
   * directly above an option list that follows a question which already had its options. iRAT
   * SoTs often number only their first questions; AE SoTs are always numbered.
   */
  inferUnnumbered: boolean;
}

/** For each paragraph, the question number it opens, or null. */
export function numberQuestionStems(texts: string[], options: NumberingOptions): (number | null)[] {
  const stems: (number | null)[] = texts.map(() => null);
  let highest = 0;
  let lastStem = -1;
  let stemHasOptions = false;
  const open = (index: number, number: number): void => {
    stems[index] = number;
    highest = Math.max(highest, number);
    lastStem = index;
    stemHasOptions = false;
  };

  texts.forEach((text, index) => {
    const nextText = texts.slice(index + 1).find((candidate) => candidate !== '') ?? '';
    const numbered = numberedStem(text, highest + 1, nextText);
    if (numbered !== null) return open(index, numbered);
    if (!options.inferUnnumbered) return;
    if (MARK_ANNOTATION.test(text) && !isOptionLine(text) && !ANSWER_OR_RATIONALE.test(text)) {
      return open(index, highest + 1);
    }
    if (!OPENS_OPTION_LIST.test(text)) return;
    // The first option list after a stem is that stem's own. A second list means a new
    // question began without a number, and its stem is the prose directly above the list.
    if (lastStem < 0 || stemHasOptions) {
      const stem = unnumberedStemAbove(texts, index, lastStem);
      if (stem !== null) open(stem, highest + 1);
    }
    stemHasOptions = true;
  });
  return stems;
}

function unnumberedStemAbove(texts: string[], optionIndex: number, lastStem: number): number | null {
  for (let index = optionIndex - 1; index > lastStem; index -= 1) {
    const text = texts[index]!;
    if (text === '' || ROMAN_STATEMENT.test(text) || isOptionLine(text) || CAPTION_PREFIX.test(text)) continue;
    return ANSWER_OR_RATIONALE.test(text) || SECTION_BOUNDARY.test(text) ? null : index;
  }
  return null;
}

/** Streams the question each paragraph belongs to, carrying the last stem forward. */
export function questionForEachParagraph(stems: (number | null)[]): (number | null)[] {
  let current: number | null = null;
  return stems.map((stem) => (current = stem ?? current));
}
