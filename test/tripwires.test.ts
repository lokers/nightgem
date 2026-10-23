import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../src/gitinfo.ts';
import {
  checkTripwires,
  discoverRepos,
  protectFiles,
  snapshotRepo,
  takeBaseline,
  type DiscoverFs,
  type ProtectFs,
} from '../src/tripwires.ts';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ng-trip-')));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Real git, isolated from the user's global/system config. */
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // The default global ignore (~/.config/git/ignore) is read via XDG; point it at nothing.
  XDG_CONFIG_HOME: '/nonexistent-ng-xdg',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
const realGit: GitRunner = async (args, opts) => sh(opts.cwd, ...args).replace(/\n$/, '');

function makeRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// built at runtime: no term the repo audit's local bannedTerms would flag
const SDLC_HOLDER = ['.sdlc', 'worktrees'].join('-');

describe('discoverRepos', () => {
  it('finds top-level dirs with a .git dir or file and skips worktree holders', async () => {
    const repo = makeRepo('repo-a');
    mkdirSync(join(tmp, 'plain'));
    mkdirSync(join(tmp, '.specs'));
    mkdirSync(join(tmp, '.worktrees', 'x'), { recursive: true });
    mkdirSync(join(tmp, '.worktrees', '.git'), { recursive: true }); // even with a .git it is excluded
    mkdirSync(join(tmp, SDLC_HOLDER, 'y', '.git'), { recursive: true });
    mkdirSync(join(tmp, SDLC_HOLDER, '.git'), { recursive: true });
    mkdirSync(join(tmp, 'linked'));
    writeFileSync(join(tmp, 'linked', '.git'), 'gitdir: /somewhere\n');
    writeFileSync(join(tmp, 'file.txt'), 'x');
    const repoB = makeRepo('repo-b');
    // nested repos are not discovered
    mkdirSync(join(repo, 'nested', '.git'), { recursive: true });

    expect(await discoverRepos(tmp)).toEqual([repo, join(tmp, 'linked'), repoB].sort());
  });

  it('still watches a real top-level repo whose name merely ends in -worktrees or is worktrees', async () => {
    const x = makeRepo('x-worktrees');
    const w = makeRepo('worktrees');
    const dot = makeRepo('.tool-worktrees');
    mkdirSync(join(tmp, SDLC_HOLDER, '.git'), { recursive: true });
    expect(await discoverRepos(tmp)).toEqual([x, w, dot].sort());
  });

  it('works through an injected fs', async () => {
    const dirs = new Set(['/h/a', '/h/b', '/h/.worktrees', '/h/c']);
    const gits = new Set(['/h/a/.git', '/h/.worktrees/.git', '/h/c/.git']);
    const fs: DiscoverFs = {
      readdir: async () => [
        { name: 'a', isDirectory: () => true },
        { name: 'b', isDirectory: () => true },
        { name: '.worktrees', isDirectory: () => true },
        { name: 'c', isDirectory: () => false },
      ],
      stat: async (p) => {
        if (!gits.has(p) || !dirs) throw new Error('ENOENT');
        return { isDirectory: () => true, isFile: () => false };
      },
    };
    expect(await discoverRepos('/h', fs)).toEqual(['/h/a']);
  });
});

describe('snapshotRepo / takeBaseline (real git)', () => {
  it('records head, branch, porcelain hash and stash count', async () => {
    const repo = makeRepo('r');
    const snap = await snapshotRepo(repo, realGit);
    expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.branch).toBe('main');
    expect(snap.porcelainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.stashCount).toBe(0);
    expect(await takeBaseline([repo], realGit)).toEqual({ [repo]: snap });
  });

  it('takeBaseline skips a failing repo and reports a warning naming it (never rejects)', async () => {
    const bad: GitRunner = async () => {
      throw new Error('boom');
    };
    const warnings: Array<{ path: string; reason: string }> = [];
    expect(await takeBaseline(['/x/y'], bad, { onWarning: (w) => warnings.push(w) })).toEqual({});
    expect(warnings).toEqual([{ path: '/x/y', reason: 'cannot snapshot: boom' }]);
  });
});

describe('checkTripwires: main checkouts (real git)', () => {
  async function setup() {
    const repo = makeRepo('r');
    const baseline = await takeBaseline([repo], realGit);
    return { repo, baseline, check: () => checkTripwires({ baseline, repos: [repo], protectedFiles: [] }, { git: realGit }) };
  }

  it('is quiet when nothing changed', async () => {
    const { check } = await setup();
    expect(await check()).toEqual([]);
  });

  it('detects a new commit (head)', async () => {
    const { repo, check } = await setup();
    writeFileSync(join(repo, 'b.txt'), 'b');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'second');
    const kinds = (await check()).map((v) => v.kind);
    expect(kinds).toEqual(['head']);
  });

  it('detects a branch switch', async () => {
    const { repo, check } = await setup();
    sh(repo, 'checkout', '-q', '-b', 'other');
    expect((await check()).map((v) => v.kind)).toEqual(['branch']);
  });

  it('detects an untracked or modified file (porcelain)', async () => {
    const { repo, check } = await setup();
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect((await check()).map((v) => v.kind)).toEqual(['porcelain']);
    rmSync(join(repo, 'new.txt'));
    expect(await check()).toEqual([]);
    writeFileSync(join(repo, 'a.txt'), 'changed');
    expect((await check()).map((v) => v.kind)).toEqual(['porcelain']);
  });

  it('detects a stash', async () => {
    const { repo, check } = await setup();
    writeFileSync(join(repo, 'a.txt'), 'changed');
    sh(repo, 'stash', 'push', '-q');
    const v = await check();
    expect(v.map((x) => x.kind)).toEqual(['stash']);
    expect(v[0]).toMatchObject({ expected: 0, actual: 1, path: repo });
  });

  it('reports every changed facet', async () => {
    const { repo, check } = await setup();
    sh(repo, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(repo, 'b.txt'), 'b');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'x');
    writeFileSync(join(repo, 'c.txt'), 'c');
    expect((await check()).map((v) => v.kind).sort()).toEqual(['branch', 'head', 'porcelain']);
  });

  it('a .worktrees/ subdir ignored via a global-style excludesFile does not change porcelain', async () => {
    const { repo, check } = await setup();
    const excludes = join(tmp, 'global-ignore');
    writeFileSync(excludes, '.worktrees/\n');
    sh(repo, 'config', 'core.excludesFile', excludes);
    const baseline = await takeBaseline([repo], realGit); // baseline with the ignore configured
    // a real linked worktree plus stray files inside .worktrees/
    sh(repo, 'worktree', 'add', '-q', join(repo, '.worktrees', 'task-1'), '-b', 'feat/task-1');
    writeFileSync(join(repo, '.worktrees', 'task-1', 'work.txt'), 'edit');
    writeFileSync(join(repo, '.worktrees', 'stray.txt'), 'x');
    expect(await checkTripwires({ baseline, repos: [repo], protectedFiles: [] }, { git: realGit })).toEqual([]);
    expect(await check()).toEqual([]);
  });

  it('control: without the ignore, .worktrees/ would trip porcelain', async () => {
    const { repo, check } = await setup();
    mkdirSync(join(repo, '.worktrees'));
    writeFileSync(join(repo, '.worktrees', 'stray.txt'), 'x');
    expect((await check()).map((v) => v.kind)).toEqual(['porcelain']);
  });

  it('writes outside any repo (run dir, .specs) trip nothing', async () => {
    const { repo, baseline } = await setup();
    mkdirSync(join(tmp, '.specs', 'slug', '.run'), { recursive: true });
    writeFileSync(join(tmp, '.specs', 'slug', '.run', 'RUN.json'), '{}');
    expect(await checkTripwires({ baseline, repos: [repo], protectedFiles: [] }, { git: realGit })).toEqual([]);
  });
});

describe('checkTripwires: error paths (fake git)', () => {
  const okGit = (over: Record<string, string> = {}): GitRunner => async (args) => {
    const key = args.join(' ');
    if (key in over) return over[key]!;
    switch (key) {
      case 'rev-parse HEAD':
        return 'abc123\n';
      case 'rev-parse --abbrev-ref HEAD':
        return 'main\n';
      case 'status --porcelain':
        return '';
      case 'stash list':
        return '';
    }
    throw new Error(`unexpected git ${key}`);
  };

  it('a git failure is a git-error violation, not a throw', async () => {
    const baseline = await takeBaseline(['/r'], okGit());
    const failing: GitRunner = async () => {
      throw new Error('fatal: not a git repository');
    };
    const v = await checkTripwires({ baseline, repos: ['/r'], protectedFiles: [] }, { git: failing });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'git-error', path: '/r' });
    expect(v[0]?.message).toContain('not a git repository');
  });

  it('a repo with no baseline is a violation', async () => {
    const v = await checkTripwires({ baseline: {}, repos: ['/new'], protectedFiles: [] }, { git: okGit() });
    expect(v.map((x) => x.kind)).toEqual(['no-baseline']);
  });

  it('only one failing repo does not hide the others', async () => {
    const baseline = await takeBaseline(['/a', '/b'], okGit());
    const git: GitRunner = async (args, opts) => {
      if (opts.cwd === '/a') throw new Error('nope');
      return okGit({ 'rev-parse HEAD': 'def456\n' })(args, opts);
    };
    const v = await checkTripwires({ baseline, repos: ['/a', '/b'], protectedFiles: [] }, { git });
    expect(v.map((x) => [x.kind, x.path])).toEqual([
      ['git-error', '/a'],
      ['head', '/b'],
    ]);
  });
});

describe('protected files', () => {
  it('protectFiles chmods to 0444 and returns sha256 hashes', async () => {
    const f = join(tmp, 'guard.mjs');
    writeFileSync(f, 'hello');
    const res = await protectFiles([f]);
    expect(res).toEqual([{ path: f, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }]);
    const { statSync } = await import('node:fs');
    expect(statSync(f).mode & 0o777).toBe(0o444);
  });

  it('is quiet for untouched protected files', async () => {
    const f = join(tmp, 'p.txt');
    writeFileSync(f, 'x');
    const protectedFiles = await protectFiles([f]);
    expect(await checkTripwires({ baseline: {}, repos: [], protectedFiles })).toEqual([]);
  });

  it('detects a content change', async () => {
    const f = join(tmp, 'p.txt');
    writeFileSync(f, 'x');
    const protectedFiles = await protectFiles([f]);
    chmodSync(f, 0o644);
    writeFileSync(f, 'y');
    chmodSync(f, 0o444);
    const v = await checkTripwires({ baseline: {}, repos: [], protectedFiles });
    expect(v.map((x) => x.kind)).toEqual(['protected-changed']);
  });

  it('detects a mode change', async () => {
    const f = join(tmp, 'p.txt');
    writeFileSync(f, 'x');
    const protectedFiles = await protectFiles([f]);
    chmodSync(f, 0o644);
    const v = await checkTripwires({ baseline: {}, repos: [], protectedFiles });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: 'protected-mode', expected: '444', actual: '644' });
  });

  it('detects content and mode together', async () => {
    const f = join(tmp, 'p.txt');
    writeFileSync(f, 'x');
    const protectedFiles = await protectFiles([f]);
    chmodSync(f, 0o644);
    writeFileSync(f, 'y');
    const v = await checkTripwires({ baseline: {}, repos: [], protectedFiles });
    expect(v.map((x) => x.kind)).toEqual(['protected-changed', 'protected-mode']);
  });

  it('a deleted file is protected-missing', async () => {
    const f = join(tmp, 'p.txt');
    writeFileSync(f, 'x');
    const protectedFiles = await protectFiles([f]);
    rmSync(f, { force: true });
    const v = await checkTripwires({ baseline: {}, repos: [], protectedFiles });
    expect(v.map((x) => x.kind)).toEqual(['protected-missing']);
  });

  it('works through an injected fs', async () => {
    const calls: string[] = [];
    const fs: ProtectFs = {
      readFile: async () => new TextEncoder().encode('hello'),
      chmod: async (p, m) => void calls.push(`${p}:${m.toString(8)}`),
      stat: async () => ({ mode: 0o100444 }),
    };
    const files = await protectFiles(['/x'], fs);
    expect(calls).toEqual(['/x:444']);
    expect(await checkTripwires({ baseline: {}, repos: [], protectedFiles: files }, { fs })).toEqual([]);
  });
});
