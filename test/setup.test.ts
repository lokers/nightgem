import { homedir, tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('test isolation (AD12)', () => {
  it('HOME is a temp directory, never the real one', () => {
    expect(process.env['HOME']).toBeDefined();
    expect(homedir()).toBe(process.env['HOME']);
    expect(homedir().startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(homedir()).toContain('ng-test-home-');
  });

  it('NIGHTGEM_* and OPENCODE_* are removed from the environment', () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('NIGHTGEM_') || k.startsWith('OPENCODE_'));
    expect(leaked).toEqual([]);
  });

  it('XDG_*_HOME variables are removed from the environment', () => {
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) expect(process.env[k]).toBeUndefined();
  });
});
