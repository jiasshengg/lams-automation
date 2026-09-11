import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));

export function runCheck(label, args, hint, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  const passed = !result.error && result.status === 0;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`);
  if (!passed) {
    console.error((result.stderr || result.error?.message || `Process exited ${result.status}, signal ${result.signal}`).trim());
    console.error(`Next step: ${hint}`);
  }
  return passed;
}

export function doctor() {
  console.log(`Checking local tools: Node ${process.version}, ${process.platform}/${process.arch}`);
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Install Node.js 24 LTS from https://nodejs.org/en/download, then restart the terminal/agent app.');
    return false;
  }
  const checks = [
    ['esbuild native executable', () => ['--input-type=module', '-e', "import { transformSync } from 'esbuild'; const result = transformSync('const n: number = 1', { loader: 'ts' }); if (!result.code) process.exit(1);"], 'Run npm run setup to reinstall local dependencies. If macOS still blocks a fresh download, ask IT to inspect it; do not disable Gatekeeper or remove quarantine automatically.'],
    ['TypeScript runtime (tsx)', () => [require.resolve('tsx/cli'), '--no-cache', '-e', 'const value: number = 7; if (value !== 7) process.exit(1);'], 'Run npm run setup. A build-only check cannot prove tsx works.'],
    ['TypeScript build', () => [require.resolve('typescript/bin/tsc'), '--noEmit'], 'Check the error above. Reinstall missing dependencies with npm run setup; report source errors to the maintainer.'],
    ['Headed Chromium launch', () => [fileURLToPath(new URL('./browser-check.mjs', import.meta.url))], 'Run npm run install:browsers and retry from a local desktop session. Ask IT about blocked downloads or executables.']
  ];
  let passed = true;
  for (const [label, args, hint] of checks) {
    try { if (!runCheck(label, args(), hint)) passed = false; }
    catch (error) { console.error(`FAIL ${label}: ${error.message}\nNext step: ${hint}`); passed = false; }
  }
  console.log(passed
    ? 'Local runtime checks passed. LAMS login is verified separately by the setup login step.'
    : 'Setup is incomplete. Resolve the failed checks above before running lesson automation.');
  return passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = doctor() ? 0 : 1;
