import { readFile } from 'node:fs/promises';
import { launchLamsBrowser } from '../scripts/setup/browser-profile.mjs';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { resolveInputFile } from './input-file.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { parsePlaceholderRepair, persistPlaceholderRepairs, projectPlaceholderRepairs, repairAEPlaceholders } from './lams/ae-placeholder.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';
import { saveDiagnostics } from './lams/diagnostics.js';

function argument(name: string) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
async function main() {
  const input = argument('--repair-json');
  if (!input) throw new Error('Supply --repair-json containing the user-authorized exact lesson and placeholder edges.');
  const plan = parsePlaceholderRepair(JSON.parse(await readFile(await resolveInputFile(input, '.json'), 'utf8')));
  const config = await loadConfig(argument('--config') ?? 'configs/local.json', parseRequestOverrides(argument('--request-json')));
  if (config.lessonTitle !== plan.lessonTitle) throw new Error('Repair plan lessonTitle differs from the requested lesson.');
  const context = await launchLamsBrowser(config.browser.userDataDir, browserLaunchOptions(config));
  let active = context.pages()[0] ?? await context.newPage();
  try {
    await openLams(active, config);
    await selectWorkspaceCourse(active, config);
    active = await openAuthoring(active, config);
    await openLessonFromLibrary(active, config.destinationFolderPath, config.lessonTitle, config);
    const expected = projectPlaceholderRepairs(await inspectAuthoringGraph(active), plan);
    if (process.argv.includes('--dry-run')) { console.log('Exact placeholder topology verified; no changes made.'); return; }
    await repairAEPlaceholders(active, plan, config.browser.actionTimeoutMs);
    await persistPlaceholderRepairs(active, expected, () =>
      openLessonFromLibrary(active, config.destinationFolderPath, config.lessonTitle, config));
    console.log('Placeholder repair saved and verified after reopening the exact lesson.');
  } catch (error) {
    const dir = await saveDiagnostics(active, 'ae-placeholder-repair-failure').catch(() => undefined);
    if (dir) console.error(`Diagnostics: ${dir}`);
    throw error;
  } finally { await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
