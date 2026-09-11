import { spawnSync } from 'node:child_process';
import { copyFileSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { doctor, root, runCheck } from './doctor.mjs';
import { SYSTEM_BROWSER_CHANNELS, readBrowserChannel, writeBrowserChannel } from './local-config.mjs';

function runNpm(npmCli, args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', timeout: 600_000 });
  return !result.error && result.status === 0;
}

// Playwright drops its bundled Chromium for operating systems it no longer supports
// (for example macOS 13), so a fresh laptop can fail at "npm run install:browsers"
// even though every other step works. An already-installed Chrome or Edge driven
// through a Playwright channel is the supported substitute; the probe below reuses
// the doctor's headed launch check so only a browser that actually opens is recorded.
function findSystemBrowserChannel() {
  const browserCheck = fileURLToPath(new URL('./browser-check.mjs', import.meta.url));
  for (const channel of SYSTEM_BROWSER_CHANNELS) {
    if (runCheck(`Headed launch through installed ${channel}`, [browserCheck, channel], `Install Google Chrome or Microsoft Edge, then rerun npm run setup.`)) return channel;
  }
  return undefined;
}

function installBrowser(npmCli) {
  const configured = readBrowserChannel();
  if (configured) {
    console.log(`configs/local.json sets browser.channel="${configured}", so the bundled Chromium download is skipped and the installed ${configured} browser is used.`);
    return;
  }
  if (runNpm(npmCli, ['run', 'install:browsers'])) return;
  console.log('The bundled Chromium could not be installed. This usually means Playwright no longer supports this operating system version. Looking for an installed system browser instead...');
  const channel = findSystemBrowserChannel();
  if (!channel) {
    throw new Error('npm run install:browsers failed and no installed Chrome/Edge could be launched. Update the operating system or install Google Chrome, then rerun npm run setup. No runtime-ready status was issued.');
  }
  writeBrowserChannel(channel);
  console.log(`Recorded browser.channel="${channel}" in configs/local.json. Automation on this computer will drive the installed ${channel} browser; delete that setting to return to the bundled Chromium.`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 24 LTS from https://nodejs.org/en/download and restart your terminal/agent app.');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Start setup with npm run setup from the project folder.');
  console.log('Installing fresh project dependencies for this computer. Existing node_modules will be replaced; local configuration and login profiles are preserved.');
  if (!runNpm(npmCli, ['ci', '--include=dev', '--include=optional'])) throw new Error('npm ci failed. Check the message above and your network/IT permissions, then retry. No runtime-ready status was issued.');
  try {
    copyFileSync(path.join(root, 'configs/example.json'), path.join(root, 'configs/local.json'), constants.COPYFILE_EXCL);
    console.log('Created configs/local.json from the example with the shared LAMS URL. Supply workspaceCourse with each job when it differs from the fallback; do not put passwords in this file.');
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  installBrowser(npmCli);
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
