import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readBrowserChannel } from './local-config.mjs';
import { elentraDir, ensurePrivatePython, ensureVenv, installPythonBrowser, installPythonPackages, venvPython } from './python-runtime.mjs';

export const pythonEnv = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };

// Installs everything the Elentra scripts need: the pinned Python, the .venv made from it,
// the Python packages, and (unless a system browser channel is recorded) Python Playwright's
// Chromium. Every later Elentra command runs the .venv interpreter directly, which is what
// activating the venv would do, so no shell activation step is needed.
export async function setupPythonRuntime() {
  const python = await ensurePrivatePython();
  const venv = ensureVenv(python);
  installPythonPackages(venv);
  installPythonBrowser(readBrowserChannel());
  console.log('PASS Elentra Python runtime installed.');
}

// The user signs in to Elentra themselves in the opened window; session.py saves the session
// under .playwright/ and then verifies it can open the admin events page without input.
export function openElentraSignIn() {
  console.log('Next: sign in to Elentra. This is a separate sign-in from LAMS.');
  const result = spawnSync(venvPython(), [path.join(elentraDir, 'session.py'), '--login'], { cwd: elentraDir, stdio: 'inherit', env: pythonEnv });
  if (result.error || result.status !== 0) {
    throw new Error('Elentra sign-in was not verified. Run npm run login:elentra to try again.');
  }
  return true;
}

async function main() {
  const { doctor } = await import('./doctor.mjs');
  await setupPythonRuntime();
  if (!doctor()) {
    process.exitCode = 1;
    return;
  }
  openElentraSignIn();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Elentra setup stopped: ${error.message}`); process.exitCode = 1; });
}
