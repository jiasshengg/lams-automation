import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root } from './doctor.mjs';

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

  return { baseUrl, userDataDir: path.resolve(root, userDataDir), timeoutMs };
}

export async function openLamsSignIn() {
  const settings = await readLoginSettings();
  const context = await chromium.launchPersistentContext(settings.userDataDir, { headless: false });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(settings.baseUrl, { waitUntil: 'domcontentloaded' });
    console.log(`Opened LAMS in the automation browser: ${settings.baseUrl}`);
    console.log(`Sign in in the browser window. Setup will wait up to ${Math.round(settings.timeoutMs / 60_000)} minutes.`);

    const deadline = Date.now() + settings.timeoutMs;
    while (Date.now() < deadline) {
      for (const candidate of context.pages()) {
        if (await candidate.getByRole('button', { name: 'Toggle course menu', exact: true }).isVisible().catch(() => false)) {
          console.log('PASS LAMS sign-in verified. The authenticated automation profile has been saved locally.');
          return true;
        }
      }
      if (context.pages().length === 0) throw new Error('The LAMS browser window was closed before sign-in could be verified.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('LAMS sign-in was not verified before the setup timeout. Run npm run login:lams to try again.');
  } finally {
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  openLamsSignIn().catch((error) => {
    console.error(`Login setup stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
