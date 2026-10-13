import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { topLevelBlocks } from '../docx/blocks.js';
import { hyperlinkTargets } from '../docx/hyperlinks.js';
import type { DocxImage } from '../docx/media.js';
import { CROPS_FILE, exportTargetPages, sha256, TARGETS_FILE, type CropManifest } from '../docx/agent-crops.js';
import { findRenderTargets, isEmptyParagraph, renderTargetId, type RenderTarget } from '../docx/render-targets.js';
import type { PageExporter } from '../docx/word-render-pages.js';
import { platformPageExporter, renderWithWord, RENDER_SCALE, type RenderOutcome } from '../docx/word-render.js';
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
  /**
   * Where Word's pages are written when a table or figure could not be pictured, for an agent to
   * crop it from by eye. Left out once the agent's crops are in use.
   */
  pagesDirectory?: string;
  /** Stands in for Word when it prints those pages, in tests. */
  pageExporter?: { exporter: PageExporter; workspace: string };
  /** Stands in for Word in tests. */
  renderer?: (docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]) => Promise<RenderOutcome>;
}

/**
 * Drafts the AE plan with every learner-facing table and drawn figure shown as Word's picture of
 * it. Only targets that reach a question's prompt are rendered: an option table, an answer key or a
 * rationale figure never becomes a picture. If Word cannot picture one, no draft is written: the
 * error names each and why. `render: false` (`--no-render`) is the deliberate choice to rebuild.
 */
export async function buildRenderedAEDraft(
  docx: Buffer,
  parts: SOTLayoutParts & { documentXml: string },
  options: RenderedDraftOptions
): Promise<AEDraftPlan> {
  const { documentXml } = parts;
  const draftOptions = {
    sourceDocx: options.sourceDocx,
    images: options.images,
    ...(options.columnQuestions ? { columnQuestions: true } : {})
  };
  const { analyse, shown } = learnerFacingTargets(parts, options);
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
  const cropped: { target: RenderTarget; question: number }[] = [];
  for (const entry of shown) {
    const rendered = outcome.rendered.get(entry.target.id);
    if (!rendered) continue;
    if (outcome.agentCropped?.has(entry.target.id)) cropped.push(entry);
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
  // A table or figure rebuilt from the DOCX can lose merged cells, shading, list numbers and its
  // arrangement, so a learner-facing one Word could not picture stops the draft instead.
  if (missed.length > 0) {
    const reasons = missed.map((entry) => ({ ...entry, reason: outcome.unavailable ?? outcome.failures.get(entry.target.id) ?? 'no picture was produced' }));
    throw new Error(unrenderedMessage(reasons) + (await cropInstructions(docx, documentXml, reasons, options)));
  }
  return buildAEDraft(analyse(renderedTargets), {
    ...draftOptions,
    renders,
    reviewNotes: [...renderNotes([...labels.values()]), ...cropNotes(cropped)]
  });
}

type Missed = { target: RenderTarget; question: number; reason: string };

/**
 * Prints the Source-of-Truth with Word and writes its pages to `directory`, with the list of the
 * tables and figures the renderer could not picture: what an agent needs to crop each from its
 * page by eye. Only those are listed, so nothing the renderer left out on purpose (an option table,
 * an answer key) can be cropped.
 */
export async function writeFigurePages(
  docx: Buffer,
  documentXml: string,
  missed: readonly Missed[],
  options: { directory: string; pageExporter?: { exporter: PageExporter; workspace: string } }
): Promise<CropManifest> {
  const pages = await exportTargetPages(docx, missed.map(({ target }) => target), {
    ...(options.pageExporter ?? platformPageExporter()),
    scale: RENDER_SCALE,
    directory: options.directory
  });
  const blocks = topLevelBlocks(documentXml);
  const manifest: CropManifest = {
    sourceSha256: sha256(docx),
    scale: RENDER_SCALE,
    pages,
    targets: missed.map(({ target, question, reason }) => ({
      id: target.id,
      question,
      kind: target.kind,
      blocks: [target.firstBlock, target.lastBlock],
      text: altText(blocks.slice(target.firstBlock, target.lastBlock + 1).map((block) => block.inner)),
      reason
    }))
  };
  await writeFile(path.join(options.directory, TARGETS_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** What to do about the tables and figures that were not pictured, once their pages are written. */
async function cropInstructions(docx: Buffer, documentXml: string, missed: readonly Missed[], options: RenderedDraftOptions): Promise<string> {
  const rebuild = 'Only if a rebuilt copy is acceptable for this lesson, rerun with --no-render and check each table and figure against the document.';
  if (!options.pagesDirectory) return `\nGive each a box in ${CROPS_FILE}, or fix what is named above, and run again. ${rebuild}`;
  try {
    await writeFigurePages(docx, documentXml, missed, { directory: options.pagesDirectory, ...(options.pageExporter ? { pageExporter: options.pageExporter } : {}) });
  } catch (error) {
    return `\nWord could not print the pages to crop them from either (${error instanceof Error ? error.message : String(error)}). Fix what is named above and run again. ${rebuild}`;
  }
  return (
    `\nWord's pages are in ${options.pagesDirectory}, with these listed in ${TARGETS_FILE}. An agent can crop each from its page: ` +
    `write a box for each into ${path.join(options.pagesDirectory, CROPS_FILE)} and run again with --figure-crops ${options.pagesDirectory}. ${rebuild}`
  );
}

/** The tables and figures that reach a learner prompt, and the analysis that reads them as pictures. */
function learnerFacingTargets(
  parts: SOTLayoutParts & { documentXml: string },
  options: { sourceLabel: string; columnQuestions?: boolean; render: boolean }
) {
  const { documentXml, ...layout } = parts;
  const analyse = (renders: readonly RenderTarget[]) =>
    analyzeAESOT(extractSOTParagraphs(documentXml, layout, { renders }), options.sourceLabel, {
      columnQuestions: options.columnQuestions === true,
      linkedUrls: hyperlinkTargets(documentXml, layout.relationshipsXml)
    });
  const targets = options.render ? withTabTables(findRenderTargets(documentXml), tabTableBlockRanges(documentXml, layout)) : [];
  const shown = shownTargets(buildAEDraft(analyse(targets), { keepRenderSlots: true }), targets);
  return { analyse, shown };
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

const targetLabel = ({ target, question }: { target: RenderTarget; question: number }) => `Q${question} ${target.kind}`;

function renderNotes(rendered: { target: RenderTarget; question: number }[]): string[] {
  if (rendered.length === 0) return [];
  return [
    `Rendered with Word from the Source-of-Truth and shown as pictures: ${rendered.map(targetLabel).join(', ')}. ` +
      'Open each PNG under renderedFigures and check it matches the document and shows no answer marking.'
  ];
}

function cropNotes(cropped: { target: RenderTarget; question: number }[]): string[] {
  if (cropped.length === 0) return [];
  return [
    `Cropped from Word's page by the agent, by eye, because the renderer could not picture them: ${cropped.map(targetLabel).join(', ')}. ` +
      'Check each of these edge to edge against the document: nothing cut off, and nothing from the lines around it. ' +
      'Every empty line typed directly after a cropped figure was taken as room left for it.'
  ];
}

/** Why the draft stopped: each table or figure the renderer could not picture, with its reason. */
function unrenderedMessage(missed: readonly Missed[]): string {
  const lines = missed.map((entry) => `- ${targetLabel(entry)} (blocks ${entry.target.firstBlock}-${entry.target.lastBlock}): ${entry.reason}`);
  return (
    'These learner-facing tables and figures could not be pictured with Microsoft Word, and a rebuilt copy can lose merged cells, ' +
    `shading, list numbers and arrangement, so no draft was written:\n${lines.join('\n')}`
  );
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
