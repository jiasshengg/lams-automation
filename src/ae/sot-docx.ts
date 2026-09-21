import { isCaption } from '../docx/media.js';
import { sliceInlineHtml, stripOptionPrefixHtml, withoutUniformInlineTag } from './inline-html.js';
import { IMAGE_SLOT_LINE } from './prompt-lines.js';
import { extractSOTParagraphs, readDocumentXmlFromDocx, readSOTDocxParts, type SOTParagraph } from './sot-paragraphs.js';

export { extractSOTParagraphs, readDocumentXmlFromDocx, readSOTDocxParts };
export type { SOTParagraph };

export type ObservedAEQuestionType = 'single-select' | 'multiple-select' | 'open-response';

export interface AEObservedOption {
  label: string;
  /** Option text with its answer-letter prefix removed and SoT emphasis preserved. */
  html: string;
  correct: boolean;
}

export interface AEQuestionObservation {
  number: number;
  type: ObservedAEQuestionType;
  explicitMarks: number | null;
  caseNumber: number | null;
  /** The question stem exactly as written, including emphasis. */
  promptHtml: string;
  /**
   * Prompt lines printed ahead of this stem after a page break inside the node, such as the next
   * part of a case. Empty strings are blank lines; see `prompt-lines.ts`.
   */
  leadInLines: string[];
  /** Blank lines the document leaves directly above the stem. */
  blankLinesBeforeStem: number;
  optionLabels: string[];
  correctAnswerLabels: string[];
  options: AEObservedOption[];
}

export interface AENodeObservation {
  index: number;
  questionNumbers: number[];
  firstQuestionNumber: number;
  lastQuestionNumber: number;
  questionRange: string;
  caseNumbers: number[];
  caseHeadings: string[];
  /**
   * Case narrative shown before the node's first question, as prompt lines in document order:
   * empty strings are blank lines and `IMAGE_SLOT_LINE` marks where a figure is printed.
   */
  contextHtml: string[];
  imageCount: number;
  suggestedTitle: string;
}

export interface AEGateObservation {
  index: number;
  afterNodeIndex: number;
  beforeNodeIndex: number;
  beforeQuestionNumber: number;
  suggestedTitle: string;
}

export interface AESOTAnalysis {
  sourceLabel: string;
  metadata: {
    applicationTitle: string | null;
    module: string | null;
    sessionTitle: string | null;
  };
  breakMarkerCount: number;
  requiredAENodes: number;
  requiredAEGates: number;
  questionCount: number;
  explicitMarksTotal: number;
  questionsWithoutExplicitMarks: number[];
  nodes: AENodeObservation[];
  gates: AEGateObservation[];
  questions: AEQuestionObservation[];
  requestVariables: {
    expectedAENodes: number;
    expectedAEGates: number;
  };
  reviewRequired: string[];
  warnings: string[];
}

export const BREAK_MARKER = /^-{3}\s*BREAK\s*-{3}$/i;
export const CASE_HEADING = /^Case\s+(\d+)\b/i;
export const SOT_QUESTION_START = /^(\d+)[.)]\s+\S/;
const END_MARKER = /^END$/i;
const OPTION_START = /^([A-Z])[.)]\s+\S/;
const INLINE_OPTION = /(?:^|\s)([A-Z])[.)]\s+\S/g;
const ANSWER_LINE = /^Answer\s*[-:]\s*(.+)$/i;
const RATIONALE_LINE = /^Rationale\b/i;
/** Front matter of the first group (copyright, outcomes, labels) is never case narrative. */
const METADATA_LABEL =
  /^(?:Module|Session Title|Authors and affiliations|Resource|Learning Outcomes|Specific Objectives for Session|Application title|Copyright Statement)\b/i;

export function analyzeAESOT(paragraphs: SOTParagraph[], fallbackLabel: string): AESOTAnalysis {
  const endIndex = paragraphs.findIndex((paragraph) => END_MARKER.test(paragraph.text));
  const contentEnd = endIndex >= 0 ? endIndex : paragraphs.length;
  const relevant = paragraphs.slice(0, contentEnd);
  const caseNumbers = caseNumberByParagraph(relevant);
  const breakIndexes = relevant
    .map((paragraph, index) => (BREAK_MARKER.test(paragraph.text) ? index : -1))
    .filter((index) => index >= 0);

  const boundaries = [-1, ...breakIndexes, relevant.length];
  const groups = boundaries.slice(0, -1).map((boundary, index) => ({
    offset: boundary + 1,
    paragraphs: relevant.slice(boundary + 1, boundaries[index + 1]!)
  }));

  if (groups.length === 0) throw new Error('The AE SOT did not contain any content.');

  const questions: AEQuestionObservation[] = [];
  const unlabelledOptionBlockQuestions: number[] = [];
  const nodes = groups.map<AENodeObservation>(({ offset, paragraphs: untrimmedGroup }, index) => {
    const firstQuestionIndex = untrimmedGroup.findIndex((paragraph) => SOT_QUESTION_START.test(paragraph.text));
    const precedingCaseIndex = untrimmedGroup.reduce(
      (latest, paragraph, paragraphIndex) =>
        paragraphIndex < firstQuestionIndex && CASE_HEADING.test(paragraph.text) ? paragraphIndex : latest,
      -1
    );
    const groupStart = precedingCaseIndex >= 0 ? precedingCaseIndex : 0;
    const group = untrimmedGroup.slice(groupStart);
    const questionStarts = group
      .map((paragraph, paragraphIndex) => {
        const match = paragraph.text.match(SOT_QUESTION_START);
        return match ? { paragraphIndex, number: Number(match[1]) } : null;
      })
      .filter((value): value is { paragraphIndex: number; number: number } => value !== null);

    if (questionStarts.length === 0) {
      throw new Error(`Break-derived AE group ${index + 1} does not contain a numbered question.`);
    }

    const slices = questionStarts.map((start, questionIndex) =>
      group.slice(start.paragraphIndex, questionStarts[questionIndex + 1]?.paragraphIndex ?? group.length)
    );
    // Only a question followed by another in this node can hand a lead-in forward.
    const leadInStarts = slices.map((slice, questionIndex) => (questionIndex < slices.length - 1 ? leadInStart(slice) : slice.length));
    const nodeQuestions = questionStarts.map((start, questionIndex) => {
      const previous = questionIndex > 0 ? slices[questionIndex - 1]!.slice(leadInStarts[questionIndex - 1]) : [];
      const observed = observeQuestion(
        slices[questionIndex]!.slice(0, leadInStarts[questionIndex]),
        start.number,
        caseNumbers[offset + groupStart + start.paragraphIndex] ?? null,
        { leadInLines: promptLines(previous), blankLinesBeforeStem: group[start.paragraphIndex]!.blankLinesBefore }
      );
      questions.push(observed.observation);
      if (observed.unlabelledOptionBlock) unlabelledOptionBlockQuestions.push(start.number);
      return observed.observation;
    });

    const questionNumbers = questionStarts.map((question) => question.number);
    const firstQuestionNumber = questionNumbers[0]!;
    const lastQuestionNumber = questionNumbers.at(-1)!;
    return {
      index: index + 1,
      questionNumbers,
      firstQuestionNumber,
      lastQuestionNumber,
      questionRange: formatQuestionRange(firstQuestionNumber, lastQuestionNumber),
      caseNumbers: unique(
        nodeQuestions.map((question) => question.caseNumber).filter((value): value is number => value !== null)
      ),
      caseHeadings: group.map((paragraph) => paragraph.text).filter((text) => CASE_HEADING.test(text)),
      contextHtml:
        index === 0 && precedingCaseIndex < 0 ? [] : promptLines(group.slice(0, questionStarts[0]!.paragraphIndex)),
      imageCount: group.reduce((sum, paragraph) => sum + paragraph.imageCount, 0),
      suggestedTitle: suggestNodeTitle(
        nodeQuestions[0]!.caseNumber,
        nodeQuestions.at(-1)!.caseNumber,
        firstQuestionNumber,
        lastQuestionNumber
      )
    };
  });

  assertSequentialQuestions(questions.map((question) => question.number));

  const applicationTitle = valueAfterLabel(relevant, 'Application title');
  const module = valueAfterLabel(relevant, 'Module');
  const sessionTitle = valueAfterLabel(relevant, 'Session Title');
  const questionsWithoutExplicitMarks = questions
    .filter((question) => question.explicitMarks === null)
    .map((question) => question.number);
  const multipleSelectQuestions = questions
    .filter((question) => question.type === 'multiple-select')
    .map((question) => question.number);
  const missingAnswerKeys = questions
    .filter((question) => question.type !== 'open-response' && question.correctAnswerLabels.length === 0)
    .map((question) => question.number);
  const warnings: string[] = [];
  if (endIndex < 0) warnings.push('No standalone END marker was found; extraction continued to the end of the document.');
  if (questionsWithoutExplicitMarks.length > 0) {
    warnings.push(`Questions without explicit marks: ${formatNumberList(questionsWithoutExplicitMarks)}.`);
  }
  if (missingAnswerKeys.length > 0) {
    warnings.push(`Selectable questions without a confidently detected answer key: ${formatNumberList(missingAnswerKeys)}.`);
  }
  if (unlabelledOptionBlockQuestions.length > 0) {
    warnings.push(
      `Questions with an unlabelled option block that could not be resolved: ${formatNumberList(unlabelledOptionBlockQuestions)}. The option list could not be bounded automatically; confirm the options and answer key manually.`
    );
  }
  if (questions.some((question) => question.caseNumber === null)) {
    warnings.push('Some questions sit outside any numbered Case heading, so their suggested node titles omit the Case prefix.');
  }

  const sourceLabel = applicationTitle ?? fallbackLabel;
  const gates = nodes.slice(1).map<AEGateObservation>((node, index) => ({
    index: index + 1,
    afterNodeIndex: index + 1,
    beforeNodeIndex: index + 2,
    beforeQuestionNumber: node.firstQuestionNumber,
    suggestedTitle: `AE Gate ${node.suggestedTitle}`
  }));
  return {
    sourceLabel,
    metadata: { applicationTitle, module, sessionTitle },
    breakMarkerCount: breakIndexes.length,
    requiredAENodes: groups.length,
    requiredAEGates: breakIndexes.length,
    questionCount: questions.length,
    explicitMarksTotal: questions.reduce((sum, question) => sum + (question.explicitMarks ?? 0), 0),
    questionsWithoutExplicitMarks,
    nodes,
    gates,
    questions,
    requestVariables: {
      expectedAENodes: groups.length,
      expectedAEGates: breakIndexes.length
    },
    reviewRequired: [
      'Confirm exact AE node titles; suggested titles follow the "AE Case <n> Q<range>" convention but are not authority for existing LAMS nodes.',
      'Confirm exact AE gate titles and build the linear expectedFlow from the approved naming convention.',
      ...(multipleSelectQuestions.length > 0
        ? [`Confirm correct answers and scoring for multiple-select questions ${formatNumberList(multipleSelectQuestions)}; ask the user whether to split the credit between correct answers or give each 100% (multipleAnswerCredit).`]
        : []),
      'Review question text, answers, marks, tables, images, and links before creating AE plan JSON.'
    ],
    warnings
  };
}

export function formatAESOTSummary(analysis: AESOTAnalysis): string {
  const lines = [
    'AE SOT extraction: REVIEW REQUIRED',
    `Source: ${analysis.sourceLabel}`,
    `Breaks: ${analysis.breakMarkerCount} | AE nodes: ${analysis.requiredAENodes} | AE gates: ${analysis.requiredAEGates}`,
    `Questions: ${analysis.questionCount} | Explicit marks subtotal: ${analysis.explicitMarksTotal}`,
    '',
    'Break-derived groups'
  ];
  analysis.nodes.forEach((node) => {
    const cases = node.caseHeadings.length > 0 ? ` | ${node.caseHeadings.join('; ')}` : '';
    const images = node.imageCount > 0 ? ` | images: ${node.imageCount}` : '';
    lines.push(`- ${node.suggestedTitle}: ${node.questionRange}${cases}${images}`);
  });
  lines.push('', 'Gate boundaries');
  analysis.gates.forEach((gate) => {
    lines.push(
      `- ${gate.suggestedTitle}: node ${gate.afterNodeIndex} -> node ${gate.beforeNodeIndex} (before Q${gate.beforeQuestionNumber})`
    );
  });
  lines.push('', 'Playwright request variables', JSON.stringify(analysis.requestVariables));
  if (analysis.warnings.length > 0) {
    lines.push('', 'Warnings', ...analysis.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('', 'Human/agent review required', ...analysis.reviewRequired.map((item) => `- ${item}`));
  return lines.join('\n');
}

/**
 * Case headings carry across break markers: an AE node that continues the previous
 * case states no heading of its own, so the last heading seen stays in effect.
 */
function caseNumberByParagraph(paragraphs: SOTParagraph[]): (number | null)[] {
  let current: number | null = null;
  return paragraphs.map((paragraph) => {
    const match = paragraph.text.match(CASE_HEADING);
    if (match) current = Number(match[1]);
    return current;
  });
}

/** Matches the observed LAMS naming convention, e.g. "AE Case 3 Q3-6". */
function suggestNodeTitle(firstCase: number | null, lastCase: number | null, first: number, last: number): string {
  if (firstCase === null || lastCase === null) return `AE ${formatQuestionRange(first, last)}`;
  if (firstCase === lastCase) return `AE Case ${firstCase} ${formatQuestionRange(first, last)}`;
  return `AE Case ${firstCase} Q${first} to Case ${lastCase} Q${last}`;
}

/**
 * Renders paragraphs as prompt lines, keeping the blank lines above each one and holding a figure's
 * place with `IMAGE_SLOT_LINE`. The caption under a figure is written with the image itself, so it is
 * not repeated as a line of text.
 */
function promptLines(paragraphs: SOTParagraph[]): string[] {
  const lines: string[] = [];
  let awaitingCaption = false;
  for (const paragraph of paragraphs) {
    if (paragraph.text === '') {
      lines.push(...blankLines(paragraph.blankLinesBefore), IMAGE_SLOT_LINE);
      awaitingCaption = true;
      continue;
    }
    const caption = awaitingCaption && isCaption(paragraph.text);
    awaitingCaption = false;
    if (caption || METADATA_LABEL.test(paragraph.text)) continue;
    lines.push(...blankLines(paragraph.blankLinesBefore), paragraph.html);
  }
  return lines;
}

function blankLines(count: number): string[] {
  return Array.from({ length: count }, () => '');
}

/**
 * Where a question's slice stops and the next question's lead-in starts: at a page break that
 * opens text belonging to no answer option, answer key, or rationale. Without one, the whole slice
 * belongs to the question.
 */
function leadInStart(slice: SOTParagraph[]): number {
  let start = -1;
  slice.forEach((paragraph, index) => {
    if (index > 0 && paragraph.pageBreakBefore) start = index;
  });
  if (start < 0) return slice.length;
  const leadIn = slice.slice(start);
  const structural = leadIn.some(
    (paragraph) => OPTION_START.test(paragraph.text) || ANSWER_LINE.test(paragraph.text) || RATIONALE_LINE.test(paragraph.text)
  );
  return structural || leadIn.every((paragraph) => paragraph.text === '') ? slice.length : start;
}

interface OptionEntry {
  label: string;
  paragraph: SOTParagraph;
  /** Visible-text bounds of this option inside its paragraph, answer letter included. */
  start: number;
  end: number;
  /** False when the label was synthesised for an unprefixed block, so nothing is stripped. */
  labelled: boolean;
  // False for options recovered from a collapsed run: they all share one
  // paragraph, so its bold flag cannot single any of them out as the answer.
  boldEligible: boolean;
}

interface ObservedQuestion {
  observation: AEQuestionObservation;
  unlabelledOptionBlock: boolean;
}

function optionLabelAt(index: number): string {
  return String.fromCharCode(65 + index);
}

function wholeParagraphEntry(
  label: string,
  paragraph: SOTParagraph,
  options: { boldEligible: boolean; labelled: boolean }
): OptionEntry {
  return { label, paragraph, start: 0, end: paragraph.text.length, ...options };
}

// Word sometimes collapses a whole option list onto one line, e.g.
// "A. First B. Second C. Third". Split it only when the labels form a
// sequential run starting at A, so ordinary prose containing "B." is untouched.
function splitInlineOptionRun(paragraph: SOTParagraph): OptionEntry[] | null {
  const matches = [...paragraph.text.matchAll(INLINE_OPTION)];
  if (matches.length < 2) return null;
  const labels = matches.map((match) => match[1]!);
  if (!labels.every((label, index) => label === optionLabelAt(index))) return null;
  const starts = matches.map((match, index) => match.index! + match[0].indexOf(labels[index]!));
  return labels.map((label, index) => ({
    label,
    paragraph,
    start: starts[index]!,
    end: starts[index + 1] ?? paragraph.text.length,
    labelled: true,
    boldEligible: false
  }));
}

// Some option lists carry no letter prefixes because each option starts with
// its own identifier. They can only be labelled safely when an explicit answer
// line closes the block; without one the end of the list is unknowable, so the
// question is reported for manual review instead of being guessed.
function collectOptionEntries(paragraphs: SOTParagraph[]): {
  entries: OptionEntry[];
  unlabelledOptionBlock: boolean;
} {
  const body = paragraphs.slice(1);
  // Answer and rationale prose often enumerates "A. … B. …" while discussing the
  // options, so it must never be read as the option list itself.
  const optionBody = body.filter(
    (paragraph) => !ANSWER_LINE.test(paragraph.text) && !RATIONALE_LINE.test(paragraph.text)
  );
  // A genuinely collapsed run occupies one paragraph; more than one prefixed
  // paragraph is proof that any inline split would be spurious.
  const allowInlineSplit = optionBody.filter((paragraph) => OPTION_START.test(paragraph.text)).length <= 1;
  const labelled: OptionEntry[] = [];
  for (const paragraph of optionBody) {
    const inline = allowInlineSplit ? splitInlineOptionRun(paragraph) : null;
    if (inline) {
      labelled.push(...inline);
      continue;
    }
    const match = paragraph.text.match(OPTION_START);
    if (match) labelled.push(wholeParagraphEntry(match[1]!, paragraph, { boldEligible: true, labelled: true }));
  }
  if (labelled.length > 0) return { entries: labelled, unlabelledOptionBlock: false };

  const answerIndex = paragraphs.findIndex((paragraph) => ANSWER_LINE.test(paragraph.text));
  const candidates = answerIndex > 1 ? paragraphs.slice(1, answerIndex) : [];
  if (candidates.length < 2) {
    const unlabelled = body.filter((paragraph) => paragraph.text !== '');
    return {
      entries: [],
      unlabelledOptionBlock:
        answerIndex < 0 && unlabelled.length >= 2 && unlabelled.some((paragraph) => paragraph.bold)
    };
  }

  // Only an answer line naming a label inside the block proves these paragraphs
  // are options. A prose answer belongs to an open-response question whose stem
  // simply spans several paragraphs.
  const answerLabel = /^([A-Z])(?:[.):]|\s|$)/.exec(paragraphs[answerIndex]!.text.match(ANSWER_LINE)![1]!.trim())?.[1];
  const inRange =
    answerLabel !== undefined && candidates.length <= 26 && answerLabel <= optionLabelAt(candidates.length - 1);
  const usable = candidates.every(
    (paragraph) =>
      paragraph.text !== '' && !RATIONALE_LINE.test(paragraph.text) && !SOT_QUESTION_START.test(paragraph.text)
  );
  if (inRange && usable) {
    return {
      entries: candidates.map((paragraph, index) =>
        wholeParagraphEntry(optionLabelAt(index), paragraph, { boldEligible: true, labelled: false })
      ),
      unlabelledOptionBlock: false
    };
  }
  // The answer names a label, so an option list exists but could not be bounded.
  // Report it rather than silently degrading the question to open-response.
  return { entries: [], unlabelledOptionBlock: answerLabel !== undefined };
}

function observeQuestion(
  paragraphs: SOTParagraph[],
  number: number,
  caseNumber: number | null,
  layout: { leadInLines: string[]; blankLinesBeforeStem: number }
): ObservedQuestion {
  const { entries: optionParagraphs, unlabelledOptionBlock } = collectOptionEntries(paragraphs);
  const optionLabels = optionParagraphs.map(({ label }) => label);
  const explicitAnswer = paragraphs
    .map((paragraph) => paragraph.text.match(ANSWER_LINE)?.[1])
    .find((value) => value !== undefined);
  const explicitLabels = explicitAnswer ? [...explicitAnswer.matchAll(/\b([A-Z])\b/g)].map((match) => match[1]!) : [];
  const boldLabels = optionParagraphs
    .filter(({ paragraph, boldEligible }) => boldEligible && paragraph.bold)
    .map(({ label }) => label);
  // An answer key may only name options that were actually observed. Free answer
  // prose otherwise contributes stray capitals such as "vitamin A".
  const correctAnswerLabels = unique(explicitLabels.length > 0 ? explicitLabels : boldLabels).filter((label) =>
    optionLabels.includes(label)
  );
  const stem = paragraphs[0];
  const prompt = stem?.text ?? '';
  const marksMatch = prompt.match(/\(?\s*(\d+)\s+marks?\s*\)?/i);
  const multipleSelect = /select\s+(?:two|three|four|five|\d+)\b/i.test(prompt) || correctAnswerLabels.length > 1;
  const type: ObservedAEQuestionType =
    optionLabels.length === 0 ? 'open-response' : multipleSelect ? 'multiple-select' : 'single-select';
  return {
    observation: {
      number,
      type,
      explicitMarks: marksMatch ? Number(marksMatch[1]) : null,
      caseNumber,
      promptHtml: stem?.html ?? '',
      leadInLines: layout.leadInLines,
      blankLinesBeforeStem: layout.blankLinesBeforeStem,
      optionLabels,
      correctAnswerLabels,
      options: optionParagraphs.map((entry) => ({
        label: entry.label,
        html: withoutUniformInlineTag(optionHtml(entry), 'strong'),
        correct: correctAnswerLabels.includes(entry.label)
      }))
    },
    unlabelledOptionBlock
  };
}

function optionHtml(entry: OptionEntry): string {
  const html = sliceInlineHtml(entry.paragraph.html, entry.start, entry.end);
  return entry.labelled ? stripOptionPrefixHtml(html) : html;
}

function assertSequentialQuestions(numbers: number[]): void {
  if (numbers.length === 0) throw new Error('The AE SOT does not contain any numbered questions.');
  numbers.forEach((number, index) => {
    const expected = index + 1;
    if (number !== expected) throw new Error(`Question numbers must be sequential from 1; expected ${expected}, found ${number}.`);
  });
}

function valueAfterLabel(paragraphs: SOTParagraph[], label: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*(.+)$`, 'i');
  for (const paragraph of paragraphs) {
    const match = paragraph.text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function formatQuestionRange(first: number, last: number): string {
  return first === last ? `Q${first}` : `Q${first}-${last}`;
}

function formatNumberList(values: number[]): string {
  return values.map((value) => `Q${value}`).join(', ');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
