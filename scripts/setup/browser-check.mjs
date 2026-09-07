import { chromium } from '@playwright/test';
// Fresh temporary context: no LAMS URL, saved profile, credentials, or lesson actions.
const browser = await chromium.launch({ headless: false, timeout: 30_000 });
try {
  const page = await browser.newPage();
  await page.setContent('<title>LAMS setup check</title><p>Local browser check. This window will close automatically.</p>');
  if (await page.title() !== 'LAMS setup check') throw new Error('Browser did not render the local check.');
} finally { await browser.close(); }
