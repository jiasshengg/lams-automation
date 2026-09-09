import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { discoverLessons } from './lams/lesson-discovery.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  if (process.argv.includes('--commit')) throw new Error('discover:lessons is read-only and does not accept --commit.');
  const config = await loadConfig(readArgument('--config') ?? 'configs/local.json', parseRequestOverrides(readArgument('--request-json')));
  const maxExpansions = Number(readArgument('--max-expansions') ?? 1000);
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1) throw new Error('--max-expansions must be a positive integer.');
  const roots = readArgument('--roots')?.split('|').map(root => root.trim()).filter(Boolean);
  if (roots && !roots.length) throw new Error('--roots must contain at least one folder name.');
  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;
  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    const candidates = await discoverLessons(activePage, {
      ...(roots ? { roots } : {}),
      query: readArgument('--query') ?? '',
      maxExpansions,
      timeoutMs: config.browser.actionTimeoutMs
    });
    console.log(`\nRead-only Authoring library discovery: ${candidates.length} matching lesson(s).`);
    console.log('Scope: Courses' + (roots ? ` > ${roots.join(' | ')}` : ' (all accessible folders; may include other courses)'));
    console.log(JSON.stringify({ complete: true, candidates }, null, 2));
    console.log('No lesson was opened or changed. Resolve the intended candidate before a write; matches are not automatically selected.');
    const directory = await saveDiagnostics(activePage, 'lesson-library-discovery');
    console.log(`Diagnostics: ${directory}`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'lesson-library-discovery-failure').catch(() => undefined);
    if (directory) console.error(`Diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
