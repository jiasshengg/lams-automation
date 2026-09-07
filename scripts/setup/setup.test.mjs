import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runCheck, root } from './doctor.mjs';

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
