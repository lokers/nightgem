import * as realFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORE_REQUIRED_SKILLS,
  DEFAULT_DISABLE_PATTERNS,
  detectSkills,
  disabledSkillNames,
  parseSkillName,
  readConfiguredSkillRoots,
  renderSkillsList,
} from '../src/skills.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills', 'opencode.jsonc');
const SECRETS = ['sk-FAKE-SECRET-DO-NOT-SHOW', 'FAKE-TOKEN-DO-NOT-LEAK', 'apiKey', 'Authorization'];

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ng-skills-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function skill(root: string, dirName: string, name?: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const fm = name === undefined ? '' : `---\nname: ${name}\ndescription: test\n---\n`;
  writeFileSync(join(dir, 'SKILL.md'), `${fm}# body\n`);
  return dir;
}

const names = (d: { available: { name: string }[] }): string[] => d.available.map((s) => s.name).sort();
const run = (extra: Partial<Parameters<typeof detectSkills>[0]> = {}) => detectSkills({ home, fs: realFs, ...extra });

describe('parseSkillName', () => {
  it('reads name from frontmatter, with quotes, CRLF and a BOM', () => {
    expect(parseSkillName('---\nname: foo\n---\nbody')).toBe('foo');
    expect(parseSkillName('---\nname: "foo-bar"\ndescription: x\n---\n')).toBe('foo-bar');
    expect(parseSkillName("---\r\nname: 'x'\r\n---\r\n")).toBe('x');
    expect(parseSkillName('\uFEFF---\nname: b\n---\n')).toBe('b');
  });
  it('returns undefined without usable frontmatter', () => {
    expect(parseSkillName('# no frontmatter\nname: foo')).toBeUndefined();
    expect(parseSkillName('---\ndescription: x\n---\n')).toBeUndefined();
    expect(parseSkillName('---\nname:\n---\n')).toBeUndefined();
  });
});

describe('detectSkills: roots and discovery', () => {
  it('scans the three default roots in order and reports realpath roots', () => {
    skill(join(home, '.config/opencode/skills'), 'a', 'alpha');
    skill(join(home, '.agents/skills'), 'b', 'beta');
    skill(join(home, '.claude/skills'), 'c', 'gamma');
    const det = run();
    expect(det.available.map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(det.roots).toEqual([
      join(home, '.config/opencode/skills'),
      join(home, '.agents/skills'),
      join(home, '.claude/skills'),
    ]);
    expect(det.available[0]).toEqual({ name: 'alpha', root: det.roots[0], path: join(home, '.config/opencode/skills/a') });
  });

  it('drops roots that do not exist silently', () => {
    skill(join(home, '.agents/skills'), 'b', 'beta');
    const det = run({ extraRoots: [join(home, 'nope')] });
    expect(det.roots).toEqual([join(home, '.agents/skills')]);
    expect(det.rootRejected).toEqual([]);
  });

  it('falls back to the directory name and ignores dirs without SKILL.md and dot dirs', () => {
    skill(join(home, '.agents/skills'), 'dirname-only');
    mkdirSync(join(home, '.agents/skills/empty'), { recursive: true });
    skill(join(home, '.agents/skills'), '.hidden', 'hidden');
    expect(names(run())).toEqual(['dirname-only']);
  });

  it('supports one level of nesting for plugin folders, not two', () => {
    const root = join(home, '.claude/skills');
    skill(join(root, 'plugin-x'), 'one', 'one');
    skill(join(root, 'plugin-x'), 'two');
    skill(join(root, 'plugin-x/deep'), 'three', 'too-deep');
    expect(names(run())).toEqual(['one', 'two']);
  });

  it('rejects an unsafe root with a reason and does not scan it', () => {
    const lib = join(home, 'Library/skills');
    skill(lib, 'x', 'x');
    const det = run({ extraRoots: [lib, '~/.ssh'] });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const again = run({ extraRoots: [lib, '~/.ssh'] });
    expect(det.available).toEqual([]);
    expect(det.rootRejected.map((r) => r.root)).toContain(lib);
    expect(again.rootRejected.map((r) => r.root).sort()).toEqual([lib, join(home, '.ssh')].sort());
    expect(again.rootRejected.every((r) => r.reasons.length > 0)).toBe(true);
    expect(again.roots).toEqual([]);
  });

  it('rejects a relative extra root', () => {
    expect(run({ extraRoots: ['relative/dir'] }).rootRejected[0]?.root).toBe('relative/dir');
  });

  it('expands ~ in extraRoots', () => {
    skill(join(home, 'extra'), 'e', 'extra-skill');
    const det = run({ extraRoots: ['~/extra'] });
    expect(names(det)).toEqual(['extra-skill']);
    expect(det.roots).toEqual([join(home, 'extra')]);
  });

  it('allows ~/.config/opencode/skills even though ~/.config is denied', () => {
    skill(join(home, '.config/opencode/skills'), 'a', 'a');
    expect(run().rootRejected).toEqual([]);
  });
});

describe('detectSkills: de-duplication and collisions', () => {
  it('collapses symlinks across roots to one entry; the first root wins', () => {
    const real = skill(join(home, '.agents/skills'), 'x', 'x');
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(real, join(home, '.claude/skills/x'));
    const det = run();
    expect(det.available).toHaveLength(1);
    expect(det.available[0]?.root).toBe(join(home, '.agents/skills'));
    expect(det.collisions).toEqual([]);
  });

  it('collapses a symlinked root onto its target', () => {
    skill(join(home, 'store'), 'x', 'x');
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(join(home, 'store'), join(home, '.claude/skills'));
    const det = run({ extraRoots: ['~/store'] });
    expect(det.roots).toEqual([join(home, 'store')]);
    expect(det.available).toHaveLength(1);
  });

  it('reports a real name collision and keeps the first', () => {
    const a = skill(join(home, '.agents/skills'), 'dup', 'same');
    const b = skill(join(home, '.claude/skills'), 'dup', 'same');
    const c = skill(join(home, '.claude/skills'), 'dup2', 'same');
    const det = run();
    expect(det.available).toHaveLength(1);
    expect(det.available[0]?.path).toBe(a);
    expect(det.collisions).toEqual([{ name: 'same', paths: [a, b, c] }]);
  });

  it('flags a skill whose realpath lies outside every scanned root', () => {
    const outside = skill(join(home, 'elsewhere'), 'o', 'outside-skill');
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    symlinkSync(outside, join(home, '.agents/skills/o'));
    const det = run();
    expect(names(det)).toEqual(['outside-skill']);
    expect(det.outsideRoots).toEqual([outside]);
  });

  it('refuses a skill symlinked into a denied location', () => {
    const ssh = skill(join(home, '.ssh'), 'k', 'ssh-skill');
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    symlinkSync(ssh, join(home, '.agents/skills/k'));
    const det = run();
    expect(det.available).toEqual([]);
    expect(det.rootRejected.map((r) => r.root)).toEqual([ssh]);
  });
});

describe('detectSkills: exclusion', () => {
  it('excludes by name glob', () => {
    skill(join(home, '.agents/skills'), 'a', 'acme-private-private');
    skill(join(home, '.agents/skills'), 'b', 'public');
    const det = run({ exclude: ['acme-private-*'] });
    expect(names(det)).toEqual(['public']);
    expect(det.excluded).toEqual([{ name: 'acme-private-private', path: join(home, '.agents/skills/a'), reason: 'pattern:acme-private-*' }]);
  });

  it('excludes by realpath glob, including with ~', () => {
    skill(join(home, 'private-root'), 'a', 'secret-a');
    skill(join(home, '.agents/skills'), 'b', 'public');
    const det = run({ extraRoots: ['~/private-root'], exclude: ['~/private-root/**'] });
    expect(names(det)).toEqual(['public']);
    expect(det.excluded.map((e) => e.name)).toEqual(['secret-a']);
    expect(det.excluded[0]?.reason).toBe(`pattern:${join(home, 'private-root/**')}`);
  });

  it('matches the realpath, so a symlink cannot launder an excluded skill', () => {
    const real = skill(join(home, 'private-root'), 'a', 'secret-a');
    mkdirSync(join(home, '.agents/skills'), { recursive: true });
    symlinkSync(real, join(home, '.agents/skills/innocent'));
    const det = run({ exclude: [`${home}/private-root/**`] });
    expect(det.available).toEqual([]);
    expect(det.excluded).toHaveLength(1);
  });
});

describe('detectSkills: required', () => {
  const installCore = (): void => {
    for (const n of CORE_REQUIRED_SKILLS) skill(join(home, '.agents/skills'), n, n);
  };

  it('has the D12 core set', () => {
    expect([...CORE_REQUIRED_SKILLS]).toEqual([
      'spec-driven-development',
      'planning-and-task-breakdown',
      'test-driven-development',
      'incremental-implementation',
      'code-review-and-quality',
    ]);
  });

  it('lists all core skills as missing on an empty machine', () => {
    const det = run();
    expect(det.missingRequired).toEqual([...CORE_REQUIRED_SKILLS]);
    expect(det.excludedRequired).toEqual([]);
  });

  it('reports nothing missing when all are present, and honours profile required', () => {
    installCore();
    expect(run().missingRequired).toEqual([]);
    expect(run({ required: ['extra-req'] }).missingRequired).toEqual(['extra-req']);
    expect(run({ required: ['test-driven-development'] }).missingRequired).toEqual([]);
  });

  it('treats an excluded required skill as missing and flags excludedRequired', () => {
    installCore();
    const det = run({ exclude: ['test-driven-*'] });
    expect(det.missingRequired).toEqual(['test-driven-development']);
    expect(det.excludedRequired).toEqual(['test-driven-development']);
    expect(det.excluded.map((e) => e.name)).toEqual(['test-driven-development']);
  });

  it('does not flag excludedRequired for a plain missing skill', () => {
    const det = run({ exclude: ['unrelated'] });
    expect(det.excludedRequired).toEqual([]);
  });
});

describe('opencode.json skills key', () => {
  const write = (text: string): string => {
    const p = join(home, '.config/opencode/opencode.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };

  it('reads roots from the fixture (JSONC, ~ expansion, URL dropped, relative to the config dir) without leaking secrets', () => {
    const cfg = write(realFs.readFileSync(FIXTURE, 'utf8'));
    skill(join(home, 'plugins-a/skills'), 'a', 'from-a');
    skill(join(home, 'plugins-b/skills'), 'b', 'from-b');
    skill(join(home, '.config/opencode/relative/skills'), 'r', 'from-rel');

    expect(readConfiguredSkillRoots(cfg, home, realFs)).toEqual([
      join(home, 'plugins-a/skills'),
      join(home, 'plugins-b/skills'),
      join(home, '.config/opencode/relative/skills'),
    ]);

    const det = run({ opencodeConfigPath: cfg });
    expect(names(det)).toEqual(['from-a', 'from-b']);
    // Relative to ~/.config/opencode, which is denied outside its skills/ carve-out.
    expect(det.rootRejected.map((r) => r.root)).toEqual([join(home, '.config/opencode/relative/skills')]);
    const dump = JSON.stringify(det) + renderSkillsList(det) + JSON.stringify(disabledSkillNames(det));
    for (const s of SECRETS) expect(dump).not.toContain(s);
  });

  it('accepts a string, an array and { paths }', () => {
    expect(readConfiguredSkillRoots(write('{"skills":"~/one"}'), home, realFs)).toEqual([join(home, 'one')]);
    expect(readConfiguredSkillRoots(write('{"skills":["~/one","/abs/two"]}'), home, realFs)).toEqual([join(home, 'one'), '/abs/two']);
    expect(readConfiguredSkillRoots(write('{"skills":{"paths":["~/p"],"urls":["https://x"]}}'), home, realFs)).toEqual([join(home, 'p')]);
    expect(readConfiguredSkillRoots(write('{"skills":{"paths":"~/p"}}'), home, realFs)).toEqual([join(home, 'p')]);
  });

  it('tolerates a missing file, a missing key, garbage and wrong types', () => {
    expect(readConfiguredSkillRoots(join(home, 'missing.json'), home, realFs)).toEqual([]);
    expect(readConfiguredSkillRoots(write('{"other":1}'), home, realFs)).toEqual([]);
    expect(readConfiguredSkillRoots(write('not json {{{'), home, realFs)).toEqual([]);
    expect(readConfiguredSkillRoots(write('{"skills":42}'), home, realFs)).toEqual([]);
    expect(readConfiguredSkillRoots(write('{"skills":[1,null,{"x":1}]}'), home, realFs)).toEqual([]);
  });

  it('only ever reads the skills key: a config whose other keys would break a full parse still works', () => {
    const cfg = write('{"skills":["~/s"],"apiKey":"sk-FAKE-SECRET-DO-NOT-SHOW"');
    expect(readConfiguredSkillRoots(cfg, home, realFs)).toEqual([join(home, 's')]);
  });

  it('never exposes the config text in what the injected fs is asked to read beyond the config path', () => {
    const reads: string[] = [];
    const cfg = write(realFs.readFileSync(FIXTURE, 'utf8'));
    const fs = { ...realFs, readFileSync: ((p: string, e: 'utf8') => (reads.push(p), realFs.readFileSync(p, e))) as typeof realFs.readFileSync };
    detectSkills({ home, fs, opencodeConfigPath: cfg });
    expect(reads.filter((p) => p.endsWith('opencode.json'))).toEqual([cfg]);
  });
});

describe('helpers', () => {
  it('renderSkillsList: sorted names only, one per line', () => {
    skill(join(home, '.agents/skills'), 'z', 'zeta');
    skill(join(home, '.agents/skills'), 'a', 'alpha');
    const det = run();
    expect(renderSkillsList(det)).toBe('- alpha\n- zeta');
    expect(renderSkillsList({ available: [] })).toBe('');
  });

  it('disabledSkillNames: excluded plus generic and profile patterns, sorted and unique', () => {
    const r = join(home, '.agents/skills');
    for (const n of ['acme-jira', 'release-notes', 'ship-it', 'Changelog-writer', 'publish-pkg', 'keep-me', 'acme-private-x', 'custom-drop']) skill(r, n, n);
    const det = run({ exclude: ['acme-private-*'] });
    expect(DEFAULT_DISABLE_PATTERNS).toEqual(['*jira*', '*release*', '*ship*', '*changelog*', '*publish*']);
    expect(disabledSkillNames(det)).toEqual(['Changelog-writer', 'acme-jira', 'acme-private-x', 'publish-pkg', 'release-notes', 'ship-it']);
    expect(disabledSkillNames(det, ['custom-*'])).toContain('custom-drop');
    expect(disabledSkillNames(det, ['custom-*'])).not.toContain('keep-me');
    const all = disabledSkillNames(det, ['custom-*']);
    expect(all).toEqual([...new Set(all)].sort());
  });

  it('never disables an exclusion-free empty detection', () => {
    expect(disabledSkillNames({ available: [], excluded: [] })).toEqual([]);
  });
});
