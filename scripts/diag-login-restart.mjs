// Read-only diagnostic: reopen the saved profile and record how Microsoft treats the stored
// session. Prints cookie names/expiry and SAML/login-page flags only - never cookie values,
// tokens, or usernames. Do not interact with the browser while it runs.
import zlib from 'node:zlib';
import { launchLamsBrowser } from './setup/browser-profile.mjs';
import { readLoginSettings } from './setup/login.mjs';

const MS = 'login.microsoftonline.com';
const settings = await readLoginSettings();
const profile = process.argv[2] ?? settings.userDataDir;
const context = await launchLamsBrowser(profile, { headless: false, ...(settings.channel ? { channel: settings.channel } : {}) });

const expiry = (c) => (c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session');
const cookieNames = (header = '') => header.split(';').map(p => p.trim().split('=')[0]).filter(Boolean);

function decodeSaml(encoded) {
  const raw = Buffer.from(decodeURIComponent(encoded), 'base64');
  try { return zlib.inflateRawSync(raw).toString('utf8'); } catch { return raw.toString('utf8'); }
}

try {
  console.log(`Platform: ${process.platform}`);
  const stored = await context.cookies([`https://${MS}`]);
  console.log('\n[1] Microsoft cookies loaded from profile before navigation:');
  for (const c of stored) console.log(`  ${c.name.padEnd(22)} ${expiry(c)}`);

  const page = context.pages()[0] ?? await context.newPage();
  context.on('request', async (request) => {
    const url = new URL(request.url());
    if (url.hostname !== MS) return;
    const headers = await request.allHeaders().catch(() => ({}));
    const sent = cookieNames(headers.cookie).filter(n => /^(ESTSAUTH|ESTSAUTHPERSISTENT|ESTSAUTHLIGHT|SignInStateCookie|buid|fpc|CCState)$/.test(n));
    console.log(`\n[2] ${request.method()} ${url.pathname}  auth cookies sent: ${sent.join(', ') || 'NONE'}`);
    const saml = url.searchParams.get('SAMLRequest')
      ?? new URLSearchParams(request.postData() ?? '').get('SAMLRequest');
    if (saml) {
      const xml = decodeSaml(saml);
      for (const attr of ['ForceAuthn', 'IsPassive']) console.log(`    SAML ${attr}: ${xml.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? '(absent)'}`);
      console.log(`    SAML RequestedAuthnContext: ${xml.match(/AuthnContextClassRef>([^<]*)</)?.[1] ?? '(absent)'}`);
    }
  });
  context.on('response', async (response) => {
    if (new URL(response.url()).hostname !== MS) return;
    const setCookies = (await response.headersArray().catch(() => [])).filter(h => h.name.toLowerCase() === 'set-cookie');
    const auth = setCookies.map(h => h.value).filter(v => /^(ESTSAUTH|ESTSAUTHPERSISTENT|SignInStateCookie)=/.test(v));
    for (const v of auth) {
      const name = v.split('=')[0];
      const expires = v.match(/expires=([^;]+)/i)?.[1] ?? v.match(/max-age=([^;]+)/i)?.[1] ?? 'session';
      const cleared = /=;|max-age=0|1970/i.test(v);
      console.log(`    <- ${response.status()} set-cookie ${name} expires=${expires}${cleared ? '  ** CLEARED BY SERVER **' : ''}`);
    }
  });

  await page.goto(settings.baseUrl, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 20_000;
  let authenticated = false;
  while (Date.now() < deadline && !authenticated) {
    authenticated = await page.getByRole('button', { name: 'Toggle course menu', exact: true }).isVisible().catch(() => false);
    if (!authenticated) await page.waitForTimeout(500);
  }

  const final = new URL(page.url());
  console.log(`\n[3] Result: ${authenticated ? 'AUTHENTICATED (course menu visible)' : 'NOT authenticated'} at ${final.origin}${final.pathname}`);
  if (final.hostname === MS) {
    const flags = await page.evaluate(() => {
      const c = window.$Config ?? {};
      return {
        errorCode: c.iErrorCode ?? c.sErrorCode ?? null,
        serviceException: c.strServiceExceptionMessage ?? null,
        loginMode: c.iLoginMode ?? null,
        knownSessions: Array.isArray(c.arrSessions) ? c.arrSessions.length : null,
        prefilledUsername: Boolean(c.sPOST_Username || c.sUsername),
        persistentCookiesWarning: c.fShowPersistentCookiesWarning ?? null,
        kmsiDisabled: c.fKMSIEnabled === false ? true : null,
        configKeys: Object.keys(c).length
      };
    }).catch(error => ({ evaluateError: error.message }));
    console.log('    Microsoft login page flags:', JSON.stringify(flags));
  }
} finally {
  await context.close();
}
