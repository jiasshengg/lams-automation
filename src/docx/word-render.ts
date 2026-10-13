import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readZipEntries, requireZipEntry } from './archive.js';
import { topLevelBlocks } from './blocks.js';
import type { RenderTarget } from './render-targets.js';
import { macPageExporter, windowsPageExporter } from './page-exporters.js';
import { renderWithWordPages, type PageExporter } from './word-render-pages.js';
import { writeZipEntries } from './zip-writer.js';

const run = promisify(execFile);

/** Word pictures the page at twice its printed size, so text stays sharp when the browser scales it. */
export const RENDER_SCALE = 2;
const RENDER_TIMEOUT_MS = 300_000;
const BOOKMARK_ID_BASE = 990_000;
const SCRIPT = fileURLToPath(new URL('../../scripts/render-docx-figures.ps1', import.meta.url));
/** Word for Mac's own folder: it is sandboxed, and this is where it may read and write without asking. */
const OFFICE_CONTAINER = path.join(os.homedir(), 'Library', 'Group Containers', 'UBF8T346G9.Office');
/**
 * One stable folder for the copies Word saves as PDF, emptied after every run and never removed.
 * On a Mac it lies inside Word's own folder, so Word never asks to be granted it; without that
 * folder, and on Windows, it is `.word-render/` in the repository.
 */
const PAGE_WORKSPACE =
  process.platform === 'darwin' && existsSync(OFFICE_CONTAINER)
    ? path.join(OFFICE_CONTAINER, 'lams-word-render')
    : fileURLToPath(new URL('../../.word-render/', import.meta.url));

export interface RenderedFigure {
  id: string;
  /** One picture per printed page: Word pictures a range only up to the end of its first page. */
  parts: RenderedPart[];
  /** Empty paragraphs after a floating figure that it is drawn over: room left for it, not blank lines. */
  coveredAfter: number;
}

export interface RenderedPart {
  firstBlock: number;
  lastBlock: number;
  path: string;
  /** The printed size in CSS pixels: the PNG is `RENDER_SCALE` times larger. */
  widthPx: number;
  heightPx: number;
}

export interface RenderOutcome {
  rendered: Map<string, RenderedFigure>;
  /** Why a target could not be rendered; it stays as the draft rebuilt it. */
  failures: Map<string, string>;
  /** Set when nothing could be rendered on this computer at all. */
  unavailable?: string;
  /** The targets an agent cropped from Word's page by eye, rather than the renderer. */
  agentCropped?: ReadonlySet<string>;
}

/** Word's pages of a document as images, on the platforms whose Word can save a PDF unattended. */
export function platformPageExporter(): { exporter: PageExporter; workspace: string } {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('Printing the document to pages needs Microsoft Word on Windows or macOS.');
  }
  return { exporter: process.platform === 'darwin' ? macPageExporter : windowsPageExporter, workspace: PAGE_WORKSPACE };
}

export interface RenderRequest {
  target: RenderTarget;
  /** The PNG to write. Its folder is created when missing. */
  outputPath: string;
}

/**
 * Renders tables and drawn figures of a Source-of-Truth to PNG with Microsoft Word, so learners see
 * them exactly as the document prints them. Word reads a temporary copy in which each target is
 * bookmarked; the user's document is never opened or changed.
 */
export async function renderWithWord(docx: Buffer, requests: RenderRequest[]): Promise<RenderOutcome> {
  const outcome: RenderOutcome = { rendered: new Map(), failures: new Map() };
  if (requests.length === 0) return outcome;
  // Word for Mac cannot hand over a picture of a range, so a Mac compares Word's pages instead.
  // LAMS_WORD_RENDER=pages runs that same comparison on Windows, to check it there.
  const comparePages = process.platform === 'darwin' || (process.platform === 'win32' && process.env.LAMS_WORD_RENDER === 'pages');
  if (comparePages) {
    return renderWithWordPages(docx, requests, {
      exporter: process.platform === 'darwin' ? macPageExporter : windowsPageExporter,
      workspace: PAGE_WORKSPACE,
      scale: RENDER_SCALE
    });
  }
  if (process.platform !== 'win32') {
    return { ...outcome, unavailable: 'Rendering tables and figures needs Microsoft Word on Windows or macOS.' };
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lams-render-'));
  try {
    const bookmarks = requests.map((request, index) => ({ request, name: `_LamsRender${index + 1}`, id: BOOKMARK_ID_BASE + index }));
    const copy = path.join(workspace, 'source.docx');
    await writeFile(copy, bookmarkedCopy(docx, bookmarks.map(({ request, name, id }) => ({ target: request.target, name, id }))));
    for (const request of requests) await mkdir(path.dirname(request.outputPath), { recursive: true });
    const resultPath = path.join(workspace, 'result.json');
    const jobPath = path.join(workspace, 'job.json');
    await writeFile(jobPath, JSON.stringify({
      docx: copy,
      result: resultPath,
      scale: RENDER_SCALE,
      targets: bookmarks.map(({ request, name }) => ({
        id: request.target.id,
        kind: request.target.kind,
        bookmark: name,
        out: path.resolve(request.outputPath),
        // Word's own count of the figure's paragraphs must match, or the page parts would be misplaced.
        paragraphs: request.target.lastBlock - request.target.firstBlock + 1
      }))
    }), 'utf8');

    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Job', jobPath], {
        timeout: RENDER_TIMEOUT_MS,
        windowsHide: true
      });
    } catch (error) {
      return { ...outcome, unavailable: `Microsoft Word could not render the document: ${conciseError(error)}` };
    }

    const results = parseResults(await readFile(resultPath, 'utf8'));
    for (const { request } of bookmarks) {
      const { target } = request;
      const result = results.get(target.id);
      const span = target.lastBlock - target.firstBlock;
      if (!result?.ok || result.parts.length === 0 || result.parts.some((part) => part.last > span)) {
        outcome.failures.set(target.id, result?.error ?? 'Word reported no result.');
        continue;
      }
      outcome.rendered.set(target.id, {
        id: target.id,
        // A table is always one part; a figure's parts name its paragraphs counted from its first.
        parts: result.parts.map((part) => ({
          firstBlock: target.firstBlock + part.first,
          lastBlock: target.kind === 'table' ? target.lastBlock : target.firstBlock + part.last,
          path: part.out,
          widthPx: Math.round(part.width / RENDER_SCALE),
          heightPx: Math.round(part.height / RENDER_SCALE)
        })),
        coveredAfter: result.coveredAfter
      });
    }
    return outcome;
  } finally {
    // Word can still hold the copy open after a timeout; a temporary folder left behind is harmless.
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The document with each target wrapped in a body-level bookmark that Word can find, and with the
 * highlighting inside the targets removed: a highlight is how a Source-of-Truth marks an answer, and
 * a picture of it would show learners the key.
 */
export function bookmarkedCopy(docx: Buffer, bookmarks: { target: RenderTarget; name: string; id: number }[]): Buffer {
  const entries = readZipEntries(docx);
  const documentXml = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const blocks = topLevelBlocks(documentXml);
  const edits = bookmarks.map(({ target, name, id }) => {
    const first = blocks[target.firstBlock];
    const last = blocks[target.lastBlock];
    if (!first || !last) throw new Error(`Render target ${target.id} lies outside the document body.`);
    return { start: first.start, end: last.end, name, id };
  });
  let xml = '';
  let cursor = 0;
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    if (edit.start < cursor) throw new Error('Render targets must not overlap.');
    xml += documentXml.slice(cursor, edit.start);
    xml += `<w:bookmarkStart w:id="${edit.id}" w:name="${edit.name}"/>`;
    xml += documentXml.slice(edit.start, edit.end).replace(/<w:highlight\b[^>]*\/>/g, '');
    xml += `<w:bookmarkEnd w:id="${edit.id}"/>`;
    cursor = edit.end;
  }
  xml += documentXml.slice(cursor);
  const copy = new Map(entries);
  copy.set('word/document.xml', Buffer.from(xml, 'utf8'));
  return writeZipEntries(copy);
}

interface ScriptPart {
  /** Paragraph offsets from the target's first paragraph. */
  first: number;
  last: number;
  out: string;
  width: number;
  height: number;
}

interface ScriptResult {
  ok: boolean;
  parts: ScriptPart[];
  coveredAfter: number;
  error?: string;
}

function parseResults(text: string): Map<string, ScriptResult> {
  // Windows PowerShell writes UTF-8 with a byte-order mark.
  const parsed = JSON.parse(text.replace(/^﻿/, '')) as { results?: unknown };
  const results = new Map<string, ScriptResult>();
  for (const record of records(parsed.results)) {
    if (typeof record.id !== 'string') continue;
    const parts = records(record.parts).flatMap((part) =>
      [part.first, part.last, part.width, part.height].every(isCount) && typeof part.out === 'string' && (part.width as number) > 0
        ? [{ first: part.first as number, last: part.last as number, out: part.out, width: part.width as number, height: part.height as number }]
        : []
    );
    results.set(record.id, {
      ok: record.ok === true,
      parts,
      coveredAfter: isCount(record.coveredAfter) ? record.coveredAfter : 0,
      ...(typeof record.error === 'string' ? { error: record.error } : {})
    });
  }
  return results;
}

function records(value: unknown): Record<string, unknown>[] {
  // ConvertTo-Json writes a one-element array as the element itself.
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function conciseError(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error instanceof Error ? error.message : String(error);
  return detail.trim().split(/\r?\n/).slice(0, 3).join(' ');
}
