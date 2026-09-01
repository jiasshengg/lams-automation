import { loadConfig, parseRequestOverrides } from './config.js';
import { sendCodeToSheet } from './sheets/code-sink.js';

/**
 * Publishes a 5-digit lesson code to the Kanban sheet.
 *
 *   npm run send:code -- --code 12345
 *   npm run send:code -- --code 12345 --identifier "FOM TBL06 030926 2026Y1"
 *
 * With no --identifier the lesson title from the config is used, because that is the
 * exact string the sheet keys on in "TBL/Quiz Details" (column G).
 */
async function main(): Promise<void> {
  const code = readArgument('--code');
  if (!code) throw new Error('Pass --code <5 digits>.');

  let identifier = readArgument('--identifier');
  if (!identifier) {
    const config = await loadConfig(readArgument('--config') ?? 'configs/example.json', parseRequestOverrides(readArgument('--request-json')));
    identifier = config.lessonTitle;
  }

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(`DRY RUN: would send code ${code} for "${identifier}".`);
    return;
  }

  await sendCodeToSheet(code, identifier);
  console.log(`Sent code ${code} for "${identifier}" to the Kanban sheet.`);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
