import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runCheck, root } from './doctor.mjs';
import { DEFAULT_LAMS_BASE_URL, readLoginSettings } from './login.mjs';

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
