import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeAESOT, extractSOTParagraphs, formatAESOTSummary, readDocumentXmlFromDocx } from './ae/sot-docx.js';

async function main(): Promise<void> {
  const inputPath = readArgument('--sot-docx');
  if (!inputPath) {
    throw new Error('Usage: npm run extract:ae-sot -- --sot-docx <path> [--out <json-path>] [--json]');
  }
  if (process.argv.includes('--commit')) throw new Error('AE SOT extraction is read-only and does not accept --commit.');

  const absoluteInput = path.resolve(inputPath);
  if (path.extname(absoluteInput).toLowerCase() !== '.docx') throw new Error('AE SOT input must be a .docx file.');
  const documentXml = readDocumentXmlFromDocx(await readFile(absoluteInput));
  const analysis = analyzeAESOT(extractSOTParagraphs(documentXml), path.basename(absoluteInput, path.extname(absoluteInput)));
  const output = JSON.stringify(analysis, null, 2);
  const outputPath = readArgument('--out');
  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    await writeFile(absoluteOutput, `${output}\n`, 'utf8');
    console.log(`Wrote reviewed-AE draft evidence to ${absoluteOutput}`);
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
