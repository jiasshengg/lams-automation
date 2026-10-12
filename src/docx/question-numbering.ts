/**
 * How a Source-of-Truth marks its structure. The AE extractor, image assignment, and SoT
 * formatting all number questions through this module so the three always agree.
 */

/**
 * `--- BREAK ---`, or the starred `***** BREAK *****` some SoTs use for the same boundary. The
 * marker may be indented or trailed by spaces, tabs, or non-breaking spaces, which Word keeps in
 * the paragraph text.
 */
export const BREAK_MARKER = /^\s*(?:-{2,}|\*{3,})\s*BREAK\s*(?:-{2,}|\*{3,})\s*$/i;
export const CASE_HEADING = /^Case\s+(\d+)\b/i;
/** A heading or note the document addresses to faculty ("Case 1 Summary – For Faculty"), not to learners. */
export const FACULTY_ONLY = /\b(?:for|notes? for)\s+faculty\b|\bfaculty\s+(?:only|notes?)\b/i;
/** A new section opens the narrative for the question that follows it. */
export const SECTION_BOUNDARY = new RegExp(`${BREAK_MARKER.source}|^Case\\s+\\d+\\b`, 'i');

/**
 * A stem numbered with punctuation: `7. …`, `7) …`, or `Q16. …`. The `Q` form needs its
 * punctuation so a reference such as "Q16 to 20 relate to this case" is never a stem.
 */
export const NUMBERED_STEM = /^\s*(?:Q\s?(\d+)[a-z]?[.):]|(\d+)[a-z]?[.)])\s+\S/i;
/**
 * `12a. …`, `12b. …`: the parts of one numbered question. Each part is its own question, so every
 * part after the first takes the next number and the document's later numbers shift with it.
 */
const SUB_LETTER_STEM = /^\s*(?:Q\s?)?(\d+)([a-z])[.)]\s+\S/;
/**
 * `3 Increased LDH…` or `14, What is…`: a stem whose full stop was dropped or mistyped as a comma.
 * Only trusted as the next number.
 */
const UNPUNCTUATED_STEM = /^\s*(\d+),?\s+[A-Za-z]/;
/** Mark annotations can sit mid-sentence, so they are matched anywhere in the paragraph. */
const MARK_ANNOTATION = /(?:\(\s*(?:mark\s*\d+|\d+\s*marks?)\s*\)|\[\s*\d+\s*marks?\s*\])/i;

export const OPTION_LINE = /^([A-Z])[.)]\s+\S/;
/** Answer keys, explanations, and rationales follow a question; they never open one. */
export const ANSWER_OR_RATIONALE = /^(?:Answers?|Rationale|Explanation|Reason|Faculty Notes)\b/i;
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
  /**
   * For each paragraph, whether it is wholly bold, as an answer key is. Lets a rationale list that
   * numbers from 1 again be followed past the number where the next real question resumes.
   */
  bold?: boolean[];
  /**
   * For each paragraph, the decimal list item Word numbers it as, if any. Word prints that number
   * without storing it as text, so a document that numbers its questions as a list would otherwise
   * show no question numbers at all.
   */
  listItems?: (ListItemNumber | null | undefined)[];
}

/** The list a Word-numbered paragraph counts in, and the number printed ahead of it. */
export interface ListItemNumber {
  key: string;
  number: number;
}

/** For each paragraph, the question number it opens, or null. */
export function numberQuestionStems(texts: string[], options: NumberingOptions): (number | null)[] {
  return scanQuestionStems(texts, options).numbers;
}

export interface QuestionStemScan {
  /** For each paragraph, the question number it opens, or null. */
  numbers: (number | null)[];
  /**
   * For each stem that is one lettered part of a numbered question ("12a.", "12b."), its letter;
   * null for every other paragraph. A lone "5b." that continues no "5a." is not a part.
   */
  letters: (string | null)[];
}

/** Numbers every stem, and records which stems are the lettered parts of one question. */
export function scanQuestionStems(texts: string[], options: NumberingOptions): QuestionStemScan {
  const stems: (number | null)[] = texts.map(() => null);
  const letters: (string | null)[] = texts.map(() => null);
  let highest = 0;
  // How far the document's printed numbers trail the sequence: one per extra lettered part.
  let offset = 0;
  // The printed number and letter of the latest lettered part, which the next part continues.
  let lastPart: { number: number; letter: string } | null = null;
  let lastStem = -1;
  let stemHasOptions = false;
  let answered = false;
  let inRationaleList = false;
  // Options seen since the last stem, however numbering is inferred.
  let optionsSinceStem = false;
  // A Word-numbered list under an answer key is rationale; its later items never open questions.
  const rationaleLists = new Set<string>();
  const open = (index: number, number: number): void => {
    stems[index] = number;
    highest = Math.max(highest, number);
    lastStem = index;
    stemHasOptions = false;
    answered = false;
    inRationaleList = false;
    optionsSinceStem = false;
  };

  texts.forEach((text, index) => {
    const nextText = texts.slice(index + 1).find((candidate) => candidate !== '') ?? '';
    const listItem = options.listItems?.[index] ?? null;
    // A rationale that Word numbers as a list ("1) …" under an answer key) restarts below the
    // current question number; the rest of that list is rationale, exactly as a typed one is.
    if (listItem && answered && listItem.number <= highest) rationaleLists.add(listItem.key);
    const part = SUB_LETTER_STEM.exec(text);
    if (part && lastPart && Number(part[1]) === lastPart.number && part[2] === nextLetter(lastPart.letter)) {
      offset += 1;
      lastPart = { number: lastPart.number, letter: part[2]! };
      letters[index] = part[2]!;
      return open(index, highest + 1);
    }
    const printed = numberedStem(text, highest + 1 - offset, nextText) ?? listStem(texts, options.listItems ?? [], index, {
      expected: highest + 1 - offset,
      previousClosed: lastStem < 0 || answered || optionsSinceStem,
      rationaleLists
    });
    const numbered = printed === null ? null : printed + offset;
    // Once a question's answer key is stated, a list that numbers from 1 again ("1. His adaptive
    // immunity…") is the rationale for that answer, not a question the document goes back to.
    if (numbered !== null && answered && (numbered <= highest || (inRationaleList && options.bold?.[index] === true))) {
      inRationaleList = true;
      return;
    }
    // A typed list that numbers from 1 again under a stem still awaiting its options ("Rank the
    // following: 1. … 2. …") is a statement list the options refer to, not questions.
    if (numbered !== null && numbered <= highest && lastStem >= 0 && !answered && !optionsSinceStem) return;
    if (numbered !== null) {
      lastPart = part && part[2] === 'a' ? { number: printed!, letter: 'a' } : null;
      if (lastPart) letters[index] = 'a';
      return open(index, numbered);
    }
    if (lastStem >= 0 && ANSWER_OR_RATIONALE.test(text)) answered = true;
    if (lastStem >= 0 && isOptionLine(text)) optionsSinceStem = true;
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
  return { numbers: stems, letters };
}

function nextLetter(letter: string): string {
  return String.fromCharCode(letter.charCodeAt(0) + 1);
}

/**
 * The number of a question stem Word numbers as a list item, or null. Statement lists, learning
 * outcomes, and rationales are decimal lists too, so a generated number opens a question only when
 * the document reads that way around it: it is the next question number, the question before it
 * has already had its options or answer key, and its own options or answer key follow before the
 * next item of the same list. A statement list the options refer to ("1) … 2) … 3)") fails the
 * second test, and learning outcomes numbered 1, 2, 3 fail the third.
 */
function listStem(
  texts: string[],
  listItems: (ListItemNumber | null | undefined)[],
  index: number,
  state: { expected: number; previousClosed: boolean; rationaleLists: ReadonlySet<string> }
): number | null {
  const item = listItems[index];
  if (!item || item.number !== state.expected || !state.previousClosed || state.rationaleLists.has(item.key)) return null;
  for (let next = index + 1; next < texts.length; next += 1) {
    if (listItems[next]?.key === item.key) return null;
    const text = texts[next]!;
    if (isOptionLine(text) || ANSWER_OR_RATIONALE.test(text)) return item.number;
    // A typed stem or a new section before any answer means this item asked nothing itself.
    if (NUMBERED_STEM.test(text) || SECTION_BOUNDARY.test(text)) return null;
  }
  return null;
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
