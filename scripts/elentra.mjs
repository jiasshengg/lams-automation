import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pythonEnv } from './setup/elentra-setup.mjs';
import { elentraDir, venvPython } from './setup/python-runtime.mjs';

// Each Elentra operation is a Python script run with the project .venv interpreter, which is
// equivalent to activating the venv. npm scripts and scripts/run.mjs both come through here.
export const ELENTRA_OPERATIONS = {
  login: ['session.py', '--login'],
  check: ['session.py', '--check'],
  download: ['main.py'],
  links: ['playwright_resource_adder.py'],
  pipeline: ['run_pipeline.py'],
  kanban: ['kanban.py'],
  'sandbox-test': ['test_add_resource.py'],
  'unit-tests': ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.']
};

export function resolveElentraCommand([operation, ...args], python = venvPython()) {
  const preset = ELENTRA_OPERATIONS[operation];
  if (!preset) throw new Error(`Choose an Elentra operation: ${Object.keys(ELENTRA_OPERATIONS).join(', ')}.`);
  if (!existsSync(python)) throw new Error('The Elentra Python environment is not installed. Run npm run setup:elentra.');
  const [script, ...fixed] = preset;
  const entry = script.startsWith('-') ? script : path.join(elentraDir, script);
  return { command: python, args: [entry, ...fixed, ...args] };
}

export function runElentra(args) {
  const { command, args: commandArgs } = resolveElentraCommand(args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: elentraDir, stdio: 'inherit', env: pythonEnv });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runElentra(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
