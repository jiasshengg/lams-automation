import type { QuestionImageRequest } from '../config.js';

export type AEQuestionType = 'mcq' | 'essay';

export interface AEOptionInput {
  text: string;
  correct?: boolean;
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
  text: string;
  creditPercent: 0 | 100;
}

export interface AEQuestionPlan {
  number: number;
  title: string;
  type: AEQuestionType;
  promptHtml: string;
  marks: number;
  answerRequired: true;
  prefixSequentialLetters: boolean;
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
    description: node.title,
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
      saveAsNewVersion: true,
      selectLatestVersion: true,
      options: [],
      sourceQuestionNumber: question.sourceQuestionNumber ?? question.number,
      images: question.images ?? []
    };
  }

  const options = question.options ?? [];
  if (options.length < 2) throw new Error(`Question ${question.number} must have at least two answer options`);
  const correctCount = options.filter((option) => option.correct === true).length;
  if (correctCount !== 1) {
    throw new Error(`Question ${question.number} must have exactly one correct answer; found ${correctCount}`);
  }
  return {
    number: question.number,
    title: question.title ?? `Question ${question.number}`,
    type: question.type,
    promptHtml: normalizePrompt(question.prompt, question.number),
    marks,
    answerRequired: true,
    prefixSequentialLetters: true,
    saveAsNewVersion: true,
    selectLatestVersion: true,
    options: options.map((option, index) => {
      const text = stripOptionPrefix(option.text);
      if (text === '') throw new Error(`Question ${question.number} option ${index + 1} is empty after removing its prefix`);
      return { text, creditPercent: option.correct === true ? 100 : 0 };
    }),
    sourceQuestionNumber: question.sourceQuestionNumber ?? question.number,
    images: question.images ?? []
  };
}

function normalizePrompt(prompt: string, number: number): string {
  const cleaned = prompt
    .replace(/\[\s*(?:\d+|x)\s+marks?\s*\]/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (cleaned.length === 0) throw new Error(`Question ${number} prompt is empty after removing mark annotations`);

  const paragraphs: string[] = [];
  cleaned.forEach((line, index) => {
    const escaped = escapeHtml(line);
    if (/^Case\s+\S+/i.test(line)) {
      paragraphs.push(`<p><strong><u>${escaped}</u></strong></p>`);
      if (index < cleaned.length - 1) paragraphs.push('<p><br></p>');
      return;
    }
    if (/^QUESTION\s+\d+\s*$/i.test(line)) {
      paragraphs.push(`<p>${escaped}</p>`);
      if (index < cleaned.length - 1) paragraphs.push('<p><br></p>');
      return;
    }
    paragraphs.push(`<p>${escaped}</p>`);
  });
  return paragraphs.join('');
}

function stripOptionPrefix(value: string): string {
  return value.replace(/^\s*[A-Z]\s*[).:-]\s*/i, '').trim();
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
    return { title, questions };
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character]!;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
