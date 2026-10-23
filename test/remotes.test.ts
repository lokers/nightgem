import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../src/gitinfo.ts';
import { DEFAULT_NOPUSH_PREFIXES, buildSafetyEnv } from '../src/profile.ts';
import { assertRemotesSafe, describeRemoteIssue, hasEmbeddedSecret, planRemotes, readRemoteUrls, rewriteRules } from '../src/remotes.ts';
import type { ServerApi } from '../src/orchestrator.ts';
import { buildShellProbes, realCliDeps, remoteSafetyCheck, remoteSafetyChecks, runShellCanary, specRemoteRules } from '../src/wiring.ts';

/** Written as a variable so the repo's own email audit does not read URLs with a user name as email addresses. */
const AT = '@';
const SECRET = 's3cr3t-TOKEN-xyz';
const TOKEN_USER = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

let root: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nightgem-remotes-')));
  home = join(root, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A git environment that cannot reach the network or read the developer's config. */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function git(cwd: string, env: Record<string, string>, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeRepo(name: string, urls: string[] = [], pushurls: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const env = gitEnv();
  git(dir, env, 'init', '-q', '-b', 'main');
  git(dir, env, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'x');
  for (const u of urls) git(dir, env, 'config', '--add', 'remote.origin.url', u);
  for (const u of pushurls) git(dir, env, 'config', '--add', 'remote.origin.pushurl', u);
  return dir;
}

/** The env the run server gets for these repos: defaults plus the computed rules. */
async function runEnv(repos: string[]): Promise<Record<string, string>> {
  const plan = await planRemotes(repos);
  assertRemotesSafe(plan);
  return { ...gitEnv(), ...buildSafetyEnv({ sshWrapper: '/usr/bin/false', pushInsteadOf: [...DEFAULT_NOPUSH_PREFIXES, ...plan.pushInsteadOf], insteadOf: plan.insteadOf }) };
}

function fake(output: string | Error): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push([...args]);
    if (output instanceof Error) throw output;
    return output;
  };
  return { runner, calls };
}

describe('readRemoteUrls', () => {
  it('asks git config for url and pushurl values and parses multi-valued remotes and dotted remote names', async () => {
    const f = fake(
      [
        `remote.origin.url\ngit${AT}host.example.invalid:acme/web.git`,
        'remote.origin.url\nhttps://mirror.example.invalid/acme/short.url.git',
        'remote.origin.pushurl\nhttps://push.example.invalid/acme/web.git',
        'remote.my.fork.url\n../fork.git',
        'remote.odd.url\nhttps://odd.example.invalid/a\nb.git',
        '',
      ].join('\0'),
    );
    expect(await readRemoteUrls('/w/repo', f.runner)).toEqual([
      { remote: 'origin', kind: 'url', value: 'git@host.example.invalid:acme/web.git' },
      { remote: 'origin', kind: 'url', value: 'https://mirror.example.invalid/acme/short.url.git' },
      { remote: 'origin', kind: 'pushurl', value: 'https://push.example.invalid/acme/web.git' },
      { remote: 'my.fork', kind: 'url', value: '../fork.git' },
      { remote: 'odd', kind: 'url', value: 'https://odd.example.invalid/a\nb.git' },
    ]);
    expect(f.calls).toEqual([['-C', '/w/repo', 'config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']]);
  });

  it('a repo with no remotes (git exits 1) gives [], any other git failure is not swallowed', async () => {
    expect(await readRemoteUrls('/w/r', fake(Object.assign(new Error('exit 1'), { exitCode: 1 })).runner)).toEqual([]);
    await expect(readRemoteUrls('/w/r', fake(Object.assign(new Error('not a git repository'), { exitCode: 128 })).runner)).rejects.toThrow('not a git repository');
  });

  it('reads a real repo, and a real repo without remotes', async () => {
    const withRemote = makeRepo('a', ['git@host.example.invalid:acme/web.git'], ['https://push.example.invalid/x.git']);
    expect((await readRemoteUrls(withRemote)).map((e) => `${e.remote}:${e.kind}`).sort()).toEqual(['origin:pushurl', 'origin:url']);
    expect(await readRemoteUrls(makeRepo('b'))).toEqual([]);
  });
});

describe('hasEmbeddedSecret', () => {
  it.each([
    [`https://alice:${SECRET}@host.example.invalid/x.git`, true],
    [`ssh://git:${SECRET}@host.example.invalid/x.git`, true],
    [`https://${TOKEN_USER}@host.example.invalid/x.git`, true],
    [`https://x-token:${SECRET}@host.example.invalid:8443/x.git`, true],
    [`https://alice${AT}host.example.invalid/x.git`, false],
    [`https://${'a1b2c3d4'.repeat(5)}${AT}host.example.invalid/x.git`, true], // 40-hex classic token as the user name
    [`https://${'Zk9'.repeat(18)}${AT}dev.example.invalid/org/x.git`, true], // 54-char PAT-like user name
    [`https://${'a'.repeat(31)}${AT}host.example.invalid/x.git`, false], // below the length bar
    [`https://gldt-abc123${AT}host.example.invalid/x.git`, true],
    [`https://glrt-abc123${AT}host.example.invalid/x.git`, true],
    [`https://glcbt-abc123${AT}host.example.invalid/x.git`, true],
    [`https://hf_abc123${AT}host.example.invalid/x.git`, true],
    [`persistent-https::https://alice:${SECRET}${AT}host.example.invalid/x.git`, true],
    [`persistent-https::https://alice${AT}host.example.invalid/x.git`, false],
    ['persistent-https::https://host.example.invalid/x.git', false],
    ['https://alice:@host.example.invalid/x.git', false],
    ['ssh://git@host.example.invalid/x.git', false],
    ['git@host.example.invalid:acme/web.git', false],
    ['https://host.example.invalid/x.git', false],
    ['/srv/origin.git', false],
    ['file:///srv/origin.git', false],
  ])('%s -> %s', (url, expected) => {
    expect(hasEmbeddedSecret(url)).toBe(expected);
  });
});

describe('rewriteRules', () => {
  const url = (value: string) => ({ remote: 'origin', kind: 'url' as const, value });
  const pushurl = (value: string) => ({ remote: 'origin', kind: 'pushurl' as const, value });

  it('scp form with and without a user: the exact value and the host prefix', () => {
    expect(rewriteRules([url('git@gitlab.example.invalid:acme/web.git')]).pushInsteadOf).toEqual(['git@gitlab.example.invalid:', 'git@gitlab.example.invalid:acme/web.git']);
    expect(rewriteRules([url('gitlab.example.invalid:acme/web.git')]).pushInsteadOf).toEqual(['gitlab.example.invalid:', 'gitlab.example.invalid:acme/web.git']);
  });

  it('URL form keeps the userinfo and port verbatim', () => {
    expect(rewriteRules([url('ssh://git@gitlab.example.invalid:2222/acme/web.git')]).pushInsteadOf).toEqual(['ssh://git@gitlab.example.invalid:2222/', 'ssh://git@gitlab.example.invalid:2222/acme/web.git']);
    expect(rewriteRules([url('https://gitlab.example.invalid/acme/web.git')]).pushInsteadOf).toEqual(['https://gitlab.example.invalid/', 'https://gitlab.example.invalid/acme/web.git']);
    expect(rewriteRules([url(`https://alice${AT}gitlab.example.invalid/acme/web.git`)]).pushInsteadOf).toEqual([`https://alice${AT}gitlab.example.invalid/`, `https://alice${AT}gitlab.example.invalid/acme/web.git`]);
  });

  it('a remote helper prefix stays in front of the host prefix, so it is still a prefix of the raw value', () => {
    expect(rewriteRules([url('persistent-https::https://gitlab.example.invalid/acme/web.git')]).pushInsteadOf).toEqual([
      'persistent-https::https://gitlab.example.invalid/',
      'persistent-https::https://gitlab.example.invalid/acme/web.git',
    ]);
  });

  it('local paths and file:// keep the old behaviour (the value, and its file:// or path twin), never a bare "/" prefix', () => {
    expect(rewriteRules([url('/srv/origin.git')]).pushInsteadOf).toEqual(['/srv/origin.git', 'file:///srv/origin.git']);
    expect(rewriteRules([url('file:///srv/origin.git')]).pushInsteadOf).toEqual(['/srv/origin.git', 'file:///srv/origin.git']);
    expect(rewriteRules([url('../origin.git')]).pushInsteadOf).toEqual(['../origin.git']);
  });

  it('a pushurl becomes an exact insteadOf rule, deduped, and never a pushInsteadOf one', () => {
    const r = rewriteRules([url('git@a.example.invalid:x.git'), pushurl('https://b.example.invalid/x.git'), pushurl('https://b.example.invalid/x.git')]);
    expect(r.insteadOf).toEqual(['https://b.example.invalid/x.git']);
    expect(r.pushInsteadOf).not.toContain('https://b.example.invalid/x.git');
  });

  it('multi-valued urls each give rules, duplicates are removed', () => {
    const r = rewriteRules([url('git@a.example.invalid:x.git'), url('git@a.example.invalid:y.git'), url('git@a.example.invalid:x.git')]);
    expect(r.pushInsteadOf).toEqual(['git@a.example.invalid:', 'git@a.example.invalid:x.git', 'git@a.example.invalid:y.git']);
  });

  it('a pushurl that is a prefix of a fetch URL is reported as a conflict instead of breaking fetch', () => {
    const r = rewriteRules([url('git@a.example.invalid:x.git'), pushurl('git@a.example.invalid:x.git')]);
    expect(r.insteadOf).toEqual([]);
    expect(r.conflicts).toHaveLength(1);
  });

  it('never emits a rule for a URL with a credential', () => {
    const bad = `https://alice:${SECRET}@gitlab.example.invalid/acme/web.git`;
    const r = rewriteRules([url(bad), pushurl(`https://bob:${SECRET}@push.example.invalid/x.git`)]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.pushInsteadOf).toEqual([]);
    expect(r.insteadOf).toEqual([]);
  });
});

describe('real git: URLs that contain ".url" or ".pushurl" do not confuse the parser', () => {
  const PW = 's3cr3t';
  const credentialed = [
    `https://alice:${PW}${AT}host.example.invalid/acme/short.url.git`,
    `https://alice:${PW}${AT}host.example.invalid/acme/short.pushurl.git`,
    `https://alice:${PW}${AT}host.example.invalid/acme/a.url b.pushurl.git`,
  ];

  it.each(credentialed)('credentials are detected, the remote is "origin", and the secret is in no output: %#', async (u) => {
    const repo = makeRepo('tricky', [u]);
    expect(await readRemoteUrls(repo)).toEqual([{ remote: 'origin', kind: 'url', value: u }]);
    const plan = await planRemotes([repo]);
    expect(plan.issues).toEqual([{ repo: 'tricky', remote: 'origin', problem: 'credentials' }]);
    expect(plan.remotes).toEqual([{ repo, names: ['origin'] }]);
    const outputs = [JSON.stringify(plan), describeRemoteIssue(plan.issues[0]!), JSON.stringify(await remoteSafetyCheck(root))];
    try {
      assertRemotesSafe(plan);
    } catch (e) {
      outputs.push(String(e));
    }
    try {
      await specRemoteRules([repo]);
    } catch (e) {
      outputs.push(String(e));
    }
    expect(outputs).toHaveLength(5);
    for (const o of outputs) expect(o).not.toContain(PW);
  });

  it('a credentialed pushurl containing ".pushurl" is detected too', async () => {
    const repo = makeRepo('tricky-push', ['git@gitlab.example.invalid:acme/web.git'], [`https://alice:${PW}${AT}host.example.invalid/acme/x.pushurl.git`]);
    const plan = await planRemotes([repo]);
    expect(plan.issues).toEqual([{ repo: 'tricky-push', remote: 'origin', problem: 'credentials' }]);
    expect(JSON.stringify(plan)).not.toContain(PW);
  });

  it.each(['https://gitlab.example.invalid/acme/short.url.git', 'https://gitlab.example.invalid/acme/my.urls.git', 'https://gitlab.example.invalid/acme/x.pushurl.git'])(
    'without credentials %s is parsed as origin and still rewritten to nopush://',
    async (u) => {
      const repo = makeRepo('tricky-clean', [u]);
      expect(await readRemoteUrls(repo)).toEqual([{ remote: 'origin', kind: 'url', value: u }]);
      const plan = await planRemotes([repo]);
      expect(plan.issues).toEqual([]);
      const env = await runEnv([repo]);
      const out = git(repo, env, 'remote', 'get-url', '--push', '--all', 'origin');
      expect(out.stdout.split('\n').filter(Boolean).every((l) => l.startsWith('nopush://'))).toBe(true);
      expect(git(repo, env, 'push', 'origin', 'HEAD').status).not.toBe(0);
    },
  );
});

describe('conflicts across spec repos', () => {
  it('a pushurl of one spec repo that is a prefix of another spec repo fetch URL is reported (they share one env)', async () => {
    const a = makeRepo('repo-a', ['git@gitlab.example.invalid:acme/a.git'], ['git@gitlab.example.invalid:acme/b']);
    const b = makeRepo('repo-b', ['git@gitlab.example.invalid:acme/b.git']);
    const plan = await planRemotes([a, b]);
    expect(plan.issues).toEqual([{ repo: 'repo-a', remote: 'origin', problem: 'pushurl-conflict' }]);
    expect(plan.insteadOf).toEqual([]);
  });

  it('doctor reports credentials across the workspace but only warns about pushurl conflicts (clones never share an env)', async () => {
    makeRepo('clone-1', ['git@gitlab.example.invalid:acme/web.git'], ['git@gitlab.example.invalid:acme/web.git']);
    makeRepo('clone-2', ['git@gitlab.example.invalid:acme/web.git']);
    const checks = await remoteSafetyChecks(root);
    expect(checks.map((c) => `${c.name}:${c.ok}:${c.hard}`)).toEqual(['remote urls:true:true', 'remote pushurls:false:false']);
    expect(checks[1]?.detail).toContain('clone-1');
    expect(checks[1]?.detail).toContain('remove or change the pushurl');
  });
});

describe('credentials: a hard failure, and the secret never appears', () => {
  it('https with a token in the URL and in a pushurl', async () => {
    const repo = makeRepo('tokened', [`https://alice:${SECRET}@gitlab.example.invalid/acme/web.git`], [`https://bob:${SECRET}@push.example.invalid/acme/web.git`]);
    const plan = await planRemotes([repo]);
    expect(plan.issues).toEqual([{ repo: 'tokened', remote: 'origin', problem: 'credentials' }]);
    expect(describeRemoteIssue(plan.issues[0]!)).toBe('repo tokened: remote origin has credentials in its URL (remove them: use ssh keys or a credential helper)');

    const outputs: string[] = [JSON.stringify(plan)];
    for (const run of [() => assertRemotesSafe(plan), () => specRemoteRules([repo]) as unknown, () => realCliDeps(home, { env: {} }).buildBaseline([repo]) as unknown]) {
      try {
        await run();
        outputs.push('did not throw');
      } catch (e) {
        outputs.push(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
      }
    }
    expect(outputs.filter((o) => o === 'did not throw')).toEqual([]);
    const check = await remoteSafetyCheck(root);
    outputs.push(JSON.stringify(check));
    expect(check).toMatchObject({ name: 'remote urls', ok: false, hard: true });
    expect(check.detail).toContain('remote origin has credentials in its URL');
    for (const o of outputs) {
      expect(o).not.toContain(SECRET);
      expect(o).not.toContain('alice');
      expect(o).not.toContain('gitlab.example.invalid');
    }
  });

  it('a token used as the user name is a credential too', async () => {
    const repo = makeRepo('tokuser', [`https://${TOKEN_USER}@gitlab.example.invalid/acme/web.git`]);
    const plan = await planRemotes([repo]);
    expect(plan.issues).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain(TOKEN_USER);
  });

  it('a user without a password is fine', async () => {
    const plan = await planRemotes([makeRepo('plain', [`https://alice${AT}gitlab.example.invalid/acme/web.git`])]);
    expect(plan.issues).toEqual([]);
  });

  it('a pushurl equal to the fetch url cannot be covered: reported by name, without the URL', async () => {
    const repo = makeRepo('same', ['git@gitlab.example.invalid:acme/web.git'], ['git@gitlab.example.invalid:acme/web.git']);
    const plan = await planRemotes([repo]);
    expect(plan.issues).toEqual([{ repo: 'same', remote: 'origin', problem: 'pushurl-conflict' }]);
    expect(describeRemoteIssue(plan.issues[0]!)).not.toContain('gitlab');
  });

  it('remoteSafetyCheck passes for a clean workspace', async () => {
    makeRepo('clean', ['git@gitlab.example.invalid:acme/web.git']);
    expect(await remoteSafetyCheck(root)).toMatchObject({ ok: true, hard: true });
  });
});

describe('real git: every push URL of every remote becomes nopush://, and push fails', () => {
  const CASES: Array<{ name: string; urls: string[]; pushurls?: string[]; globalConfig?: string; relative?: boolean }> = [
    { name: 'scp with a user', urls: ['git@gitlab.example.invalid:acme/web.git'] },
    { name: 'scp without a user', urls: ['gitlab.example.invalid:acme/web.git'] },
    { name: 'ssh with user and port', urls: ['ssh://git@gitlab.example.invalid:2222/acme/web.git'] },
    { name: 'https', urls: ['https://gitlab.example.invalid/acme/web.git'] },
    { name: 'https with a user but no password', urls: [`https://alice${AT}gitlab.example.invalid/acme/web.git`] },
    { name: 'a relative local path', urls: ['../origin.git'], relative: true },
    { name: 'file://', urls: ['file:///nonexistent/origin.git'] },
    { name: 'an explicit pushurl on another host', urls: ['git@gitlab.example.invalid:acme/web.git'], pushurls: ['https://bitbucket.example.invalid/acme/web.git'] },
    { name: 'several pushurls', urls: ['git@gitlab.example.invalid:acme/web.git'], pushurls: ['https://bitbucket.example.invalid/a.git', 'ssh://git@other.example.invalid/b.git'] },
    { name: 'multi-valued url', urls: ['git@gitlab.example.invalid:acme/web.git', 'https://mirror.example.invalid/acme/web.git'] },
    {
      name: "the user's global url.<x>.insteadOf",
      urls: ['gh:acme/web.git'],
      globalConfig: '[url "ssh://git@mirror.example.invalid/"]\n\tinsteadOf = gh:\n',
    },
    {
      name: "the user's own pushInsteadOf for the host prefix (the exact-URL rule is longer, so ours wins)",
      urls: ['git@gitlab.example.invalid:acme/web.git'],
      globalConfig: '[url "ssh://git@push.example.invalid/"]\n\tpushInsteadOf = git@gitlab.example.invalid:\n',
    },
  ];

  it.each(CASES)('$name', async ({ urls, pushurls, globalConfig, relative }) => {
    if (globalConfig) writeFileSync(join(home, '.gitconfig'), globalConfig);
    const repo = makeRepo('spec-repo', urls, pushurls ?? []);
    const env = await runEnv([repo]);
    // GIT_CONFIG_COUNT matches the number of key/value pairs actually present
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).length).toBe(count);
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_VALUE_')).length).toBe(count);

    const urlsOut = git(repo, env, 'remote', 'get-url', '--push', '--all', 'origin');
    expect(urlsOut.status, urlsOut.stderr).toBe(0);
    const lines = urlsOut.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.startsWith('nopush://'))).toBe(true);

    const push = git(repo, env, 'push', 'origin', 'HEAD');
    expect(push.status).not.toBe(0);
    expect(push.stderr).toMatch(/nopush/i);
    if (relative) expect(git(repo, env, 'push', '--dry-run', 'origin', 'HEAD').status).not.toBe(0);
  });

  it("a user-level pushInsteadOf identical to ours wins the tie, and the canary's all-remotes probe fails (intended)", async () => {
    const exact = 'git@gitlab.example.invalid:acme/web.git';
    writeFileSync(join(home, '.gitconfig'), `[url "ssh://git@push.example.invalid/"]\n\tpushInsteadOf = ${exact}\n`);
    const repo = makeRepo('spec-repo', [exact]);
    const env = await runEnv([repo]);
    const out = git(repo, env, 'remote', 'get-url', '--push', '--all', 'origin').stdout;
    expect(out.split('\n').filter(Boolean).every((l) => l.startsWith('nopush://'))).toBe(false);
    const probes = buildShellProbes({ repoDir: '/x', port: undefined, sandbox: false, specRemotes: [{ repo, remotes: ['origin'] }], readDenyFile: undefined, nonce: 'n' }).probes.filter((p) =>
      p.name.startsWith('push urls of'),
    );
    const api = { shell: async () => ({ status: 'exited', exit: 0, output: out }) } as unknown as ServerApi;
    const res = await runShellCanary(api as never, 's', probes);
    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
  });

  it('an explicit pushurl is rewritten by insteadOf and fetch is left alone', async () => {
    const repo = makeRepo('spec-repo', ['git@gitlab.example.invalid:acme/web.git'], ['https://bitbucket.example.invalid/acme/web.git']);
    const env = await runEnv([repo]);
    expect(git(repo, env, 'remote', 'get-url', 'origin').stdout.trim()).toBe('git@gitlab.example.invalid:acme/web.git');
    // without the insteadOf rule the pushurl would escape (git ignores pushInsteadOf for it): the point of the second rule
    const plan = await planRemotes([repo]);
    const withoutInsteadOf = { ...gitEnv(), ...buildSafetyEnv({ sshWrapper: '/usr/bin/false', pushInsteadOf: [...DEFAULT_NOPUSH_PREFIXES, ...plan.pushInsteadOf] }) };
    expect(git(repo, withoutInsteadOf, 'remote', 'get-url', '--push', 'origin').stdout.trim()).toBe('https://bitbucket.example.invalid/acme/web.git');
  });

  it('fetch from a local origin still works when its pushurl is rewritten to nopush://', async () => {
    const bare = join(root, 'origin.git');
    const other = join(root, 'other.git');
    for (const b of [bare, other]) git(root, gitEnv(), 'init', '-q', '--bare', '-b', 'main', b);
    const seed = makeRepo('seed', [bare]);
    expect(git(seed, gitEnv(), 'push', '-q', 'origin', 'HEAD:refs/heads/main').status).toBe(0);
    const repo = makeRepo('spec-repo', [bare], [other]);
    const env = await runEnv([repo]);
    const fetch = git(repo, env, 'fetch', 'origin');
    expect(fetch.status, fetch.stderr).toBe(0);
    expect(git(repo, env, 'remote', 'get-url', '--push', 'origin').stdout.trim()).toBe('nopush://');
    expect(git(repo, env, 'push', 'origin', 'HEAD').status).not.toBe(0);
  });

  it('every remote of a repo is covered, not only origin', async () => {
    const repo = makeRepo('spec-repo', ['git@gitlab.example.invalid:acme/web.git']);
    git(repo, gitEnv(), 'remote', 'add', 'upstream', 'https://github-mirror.example.invalid/acme/web.git');
    git(repo, gitEnv(), 'remote', 'add', 'fork', `ssh://deploy${AT}fork.example.invalid:2200/me/web.git`);
    git(repo, gitEnv(), 'config', 'remote.fork.pushurl', 'https://elsewhere.example.invalid/me/web.git');
    const env = await runEnv([repo]);
    for (const remote of ['origin', 'upstream', 'fork']) {
      const out = git(repo, env, 'remote', 'get-url', '--push', '--all', remote);
      expect(out.stdout.split('\n').filter(Boolean).every((l) => l.startsWith('nopush://')), remote).toBe(true);
      expect(git(repo, env, 'push', remote, 'HEAD').status, remote).not.toBe(0);
    }
  });
});
