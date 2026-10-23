import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProfileError,
  UserProfile,
  controlRootFor,
  expandHome,
  loadProfile,
  profileHash,
  resolveProfilePath,
  splitModelSpec,
  validateSkillRoot,
  validateWorkspaceRoot,
} from '../src/userprofile.ts';

let home: string;
let ws: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ng-profile-')));
  ws = join(home, 'work');
  mkdirSync(ws);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const write = (path: string, text: string): string => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const load = (path: string) => loadProfile({ path, home, env: {}, fs: nodeFs });
const profileJson = (extra: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, workspaceRoot: ws, ...extra });

describe('UserProfile schema', () => {
  it('needs only version and workspaceRoot; every other block resolves to empty values', () => {
    const p = UserProfile.parse({ version: 1, workspaceRoot: '/w' });
    expect(p).toEqual({
      version: 1,
      workspaceRoot: '/w',
      repos: {},
      tracker: { autoClaim: { enabled: false, when: { unassigned: false } } },
      skills: { required: [], exclude: [], extraRoots: [] },
      deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] },
      models: {},
      audit: { bannedTerms: [] },
    });
  });

  it('parses a full profile', () => {
    const p = UserProfile.parse({
      version: 1,
      workspaceRoot: '~/work',
      instructionsFile: '~/i.md',
      repos: { api: { tools: ['go', 'buf'] }, web: {} },
      tracker: {
        keyPattern: '[A-Z][A-Z0-9]+-\\d+',
        fetchCommand: 'tracker show {KEY}',
        linkedFetchCommand: 'tracker list {KEYS}',
        autoClaim: { enabled: true, when: { status: 'Backlog', unassigned: true }, command: 'claim {KEY}', verifyCommand: 'verify {KEY}' },
        notes: 'hi',
      },
      skills: { required: ['a'], exclude: ['x-*'], extraRoots: ['~/s'] },
      deny: { commands: ['foo'], shellPatterns: ['*bar*'], secretPaths: ['~/.aws', '.config/x'], editPaths: ['**/generated/**'] },
      models: { orchestrator: 'anthropic/claude-opus-5-5#high', fixer: 'openai/gpt-5' },
      audit: { bannedTerms: ['acme'] },
    });
    expect(p.repos['web']).toEqual({ tools: [] });
    expect(p.deny.secretPaths).toEqual(['.aws', '.config/x']);
    expect(p.tracker.autoClaim.when).toEqual({ status: 'Backlog', unassigned: true });
  });

  it('rejects unknown keys, a wrong version and a missing workspaceRoot', () => {
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', skils: {} })).toThrow();
    expect(() => UserProfile.parse({ version: 2, workspaceRoot: '/w' })).toThrow();
    expect(() => UserProfile.parse({ version: 1 })).toThrow();
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '' })).toThrow();
  });

  it('rejects bad model specs, bad regexes, absolute secretPaths and incomplete autoClaim', () => {
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', models: { a: 'nomodel' } })).toThrow();
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', models: { a: 'p/m#' } })).toThrow();
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', tracker: { keyPattern: '(' } })).toThrow();
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', deny: { secretPaths: ['/etc/x'] } })).toThrow();
    expect(() => UserProfile.parse({ version: 1, workspaceRoot: '/w', tracker: { autoClaim: { enabled: true } } })).toThrow(
      /requires both/,
    );
  });

  it('splitModelSpec', () => {
    expect(splitModelSpec('a/b')).toEqual({ model: 'a/b' });
    expect(splitModelSpec('a/b-c#high')).toEqual({ model: 'a/b-c', variant: 'high' });
  });
});

describe('paths and hashing', () => {
  it('expandHome', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x/y', '/h')).toBe('/h/x/y');
    expect(expandHome('/abs', '/h')).toBe('/abs');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
    expect(expandHome('rel', '/h')).toBe('rel');
  });

  it('resolveProfilePath prefers NIGHTGEM_PROFILE', () => {
    expect(resolveProfilePath({ home: '/h', env: {} })).toBe('/h/.config/nightgem/profile.jsonc');
    expect(resolveProfilePath({ home: '/h', env: { NIGHTGEM_PROFILE: '' } })).toBe('/h/.config/nightgem/profile.jsonc');
    expect(resolveProfilePath({ home: '/h', env: { NIGHTGEM_PROFILE: '/p/x.jsonc' } })).toBe('/p/x.jsonc');
    expect(resolveProfilePath({ home: '/h', env: { NIGHTGEM_PROFILE: '~/p.jsonc' } })).toBe('/h/p.jsonc');
  });

  it('profileHash is a stable sha256 hex of the raw text', () => {
    expect(profileHash('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(profileHash('a')).not.toBe(profileHash('a '));
  });
});

describe('loadProfile', () => {
  it('loads JSONC (comments, trailing commas), absolutises paths and hashes the raw text', () => {
    const raw = `// my profile
{
  "version": 1,
  "workspaceRoot": "~/work", /* tilde */
  "instructionsFile": "~/.config/nightgem/i.md",
  "skills": { "extraRoots": ["~/my-skills", "rel-skills"], },
}
`;
    const path = write(join(home, '.config', 'nightgem', 'profile.jsonc'), raw);
    const r = load(path);
    expect(r.path).toBe(path);
    expect(r.raw).toBe(raw);
    expect(r.sha256).toBe(profileHash(raw));
    expect(r.profile.workspaceRoot).toBe(ws);
    expect(r.profile.instructionsFile).toBe(join(home, '.config', 'nightgem', 'i.md'));
    // relative paths resolve against the profile's directory
    expect(r.profile.skills.extraRoots).toEqual([join(home, 'my-skills'), join(home, '.config', 'nightgem', 'rel-skills')]);
    expect(r.profile.models).toEqual({});
  });

  it('missing: typed error with a hint', () => {
    const path = join(home, 'nope.jsonc');
    try {
      load(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileError);
      expect(e).toMatchObject({ code: 'missing', path });
      expect((e as Error).message).toContain('NIGHTGEM_PROFILE');
    }
  });

  it('invalid-json: reports line and column', () => {
    const path = write(join(home, 'p.jsonc'), '{\n  "version": 1,\n  "workspaceRoot": \n}\n');
    try {
      load(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid-json' });
      expect((e as Error).message).toMatch(/line \d+, column \d+/);
    }
  });

  it('invalid-schema: carries the zod issues and names the field', () => {
    const path = write(join(home, 'p.jsonc'), JSON.stringify({ version: 1, workspaceRoot: ws, models: { a: 'bad' } }));
    try {
      load(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid-schema' });
      const err = e as ProfileError;
      expect(err.issues?.[0]?.path).toEqual(['models', 'a']);
      expect(err.message).toContain('models');
    }
    const path2 = write(join(home, 'p2.jsonc'), JSON.stringify({ version: 1 }));
    expect(() => load(path2)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
  });

  it('invalid-workspace: lists the reasons', () => {
    const path = write(join(home, 'p.jsonc'), JSON.stringify({ version: 1, workspaceRoot: '~' }));
    try {
      load(path);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid-workspace' });
      expect((e as ProfileError).reasons?.join(' ')).toContain('home directory');
    }
  });

  it('rethrows non-ENOENT read errors untouched', () => {
    const fs = { ...nodeFs, readFileSync: () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); } };
    expect(() => loadProfile({ path: '/p', home, env: {}, fs: fs as never })).toThrow('boom');
  });

  it('accepts a valid profile written through the injected fs', () => {
    const files = new Map([[join(home, 'p.jsonc'), profileJson({ audit: { bannedTerms: ['acme'] } })]]);
    const fs = {
      ...nodeFs,
      readFileSync: ((p: string) => {
        const v = files.get(p);
        if (v === undefined) throw Object.assign(new Error('nf'), { code: 'ENOENT' });
        return v;
      }) as never,
    };
    const r = loadProfile({ path: join(home, 'p.jsonc'), home, env: {}, fs });
    expect(r.profile.audit.bannedTerms).toEqual(['acme']);
  });
});

describe('validateWorkspaceRoot (AD11)', () => {
  const check = (p: string): string[] => validateWorkspaceRoot(p, { home, fs: nodeFs });
  const expectRejected = (p: string, re: RegExp): void => {
    const reasons = check(p);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join('\n')).toMatch(re);
  };

  it('accepts a plain directory under HOME', () => {
    expect(check(ws)).toEqual([]);
  });

  it('rejects /', () => expectRejected('/', /root/));
  it('rejects $HOME', () => expectRejected(home, /home directory/));
  it('rejects an ancestor of $HOME', () => expectRejected(join(home, '..'), /home directory/));
  it('rejects a relative path', () => expectRejected('work', /absolute/));

  it('rejects ~/Library, ~/.config, ~/.ssh and anything inside them', () => {
    for (const d of ['Library', '.config', '.ssh']) {
      mkdirSync(join(home, d, 'inner'), { recursive: true });
      expectRejected(join(home, d), /overlaps/);
      expectRejected(join(home, d, 'inner'), /overlaps/);
    }
  });

  it('rejects any hidden directory directly under HOME (~/.aws, ~/.gnupg, ~/.docker) and anything inside it', () => {
    for (const d of ['.aws', '.gnupg', '.docker']) {
      mkdirSync(join(home, d, 'inner'), { recursive: true });
      expectRejected(join(home, d), /hidden directory/);
      expectRejected(join(home, d, 'inner'), /hidden directory/);
    }
    mkdirSync(join(ws, '.hidden-inside'), { recursive: true });
    expect(check(join(ws, '.hidden-inside'))).toEqual([]);
  });

  it('rejects the control root and anything inside it', () => {
    const control = controlRootFor(home);
    mkdirSync(join(control, 'demo'), { recursive: true });
    expectRejected(control, /control directory/);
    expectRejected(join(control, 'demo'), /control directory/);
  });

  it('rejects a custom control root passed by the caller', () => {
    const custom = join(home, 'ctl');
    mkdirSync(custom);
    expect(validateWorkspaceRoot(custom, { home, fs: nodeFs, controlRoot: custom }).join()).toMatch(/control directory/);
  });

  it('is not fooled by letter case (case-insensitive filesystems)', () => {
    expectRejected(join(home, 'LIBRARY'), /overlaps ~\/Library/);
  });

  it('is not fooled by a symlink into a denied location', () => {
    mkdirSync(join(home, '.ssh'));
    const link = join(home, 'innocent');
    symlinkSync(join(home, '.ssh'), link);
    expectRejected(link, /overlaps ~\/\.ssh/);
  });

  it('rejects a path that does not exist and a file', () => {
    expectRejected(join(ws, 'missing'), /does not exist/);
    const file = join(ws, 'f.txt');
    writeFileSync(file, 'x');
    expectRejected(file, /not a directory/);
  });

  it('rejects a path inside a git work tree (repo root, subdirectory and linked worktree)', () => {
    const repo = join(ws, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'sub', 'deep'), { recursive: true });
    expectRejected(repo, /git work tree/);
    expectRejected(join(repo, 'sub', 'deep'), /git work tree/);

    // a linked worktree has a `.git` *file*
    const wt = join(ws, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: /somewhere\n');
    expectRejected(wt, /git work tree/);
  });

  it('rejects a real git worktree created by git', async () => {
    const { execFileSync } = await import('node:child_process');
    const repo = join(ws, 'main-repo');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(ws, 'linked');
    git('worktree', 'add', '-q', wt, '-b', 'other');
    expectRejected(wt, /git work tree/);
  });
});

describe('validateSkillRoot', () => {
  const check = (p: string): string[] => validateSkillRoot(p, { home });

  it('accepts ordinary roots, even inside a git work tree', () => {
    const repo = join(ws, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(check(join(home, '.claude', 'skills'))).toEqual([]);
    expect(check(join(home, '.agents', 'skills'))).toEqual([]);
    expect(check(join(repo, 'skills'))).toEqual([]);
  });

  it('rejects /, $HOME, ancestors, Library, .ssh, the control root and non-absolute paths', () => {
    expect(check('/').length).toBeGreaterThan(0);
    expect(check(home).join()).toMatch(/home directory/);
    expect(check(join(home, '..')).join()).toMatch(/home directory/);
    expect(check(join(home, 'Library', 'x')).join()).toMatch(/overlaps/);
    expect(check(join(home, '.ssh')).join()).toMatch(/overlaps/);
    expect(check(join(controlRootFor(home), 'demo')).join()).toMatch(/control/);
    expect(check('skills')).toEqual([expect.stringContaining('absolute')]);
  });

  it('rejects ~/.config and other parts of it, but allows ~/.config/opencode/skills', () => {
    expect(check(join(home, '.config')).join()).toMatch(/overlaps ~\/\.config/);
    expect(check(join(home, '.config', 'opencode')).join()).toMatch(/overlaps ~\/\.config/);
    expect(check(join(home, '.config', 'gh')).join()).toMatch(/overlaps ~\/\.config/);
    expect(check(join(home, '.config', 'opencode', 'skills'))).toEqual([]);
    expect(check(join(home, '.config', 'opencode', 'skills', 'nested'))).toEqual([]);
  });

  it('resolves symlinks when given an fs', () => {
    mkdirSync(join(home, '.ssh'));
    const link = join(home, 'sk');
    symlinkSync(join(home, '.ssh'), link);
    expect(check(link)).toEqual([]);
    expect(validateSkillRoot(link, { home, fs: nodeFs }).join()).toMatch(/overlaps ~\/\.ssh/);
  });
});
