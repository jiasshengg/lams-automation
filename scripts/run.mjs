import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));

export function resolveCommand(args) {
  const [operation, ...input] = args;
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const command = scripts[operation];
  if (typeof command !== 'string' || !/^(tsx src\/[\w-]+\.ts|node scripts\/setup\/login\.mjs)( --[\w-]+)?$/.test(command)) {
    throw new Error('Choose a LAMS operation from package.json, e.g. run:tbl, preflight:tbl, apply:irat, login:check.');
  }
  let logFile;
  const forwarded = [];
  const flags = new Set(['--commit', '--dry-run', '--validate', '--source', '--json', '--keep-open', '--skip-sot-check', '--monitor-only', '--no-publish-code', '--publish-code', '--check-only', '--resume-trat-sync', '--preflight-only', '--monitor']);
  const values = new Set(['--config', '--request-json', '--ae-json', '--repair-json', '--team-setup', '--slow-mo', '--query', '--exact-title', '--roots', '--max-expansions', '--node', '--dump-question', '--sot-docx', '--out', '--draft', '--expect-design', '--checkpoint', '--batch-size', '--question-batch-size', '--lesson', '--manifest', '--out-dir', '--title', '--gate', '--rotation-seconds', '--code', '--identifier', '--repair-question']);
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (flags.has(arg)) { forwarded.push(arg); continue; }
    if (values.has(arg) || arg === '--log-file') {
      const value = input[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--log-file') logFile = value;
      else forwarded.push(arg, value);
      continue;
    }
    throw new Error(`Unexpected argument ${JSON.stringify(arg)}. A shell may have lost a flag; refusing to use defaults. Use node scripts/run.mjs <operation> --request-json <file>.`);
  }
  const [runtime, entry, ...preset] = command.split(' ');
  return { args: [...(runtime === 'tsx' ? [require.resolve('tsx/cli')] : []), path.join(root, entry), ...preset, ...forwarded], logFile };
}

export async function run(args) {
  const command = resolveCommand(args);
  const log = command.logFile ? createWriteStream(command.logFile, { flags: 'a', mode: 0o600 }) : undefined;
  if (log) await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command.args, { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', data => { process.stdout.write(data); log?.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); log?.write(data); });
    child.once('error', error => { log?.end(); reject(error); });
    child.once('close', (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      if (log) log.end(() => resolve(status));
      else resolve(status);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
