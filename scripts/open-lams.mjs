import { readLoginSettings } from './setup/login.mjs';
import { launchLamsBrowser } from './setup/browser-profile.mjs';

const settings = await readLoginSettings();
const options = { headless: false, ...(settings.channel ? { channel: settings.channel } : {}) };
const context = await launchLamsBrowser(settings.userDataDir, options);
const page = context.pages()[0] ?? await context.newPage();
await page.goto(settings.baseUrl, { waitUntil: 'domcontentloaded' });
console.log(`Opened LAMS in the persistent automation browser: ${settings.baseUrl}`);
console.log('This window stays open for manual use. Close it whenever you are done.');
context.once('close', () => process.exit(0));
await new Promise(() => {});
