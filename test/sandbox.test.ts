import { describe, expect, it } from 'vitest';

import type { SafetyInputs } from '../src/contracts.ts';
import { renderSandboxProfile, sandboxWriteSubpaths } from '../src/sandbox.ts';

const HOME = '/Users/alice';
const WORKSPACE = `${HOME}/work`;
const safety: SafetyInputs = { workspaceRoot: WORKSPACE, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } };
const input = { home: HOME, workspaceRoot: WORKSPACE, tmpDir: '/private/var/folders/xx/T/nightgem-s', xdgDataHome: `${HOME}/Library/Application Support/nightgem/s/xdg-data`, port: 4242, safety };

/** The `(allow file-write* ...)` form, as lines. */
function writeAllow(profile: string): string[] {
  const start = profile.indexOf('(allow file-write*');
  return profile.slice(start, profile.indexOf(')\n', profile.indexOf('/dev/(tty', start)) + 1).split('\n');
}

describe('sandbox write allowance: no rule for temp files outside the run tmp dir (#7)', () => {
  const profile = renderSandboxProfile(input);

  it('is the subpaths, the /dev nodes and the tty regex, and nothing else (no /private/var/tmp, no per-user temp dir, no sh-thd rule)', () => {
    expect(writeAllow(profile)).toEqual([
      '(allow file-write*',
      ...sandboxWriteSubpaths(input).map((p) => `  (subpath "${p}")`),
      '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
      '  (regex #"^/dev/(tty|ttys[0-9]+|fd/[0-9]+)$"))',
    ]);
    expect(profile).not.toContain('/private/var/tmp');
    expect(profile).not.toContain('sh-thd');
    expect([...profile.matchAll(/\(regex /g)]).toHaveLength(1);
  });

  it('does not grant the shim dir (<controlDir>/bin): only xdg-data below the control dir is writable', () => {
    const control = `${HOME}/Library/Application Support/nightgem/s`;
    expect(sandboxWriteSubpaths(input)).not.toContain(`${control}/bin`);
    expect(sandboxWriteSubpaths(input)).not.toContain(control);
  });
});
