import { spawnSync } from 'node:child_process';
import { copyFileSync, constants } from 'node:fs';
import path from 'node:path';
import { doctor, root } from './doctor.mjs';

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 24 LTS from https://nodejs.org/en/download and restart your terminal/agent app.');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Start setup with npm run setup from the project folder.');
  console.log('Installing fresh project dependencies for this computer. Existing node_modules will be replaced; local configuration and login profiles are preserved.');
  for (const args of [['ci', '--include=dev', '--include=optional'], ['run', 'install:browsers']]) {
    const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', timeout: 600_000 });
    if (result.error || result.status !== 0) throw new Error(`npm ${args.join(' ')} failed. Check the message above and your network/IT permissions, then retry. No runtime-ready status was issued.`);
  }
  try {
    copyFileSync(path.join(root, 'configs/example.json'), path.join(root, 'configs/local.json'), constants.COPYFILE_EXCL);
    console.log('Created configs/local.json from the example with the shared LAMS URL. Ask your agent to set your course; do not put passwords in this file.');
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!doctor()) {
    process.exitCode = 1;
    return;
  }
  // Load Playwright only after npm ci has installed it, so a clean computer can
  // still start this bootstrap with no node_modules directory.
  const { openLamsSignIn } = await import('./login.mjs');
  await openLamsSignIn();
}
try { await main(); } catch (error) { console.error(`Setup stopped: ${error.message}`); process.exitCode = 1; }
