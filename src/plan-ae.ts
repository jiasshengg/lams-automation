import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAEPlan, formatAEPlanSummary } from './ae/plan.js';

async function main(): Promise<void> {
  const inputPath = readArgument('--ae-json');
  if (!inputPath) throw new Error('Usage: npm run plan:ae -- --ae-json <path> [--json]');
  const absolutePath = path.resolve(inputPath);
  const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));
  const plan = buildAEPlan(parsed);
  console.log(process.argv.includes('--json') ? JSON.stringify(plan, null, 2) : formatAEPlanSummary(plan));
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
