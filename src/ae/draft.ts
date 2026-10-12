import type { DocxImage } from '../docx/media.js';
import { aeGateTitle, type RenderedFigureRequest } from './plan.js';
import { IMAGE_SLOT_LINE, renderSlotId } from './prompt-lines.js';
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
  options?: { text: string; correct: boolean }[];
  TODO_answerKey?: string;
  /** Reviewed additions: pictures for this question, and whether they replace the document's own. */
  images?: { path: string; altText?: string; widthPx?: number; placement?: 'before' | 'after'; caption?: string }[];
  replaceSourceFigures?: boolean;
  promptReplacements?: { find: string; replaceWith: string }[];
  /** Tables and drawn figures Word rendered as pictures, each filling one image slot. */
  renderedFigures?: RenderedFigureRequest[];
}

export interface AEDraftGate {
  title: string;
  afterNodeTitle: string;
  beforeNodeTitle: string;
  beforeQuestionNumber: number;
}

export interface AEDraftOptions {
  sourceDocx?: string;
  images?: DocxImage[];
  columnQuestions?: boolean;
  /** Word's pictures of the tables and figures the analysis marked for rendering, by render id. */
  renders?: ReadonlyMap<string, RenderedFigureRequest>;
  /** Leave the render markers in the prompts, to find which questions show which targets. */
  keepRenderSlots?: boolean;
  /** Further notes for `_review`, such as what was rendered and what could not be. */
  reviewNotes?: string[];
}

export function buildAEDraft(analysis: AESOTAnalysis, options: AEDraftOptions = {}): AEDraftPlan {
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
      const placed = placeRenderedFigures(prompt, options);
      const draft: AEDraftQuestion = {
        number,
        type: question.type === 'open-response' ? 'essay' : 'mcq',
        prompt: placed.prompt
      };
      if (placed.figures.length > 0) draft.renderedFigures = placed.figures;
      if (question.explicitMarks !== null) draft.marks = question.explicitMarks;
      if (question.options.length > 0) {
        draft.options = question.options.map((option) => ({
          text: option.html,
          correct: option.correct
        }));
      }
      if (draft.options && !draft.options.some((option) => option.correct)) {
        draft.TODO_answerKey = 'No answer key was detected in the Source-of-Truth; mark the correct option before writing.';
      }
      return draft;
    })
  }));

  // Each gate takes its title from the node it leads into, so the two are always spelled alike.
  const gates = analysis.gates.map<AEDraftGate>((gate) => ({
    title: aeGateTitle(nodes[gate.beforeNodeIndex - 1]!.title),
    afterNodeTitle: nodes[gate.afterNodeIndex - 1]!.title,
    beforeNodeTitle: nodes[gate.beforeNodeIndex - 1]!.title,
    beforeQuestionNumber: gate.beforeQuestionNumber
  }));

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
      ...(multipleAnswer.length > 0
        ? [
            `Questions with more than one correct answer: ${multipleAnswer.join(', ')}. Ask the user whether to split the credit ` +
              '(multipleAnswerCredit "split", e.g. 50/50) or give each correct answer 100% ("full"), then set multipleAnswerCredit.'
          ]
        : []),
      ...(options.reviewNotes ?? []),
      ...analysis.warnings,
      ...analysis.reviewRequired
    ],
    nodes,
    gates
  };
}

/**
 * Each rendered table or figure takes an ordinary image slot, and the question records the picture
 * that fills it. A marker with no picture (the Source-of-Truth check reads the plan's figures back
 * without rendering them) still becomes a slot, so both sides compare the same prompt.
 */
function placeRenderedFigures(prompt: string, options: AEDraftOptions): { prompt: string; figures: RenderedFigureRequest[] } {
  const figures: RenderedFigureRequest[] = [];
  const lines = prompt.split('\n').map((line) => {
    const id = renderSlotId(line);
    if (id === null || options.keepRenderSlots) return line;
    const figure = options.renders?.get(id);
    if (figure) figures.push(figure);
    return IMAGE_SLOT_LINE;
  });
  return { prompt: lines.join('\n'), figures };
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
