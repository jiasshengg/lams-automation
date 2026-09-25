import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveInputFile } from './input-file.js';
import { detectCaseHeadings, extractDocxImages, formatUnresolvedSotWarnings } from './docx/media.js';

async function main(): Promise<void> {
  const input = readArgument('--sot-docx');
  if (!input) throw new Error('Usage: npm run extract:sot-media -- --sot-docx <path> [--out-dir <directory>] [--manifest <json-path>]');
  if (process.argv.includes('--commit')) throw new Error('SOT media extraction is local-only and does not accept --commit.');
  const source = await resolveInputFile(input, '.docx');
  const defaultName = `${path.basename(source, path.extname(source)).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-media`;
  const outputDirectory = path.resolve(readArgument('--out-dir') ?? path.join('artifacts', defaultName));
  const buffer = await readFile(source);
  const manifest = await extractDocxImages(buffer, source, outputDirectory);
  const manifestPath = path.resolve(readArgument('--manifest') ?? path.join(outputDirectory, 'manifest.json'));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Extracted ${manifest.imageCount} image(s) from ${source}`);
  console.log(`Manifest: ${manifestPath}`);
  if (manifest.unassignedImageIds.length > 0) {
    console.log(`Review required: ${manifest.unassignedImageIds.length} image(s) were not associated with a numbered question.`);
  }
  for (const warning of formatUnresolvedSotWarnings(detectCaseHeadings(buffer), manifest.images)) {
    console.log(`Review needed: ${warning}`);
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
