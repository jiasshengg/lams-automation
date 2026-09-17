import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchLamsBrowser, resolveBrowserProfile } from './browser-profile.mjs';
import { root } from './doctor.mjs';
import { readBrowserChannel } from './local-config.mjs';

export const DEFAULT_LAMS_BASE_URL = 'https://ilams.lamsinternational.com/lams/index.do';
const MINIMUM_SETUP_LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function readLoginSettings(configPath = path.join(root, 'configs/local.json')) {
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('configs/local.json must contain a JSON object.');
  }

  const baseUrl = typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() !== ''
    ? parsed.baseUrl
    : DEFAULT_LAMS_BASE_URL;
  const protocol = new URL(baseUrl).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('The configured LAMS baseUrl must use HTTP or HTTPS.');

  const configuredProfile = parsed.browser?.userDataDir;
  const userDataDir = typeof configuredProfile === 'string' && configuredProfile.trim() !== ''
    ? configuredProfile
    : '.playwright/lams-profile';
  const configuredTimeout = parsed.browser?.manualLoginTimeoutMs;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(configuredTimeout, MINIMUM_SETUP_LOGIN_TIMEOUT_MS)
    : MINIMUM_SETUP_LOGIN_TIMEOUT_MS;

  return { baseUrl, userDataDir: resolveBrowserProfile(userDataDir), timeoutMs, channel: readBrowserChannel(configPath) };
}

async function waitForCourseMenu(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (await page.getByRole('button', { name: 'Toggle course menu', exact: true }).isVisible().catch(() => false)) return true;
    }
    if (context.pages().length === 0) throw new Error('The LAMS browser window was closed before sign-in could be verified.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// NTU ADFS sends Windows browsers to its Windows Integrated Authentication endpoint
// (/adfs/ls/wia), where Microsoft never offers "Stay signed in?", so the login ends with the
// browser. Reporting macOS during the interactive sign-in gets the ADFS forms page and that
// prompt, as on a Mac. Password and MFA are unchanged, and only this phase is affected:
// the restart check and every automation command keep the browser's own identity.
const FORM_SIGN_IN_PLATFORM = '(Macintosh; Intel Mac OS X 10_15_7)';

async function reportFormSignInPlatform(page) {
  const session = await page.context().newCDPSession(page);
  const { userAgent, hints } = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    hints: await navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'uaFullVersion'])
  }));
  await session.send('Emulation.setUserAgentOverride', {
    userAgent: userAgent.replace(/\([^)]*\)/, FORM_SIGN_IN_PLATFORM),
    platform: 'MacIntel',
    userAgentMetadata: {
      brands: hints?.brands ?? [],
      fullVersionList: hints?.fullVersionList ?? [],
      fullVersion: hints?.uaFullVersion ?? '',
      platform: 'macOS',
      platformVersion: '15.0.0',
      architecture: 'arm',
      bitness: '64',
      model: '',
      mobile: false
    }
  });
}

export async function useFormSignIn(context) {
  if (context.pages().length === 0) await context.newPage();
  for (const page of context.pages()) await reportFormSignInPlatform(page);
  context.on('page', page => { void reportFormSignInPlatform(page).catch(error => console.error(`Sign-in form identity not applied to a new tab: ${error.message}`)); });
}

// Verification must not succeed because somebody completed another login during it.
export async function installNoInteractionGuard(context) {
  let interacted = false;
  await context.exposeBinding('__lamsVerificationInput', () => { interacted = true; });
  await context.addInitScript(() => {
    for (const event of ['pointerdown', 'keydown', 'submit']) {
      document.addEventListener(event, (e) => {
        if (!e.isTrusted) return;
        void window.__lamsVerificationInput();
        e.preventDefault();
        e.stopImmediatePropagation();
      }, true);
    }
  });
  return () => {
    if (interacted) throw new Error('Automatic login verification was interrupted by manual input. Rerun npm run login:check without interacting with the browser.');
  };
}

export async function openLamsSignIn({
  settings: suppliedSettings,
  checkOnly = false,
  guard = installNoInteractionGuard,
  launch = launchLamsBrowser,
  verify = waitForCourseMenu,
  platform = process.platform,
  formSignIn = useFormSignIn
} = {}) {
  const settings = suppliedSettings ?? await readLoginSettings();
  const options = { headless: false, ...(settings.channel ? { channel: settings.channel } : {}) };
  if (!checkOnly) {
    const context = await launch(settings.userDataDir, options);
    try {
      if (platform === 'win32') {
        await formSignIn(context);
        console.log('Windows: using the NTU sign-in form so Microsoft offers "Stay signed in?".');
      }
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(settings.baseUrl, { waitUntil: 'domcontentloaded' });
      console.log(`Opened LAMS in the automation browser: ${settings.baseUrl}`);
      console.log(`Sign in in the browser window. Setup will wait up to ${Math.round(settings.timeoutMs / 60_000)} minutes.`);
      console.log('If Microsoft asks "Stay signed in?", choose Yes if organisational policy permits.');
      if (!await verify(context, settings.timeoutMs)) {
        throw new Error('LAMS sign-in was not verified before the setup timeout. Run npm run login:lams to try again.');
      }
      console.log('PASS LAMS sign-in verified for the current session.');
    } finally {
      await context.close();
    }

  }
  console.log('Checking saved authentication without manual input. Please do not interact with this browser.');
  const restarted = await launch(settings.userDataDir, options);
  try {
    const assertNoInteraction = await guard(restarted);
    const page = restarted.pages()[0] ?? await restarted.newPage();
    await page.goto(settings.baseUrl, { waitUntil: 'domcontentloaded' });
    const authenticated = await verify(restarted, 60_000);
    assertNoInteraction();
    if (!authenticated) {
      const locations = restarted.pages().map(tab => { const url = new URL(tab.url()); return url.origin + url.pathname; });
      console.error(`Authentication check locations (query strings omitted): ${locations.join(', ')}`);
      throw new Error(`Authentication was not verified after browser restart. Profile: ${settings.userDataDir}. Run npm run login:lams with the same profile to retry. Microsoft or organisational session policy may require reauthentication.`);
    }
  } finally {
    await restarted.close();
  }
  console.log(checkOnly
    ? 'PASS Saved authentication verified without manual input. Future sign-in or MFA may still be required by organisational policy.'
    : 'PASS Authentication persisted across browser restart without manual input. Future sign-in or MFA may still be required by organisational policy.');
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  openLamsSignIn({ checkOnly: process.argv.includes('--check-only') }).catch((error) => {
    console.error(`Login setup stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
