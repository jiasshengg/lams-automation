import type { DocxImage } from '../docx/media.js';
import type { AESOTAnalysis } from './sot-docx.js';

/**
 * A reviewable AE plan transcribed straight from the Source-of-Truth.
 *
 * Hand-transcription is where node titles, emphasis, and figure order drift away
 * from the document, so the draft carries all three across mechanically. It is
 * still a draft: `_review` states what a human must confirm before `apply:ae`.
 */
export interface AEDraftPlan {
  sourceLabel: string;
  sourceDocx?: string;
  /** Recorded so the Source-of-Truth check reads the document the same way the draft did. */
  columnQuestions?: boolean;
  breakMarkerCount: number;
  _review: string[];
  nodes: AEDraftNode[];
  gates: AEDraftGate[];
}

export interface AEDraftNode {
  title: string;
  questions: AEDraftQuestion[];
}

export interface AEDraftQuestion {
  number: number;
  type: 'mcq' | 'essay';
  prompt: string;
  marks?: number;
  options?: { text: string; correct: boolean; hedged?: boolean }[];
  TODO_answerKey?: string;
  /** Reviewed additions: pictures for this question, and whether they replace the document's own. */
  images?: { path: string; altText?: string; widthPx?: number; placement?: 'before' | 'after'; caption?: string }[];
  replaceSourceFigures?: boolean;
  promptReplacements?: { find: string; replaceWith: string }[];
}

export interface AEDraftGate {
  title: string;
  afterNodeTitle: string;
  beforeNodeTitle: string;
  beforeQuestionNumber: number;
}

export function buildAEDraft(
  analysis: AESOTAnalysis,
  options: { sourceDocx?: string; images?: DocxImage[]; columnQuestions?: boolean } = {}
): AEDraftPlan {
  const nodes = analysis.nodes.map<AEDraftNode>((node) => ({
    title: node.suggestedTitle,
    questions: node.questionNumbers.map((number, index) => {
      const question = analysis.questions.find((candidate) => candidate.number === number)!;
      const opening = index === 0 ? node.contextHtml : question.leadInLines;
      const prompt = trimBlankLines([
        ...opening,
        ...Array.from({ length: question.blankLinesBeforeStem }, () => ''),
        question.promptHtml,
        ...question.bodyLines,
        // The credit for the figures a question shows belongs with them, even though the document
        // prints it after the answer key.
        ...(question.creditLines.length > 0 ? ['', ...question.creditLines] : [])
      ]).join('\n');
      const draft: AEDraftQuestion = {
        number,
        type: question.type === 'open-response' ? 'essay' : 'mcq',
        prompt
      };
      if (question.explicitMarks !== null) draft.marks = question.explicitMarks;
      if (question.options.length > 0) {
        draft.options = question.options.map((option) => ({
          text: option.html,
          correct: option.correct,
          // The document names this one without committing to it, so the reviewer decides whether
          // it scores; until then the plan refuses to guess.
          ...(question.hedgedAnswerLabels.includes(option.label) ? { hedged: true } : {})
        }));
      }
      if (draft.options && !draft.options.some((option) => option.correct)) {
        draft.TODO_answerKey = 'No answer key was detected in the Source-of-Truth; mark the correct option before preflight.';
      }
      return draft;
    })
  }));

  const gates = analysis.gates.map<AEDraftGate>((gate) => ({
    title: gate.suggestedTitle,
    afterNodeTitle: nodes[gate.afterNodeIndex - 1]!.title,
    beforeNodeTitle: nodes[gate.beforeNodeIndex - 1]!.title,
    beforeQuestionNumber: gate.beforeQuestionNumber
  }));

  const hedged = analysis.questions
    .filter((question) => question.hedgedAnswerLabels.length > 0)
    .map((question) => `Q${question.number} (${question.hedgedAnswerLabels.join(', ')})`);
  const multipleAnswer = nodes
    .flatMap((node) => node.questions)
    .filter((question) => (question.options ?? []).filter((option) => option.correct).length > 1)
    .map((question) => `Q${question.number}`);

  return {
    sourceLabel: analysis.sourceLabel,
    ...(options.sourceDocx ? { sourceDocx: options.sourceDocx } : {}),
    ...(options.columnQuestions ? { columnQuestions: true } : {}),
    breakMarkerCount: analysis.breakMarkerCount,
    _review: [
      'DRAFT transcribed from the DOCX. Not authority for LAMS; confirm every title, answer key, and mark.',
      'Node titles follow the "AE Case <n> Q<range>" convention derived from the Case headings in the document.',
      ...(options.images ? imageSummary(options.images) : []),
      ...(hedged.length > 0
        ? [
            `The document hedges its answer key for ${hedged.join(', ')}. Ask the user whether a hedged answer ` +
              'scores like any other correct answer or not at all, then set hedgedAnswers to "include" or "exclude".'
          ]
        : []),
      ...(multipleAnswer.length > 0
        ? [
            `Questions with more than one correct answer: ${multipleAnswer.join(', ')}. Ask the user whether to split the credit ` +
              '(multipleAnswerCredit "split", e.g. 50/50) or give each correct answer 100% ("full"), then set multipleAnswerCredit.'
          ]
        : []),
      ...analysis.warnings,
      ...analysis.reviewRequired
    ],
    nodes,
    gates
  };
}

/** Blank lines above a prompt belong to whatever the document printed before it. */
function trimBlankLines(lines: string[]): string[] {
  const content = lines.flatMap((line, index) => (line === '' ? [] : [index]));
  return content.length === 0 ? [] : lines.slice(content[0], content.at(-1)! + 1);
}

function imageSummary(images: DocxImage[]): string[] {
  const importable = images.filter((image) => !image.afterAnswerKey);
  const assigned = importable.filter((image) => image.questionNumber !== null);
  const before = assigned.filter((image) => image.placement === 'before').map((image) => `Q${image.questionNumber}`);
  const unassigned = importable.length - assigned.length;
  const rationale = images.filter((image) => image.afterAnswerKey).map((image) => `Q${image.questionNumber}`);
  return [
    [
      `Embedded images: ${importable.length} (${assigned.length} assigned by question number`,
      before.length > 0 ? `, printed above the stem for ${[...new Set(before)].join(', ')}` : '',
      unassigned > 0 ? `, ${unassigned} unassigned and not imported` : '',
      '). Set sourceDocx to import them.'
    ].join(''),
    ...(rationale.length > 0
      ? [
          `${rationale.length} further image(s) are printed under the answer key of ${[...new Set(rationale)].join(', ')}, ` +
            'so they illustrate the rationale and are NOT imported. Name the file in that question\'s "images" if a learner should see it.'
        ]
      : [])
  ];
}
