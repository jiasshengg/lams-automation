import path from 'node:path';
import { topLevelBlocks } from '../docx/blocks.js';
import { hyperlinkTargets } from '../docx/hyperlinks.js';
import type { DocxImage } from '../docx/media.js';
import { findRenderTargets, isEmptyParagraph, renderTargetId, type RenderTarget } from '../docx/render-targets.js';
import { renderWithWord, type RenderOutcome } from '../docx/word-render.js';
import { buildAEDraft, type AEDraftPlan } from './draft.js';
import type { RenderedFigureRequest } from './plan.js';
import { renderSlotId } from './prompt-lines.js';
import { analyzeAESOT, extractSOTParagraphs } from './sot-docx.js';
import { tabTableBlockRanges, type SOTLayoutParts } from './sot-paragraphs.js';

const ALT_TEXT_LIMIT = 300;

export interface RenderedDraftOptions {
  sourceLabel: string;
  sourceDocx: string;
  images: DocxImage[];
  columnQuestions?: boolean;
  /** Where Word's pictures are written. */
  figuresDirectory: string;
  /** False keeps every table and figure as the draft rebuilds it, without opening Word. */
  render: boolean;
  /** Stands in for Word in tests. */
  renderer?: (docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]) => Promise<RenderOutcome>;
}

/**
 * Drafts the AE plan with every learner-facing table and drawn figure shown as Word's picture of
 * it. Only targets that reach a question's prompt are rendered: an option table, an answer key or a
 * rationale figure never becomes a picture. Whatever Word cannot render stays as rebuilt, and the
 * draft's `_review` says which, so a person checks those against the document.
 */
export async function buildRenderedAEDraft(
  docx: Buffer,
  parts: SOTLayoutParts & { documentXml: string },
  options: RenderedDraftOptions
): Promise<AEDraftPlan> {
  const { documentXml, ...layout } = parts;
  const draftOptions = {
    sourceDocx: options.sourceDocx,
    images: options.images,
    ...(options.columnQuestions ? { columnQuestions: true } : {})
  };
  const analyse = (renders: readonly RenderTarget[]) =>
    analyzeAESOT(extractSOTParagraphs(documentXml, layout, { renders }), options.sourceLabel, {
      columnQuestions: options.columnQuestions === true,
      linkedUrls: hyperlinkTargets(documentXml, layout.relationshipsXml)
    });

  const targets = options.render ? withTabTables(findRenderTargets(documentXml), tabTableBlockRanges(documentXml, layout)) : [];
  const shown = shownTargets(buildAEDraft(analyse(targets), { keepRenderSlots: true }), targets);
  if (shown.length === 0) return buildAEDraft(analyse([]), draftOptions);

  const requests = shown.map(({ target, question }) => ({
    target,
    outputPath: path.join(options.figuresDirectory, `Q${question}-${target.kind}-${target.id}.png`)
  }));
  const outcome = await (options.renderer ?? renderWithWord)(docx, requests);
  const blocks = topLevelBlocks(documentXml);
  const renders = new Map<string, RenderedFigureRequest>();
  const renderedTargets: RenderTarget[] = [];
  const labels = new Map<string, { target: RenderTarget; question: number }>();
  for (const entry of shown) {
    const rendered = outcome.rendered.get(entry.target.id);
    if (!rendered) continue;
    // A figure printed across two pages comes back as one picture per page, each in its own slot.
    rendered.parts.forEach((part, index) => {
      const last = index === rendered.parts.length - 1;
      const pageTarget: RenderTarget = {
        ...entry.target,
        id: renderTargetId(part.firstBlock, part.lastBlock),
        firstBlock: part.firstBlock,
        lastBlock: part.lastBlock
      };
      const target = last ? withCoveredParagraphs(pageTarget, rendered.coveredAfter, blocks) : pageTarget;
      renderedTargets.push(target);
      labels.set(target.id, { target, question: entry.question });
      renders.set(target.id, {
        path: planPath(part.path),
        kind: target.kind,
        blocks: [target.firstBlock, target.lastBlock],
        widthPx: part.widthPx,
        altText: altText(blocks.slice(target.firstBlock, target.lastBlock + 1).map((block) => block.inner))
      });
    });
  }
  const missed = shown.filter(({ target }) => !outcome.rendered.has(target.id));
  return buildAEDraft(analyse(renderedTargets), {
    ...draftOptions,
    renders,
    reviewNotes: renderNotes([...labels.values()], missed, outcome)
  });
}

/**
 * A floating figure is drawn over the empty paragraphs typed after it to make room for it. They
 * belong to the figure, so its one picture is not followed by that many blank lines. Word counts
 * them from the printed positions; each must also be empty in the document itself.
 */
function withCoveredParagraphs(target: RenderTarget, covered: number, blocks: ReturnType<typeof topLevelBlocks>): RenderTarget {
  let last = target.lastBlock;
  while (last - target.lastBlock < covered) {
    const next = blocks[last + 1];
    if (!next || next.kind !== 'p' || !isEmptyParagraph(next.inner)) break;
    last += 1;
  }
  return last === target.lastBlock ? target : { ...target, id: renderTargetId(target.firstBlock, last), lastBlock: last };
}

/**
 * Adds the column layouts the document builds with tab stops: they print as tables, and rebuilt as
 * HTML their columns and the emphasis that spans a tab come apart. One that states an answer key
 * stays text, like a table that carries one.
 */
function withTabTables(targets: RenderTarget[], ranges: { firstBlock: number; lastBlock: number; text: string }[]): RenderTarget[] {
  const overlaps = (first: number, last: number) => targets.some((target) => target.firstBlock <= last && first <= target.lastBlock);
  const tabTables = ranges
    .filter((range) => !TAB_TABLE_ANSWER.test(range.text) && !overlaps(range.firstBlock, range.lastBlock))
    .map<RenderTarget>((range) => ({
      id: renderTargetId(range.firstBlock, range.lastBlock),
      kind: 'table',
      firstBlock: range.firstBlock,
      lastBlock: range.lastBlock,
      hasPictures: false
    }));
  return [...targets, ...tabTables].sort((left, right) => left.firstBlock - right.firstBlock);
}

const TAB_TABLE_ANSWER = /(?:^|\s)(?:Answers?|Correct answer|Rationale|Explanation)\s*[:\-–]/i;

/** The targets that reached a learner prompt, each with the first question that shows it. */
function shownTargets(draft: AEDraftPlan, targets: readonly RenderTarget[]): { target: RenderTarget; question: number }[] {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const shown = new Map<string, { target: RenderTarget; question: number }>();
  for (const question of draft.nodes.flatMap((node) => node.questions)) {
    for (const line of question.prompt.split('\n')) {
      const id = renderSlotId(line);
      const target = id === null ? undefined : byId.get(id);
      if (target && !shown.has(target.id)) shown.set(target.id, { target, question: question.number });
    }
  }
  return [...shown.values()];
}

function renderNotes(
  rendered: { target: RenderTarget; question: number }[],
  missed: { target: RenderTarget; question: number }[],
  outcome: RenderOutcome
): string[] {
  const label = ({ target, question }: { target: RenderTarget; question: number }) => `Q${question} ${target.kind}`;
  const notes: string[] = [];
  if (rendered.length > 0) {
    notes.push(
      `Rendered with Word from the Source-of-Truth and shown as pictures: ${rendered.map(label).join(', ')}. ` +
        'Open each PNG under renderedFigures and check it matches the document and shows no answer marking.'
    );
  }
  if (missed.length > 0) {
    const reason = outcome.unavailable ?? [...new Set(missed.map(({ target }) => outcome.failures.get(target.id) ?? 'no picture was produced'))].join('; ');
    notes.push(
      `Not rendered (${reason}), so rebuilt from the DOCX instead: ${missed.map(label).join(', ')}. ` +
        'Check these tables and figures against the document; rebuilt tables lose merged cells and shading, and drawn figures lose their arrangement.'
    );
  }
  return notes;
}

/** What the picture shows, in words, for readers who cannot see it. */
function altText(blocksXml: string[]): string {
  // Words split across runs join up; paragraphs and table cells are separated by a space.
  const xml = blocksXml
    .join('</w:p>')
    .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')
    .replace(/<\/w:(?:p|tc)>/g, '<w:t> </w:t>');
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1] ?? '')
    .join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > ALT_TEXT_LIMIT ? `${text.slice(0, ALT_TEXT_LIMIT - 1).trimEnd()}…` : text;
}

/** Inside the repository the plan names the picture relative to it, the way it names other inputs. */
function planPath(file: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : absolute;
}
