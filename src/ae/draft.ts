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
}

export interface AEDraftGate {
  title: string;
  afterNodeTitle: string;
  beforeNodeTitle: string;
  beforeQuestionNumber: number;
}

export function buildAEDraft(
  analysis: AESOTAnalysis,
  options: { sourceDocx?: string; images?: DocxImage[] } = {}
): AEDraftPlan {
  const nodes = analysis.nodes.map<AEDraftNode>((node) => ({
    title: node.suggestedTitle,
    questions: node.questionNumbers.map((number, index) => {
      const question = analysis.questions.find((candidate) => candidate.number === number)!;
      const prompt = index === 0 ? [...node.contextHtml, question.promptHtml].join('\n') : question.promptHtml;
      const draft: AEDraftQuestion = {
        number,
        type: question.type === 'open-response' ? 'essay' : 'mcq',
        prompt
      };
      if (question.explicitMarks !== null) draft.marks = question.explicitMarks;
      if (question.options.length > 0) {
        draft.options = question.options.map((option) => ({ text: option.html, correct: option.correct }));
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

  return {
    sourceLabel: analysis.sourceLabel,
    ...(options.sourceDocx ? { sourceDocx: options.sourceDocx } : {}),
    breakMarkerCount: analysis.breakMarkerCount,
    _review: [
      'DRAFT transcribed from the DOCX. Not authority for LAMS; confirm every title, answer key, and mark.',
      'Node titles follow the "AE Case <n> Q<range>" convention derived from the Case headings in the document.',
      ...(options.images ? [imageSummary(options.images)] : []),
      ...analysis.warnings,
      ...analysis.reviewRequired
    ],
    nodes,
    gates
  };
}

function imageSummary(images: DocxImage[]): string {
  const assigned = images.filter((image) => image.questionNumber !== null);
  const before = assigned.filter((image) => image.placement === 'before').map((image) => `Q${image.questionNumber}`);
  const unassigned = images.length - assigned.length;
  return [
    `Embedded images: ${images.length} (${assigned.length} assigned by question number`,
    before.length > 0 ? `, printed above the stem for ${[...new Set(before)].join(', ')}` : '',
    unassigned > 0 ? `, ${unassigned} unassigned and not imported` : '',
    '). Set sourceDocx to import them.'
  ].join('');
}
