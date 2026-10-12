import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PageExporter } from './word-render-pages.js';

const run = promisify(execFile);
const EXPORT_TIMEOUT_MS = 600_000;
const scriptPath = (name: string) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));

/** PDF pages are measured in points (1/72 inch); CSS pixels are 1/96 inch. */
const CSS_PIXELS_PER_POINT = 96 / 72;

/**
 * Microsoft Word for Mac saves each document as a PDF (AppleScript), and macOS's PDFKit draws its
 * pages (JavaScript for Automation). Both ship with macOS; only Word must be installed.
 */
export const macPageExporter: PageExporter = async (documents, { scale, workspace }) => {
  const pdfs = documents.map((document) => ({ ...document, pdf: path.join(workspace, `${document.name}.pdf`) }));
  try {
    await run('osascript', [scriptPath('word-to-pdf.applescript'), ...pdfs.flatMap(({ docx, pdf }) => [docx, pdf])], { timeout: EXPORT_TIMEOUT_MS });
  } catch (error) {
    throw new Error(macWordProblem(error, workspace));
  }
  const pages = new Map<string, string[]>();
  for (const { name, pdf } of pdfs) {
    const prefix = path.join(workspace, name);
    const { stdout } = await run('osascript', ['-l', 'JavaScript', scriptPath('pdf-pages.js'), pdf, prefix, String(scale * CSS_PIXELS_PER_POINT)], {
      timeout: EXPORT_TIMEOUT_MS
    });
    const count = Number(stdout.trim());
    if (!Number.isInteger(count) || count <= 0) throw new Error(`macOS could not draw the pages of ${pdf}.`);
    pages.set(name, Array.from({ length: count }, (_value, index) => `${prefix}-${index + 1}.png`));
  }
  return pages;
};

/**
 * Microsoft Word for Windows saves each document as a PDF and Windows draws its pages: the same
 * comparison as on a Mac, so it can be checked on Windows. Windows otherwise renders with
 * `renderWithWord`, which asks Word for a picture of each range directly.
 */
export const windowsPageExporter: PageExporter = async (documents, { scale, workspace }) => {
  const job = path.join(workspace, 'pages-job.json');
  const result = path.join(workspace, 'pages-result.json');
  await writeFile(job, JSON.stringify({
    scale,
    result,
    documents: documents.map(({ name, docx }) => ({ name, docx, pdf: path.join(workspace, `${name}.pdf`), prefix: path.join(workspace, name) }))
  }), 'utf8');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('render-docx-pages.ps1'), '-Job', job], {
    timeout: EXPORT_TIMEOUT_MS,
    windowsHide: true
  });
  // Windows PowerShell writes UTF-8 with a byte-order mark.
  const parsed = JSON.parse((await readFile(result, 'utf8')).replace(/^﻿/, '')) as { pages?: Record<string, unknown> };
  const pages = new Map<string, string[]>();
  for (const [name, list] of Object.entries(parsed.pages ?? {})) {
    // ConvertTo-Json writes a one-element array as the element itself, and can nest a returned list
    // in another; the page files are every string, in order.
    const files = [list].flat(Infinity).filter((file): file is string => typeof file === 'string');
    pages.set(name, files);
  }
  return pages;
};

/** What stopped Word for Mac, in words the person at the Mac can act on. */
function macWordProblem(error: unknown, workspace: string): string {
  const stderr = String((error as { stderr?: unknown }).stderr ?? (error instanceof Error ? error.message : error));
  if ((error as { killed?: boolean }).killed) {
    return (
      'Microsoft Word did not finish saving the copies. If Word is showing a "Grant File Access" dialog, ' +
      `click Select, choose the folder ${workspace}, and run again; Word remembers the folder after that.`
    );
  }
  if (/-1743|not allowed to send Apple events|Not authori[sz]ed/i.test(stderr)) {
    return (
      'macOS has not allowed this Terminal to control Microsoft Word. Open System Settings > Privacy & Security > ' +
      'Automation, allow your terminal app to control Microsoft Word, and run again.'
    );
  }
  if (/-1728|-10814|-600|Can.t get application|application isn.t running|Unable to find application/i.test(stderr)) {
    return 'Microsoft Word for Mac is not installed or could not be started; tables and figures need it to be pictured.';
  }
  return `Microsoft Word for Mac could not save the copies as PDF: ${stderr.trim().split(/\r?\n/).slice(0, 3).join(' ')}`;
}
