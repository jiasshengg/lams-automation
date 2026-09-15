import type { QuestionImageRequest } from '../config.js';
import { escapeHtmlText, inlineHtmlToText, sanitizeInlineHtml, stripOptionPrefixHtml } from './inline-html.js';
import { IMAGE_SLOT_HTML, IMAGE_SLOT_LINE } from './prompt-lines.js';

export { IMAGE_SLOT_HTML, IMAGE_SLOT_LINE };

export type AEQuestionType = 'mcq' | 'essay';

export interface AEOptionInput {
  text: string;
  correct?: boolean;
  /** Optional percentage credit. Correct-option weights must total 100. */
  weight?: number;
}

export interface AEQuestionInput {
  number: number;
  title?: string;
  type: AEQuestionType;
  prompt: string;
  marks?: number;
  options?: AEOptionInput[];
  sourceQuestionNumber?: number;
  images?: QuestionImageRequest[];
}

export interface AENodeInput {
  title: string;
  /** Optional. AE activities carry no description unless the reviewed input supplies one. */
  description?: string;
  questions: AEQuestionInput[];
}

export interface AEGateInput {
  title: string;
  afterNodeTitle: string;
  beforeNodeTitle: string;
  beforeQuestionNumber: number;
}

export interface AEPlanInput {
  sourceLabel: string;
  sourceDocx?: string;
  breakMarkerCount: number;
  expectedTotalMarks?: number;
  attempts?: number;
  passingMark?: number | null;
  nodes: AENodeInput[];
  gates: AEGateInput[];
}

export interface AEOptionPlan {
  /** Visible option text, used for Print View verification. */
  text: string;
  /** The same option with its Source-of-Truth emphasis, written to CKEditor. */
  html: string;
  creditPercent: number;
}

export interface AEQuestionPlan {
  number: number;
  title: string;
  type: AEQuestionType;
  promptHtml: string;
  marks: number;
  answerRequired: true;
  prefixSequentialLetters: boolean;
  multipleAnswersAllowed: boolean;
  saveAsNewVersion: true;
  selectLatestVersion: true;
  options: AEOptionPlan[];
  sourceQuestionNumber: number;
  images: QuestionImageRequest[];
}

export interface AENodePlan {
  title: string;
  description: string;
  questions: AEQuestionPlan[];
}

export interface AEActivitySettings {
  shuffleQuestions: false;
  shuffleAnswers: false;
  questionNumbering: false;
  displayAllAfterCompletion: true;
  questionFeedback: false;
  discloseAnswersInMonitor: true;
  peerRating: false;
  answerJustification: true;
  burningQuestions: false;
  focusTracking: false;
  discussionNotepad: false;
  discussionSentimentVoting: true;
  confidenceLevel: false;
  useSelectLeaderToolLeaders: true;
  attempts: number;
  passingMark: number | null;
}

export interface AEPlan {
  sourceLabel: string;
  sourceDocx?: string;
  breakMarkerCount: number;
  requiredAENodes: number;
  requiredAEGates: number;
  totalMarks: number;
  nodes: AENodePlan[];
  gates: AEGateInput[];
  activitySettings: AEActivitySettings;
}

export const DEFAULT_AE_ACTIVITY_SETTINGS = Object.freeze({
  shuffleQuestions: false,
  shuffleAnswers: false,
  questionNumbering: false,
  displayAllAfterCompletion: true,
  questionFeedback: false,
  discloseAnswersInMonitor: true,
  peerRating: false,
  answerJustification: true,
  burningQuestions: false,
  focusTracking: false,
  discussionNotepad: false,
  discussionSentimentVoting: true,
  confidenceLevel: false,
  useSelectLeaderToolLeaders: true
} as const);

export function buildAEPlan(value: unknown): AEPlan {
  const input = parseInput(value);
  const requiredAENodes = input.breakMarkerCount + 1;
  if (input.nodes.length !== requiredAENodes) {
    throw new Error(
      `breakMarkerCount ${input.breakMarkerCount} requires ${requiredAENodes} AE nodes; found ${input.nodes.length}`
    );
  }
  // Documented process: AE gates equal the number of SoT breaks while AE nodes are
  // breaks + 1, so every gate sits between two AE nodes and the first is never gated.
  const requiredAEGates = input.breakMarkerCount;
  if (input.gates.length !== requiredAEGates) {
    throw new Error(
      `breakMarkerCount ${input.breakMarkerCount} requires ${requiredAEGates} AE gates; found ${input.gates.length}`
    );
  }

  assertUnique(input.nodes.map((node) => node.title), 'AE node title');
  assertUnique(input.gates.map((gate) => gate.title), 'AE gate title');

  let expectedQuestionNumber = 1;
  const nodes = input.nodes.map<AENodePlan>((node) => ({
    title: node.title,
    description: node.description ?? '',
    questions: node.questions.map((question) => {
      if (question.number !== expectedQuestionNumber) {
        throw new Error(
          `Question numbers must be sequential from 1; expected ${expectedQuestionNumber}, found ${question.number}`
        );
      }
      expectedQuestionNumber += 1;
      return buildQuestion(question);
    })
  }));
  validateGateAdjacency(input);

  const totalMarks = nodes.flatMap((node) => node.questions).reduce((sum, question) => sum + question.marks, 0);
  if (input.expectedTotalMarks !== undefined && input.expectedTotalMarks !== totalMarks) {
    throw new Error(`Expected total marks ${input.expectedTotalMarks}; calculated ${totalMarks}`);
  }
  if (input.passingMark !== undefined && input.passingMark !== null && input.passingMark > totalMarks) {
    throw new Error(`passingMark ${input.passingMark} cannot exceed total marks ${totalMarks}`);
  }

  return {
    sourceLabel: input.sourceLabel,
    ...(input.sourceDocx ? { sourceDocx: input.sourceDocx } : {}),
    breakMarkerCount: input.breakMarkerCount,
    requiredAENodes,
    requiredAEGates,
    totalMarks,
    nodes,
    gates: input.gates,
    activitySettings: {
      ...DEFAULT_AE_ACTIVITY_SETTINGS,
      attempts: input.attempts ?? 1,
      passingMark: input.passingMark ?? null
    }
  };
}

export function formatAEPlanSummary(plan: AEPlan): string {
  const questionCount = plan.nodes.reduce((sum, node) => sum + node.questions.length, 0);
  const lines = [
    'AE preflight: PASS',
    `Source: ${plan.sourceLabel}`,
    `Nodes: ${plan.requiredAENodes} | Gates: ${plan.requiredAEGates} | Questions: ${questionCount} | Marks: ${plan.totalMarks}`,
    '',
    'Nodes'
  ];
  plan.nodes.forEach((node) => {
    const first = node.questions[0]!.number;
    const last = node.questions[node.questions.length - 1]!.number;
    lines.push(`- ${node.title}: questions ${first}${first === last ? '' : `–${last}`}`);
  });
  lines.push('', 'Gates');
  if (plan.gates.length === 0) lines.push('- none');
  plan.gates.forEach((gate) => {
    lines.push(`- ${gate.title}: ${gate.afterNodeTitle} -> ${gate.beforeNodeTitle} (question ${gate.beforeQuestionNumber})`);
  });
  return lines.join('\n');
}

function buildQuestion(question: AEQuestionInput): AEQuestionPlan {
  const marks = question.marks ?? 4;
  if (!Number.isInteger(marks) || marks <= 0) {
    throw new Error(`Question ${question.number} marks must be a positive integer; found ${marks}`);
  }
  if (question.type === 'essay') {
    if (question.options !== undefined && question.options.length > 0) {
      throw new Error(`Essay question ${question.number} must not define answer options`);
    }
    return {
      number: question.number,
      title: question.title ?? `Question ${question.number}`,
      type: question.type,
      promptHtml: normalizePrompt(question.prompt, question.number),
      marks,
      answerRequired: true,
      prefixSequentialLetters: false,
      multipleAnswersAllowed: false,
      saveAsNewVersion: true,
      selectLatestVersion: true,
      options: [],
      sourceQuestionNumber: question.sourceQuestionNumber ?? question.number,
      images: question.images ?? []
    };
  }

  const options = question.options ?? [];
  if (options.length < 2) throw new Error(`Question ${question.number} must have at least two answer options`);
  const correctOptions = options.filter((option) => option.correct === true);
  if (correctOptions.length === 0) throw new Error(`Question ${question.number} must have at least one correct answer`);
  const hasExplicitWeights = correctOptions.some((option) => option.weight !== undefined);
  if (hasExplicitWeights && correctOptions.some((option) => option.weight === undefined)) {
    throw new Error(`Question ${question.number} must supply a weight for every correct answer when any correct weight is explicit`);
  }
  options.forEach((option, index) => {
    if (option.weight !== undefined && (!Number.isFinite(option.weight) || option.weight < 0 || option.weight > 100)) {
      throw new Error(`Question ${question.number} option ${index + 1} weight must be between 0 and 100`);
    }
    if (option.correct !== true && option.weight !== undefined && option.weight !== 0) {
      throw new Error(`Question ${question.number} option ${index + 1} is incorrect and must have weight 0`);
    }
    if (option.correct === true && option.weight !== undefined && option.weight <= 0) {
      throw new Error(`Question ${question.number} option ${index + 1} is correct and must have a positive weight`);
    }
  });
  if (hasExplicitWeights) {
    const total = correctOptions.reduce((sum, option) => sum + option.weight!, 0);
    if (Math.abs(total - 100) > 1e-9) {
      throw new Error(`Question ${question.number} correct-answer weights must total 100; found ${total}`);
    }
  }
  const defaultCorrectWeight = 100 / correctOptions.length;
  return {
    number: question.number,
    title: question.title ?? `Question ${question.number}`,
    type: question.type,
    promptHtml: normalizePrompt(question.prompt, question.number),
    marks,
    answerRequired: true,
    prefixSequentialLetters: true,
    multipleAnswersAllowed: correctOptions.length > 1,
    saveAsNewVersion: true,
    selectLatestVersion: true,
    options: options.map((option, index) => {
      const html = stripOptionPrefix(option.text);
      if (html === '') throw new Error(`Question ${question.number} option ${index + 1} is empty after removing its prefix`);
      return {
        text: inlineHtmlToText(html),
        html,
        creditPercent: option.correct === true ? (hasExplicitWeights ? option.weight! : defaultCorrectWeight) : 0
      };
    }),
    sourceQuestionNumber: question.sourceQuestionNumber ?? question.number,
    images: question.images ?? []
  };
}

/**
 * Each newline-separated line becomes one CKEditor block. CKEditor is configured for Normal
 * (DIV) here, so blocks are divs rather than paragraphs. Emphasis carried over
 * from the Source-of-Truth survives; every other tag is escaped by the sanitizer.
 */
const TABLE_LINE = /^\s*<table\b[\s\S]*<\/table>\s*$/i;

/**
 * Tables are rebuilt from their rows and cells rather than passed through: the inline sanitizer
 * deliberately escapes every block tag, and re-deriving the structure keeps that guarantee - only
 * the allowlisted inline tags can reach the authoring surface, inside cells we emitted ourselves.
 */
function renderPromptTable(line: string, number: number): string {
  const rows = [...line.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...(row[1] ?? '').matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((cell) => ({
      // Only a plain percentage survives, so a reviewed table cannot carry styling of its own.
      width: /\bwidth=["'](\d{1,3})%["']/i.exec(cell[2] ?? '')?.[1] ?? null,
      align: /\balign=["'](center|right)["']/i.exec(cell[2] ?? '')?.[1]?.toLowerCase() ?? null,
      html: sanitizeInlineHtml(cell[3] ?? '')
    }))
  );
  if (rows.length === 0 || rows.some((cells) => cells.length === 0)) {
    throw new Error(`Question ${number} contains a table with no readable rows or cells`);
  }
  const body = rows
    .map((cells) =>
      `<tr>${cells
        .map((cell) => `<td${cell.width === null ? '' : ` width="${cell.width}%"`}${cell.align === null ? '' : ` align="${cell.align}"`} style="${TABLE_CELL_STYLE}">${cell.html}</td>`)
        .join('')}</tr>`
    )
    .join('');
  // The document's printed width in pixels; anything missing or wider than the editor fills the line.
  const declared = Number(/^\s*<table\b[^>]*\bwidth=["'](\d{1,4})["']/i.exec(line)?.[1] ?? 0);
  const width = declared > 0 && declared <= MAX_TABLE_WIDTH_PX ? String(declared) : '100%';
  // border/cellpadding/cellspacing reproduce Word's TableGrid style: single ruled lines throughout.
  return `<table border="1" cellpadding="4" cellspacing="0" width="${width}" style="${TABLE_STYLE}">${body}</table>`;
}

const MAX_TABLE_WIDTH_PX = 1200;
// LAMS's components.css sets `td { border-width: 0 }`, which overrides the border attribute and
// leaves only the outer frame, so Word's TableGrid lines are written as inline styles. Padding,
// top alignment and line height follow Word's default cell margins and single line spacing.
// The font is deliberately left unset so tables use the LAMS site default, not the SoT's font.
const TABLE_STYLE = 'border-collapse:collapse;border:1px solid #000';
const TABLE_CELL_STYLE = 'border:1px solid #000;padding:0 7px;vertical-align:top;line-height:1.15';

const MARK_ANNOTATION = /\[\s*(?:\d+|x)\s+marks?\s*\]/gi;
const BLANK_LINE = '<div><br></div>';

/**
 * Each prompt line becomes one block in the LAMS default Normal format, and each empty line a
 * blank line, so the prompt reads with the paragraphs and gaps the Source-of-Truth prints.
 */
function promptEntries(prompt: string): string[] {
  const entries = prompt.split(/\r?\n/).flatMap((raw) => {
    const line = raw.replace(MARK_ANNOTATION, '').trim();
    if (line === IMAGE_SLOT_LINE) return [IMAGE_SLOT_HTML];
    if (inlineHtmlToText(line) !== '') return [line];
    // A line emptied only by removing its mark annotation was never a blank line in the document.
    return inlineHtmlToText(raw.trim()) === '' ? [BLANK_LINE] : [];
  });
  const content = entries.flatMap((entry, index) => (entry === BLANK_LINE ? [] : [index]));
  return content.length === 0 ? [] : entries.slice(content[0], content.at(-1)! + 1);
}

function normalizePrompt(prompt: string, number: number): string {
  const cleaned = promptEntries(prompt);
  if (!cleaned.some((entry) => entry !== BLANK_LINE && entry !== IMAGE_SLOT_HTML)) {
    throw new Error(`Question ${number} prompt is empty after removing mark annotations`);
  }

  const paragraphs: string[] = [];
  cleaned.forEach((line, index) => {
    if (line === BLANK_LINE || line === IMAGE_SLOT_HTML) {
      paragraphs.push(line);
      return;
    }
    const html = sanitizeInlineHtml(line);
    const text = inlineHtmlToText(line);
    const caseHeading = /^Case\s+\S+/i.test(text);
    // A Case heading the Source-of-Truth already styled keeps its own emphasis; only
    // an unformatted heading receives the house bold-underline treatment.
    if (TABLE_LINE.test(line)) {
      paragraphs.push(renderPromptTable(line, number));
      return;
    }
    const styled = caseHeading && html === escapeHtmlText(text) ? `<strong><u>${html}</u></strong>` : html;
    paragraphs.push(`<div>${styled}</div>`);
    // The heading's blank line is added only where the document did not already leave one.
    const next = cleaned[index + 1];
    if ((caseHeading || /^QUESTION\s+\d+\s*$/i.test(text)) && next !== undefined && next !== BLANK_LINE) {
      paragraphs.push('<div><br></div>');
    }
  });
  return paragraphs.join('');
}

function stripOptionPrefix(value: string): string {
  return stripOptionPrefixHtml(sanitizeInlineHtml(value));
}

/** A leading gate is the first gate and declares no preceding AE node. */
function hasLeadingGate(input: AEPlanInput): boolean {
  const [first] = input.gates;
  return first !== undefined && first.afterNodeTitle === undefined;
}

function validateGateAdjacency(input: AEPlanInput): void {
  const leading = hasLeadingGate(input);
  if (leading) {
    const firstNode = input.nodes[0]!;
    const firstQuestion = firstNode.questions[0];
    const gate = input.gates[0]!;
    if (gate.beforeNodeTitle !== firstNode.title || !firstQuestion || gate.beforeQuestionNumber !== firstQuestion.number) {
      throw new Error(
        `A leading gate must point at the first AE node "${firstNode.title}" and its first question (${firstQuestion?.number ?? 'missing'})`
      );
    }
  }

  const betweenGates = leading ? input.gates.slice(1) : input.gates;
  betweenGates.forEach((gate, index) => {
    const after = input.nodes[index]!;
    const before = input.nodes[index + 1]!;
    if (gate.afterNodeTitle === undefined) {
      throw new Error(`Only the first gate may omit afterNodeTitle as a leading gate; gate "${gate.title}" does not`);
    }
    if (gate.afterNodeTitle !== after.title || gate.beforeNodeTitle !== before.title) {
      throw new Error(`Gate ${index + 1} must connect "${after.title}" to "${before.title}"`);
    }
    const firstQuestion = before.questions[0];
    if (!firstQuestion || gate.beforeQuestionNumber !== firstQuestion.number) {
      throw new Error(
        `Gate ${index + 1} beforeQuestionNumber must be the first question in "${before.title}" (${firstQuestion?.number ?? 'missing'})`
      );
    }
  });
}

function parseInput(value: unknown): AEPlanInput {
  if (!isRecord(value)) throw new Error('AE input must be a JSON object');
  const sourceLabel = nonEmptyString(value.sourceLabel, 'sourceLabel');
  const sourceDocx = value.sourceDocx === undefined ? undefined : nonEmptyString(value.sourceDocx, 'sourceDocx');
  const breakMarkerCount = nonNegativeInteger(value.breakMarkerCount, 'breakMarkerCount');
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw new Error('nodes must be a non-empty array');
  if (!Array.isArray(value.gates)) throw new Error('gates must be an array');

  const nodes = value.nodes.map((node, nodeIndex): AENodeInput => {
    if (!isRecord(node)) throw new Error(`nodes[${nodeIndex}] must be an object`);
    const title = nonEmptyString(node.title, `nodes[${nodeIndex}].title`);
    const description =
      node.description === undefined ? undefined : nonEmptyString(node.description, `nodes[${nodeIndex}].description`);
    if (!Array.isArray(node.questions) || node.questions.length === 0) {
      throw new Error(`nodes[${nodeIndex}].questions must be a non-empty array`);
    }
    const questions = node.questions.map((question, questionIndex): AEQuestionInput => {
      if (!isRecord(question)) throw new Error(`nodes[${nodeIndex}].questions[${questionIndex}] must be an object`);
      const number = positiveInteger(question.number, `nodes[${nodeIndex}].questions[${questionIndex}].number`);
      if (question.type !== 'mcq' && question.type !== 'essay') {
        throw new Error(`Question ${number} type must be "mcq" or "essay"`);
      }
      const parsedQuestion: AEQuestionInput = {
        number,
        type: question.type,
        prompt: nonEmptyString(question.prompt, `Question ${number} prompt`)
      };
      if (question.title !== undefined) parsedQuestion.title = nonEmptyString(question.title, `Question ${number} title`);
      if (question.marks !== undefined) parsedQuestion.marks = numberValue(question.marks, `Question ${number} marks`);
      if (question.options !== undefined) {
        if (!Array.isArray(question.options)) throw new Error(`Question ${number} options must be an array`);
        parsedQuestion.options = question.options.map((option, optionIndex) => {
          if (!isRecord(option)) throw new Error(`Question ${number} option ${optionIndex + 1} must be an object`);
          const parsedOption: AEOptionInput = { text: nonEmptyString(option.text, `Question ${number} option ${optionIndex + 1}`) };
          if (option.correct !== undefined) {
            if (typeof option.correct !== 'boolean') throw new Error(`Question ${number} option ${optionIndex + 1} correct must be boolean`);
            parsedOption.correct = option.correct;
          }
          if (option.weight !== undefined) parsedOption.weight = numberValue(option.weight, `Question ${number} option ${optionIndex + 1} weight`);
          return parsedOption;
        });
      }
      if (question.sourceQuestionNumber !== undefined) {
        parsedQuestion.sourceQuestionNumber = positiveInteger(question.sourceQuestionNumber, `Question ${number} sourceQuestionNumber`);
      }
      if (question.images !== undefined) {
        if (!Array.isArray(question.images)) throw new Error(`Question ${number} images must be an array`);
        parsedQuestion.images = question.images.map((image, imageIndex) => parseQuestionImage(image, `Question ${number} image ${imageIndex + 1}`));
      }
      return parsedQuestion;
    });
    return description === undefined ? { title, questions } : { title, description, questions };
  });

  const gates = value.gates.map((gate, index): AEGateInput => {
    if (!isRecord(gate)) throw new Error(`gates[${index}] must be an object`);
    return {
      title: nonEmptyString(gate.title, `gates[${index}].title`),
      afterNodeTitle: nonEmptyString(gate.afterNodeTitle, `gates[${index}].afterNodeTitle`),
      beforeNodeTitle: nonEmptyString(gate.beforeNodeTitle, `gates[${index}].beforeNodeTitle`),
      beforeQuestionNumber: positiveInteger(gate.beforeQuestionNumber, `gates[${index}].beforeQuestionNumber`)
    };
  });

  const parsed: AEPlanInput = { sourceLabel, breakMarkerCount, nodes, gates, ...(sourceDocx ? { sourceDocx } : {}) };
  if (value.expectedTotalMarks !== undefined) parsed.expectedTotalMarks = nonNegativeInteger(value.expectedTotalMarks, 'expectedTotalMarks');
  if (value.attempts !== undefined) parsed.attempts = positiveInteger(value.attempts, 'attempts');
  if (value.passingMark !== undefined) {
    parsed.passingMark = value.passingMark === null ? null : nonNegativeInteger(value.passingMark, 'passingMark');
  }
  return parsed;
}

function parseQuestionImage(value: unknown, label: string): QuestionImageRequest {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const image: QuestionImageRequest = { path: nonEmptyString(value.path, `${label} path`) };
  if (value.altText !== undefined) {
    if (typeof value.altText !== 'string') throw new Error(`${label} altText must be a string`);
    image.altText = value.altText;
  }
  if (value.widthPx !== undefined) {
    const width = numberValue(value.widthPx, `${label} widthPx`);
    if (width <= 0) throw new Error(`${label} widthPx must be positive`);
    image.widthPx = width;
  }
  if (value.placement !== undefined) {
    if (value.placement !== 'before' && value.placement !== 'after') {
      throw new Error(`${label} placement must be "before" or "after"`);
    }
    image.placement = value.placement;
  }
  if (value.caption !== undefined) {
    if (typeof value.caption !== 'string') throw new Error(`${label} caption must be a string`);
    image.caption = value.caption;
  }
  return image;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} "${value}" must be unique`);
    seen.add(value);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
