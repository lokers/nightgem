/**
 * Vitest setup (AD12): tests never touch the real HOME and never see the caller's NIGHTGEM_* / OPENCODE_* env.
 * Runs once per test file (each file has its own worker context), before the file's imports are evaluated.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
const testHome = realpathSync(mkdtempSync(join(tmpdir(), 'ng-test-home-')));
process.env['HOME'] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('NIGHTGEM_') || key.startsWith('OPENCODE_') || XDG_VARS.includes(key)) delete process.env[key];
}
