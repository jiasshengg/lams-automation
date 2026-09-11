import { chromium } from '@playwright/test';
import { readBrowserChannel } from './local-config.mjs';
// Fresh temporary context: no LAMS URL, saved profile, credentials, or lesson actions.
// An explicit channel argument lets setup probe an installed browser before recording it.
const channel = process.argv[2] ?? readBrowserChannel();
const browser = await chromium.launch({ headless: false, timeout: 30_000, ...(channel ? { channel } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent('<title>LAMS setup check</title><p>Local browser check. This window will close automatically.</p>');
  if (await page.title() !== 'LAMS setup check') throw new Error('Browser did not render the local check.');
} finally { await browser.close(); }
