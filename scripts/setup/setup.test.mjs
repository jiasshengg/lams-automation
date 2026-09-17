import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runCheck, root } from './doctor.mjs';
import { DEFAULT_LAMS_BASE_URL, readLoginSettings } from './login.mjs';
import { SYSTEM_BROWSER_CHANNELS, readBrowserChannel, writeBrowserChannel } from './local-config.mjs';

test('runtime probes fail on nonzero exit and killed processes', () => {
  assert.equal(runCheck('failure fixture', ['-e', 'process.exit(3)'], 'fixture'), false);
  assert.equal(runCheck('killed fixture', ['-e', "process.kill(process.pid, 'SIGKILL')"], 'fixture'), false);
});

test('doctor runs without installed dependencies and never claims readiness', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'lams-doctor-missing-'));
  try {
    mkdirSync(path.join(temporary, 'scripts'));
    cpSync(path.join(root, 'scripts/setup'), path.join(temporary, 'scripts/setup'), { recursive: true });
    writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, ['scripts/setup/doctor.mjs'], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Setup is incomplete/);
    assert.doesNotMatch(result.stdout, /Local runtime checks passed/);
    assert.match(result.stdout + result.stderr, /FAIL TypeScript runtime/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('beginner launchers bootstrap the same pinned, checksummed local Node runtime', () => {
  const macLauncher = readFileSync(path.join(root, 'Setup Mac.command'), 'utf8');
  const windowsLauncher = readFileSync(path.join(root, 'Setup Windows.cmd'), 'utf8');
  const windowsBootstrap = readFileSync(path.join(root, 'scripts/setup/bootstrap-windows.ps1'), 'utf8');
  const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');

  assert.equal(spawnSync('bash', ['-n', path.join(root, 'Setup Mac.command')]).status, 0);
  assert.match(macLauncher, /node_version='24\.20\.0'/);
  assert.match(windowsBootstrap, /\$nodeVersion = '24\.20\.0'/);
  assert.equal((macLauncher.match(/[a-f0-9]{64}/g) ?? []).length, 2);
  assert.equal((windowsBootstrap.match(/[a-f0-9]{64}/g) ?? []).length, 2);
  assert.match(macLauncher, /https:\/\/nodejs\.org\/dist\/v/);
  assert.match(windowsBootstrap, /https:\/\/nodejs\.org\/dist\/v/);
  assert.match(macLauncher, /\.tools/);
  assert.match(windowsBootstrap, /\.tools/);
  assert.match(gitignore, /^\.tools\/$/m);
  assert.match(windowsLauncher, /bootstrap-windows\.ps1/);
  assert.doesNotMatch(windowsLauncher, /where node/i);
});

test('login setup uses the shared URL and persistent local profile defaults', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'lams-login-config-'));
  try {
    const configPath = path.join(temporary, 'local.json');
    writeFileSync(configPath, '{}');
    const settings = await readLoginSettings(configPath);

    assert.equal(settings.baseUrl, DEFAULT_LAMS_BASE_URL);
    assert.equal(settings.userDataDir, path.join(root, '.playwright/lams-profile'));
    assert.equal(settings.timeoutMs, 5 * 60_000);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('clean setup defers loading Playwright until after dependencies are installed', () => {
  const setup = readFileSync(path.join(root, 'scripts/setup/setup.mjs'), 'utf8');
  assert.match(setup, /await import\('\.\/login\.mjs'\)/);
  assert.doesNotMatch(setup, /^import .*login\.mjs/m);
});

test('system browser channel is read from and written to local config without disturbing other settings', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'lams-channel-config-'));
  try {
    const configPath = path.join(temporary, 'local.json');
    assert.equal(readBrowserChannel(configPath), undefined, 'missing config means bundled Chromium');
    writeFileSync(configPath, '{"baseUrl":"https://example.test/lams","browser":{"headless":false,"channel":""}}');
    assert.equal(readBrowserChannel(configPath), undefined, 'blank channel means bundled Chromium');
    writeBrowserChannel('chrome', configPath);
    assert.equal(readBrowserChannel(configPath), 'chrome');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.baseUrl, 'https://example.test/lams');
    assert.equal(saved.browser.headless, false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('login setup passes the configured system browser channel through', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'lams-login-channel-'));
  try {
    const configPath = path.join(temporary, 'local.json');
    writeFileSync(configPath, '{"browser":{"channel":"msedge"}}');
    assert.equal((await readLoginSettings(configPath)).channel, 'msedge');
    writeFileSync(configPath, '{}');
    assert.equal((await readLoginSettings(configPath)).channel, undefined);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('setup falls back to an installed system browser when the bundled Chromium is unsupported', () => {
  const setup = readFileSync(path.join(root, 'scripts/setup/setup.mjs'), 'utf8');
  assert.match(setup, /SYSTEM_BROWSER_CHANNELS/);
  assert.match(setup, /writeBrowserChannel/);
  assert.doesNotMatch(setup, /^import .*login\.mjs/m);
  assert.deepEqual(SYSTEM_BROWSER_CHANNELS, ['chrome', 'msedge']);
});

test('Windows launcher runs the bootstrap with a process-scoped execution policy', () => {
  const windowsLauncher = readFileSync(path.join(root, 'Setup Windows.cmd'), 'utf8');
  assert.match(windowsLauncher, /-ExecutionPolicy Bypass/);
});

test('profile resolution is independent of working directory and preserves absolute paths', async () => {
  const { resolveBrowserProfile } = await import('./browser-profile.mjs');
  const moduleUrl = new URL('./browser-profile.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { resolveBrowserProfile } from ${JSON.stringify(moduleUrl)}; console.log(resolveBrowserProfile());`
  ], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(root, '.playwright/lams-profile'));
  const absolute = path.join(os.tmpdir(), 'custom-lams-profile');
  assert.equal(resolveBrowserProfile(absolute), absolute);
  assert.throws(() => resolveBrowserProfile(' '), /non-empty path/);
});

function loginFixture(results, closeFails = false) {
  const events = [];
  const settings = { baseUrl: 'https://example.test/lams', userDataDir: path.join(root, '.playwright/lams-profile'), timeoutMs: 300_000, channel: 'chrome' };
  let launches = 0;
  return {
    events,
    options: {
      settings,
      guard: async () => () => {},
      launch: async (profile, options) => {
        const id = ++launches;
        assert.equal(profile, settings.userDataDir);
        assert.deepEqual(options, { headless: false, channel: 'chrome' });
        events.push(`launch ${id}`);
        return {
          id,
          pages: () => [{ url: () => settings.baseUrl, goto: async (url) => { assert.equal(url, settings.baseUrl); events.push(`navigate ${id}`); } }],
          close: async () => { events.push(`close ${id}`); if (closeFails) throw new Error('close failed'); }
        };
      },
      verify: async (context) => { events.push(`verify ${context.id}`); return results[context.id - 1]; }
    }
  };
}

test('login closes before restarting the same profile and verifies both sessions', async () => {
  const { openLamsSignIn } = await import('./login.mjs');
  const fixture = loginFixture([true, true]);
  assert.equal(await openLamsSignIn(fixture.options), true);
  assert.deepEqual(fixture.events, ['launch 1', 'navigate 1', 'verify 1', 'close 1', 'launch 2', 'navigate 2', 'verify 2', 'close 2']);
});

test('failed persistence check closes browser and reports retry without claiming a cookie cause', async () => {
  const { openLamsSignIn } = await import('./login.mjs');
  const fixture = loginFixture([true, false]);
  await assert.rejects(openLamsSignIn(fixture.options), /Authentication was not verified after browser restart.*login:lams/);
  assert.equal(fixture.events.at(-1), 'close 2');
});

test('failed initial login or profile flush never starts the restart check', async () => {
  const { openLamsSignIn } = await import('./login.mjs');
  for (const fixture of [loginFixture([false]), loginFixture([true], true)]) {
    await assert.rejects(openLamsSignIn(fixture.options));
    assert.deepEqual(fixture.events, ['launch 1', 'navigate 1', 'verify 1', 'close 1']);
  }
});

test('profile lock refuses concurrent ownership and can be reacquired after awaited release', async () => {
  const { acquireProfileLock } = await import('./profile-lock.mjs');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'lams-profile-lock-'));
  try {
    const release = await acquireProfileLock(profile);
    await assert.rejects(acquireProfileLock(profile), /already reserved/);
    await Promise.all([release(), release()]);
    await (await acquireProfileLock(profile))();
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('unattended login check never enters the interactive initial login phase', async () => {
  const { openLamsSignIn } = await import('./login.mjs');
  const fixture = loginFixture([true]);
  assert.equal(await openLamsSignIn({ ...fixture.options, checkOnly: true }), true);
  assert.deepEqual(fixture.events, ['launch 1', 'navigate 1', 'verify 1', 'close 1']);
});

test('manual input cannot produce a successful unattended verification', async () => {
  const { openLamsSignIn } = await import('./login.mjs');
  const fixture = loginFixture([true]);
  await assert.rejects(openLamsSignIn({ ...fixture.options, checkOnly: true, guard: async () => () => { throw new Error('manual input'); } }), /manual input/);
  assert.equal(fixture.events.at(-1), 'close 1');
});

test('direct runner preserves arguments with spaces and rejects stripped flags', async () => {
  const { resolveCommand } = await import('../run.mjs');
  const command = resolveCommand(['run:tbl', '--request-json', 'requests/my lesson.json', '--repair-json', 'repair.json', '--log-file', 'run.log']);
  assert.deepEqual(command.args.slice(-4), ['--request-json', 'requests/my lesson.json', '--repair-json', 'repair.json']);
  assert.equal(command.logFile, 'run.log');
  assert.throws(() => resolveCommand(['run:tbl', 'configs/local.json']), /lost a flag/);
  assert.throws(() => resolveCommand(['run:tbl', '--config']), /requires a value/);
});

test('direct runner propagates failed operation status while saving output', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'lams-runner-'));
  try {
    const log = path.join(temporary, 'run.log');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/run.mjs'), 'repair:ae-placeholder', '--log-file', log], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(readFileSync(log, 'utf8'), /Supply --repair-json/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
