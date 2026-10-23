/**
 * nightgem's own git calls run outside the sandbox, in repos an agent can write to. These tests plant every
 * program-running git setting we know of and check that none of them runs. Real git, temp repos, a local bare repo as
 * origin, no network. Each vector also has a CONTROL: plain git runs the same planted program, which proves the
 * vector is real on this git version.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkRemoteBranch, commitsBetween, currentBranch, defaultGit, headSha, porcelainHash, stashCount } from '../src/gitinfo.ts';
import { dynamicOverrides, FIXED_OVERRIDES, inspectArgs, parseConfigList, runGitSafe, safeEnv } from '../src/gitsafe.ts';
import { readRemoteUrls } from '../src/remotes.ts';
import { gitFetchOrigin } from '../src/wiring.ts';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

let base: string;
let repo: string;
let bare: string;
let markers: string;

/** Plain git with only the identity needed to commit. It runs hooks and config programs, like an unhardened caller. */
function plain(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A script outside the repo that records that it ran, then runs `body`. */
function evil(name: string, body = ''): string {
  const path = join(base, `evil-${name}.sh`);
  writeFileSync(path, `#!/bin/sh\ntouch "${join(markers, name)}"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const fired = (name: string): boolean => existsSync(join(markers, name));
const reset = (name: string): void => rmSync(join(markers, name), { force: true });

/** Make every tracked file look stat-dirty, so `git status` has to re-hash it (and run a clean filter if one is set). */
function racy(): void {
  const t = new Date(Date.now() + 5000);
  for (const f of ['a.txt', 'b.dat']) utimesSync(join(repo, f), t, t);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ng-gitsafe-')));
  markers = join(base, 'markers');
  mkdirSync(markers);
  repo = join(base, 'acme-api');
  bare = join(base, 'origin.git');
  plain(base, ['init', '-q', '--bare', '-b', 'main', bare]);
  plain(base, ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, 'b.dat'), 'dat\n');
  plain(repo, ['add', '.']);
  plain(repo, ['commit', '-q', '-m', 'first']);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  plain(repo, ['commit', '-q', '-am', 'second']);
  writeFileSync(join(repo, 'a.txt'), 'stashed\n');
  plain(repo, ['stash', 'push', '-q']);
  plain(repo, ['remote', 'add', 'origin', bare]);
  plain(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  plain(repo, ['fetch', '-q', 'origin']);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const cfg = (...kv: string[]): void => {
  for (let i = 0; i < kv.length; i += 2) plain(repo, ['config', kv[i] as string, kv[i + 1] as string]);
};

/** Every git helper nightgem uses, run against the (hostile) repo. Returns what they computed. */
async function runAllHelpers(): Promise<Record<string, unknown>> {
  const fetch = await gitFetchOrigin(repo, 30_000, process.env);
  return {
    porcelain: await porcelainHash(repo),
    branch: await currentBranch(repo),
    head: await headSha(repo),
    stashes: await stashCount(repo),
    commits: await commitsBetween(repo, 'HEAD~1'),
    remotes: await readRemoteUrls(repo),
    lsRemote: await checkRemoteBranch(repo, 'main'),
    fetchExit: fetch.exitCode,
  };
}

function expectCorrect(r: Record<string, unknown>): void {
  expect(r['porcelain']).toBe(EMPTY_SHA256);
  expect(r['branch']).toBe('main');
  expect(r['head']).toBe(plain(repo, ['rev-parse', 'HEAD']).trim());
  expect(r['stashes']).toBe(1);
  expect(r['commits']).toEqual([expect.stringMatching(/^[0-9a-f]+ second$/)]);
  expect(r['remotes']).toContainEqual({ remote: 'origin', kind: 'url', value: bare });
  expect(r['lsRemote']).toEqual({ state: 'yes' });
  expect(r['fetchExit']).toBe(0);
}

interface Vector {
  name: string;
  plant: () => void;
  /** Plain git commands that must fire the planted program (the control). */
  control: string[][];
  /** More nightgem-style calls (through the hardened runner) that would reach the vector. */
  extra?: string[][];
  /** Run the control under a pty (a pager only starts on a terminal). */
  pty?: boolean;
}

const vectors: Vector[] = [
  {
    name: 'core.fsmonitor',
    plant: () => cfg('core.fsmonitor', evil('core.fsmonitor')),
    control: [['status', '--porcelain']],
  },
  {
    name: 'include.path to a file that sets core.fsmonitor',
    plant: () => {
      const inc = join(base, 'inc.cfg');
      writeFileSync(inc, `[core]\n\tfsmonitor = ${evil('include')}\n`);
      cfg('include.path', inc);
    },
    control: [['status', '--porcelain']],
  },
  {
    name: 'includeIf gitdir: that sets core.fsmonitor',
    plant: () => {
      const inc = join(base, 'incif.cfg');
      writeFileSync(inc, `[core]\n\tfsmonitor = ${evil('includeif')}\n`);
      cfg(`includeIf.gitdir:${repo}/.path`, inc);
    },
    control: [['status', '--porcelain']],
  },
  {
    name: 'filter clean + .gitattributes',
    plant: () => {
      cfg('filter.evil.clean', evil('filter-clean', 'cat'), 'filter.evil.smudge', evil('filter-smudge', 'cat'), 'filter.evil.required', 'true');
      racy();
    },
    control: [['status', '--porcelain']],
  },
  {
    name: 'filter process + .gitattributes',
    plant: () => {
      cfg('filter.evil.process', evil('filter-process'));
      racy();
    },
    control: [['status', '--porcelain']],
  },
  {
    name: 'filter clean via .git/info/attributes',
    plant: () => {
      appendFileSync(join(repo, '.git', 'info', 'attributes'), '*.dat filter=sneaky\n');
      cfg('filter.sneaky.clean', evil('info-attributes', 'cat'));
      racy();
    },
    control: [['status', '--porcelain']],
  },
  {
    name: 'diff.external',
    plant: () => cfg('diff.external', evil('diff-external')),
    control: [['diff', 'HEAD~1', 'HEAD'], ['log', '-p', '-1']],
  },
  {
    name: 'diff textconv',
    plant: () => cfg('diff.evil.textconv', evil('textconv', 'cat "$1"')),
    control: [['diff', 'HEAD~1', 'HEAD'], ['log', '-p', '-1']],
  },
  {
    name: 'diff.<driver>.command',
    plant: () => cfg('diff.evil.command', evil('diff-command')),
    control: [['diff', 'HEAD~1', 'HEAD']],
  },
  {
    name: 'core.pager',
    plant: () => cfg('core.pager', evil('core.pager', 'cat')),
    control: [['log', '--oneline']],
    pty: true,
  },
  {
    name: 'pager.log',
    plant: () => cfg('pager.log', evil('pager.log', 'cat')),
    control: [['log', '--oneline']],
    pty: true,
  },
  {
    name: 'core.hooksPath with a hook',
    plant: () => {
      const hooks = join(base, 'hooks');
      mkdirSync(hooks);
      writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch "${join(markers, 'hooksPath')}"\n`);
      chmodSync(join(hooks, 'pre-commit'), 0o755);
      cfg('core.hooksPath', hooks);
    },
    control: [['commit', '--allow-empty', '-q', '-m', 'x']],
  },
  {
    name: '.git/hooks/pre-commit',
    plant: () => {
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${join(markers, 'hooks')}"\n`);
      chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    },
    control: [['commit', '--allow-empty', '-q', '-m', 'x']],
  },
  {
    name: 'remote.origin.uploadpack',
    plant: () => cfg('remote.origin.uploadpack', `${evil('uploadpack', 'exec git-upload-pack "$@"')}`),
    control: [['fetch', 'origin'], ['ls-remote', 'origin']],
  },
  {
    name: 'core.sshCommand (ssh remote)',
    plant: () => {
      cfg('core.sshCommand', evil('sshCommand'));
      plain(repo, ['remote', 'add', 'viassh', 'ssh://127.0.0.1:1/nowhere.git']);
    },
    control: [['ls-remote', 'viassh']],
    extra: [['ls-remote', 'viassh']],
  },
  {
    name: 'core.gitProxy (git:// remote)',
    plant: () => {
      cfg('core.gitProxy', evil('gitProxy'));
      plain(repo, ['config', '--add', 'core.gitProxy', `${evil('gitProxy-host')} for localhost`]);
      plain(repo, ['remote', 'add', 'viagit', 'git://localhost/nowhere.git']);
    },
    control: [['ls-remote', 'viagit']],
    extra: [['ls-remote', 'viagit']],
  },
  {
    name: 'core.alternateRefsCommand',
    plant: () => {
      writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(bare, 'objects')}\n`);
      cfg('core.alternateRefsCommand', evil('alternateRefs'));
    },
    control: [['fetch', 'origin']],
  },
  {
    name: 'ext:: transport via remote url',
    plant: () => {
      cfg('protocol.ext.allow', 'always');
      plain(repo, ['remote', 'add', 'viaext', `ext::${evil('ext')}`]);
    },
    control: [['ls-remote', 'viaext']],
    extra: [['ls-remote', 'viaext']],
  },
  {
    name: 'core.askPass',
    plant: () => cfg('core.askPass', evil('askpass', 'echo secret')),
    control: [['credential', 'fill']],
    extra: [['credential', 'fill']],
  },
  {
    name: 'credential.helper',
    plant: () => cfg('credential.helper', `!${evil('credential-helper', 'cat >/dev/null')}`),
    control: [['credential', 'fill']],
  },
];

describe('hostile repo config: nightgem git helpers run nothing', () => {
  for (const v of vectors) {
    const key = v.name;
    it(`CONTROL: plain git runs the planted ${v.name}`, () => {
      v.plant();
      const names = () => readMarkers();
      const before = names().length;
      for (const args of v.control) {
        try {
          if (v.pty) {
            execFileSync('script', ['-q', '/dev/null', 'git', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GIT_PAGER' && k !== 'PAGER')) });
            continue;
          }
          execFileSync('git', args, { cwd: repo, input: 'protocol=https\nhost=example.invalid\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        } catch {
          /* the planted program may break the command; only the marker matters */
        }
      }
      expect(names().length, `${key}: plain git did not run the planted program`).toBeGreaterThan(before);
    });

    it(`${v.name}: no helper runs it and the results stay correct`, async () => {
      v.plant();
      const result = await runAllHelpers();
      for (const args of v.extra ?? []) await runGitSafe(args, { cwd: repo, env: process.env, reject: false, timeoutMs: 20_000, input: 'protocol=https\nhost=example.invalid\n\n' });
      expect(readMarkers(), `${key} fired`).toEqual([]);
      expectCorrect(result);
    });
  }
});

function readMarkers(): string[] {
  return execFileSync('ls', [markers], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

describe('hostile repo config: commands nightgem does not use today are hardened too', () => {
  const run = (args: string[]) => runGitSafe(args, { cwd: repo, env: process.env, reject: false });

  it('diff / log -p / show with diff.external, textconv and a driver command run nothing and still print the diff', async () => {
    cfg('diff.external', evil('x-external'), 'diff.evil.textconv', evil('x-textconv', 'cat "$1"'), 'diff.evil.command', evil('x-command'));
    for (const args of [['diff', 'HEAD~1', 'HEAD'], ['log', '-p', '-1'], ['show', 'HEAD']]) {
      const r = await run(args);
      expect(r.exitCode, args.join(' ')).toBe(0);
      expect(r.stdout).toContain('+two');
    }
    expect(readMarkers()).toEqual([]);
  });

  it('GIT_EXTERNAL_DIFF in the environment is dropped', async () => {
    const r = await runGitSafe(['diff', 'HEAD~1', 'HEAD'], { cwd: repo, env: { ...process.env, GIT_EXTERNAL_DIFF: evil('env-external') }, reject: false });
    expect(r.stdout).toContain('+two');
    expect(readMarkers()).toEqual([]);
  });

  it('a hook-triggering command (commit) runs no hook, planted in core.hooksPath or .git/hooks', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${join(markers, 'hook-a')}"\n`);
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
    const r = await runGitSafe(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'x'], { cwd: repo, env: process.env, reject: false });
    expect(r.exitCode).toBe(0);
    expect(readMarkers()).toEqual([]);
  });

  it('a planted credential helper is dropped, the global one is kept', async () => {
    const home = process.env['HOME'] as string;
    writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = "!f() { echo username=trusted; echo password=ok; }; f"\n`);
    try {
      cfg('credential.helper', `!${evil('cred', 'echo username=planted; echo password=bad')}`);
      cfg('credential.https://example.invalid.helper', `!${evil('cred2', 'echo username=planted2; echo password=bad')}`);
      const res = (await runGitSafe(['credential', 'fill'], { cwd: repo, env: process.env, reject: false, input: 'protocol=https\nhost=example.invalid\n\n' })).stdout;
      expect(res).toContain('username=trusted');
      expect(res).not.toContain('planted');
      expect(readMarkers()).toEqual([]);
    } finally {
      rmSync(join(home, '.gitconfig'), { force: true });
    }
  });

  it('a submodule with its own planted config does not run it during status or fetch', async () => {
    const sub = join(base, 'sub-src');
    plain(base, ['init', '-q', '-b', 'main', sub]);
    writeFileSync(join(sub, 's.txt'), 's\n');
    plain(sub, ['add', '.']);
    plain(sub, ['commit', '-q', '-m', 'sub']);
    plain(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
    plain(repo, ['commit', '-q', '-m', 'add submodule']);
    // Plant in the submodule's own gitdir config (inside the main .git) and make the submodule dirty.
    plain(join(repo, 'vendor', 'sub'), ['config', 'core.fsmonitor', evil('sub-fsmonitor')]);
    writeFileSync(join(repo, 'vendor', 'sub', 's.txt'), 'dirty\n');
    const out = await porcelainHash(repo);
    expect(out).not.toBe(EMPTY_SHA256);
    await gitFetchOrigin(repo, 30_000, process.env);
    expect(readMarkers()).toEqual([]);
  });

  it('a linked worktree with a planted config.worktree runs nothing', async () => {
    cfg('extensions.worktreeConfig', 'true');
    const wt = join(base, 'wt');
    plain(repo, ['worktree', 'add', '-q', '-b', 'feat/x', wt]);
    plain(wt, ['config', '--worktree', 'core.fsmonitor', evil('worktree')]);
    expect(await porcelainHash(wt)).toBe(EMPTY_SHA256);
    expect(await currentBranch(wt)).toBe('feat/x');
    expect(readMarkers()).toEqual([]);
  });

  it('a symlinked repo path and a relative -C work', async () => {
    cfg('core.fsmonitor', evil('symlink'));
    const link = join(base, 'link');
    symlinkSync(repo, link);
    expect(await headSha(link)).toBe(plain(repo, ['rev-parse', 'HEAD']).trim());
    expect((await defaultGit(['-C', '..', 'status', '--porcelain'], { cwd: join(repo, '.git') })).trim()).toBe('');
    expect(readMarkers()).toEqual([]);
  });
});

describe('precedence: command-line -c beats repo config and includes', () => {
  it('the effective value of every fixed override is ours, whatever the repo (or an include) says', async () => {
    const inc = join(base, 'inc.cfg');
    writeFileSync(inc, `[core]\n\tfsmonitor = ${evil('p-include')}\n\thooksPath = ${base}\n`);
    cfg('include.path', inc, 'core.fsmonitor', evil('p-local'), 'core.pager', evil('p-pager'), 'diff.external', evil('p-ext'), 'core.hooksPath', base);
    // Prove the plant is real: git alone reports the hostile values.
    expect(plain(repo, ['config', '--get', 'core.fsmonitor']).trim()).toMatch(/evil-p-(local|include)\.sh$/);
    for (const [key, want] of FIXED_OVERRIDES) {
      const r = await runGitSafe(['config', '--get', key], { cwd: repo, env: process.env, reject: false });
      // `--get` of a key set to the empty string prints an empty line.
      expect(r.stdout.trim(), key).toBe(want);
    }
    expect(readMarkers()).toEqual([]);
  });

  it('the dynamic overrides win over the repo config, an include and a worktree config', async () => {
    const inc = join(base, 'inc2.cfg');
    writeFileSync(inc, `[filter "inc"]\n\tclean = ${evil('d-inc')}\n`);
    cfg('include.path', inc, 'filter.evil.clean', evil('d-clean'), 'diff.evil.textconv', evil('d-textconv'));
    const get = async (key: string) => (await runGitSafe(['config', '--get', key], { cwd: repo, env: process.env, reject: false })).stdout.trim();
    expect(await get('filter.evil.clean')).toBe('');
    expect(await get('filter.inc.clean')).toBe('');
    expect(await get('filter.evil.required')).toBe('false');
    expect(await get('diff.evil.textconv')).toBe('');
    // The same key, read by plain git, is hostile (the planted value is what a bare git call would use).
    expect(plain(repo, ['config', '--get', 'filter.evil.clean'])).toContain('evil-d-clean.sh');
  });

  it('a trusted global value is kept for a key the repo also sets', async () => {
    const home = process.env['HOME'] as string;
    writeFileSync(join(home, '.gitconfig'), `[filter "evil"]\n\tclean = cat\n`);
    try {
      cfg('filter.evil.clean', evil('g-clean', 'cat'));
      const r = await runGitSafe(['config', '--get', 'filter.evil.clean'], { cwd: repo, env: process.env, reject: false });
      expect(r.stdout.trim()).toBe('cat');
    } finally {
      rmSync(join(home, '.gitconfig'), { force: true });
    }
  });
});

describe('gitsafe units', () => {
  it('parseConfigList reads scope, key and value, bare keys and multi-line values', () => {
    expect(parseConfigList('local\0core.bare\nfalse\0global\0some.flag\0local\0a.b\nl1\nl2\0')).toEqual([
      { scope: 'local', key: 'core.bare', value: 'false' },
      { scope: 'global', key: 'some.flag', value: '' },
      { scope: 'local', key: 'a.b', value: 'l1\nl2' },
    ]);
  });

  it('dynamicOverrides only neutralises untrusted scopes', () => {
    const o = dynamicOverrides([
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean' },
      { scope: 'local', key: 'filter.lfs.process', value: 'x' },
      { scope: 'worktree', key: 'diff.d.textconv', value: 'x' },
      { scope: 'local', key: 'pager.log', value: 'x' },
    ]);
    const m = new Map(o);
    expect(m.get('filter.lfs.process')).toBe('');
    expect(m.has('filter.lfs.clean')).toBe(true); // all four keys of a planted driver are covered
    expect(m.get('filter.lfs.clean')).toBe('git-lfs clean'); // ... with the trusted value where there is one
    expect(m.get('diff.d.textconv')).toBe('');
    expect(m.get('pager.log')).toBe('false');
    expect(dynamicOverrides([{ scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean' }])).toEqual([]);
  });

  it('a driver name containing "=" is still neutralised (through GIT_CONFIG_COUNT)', async () => {
    cfg('filter.a=b.clean', evil('eq-clean', 'cat'));
    const r = await runGitSafe(['config', '--get', 'filter.a=b.clean'], { cwd: repo, env: process.env, reject: false });
    expect(r.stdout.trim()).toBe('');
    expect(readMarkers()).toEqual([]);
  });

  it('inspectArgs finds the subcommand past -C and -c', () => {
    expect(inspectArgs(['-C', 'x', '-c', 'a=b', 'log', '--oneline'], '/r')).toMatchObject({ subcommand: 'log', subIndex: 4, dir: '/r/x' });
    expect(inspectArgs(['--paginate', 'status'], '/r')).toMatchObject({ subcommand: 'status', subIndex: 1 });
  });

  it('safeEnv sets the trusted env and keeps a caller GIT_SSH_COMMAND', () => {
    const e = safeEnv({ PATH: '/bin', GIT_EXTERNAL_DIFF: 'x', GIT_PAGER: 'less', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
    expect(e).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
    expect(e['GIT_EXTERNAL_DIFF']).toBeUndefined();
    expect(safeEnv({})['GIT_SSH_COMMAND']).toBe('ssh');
  });

  it('a failing command still rejects with the git exit code (readRemoteUrls relies on exit 1)', async () => {
    await expect(defaultGit(['config', '--get', 'no.such.key'], { cwd: repo })).rejects.toMatchObject({ exitCode: 1 });
    expect(await readRemoteUrls(join(base, 'origin.git'))).toEqual([]);
  });
});

describe('gitFetchOrigin keeps its contract', () => {
  it('fetches a new commit from a local bare origin through a hostile uploadpack, with the ssh command set by the caller', async () => {
    cfg('remote.origin.uploadpack', evil('fetch-up', 'exec git-upload-pack "$@"'));
    writeFileSync(join(repo, 'n.txt'), 'n\n');
    plain(repo, ['add', 'n.txt']);
    plain(repo, ['commit', '-q', '-m', 'third']);
    plain(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/other']);
    const r = await gitFetchOrigin(repo, 30_000, process.env);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(plain(repo, ['rev-parse', 'refs/remotes/origin/other']).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(readMarkers()).toEqual([]);
  });

  it('a missing origin is a non-zero exit, not a throw', async () => {
    plain(repo, ['remote', 'remove', 'origin']);
    expect((await gitFetchOrigin(repo, 30_000, process.env)).exitCode).not.toBe(0);
  });
});
