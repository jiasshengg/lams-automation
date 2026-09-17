// One-off login test. On Windows, NTU ADFS sends the browser to its Windows Integrated
// Authentication endpoint (/adfs/ls/wia), where Microsoft's "Stay signed in?" prompt never
// appears. This signs in once while the browser reports macOS, so ADFS serves its normal
// forms page as it does on a Mac. Password and MFA are still entered manually.
//
// Phase 1: sign in (macOS identity) and verify the restart check with the same identity.
// Phase 2: restart WITHOUT the override, exactly as normal automation commands launch.
import { launchLamsBrowser } from './setup/browser-profile.mjs';
import { openLamsSignIn, readLoginSettings } from './setup/login.mjs';

const MAC_PLATFORM = '(Macintosh; Intel Mac OS X 10_15_7)';

async function reportMacOs(page) {
  const session = await page.context().newCDPSession(page);
  const { userAgent, hints } = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    hints: await navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'uaFullVersion'])
  }));
  await session.send('Emulation.setUserAgentOverride', {
    userAgent: userAgent.replace(/\([^)]*\)/, MAC_PLATFORM),
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

async function launchAsMacOs(userDataDir, options) {
  const context = await launchLamsBrowser(userDataDir, options);
  for (const page of context.pages()) await reportMacOs(page);
  context.on('page', page => { void reportMacOs(page).catch(error => console.error(`macOS identity not applied to new tab: ${error.message}`)); });
  console.log('Browser identity: macOS (ADFS forms page expected)');
  return context;
}

const settings = await readLoginSettings();
try {
  console.log('Phase 1: sign in. After MFA, choose Yes at "Stay signed in?" if it appears.');
  await openLamsSignIn({ settings, launch: launchAsMacOs });
  console.log('\nPhase 2: restart with the normal browser identity, as automation commands do.');
  await openLamsSignIn({ settings, checkOnly: true });
  console.log('\nRESULT: login persists for normal automation runs.');
} catch (error) {
  console.error(`\nRESULT: ${error.message}`);
  process.exitCode = 1;
}
