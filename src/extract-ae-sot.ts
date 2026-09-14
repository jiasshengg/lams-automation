import { resolveInputFile } from './input-file.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAEDraft } from './ae/draft.js';
import { analyzeAESOT, extractSOTParagraphs, formatAESOTSummary, readSOTDocxParts } from './ae/sot-docx.js';
import { inspectDocxImages } from './docx/media.js';

async function main(): Promise<void> {
  const inputPath = readArgument('--sot-docx');
  if (!inputPath) {
    throw new Error('Usage: npm run extract:ae-sot -- --sot-docx <path> [--out <json-path>] [--draft <json-path>] [--json]');
  }
  if (process.argv.includes('--commit')) throw new Error('AE SOT extraction is read-only and does not accept --commit.');

  const absoluteInput = await resolveInputFile(inputPath, '.docx');
  if (path.extname(absoluteInput).toLowerCase() !== '.docx') throw new Error('AE SOT input must be a .docx file.');
  const buffer = await readFile(absoluteInput);
  const { documentXml, ...layout } = readSOTDocxParts(buffer);
  const analysis = analyzeAESOT(extractSOTParagraphs(documentXml, layout), path.basename(absoluteInput, path.extname(absoluteInput)));
  const output = JSON.stringify(analysis, null, 2);
  const outputPath = readArgument('--out');
  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    await writeFile(absoluteOutput, `${output}\n`, 'utf8');
    console.log(`Wrote reviewed-AE draft evidence to ${absoluteOutput}`);
  }

  const draftPath = readArgument('--draft');
  if (draftPath) {
    const draft = buildAEDraft(analysis, {
      sourceDocx: path.basename(absoluteInput),
      images: inspectDocxImages(buffer)
    });
    const absoluteDraft = path.resolve(draftPath);
    await writeFile(absoluteDraft, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    console.log(`Wrote a reviewable AE plan draft to ${absoluteDraft}`);
    console.log('The draft is not executable input until every _review and TODO_ entry is resolved.');
  }
  console.log(process.argv.includes('--json') ? output : formatAESOTSummary(analysis));
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
