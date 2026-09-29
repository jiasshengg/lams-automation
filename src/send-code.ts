import { loadConfig, parseRequestOverrides } from './config.js';
import { loadEnvFile } from './load-env.js';
import { sendCodeToSheet } from './sheets/code-sink.js';

/**
 * Publishes a 5-digit lesson code to the Kanban sheet.
 *
 *   npm run send:code -- --code 12345 --tab "INTERNS_Kanban AY26/27" --details "TBL Session: FOM TBL 11 ..."
 *
 * The row is the tab plus its "TBL/Quiz Details" (column G) text. Without --tab/--details
 * the request's kanbanTab/kanbanDetails are used; both are required, since no row is
 * assumed. --identifier is the older name for --details.
 */
loadEnvFile();

async function main(): Promise<void> {
  const code = readArgument('--code');
  if (!code) throw new Error('Pass --code <5 digits>.');

  let identifier = readArgument('--details') ?? readArgument('--identifier');
  let tab = readArgument('--tab');
  if (!identifier || !tab) {
    const config = await loadConfig(readArgument('--config') ?? 'configs/local.json', parseRequestOverrides(readArgument('--request-json')));
    identifier ??= config.kanbanDetails;
    tab ??= config.kanbanTab;
  }
  if (!tab) throw new Error('Pass --tab "<Kanban tab>" (or kanbanTab in --request-json).');
  if (!identifier) throw new Error('Pass --details "<TBL/Quiz Details>" (or kanbanDetails in --request-json).');

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(`DRY RUN: would send code ${code} for "${identifier}" to the Kanban tab "${tab}".`);
    return;
  }

  await sendCodeToSheet(code, identifier, tab);
  console.log(`Sent code ${code} for "${identifier}" to the Kanban tab "${tab}".`);
}

/**
 * Reads `--name value`, joining every token up to the next `--flag`.
 *
 * `npm run send:code -- --identifier "[Claude-Test-2] [Jss] TEST LESSON A 280826"` loses
 * the quotes on the way through npm on Windows, so taking only argv[index + 1] silently
 * sent "[Claude-Test-2]" as the identifier and the sheet lookup failed for the wrong
 * reason. The identifier has to match column G exactly, so the whole run is kept.
 */
function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const parts: string[] = [];
  for (let next = index + 1; next < process.argv.length; next += 1) {
    const value = process.argv[next]!;
    if (value.startsWith('--')) break;
    parts.push(value);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
