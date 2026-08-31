export type AEQuestionType = 'mcq' | 'essay';

export interface AEOptionInput {
  text: string;
  correct?: boolean;
}

export interface AEQuestionInput {
  number: number;
  type: AEQuestionType;
  prompt: string;
  marks?: number;
  options?: AEOptionInput[];
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
  type: AEQuestionType;
  promptHtml: string;
  marks: number;
  answerRequired: true;
  prefixSequentialLetters: boolean;
  saveAsNewVersion: true;
  selectLatestVersion: true;
  options: AEOptionPlan[];
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
  if (input.gates.length !== input.breakMarkerCount) {
    throw new Error(
      `breakMarkerCount ${input.breakMarkerCount} requires ${input.breakMarkerCount} AE gates; found ${input.gates.length}`
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
    breakMarkerCount: input.breakMarkerCount,
    requiredAENodes,
    requiredAEGates: input.breakMarkerCount,
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
      type: question.type,
      promptHtml: normalizePrompt(question.prompt, question.number),
      marks,
      answerRequired: true,
      prefixSequentialLetters: false,
      saveAsNewVersion: true,
      selectLatestVersion: true,
      options: []
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
    })
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

function validateGateAdjacency(input: AEPlanInput): void {
  input.gates.forEach((gate, index) => {
    const after = input.nodes[index]!;
    const before = input.nodes[index + 1]!;
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

  const parsed: AEPlanInput = { sourceLabel, breakMarkerCount, nodes, gates };
  if (value.expectedTotalMarks !== undefined) parsed.expectedTotalMarks = nonNegativeInteger(value.expectedTotalMarks, 'expectedTotalMarks');
  if (value.attempts !== undefined) parsed.attempts = positiveInteger(value.attempts, 'attempts');
  if (value.passingMark !== undefined) {
    parsed.passingMark = value.passingMark === null ? null : nonNegativeInteger(value.passingMark, 'passingMark');
  }
  return parsed;
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
