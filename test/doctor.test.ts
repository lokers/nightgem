import { describe, expect, it } from 'vitest';

import type { DoctorCheck, ExecFn, ExecResult } from '../src/cli-deps.ts';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { ProfileError } from '../src/userprofile.ts';

import {
  ancestorConfigCheck,
  cliOnPathCheck,
  compactLine,
  detectSlim,
  formatDoctor,
  formatWarning,
  MAX_LINE,
  skillChecks,
  slimCheck,
  doctor,
  environmentChecks,
  hardFailures,
  hasHardFailure,
  profileCheck,
  profileErrorCheck,
  readPluginSpecs,
  toolchainChecks,
  trackerChecks,
} from '../src/doctor.ts';

interface Env {
  version?: string;
  power?: string;
  dfAvailKb?: number;
}

function fakeExec(e: Env = {}): ExecFn {
  return async (cmd, args): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'opencode --version') return { stdout: `opencode v${e.version ?? '2.0.29'}\n`, stderr: '', exitCode: 0 };
    if (key === 'pmset -g batt') {
      return { stdout: `Now drawing from '${e.power ?? 'AC Power'}'\n -InternalBattery-0 100%\n`, stderr: '', exitCode: 0 };
    }
    if (cmd === 'df') {
      const avail = e.dfAvailKb ?? 100 * 1024 * 1024;
      return {
        stdout: `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971350180 342622980 ${avail} 37% 1 2 0% /System/Volumes/Data\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  };
}

const fs = { exists: () => true };
const WS = '/Users/alice/work';
const find = (r: { checks: DoctorCheck[] }, name: string) => r.checks.find((c) => c.name === name)!;

describe('doctor', () => {
  it('passes on a healthy machine', async () => {
    const r = await doctor({ exec: fakeExec(), fs, workspaceRoot: WS, nodePath: '/n/node', lockIsFree: async () => true });
    expect(r.checks.map((c) => c.name)).toEqual([
      'opencode version',
      'node path',
      'sandbox-exec',
      'AC power',
      'free disk',
      'lock',
      'launchctl',
    ]);
    expect(hasHardFailure(r)).toBe(false);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('hard-fails on battery power', async () => {
    const r = await doctor({ exec: fakeExec({ power: 'Battery Power' }), fs, workspaceRoot: WS, nodePath: '/n/node' });
    const c = find(r, 'AC power');
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(c.detail).toContain('Battery Power');
    expect(hasHardFailure(r)).toBe(true);
  });

  it('hard-fails below 20 GB free and passes at the threshold', async () => {
    const low = await doctor({ exec: fakeExec({ dfAvailKb: 19 * 1024 * 1024 }), fs, workspaceRoot: WS, nodePath: '/n/node' });
    expect(find(low, 'free disk')).toMatchObject({ ok: false, hard: true });
    const ok = await doctor({ exec: fakeExec({ dfAvailKb: 20 * 1024 * 1024 }), fs, workspaceRoot: WS, nodePath: '/n/node' });
    expect(find(ok, 'free disk').ok).toBe(true);
  });

  it('warns on a minor/patch version mismatch, hard-fails on major', async () => {
    const patch = await doctor({ exec: fakeExec({ version: '2.0.30' }), fs, workspaceRoot: WS, nodePath: '/n/node' });
    expect(find(patch, 'opencode version')).toMatchObject({ ok: false, hard: false });
    expect(hasHardFailure(patch)).toBe(false);
    const major = await doctor({ exec: fakeExec({ version: '3.1.0' }), fs, workspaceRoot: WS, nodePath: '/n/node' });
    expect(find(major, 'opencode version')).toMatchObject({ ok: false, hard: true });
  });

  it('fails when node is not an existing absolute path or tools are missing', async () => {
    const r = await doctor({ exec: fakeExec(), fs: { exists: () => false }, workspaceRoot: WS, nodePath: 'node' });
    expect(hardFailures(r).map((c) => c.name)).toEqual(['node path', 'sandbox-exec', 'launchctl']);
  });

  it('hard-fails when the lock is held, and when the lock check throws', async () => {
    const held = await doctor({ exec: fakeExec(), fs, workspaceRoot: WS, nodePath: '/n/node', lockIsFree: async () => false });
    expect(find(held, 'lock')).toMatchObject({ ok: false, hard: true });
    const thrown = await doctor({
      exec: fakeExec(),
      fs,
      workspaceRoot: WS,
      nodePath: '/n/node',
      lockIsFree: async () => {
        throw new Error('boom');
      },
    });
    expect(find(thrown, 'lock').detail).toBe('boom');
  });

  it('appends preflight checks and survives a throwing preflight', async () => {
    const r = await doctor({
      exec: fakeExec(),
      fs,
      workspaceRoot: WS,
      nodePath: '/n/node',
      preflight: async () => [{ name: 'rules', ok: false, hard: true, detail: 'ask rule found' }],
    });
    expect(find(r, 'rules').ok).toBe(false);
    const t = await doctor({
      exec: fakeExec(),
      fs,
      workspaceRoot: WS,
      nodePath: '/n/node',
      preflight: async () => {
        throw new Error('no server');
      },
    });
    expect(find(t, 'preflight')).toMatchObject({ ok: false, hard: true, detail: 'no server' });
  });
});

describe('doctor without a run context (missing profile)', () => {
  const missing = new ProfileError('missing', '/Users/alice/.config/nightgem/profile.jsonc', 'Profile not found');

  it('a ProfileError is one profile FAIL with the install hint, and free disk FAILs instead of crashing', async () => {
    const r = await doctor({ exec: fakeExec(), fs, nodePath: '/n/node', runContextError: missing });
    const profile = r.checks.filter((c) => c.name === 'profile');
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatchObject({ ok: false, hard: true });
    expect(profile[0]!.detail).toMatch(/nightgem\.mjs install --workspace <dir>/);
    expect(profile[0]!.detail).toContain('/Users/alice/.config/nightgem/profile.jsonc');
    expect(find(r, 'free disk')).toMatchObject({ ok: false, hard: true, detail: expect.stringContaining('no workspace root') });
    expect(hasHardFailure(r)).toBe(true);
  });

  it('the preflight\'s own profile check is not repeated', async () => {
    const r = await doctor({
      exec: fakeExec(),
      fs,
      nodePath: '/n/node',
      runContextError: missing,
      preflight: async () => [{ name: 'profile', ok: false, hard: true, detail: 'dup' }, { name: 'other', ok: true, hard: false, detail: 'x' }],
    });
    expect(r.checks.filter((c) => c.name === 'profile')).toHaveLength(1);
    expect(find(r, 'other').ok).toBe(true);
  });

  it('another error becomes a run context FAIL; the workspace comes from runContext when not passed', async () => {
    const r = await doctor({ exec: fakeExec(), fs, nodePath: '/n/node', runContextError: new Error('instructions gone') });
    expect(find(r, 'run context')).toMatchObject({ ok: false, hard: true, detail: 'instructions gone' });
    const ctx = { workspaceRoot: WS } as never;
    const ok = await doctor({ exec: fakeExec(), fs, nodePath: '/n/node', runContext: ctx });
    expect(find(ok, 'free disk').ok).toBe(true);
  });
});

describe('toolchain check (spec repos, job PATH)', () => {
  const JOB_PATH = '/job/bin:/opt/homebrew/bin';
  const repos = [
    { name: 'acme-api', path: '/w/acme-api' },
    { name: 'acme-web', path: '/w/acme-web' },
    { name: 'acme-rs', path: '/w/acme-rs' },
    { name: 'plain', path: '/w/plain' },
  ];
  /** Files that "exist": tools by absolute path, repo marker files, plus package.json contents. */
  const world = (present: string[], pkgs: Record<string, unknown> = {}) => ({
    exists: (p: string) => present.includes(p),
    readText: (p: string) => {
      const key = p.replace(/\/package\.json$/, '');
      return p.endsWith('/package.json') && key in pkgs ? JSON.stringify(pkgs[key]) : undefined;
    },
  });

  it('uses the profile tools for a listed repo and the generic defaults (npm / go / cargo) for the rest', () => {
    const w = world(['/job/bin/go', '/w/acme-api/go.mod', '/w/acme-rs/Cargo.toml'], { '/w/acme-web': { scripts: { test: 'x' } } });
    const checks = toolchainChecks(repos, JOB_PATH, w, { 'acme-api': { tools: ['go', 'buf'] } });
    expect(checks.map((c) => c.name)).toEqual(['toolchain acme-api', 'toolchain acme-web', 'toolchain acme-rs', 'toolchain plain']);
    expect(checks.every((c) => !c.hard)).toBe(true);
    expect(checks[0]).toMatchObject({ ok: false, detail: expect.stringContaining('buf') });
    expect(checks[0]!.detail).not.toMatch(/\bgo\b.*\bgo\b/);
    expect(checks[1]).toMatchObject({ ok: false, detail: expect.stringContaining('npm') });
    expect(checks[2]).toMatchObject({ ok: false, detail: expect.stringContaining('cargo') });
    expect(checks[3]).toMatchObject({ ok: true, detail: 'no verify tools to check' });
  });

  it('profile tools add to the generic defaults: npm is still checked next to a configured tool', () => {
    const w = world(['/job/bin/sometool'], { '/w/acme-web': { scripts: { test: 'x' } } });
    const [c] = toolchainChecks([repos[1]!], JOB_PATH, w, { 'acme-web': { tools: ['sometool'] } });
    expect(c).toMatchObject({ ok: false, detail: expect.stringMatching(/not on the job PATH: npm\b/) });
    expect(c!.detail).not.toContain('sometool');
    const [d] = toolchainChecks([repos[1]!], JOB_PATH, world([], { '/w/acme-web': { scripts: { test: 'x' } } }), { 'acme-web': { tools: ['sometool'] } });
    expect(d!.detail).toMatch(/npm.*sometool|sometool.*npm/);
  });

  it('go.mod without profile tools needs go, and nothing is hard-coded by repo name', () => {
    const w = world(['/w/acme-api/go.mod']);
    const [c] = toolchainChecks([{ name: 'acme-api', path: '/w/acme-api' }], JOB_PATH, w);
    expect(c).toMatchObject({ ok: false, detail: expect.stringMatching(/not on the job PATH: go\b/) });
    const [other] = toolchainChecks([{ name: 'acme-web', path: '/w/acme-web' }], JOB_PATH, world([]));
    expect(other).toMatchObject({ ok: true });
  });

  it('is ok when every tool is found on the job PATH', () => {
    const all = ['go', 'buf', 'npm', 'cargo'].map((t) => `/opt/homebrew/bin/${t}`);
    const checks = toolchainChecks(repos, JOB_PATH, world([...all, '/w/acme-rs/Cargo.toml'], { '/w/acme-web': { scripts: { build: 'x' } } }), { 'acme-api': { tools: ['go', 'buf'] } });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('doctor warns (never hard) about a verify tool missing from the JOB path: npm for a package.json with scripts', async () => {
    const w = {
      exists: (p: string) => !p.endsWith('/npm'),
      readText: (p: string) => (p.endsWith('/package.json') ? '{"scripts":{"test":"x"}}' : undefined),
    };
    const r = await doctor({ exec: fakeExec(), fs: w, workspaceRoot: WS, nodePath: '/n/node', specRepos: [repos[1]!], jobPath: JOB_PATH });
    const c = r.checks.find((x) => x.name === 'toolchain acme-web')!;
    expect(c).toMatchObject({ ok: false, hard: false, detail: expect.stringContaining('npm') });
    expect(hasHardFailure({ checks: [c] })).toBe(false);
  });

  it('a package.json without scripts needs no npm', () => {
    const checks = toolchainChecks([repos[3]!], JOB_PATH, world([], { '/w/plain': { name: 'x' } }));
    expect(checks[0]).toMatchObject({ ok: true });
  });

  it('doctor runs it only when given spec repos and a job PATH, and passes the profile tools through', async () => {
    const without = await doctor({ exec: fakeExec(), fs, workspaceRoot: WS, nodePath: '/n/node' });
    expect(without.checks.some((c) => c.name.startsWith('toolchain'))).toBe(false);
    const withRepos = await doctor({
      exec: fakeExec(),
      fs: world([]),
      workspaceRoot: WS,
      nodePath: '/n/node',
      specRepos: [repos[0]!],
      jobPath: JOB_PATH,
      repoTools: { 'acme-api': { tools: ['yamllint'] } },
    });
    const c = withRepos.checks.find((x) => x.name === 'toolchain acme-api')!;
    expect(c).toMatchObject({ ok: false, hard: false });
    expect(c.detail).toContain('yamllint');
    expect(hasHardFailure({ checks: [c] })).toBe(false);
  });
});

describe('environment checks (explicit home / env / fs)', () => {
  let home: string;
  let ws: string;
  beforeEach(() => {
    home = nodeFs.realpathSync(mkdtempSync(join(tmpdir(), 'ng-doctor-')));
    ws = join(home, 'work');
    mkdirSync(ws, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const profilePath = (): string => join(home, '.config', 'nightgem', 'profile.jsonc');
  const writeProfile = (extra: Record<string, unknown> = {}): void => {
    mkdirSync(join(home, '.config', 'nightgem'), { recursive: true });
    writeFileSync(profilePath(), JSON.stringify({ version: 1, workspaceRoot: ws, ...extra }));
  };
  const writeOpencodeJson = (obj: unknown): void => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  const cachePkg = (dir: string, version: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'oh-my-opencode-slim', version }));
  };
  const installSkills = (names: string[]): void => {
    for (const n of names) {
      mkdirSync(join(home, '.agents', 'skills', n), { recursive: true });
      writeFileSync(join(home, '.agents', 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
    }
  };
  const CORE = ['spec-driven-development', 'planning-and-task-breakdown', 'test-driven-development', 'incremental-implementation', 'code-review-and-quality'];
  const check = (name: string, env: Record<string, string> = {}) => environmentChecks({ home, env, fs: nodeFs, which: () => undefined }).checks.find((c) => c.name === name);

  describe('profile', () => {
    it('a missing profile is one FAIL with the install hint, and nothing that needs the profile runs', () => {
      const r = environmentChecks({ home, env: {}, fs: nodeFs });
      expect(r.checks.filter((c) => c.name === 'profile')).toHaveLength(1);
      const c = r.checks.find((x) => x.name === 'profile')!;
      expect(c).toMatchObject({ ok: false, hard: true });
      expect(c.detail).toContain(profilePath());
      expect(c.detail).toMatch(/nightgem\.mjs install --workspace <dir>/);
      expect(r.checks.map((x) => x.name)).toEqual(['profile', 'oh-my-opencode-slim']);
    });

    it('a valid profile reports its path and workspace', () => {
      writeProfile();
      const c = profileCheck({ home, env: {}, fs: nodeFs }).check;
      expect(c).toMatchObject({ ok: true });
      expect(c.detail).toContain(profilePath());
      expect(c.detail).toContain(ws);
    });

    it('an invalid profile reports the schema error; a rejected workspace lists the AD11 reasons', () => {
      writeProfile({ version: 9 });
      expect(profileCheck({ home, env: {}, fs: nodeFs }).check).toMatchObject({ ok: false, hard: true, detail: expect.stringContaining('Invalid profile') });
      writeProfile({ workspaceRoot: home });
      const c = profileCheck({ home, env: {}, fs: nodeFs }).check;
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('home directory');
    });

    it('NIGHTGEM_PROFILE is honoured', () => {
      const other = join(home, 'p.jsonc');
      writeFileSync(other, JSON.stringify({ version: 1, workspaceRoot: ws }));
      const c = profileCheck({ home, env: { NIGHTGEM_PROFILE: other }, fs: nodeFs }).check;
      expect(c).toMatchObject({ ok: true });
      expect(c.detail).toContain(other);
    });
  });

  describe('oh-my-opencode-slim', () => {
    const slimDir = (spec: string, stamp = '100') => join(home, '.cache', 'opencode', 'npm', spec, stamp, 'node_modules', 'oh-my-opencode-slim');

    it('present with major 3: ok, version from the cache', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@3.0.4'] });
      cachePkg(slimDir('oh-my-opencode-slim@3.0.4'), '3.0.4');
      expect(detectSlim({ home, fs: nodeFs })).toMatchObject({ status: 'ok', version: '3.0.4' });
      writeProfile();
      expect(check('oh-my-opencode-slim')).toMatchObject({ ok: true, hard: false });
    });

    it('the cache decides the version: a floating @latest spec resolves to the installed package', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@latest'] });
      cachePkg(slimDir('oh-my-opencode-slim@latest', '1'), '3.1.0');
      cachePkg(slimDir('oh-my-opencode-slim@latest', '2'), '3.2.0'); // newest stamp wins
      expect(detectSlim({ home, fs: nodeFs })).toMatchObject({ status: 'ok', version: '3.2.0' });
    });

    it('also reads the flat cache layout and [name, options] entries', () => {
      writeOpencodeJson({ plugin: [['oh-my-opencode-slim', { x: 1 }]] });
      cachePkg(join(home, '.cache', 'opencode', 'node_modules', 'oh-my-opencode-slim'), '3.4.5');
      expect(detectSlim({ home, fs: nodeFs })).toMatchObject({ status: 'ok', version: '3.4.5' });
    });

    it('wrong major: hard FAIL', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@2.9.0'] });
      cachePkg(slimDir('oh-my-opencode-slim@2.9.0'), '2.9.0');
      writeProfile();
      const c = check('oh-my-opencode-slim')!;
      expect(c).toMatchObject({ ok: false, hard: true });
      expect(c.detail).toContain('major 3 required');
    });

    it('absent from the plugin list (or no config): FAIL / WARN', () => {
      writeOpencodeJson({ plugin: ['some-other-plugin@1.0.0'] });
      expect(detectSlim({ home, fs: nodeFs }).status).toBe('absent');
      writeProfile();
      expect(check('oh-my-opencode-slim')).toMatchObject({ ok: false, hard: true });
    });

    it('configured but not in the opencode cache (no version in the spec): a hard FAIL that names the fix', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim'] });
      expect(detectSlim({ home, fs: nodeFs }).status).toBe('uncached');
      writeProfile();
      const c = check('oh-my-opencode-slim')!;
      expect(c).toMatchObject({ ok: false, hard: true });
      expect(c.detail).toContain('opencode run "hi"');
      expect(c.detail).toContain('rerun doctor');
      // the whole default line stays compact, fix included
      expect(formatDoctor({ checks: [c] })).toMatch(/^FAIL {2}oh-my-opencode-slim: .*rerun doctor$/);
      expect(formatDoctor({ checks: [c] }).length).toBeLessThanOrEqual(MAX_LINE);
    });

    it('an unreadable opencode.json stays a soft "unknown"', () => {
      expect(slimCheck({ status: 'unknown', detail: 'cannot read x' })).toMatchObject({ ok: false, hard: false });
    });

    it('a pinned spec that is not cached yet is a hard FAIL too, and still reports the pinned version', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@3.0.4'] });
      const status = detectSlim({ home, fs: nodeFs });
      expect(status).toMatchObject({ status: 'uncached', version: '3.0.4' });
      expect(slimCheck(status)).toMatchObject({ ok: false, hard: true, detail: expect.stringContaining('opencode run "hi"') });
      writeProfile();
      expect(check('oh-my-opencode-slim')!.detail).toContain('rerun doctor');
    });

    it('a pinned spec that is cached keeps its behaviour: ok on major 3, hard on another major', () => {
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@3.0.4'] });
      cachePkg(slimDir('oh-my-opencode-slim@3.0.4'), '3.0.4');
      expect(slimCheck(detectSlim({ home, fs: nodeFs }))).toMatchObject({ ok: true });
      writeOpencodeJson({ plugin: ['oh-my-opencode-slim@2.9.0'] });
      cachePkg(slimDir('oh-my-opencode-slim@2.9.0'), '2.9.0');
      expect(detectSlim({ home, fs: nodeFs })).toMatchObject({ status: 'wrong-major', version: '2.9.0' });
      expect(slimCheck(detectSlim({ home, fs: nodeFs }))).toMatchObject({ ok: false, hard: true });
    });

    it('no global opencode.json at all means slim is not enabled: a hard failure (SC2)', () => {
      const status = detectSlim({ home, fs: nodeFs });
      expect(status.status).toBe('absent');
      expect(slimCheck(status)).toMatchObject({ ok: false, hard: true });
    });

    it('reads only the plugin key: a secret elsewhere in the file never reaches the result', () => {
      const text = '// comment\n{ "provider": { "x": { "options": { "apiKey": "SECRET-KEY" } } }, "plugin": ["oh-my-opencode-slim@3.0.4",], }';
      writeOpencodeJson(text);
      expect(readPluginSpecs(text)).toEqual(['oh-my-opencode-slim@3.0.4']);
      expect(JSON.stringify(detectSlim({ home, fs: nodeFs }))).not.toContain('SECRET-KEY');
    });
  });

  describe('required skills', () => {
    it('all core skills present: ok', () => {
      writeProfile();
      installSkills(CORE);
      expect(check('required skills')).toMatchObject({ ok: true });
    });

    it('missing core skills: hard FAIL listing them with the install hint', () => {
      writeProfile();
      installSkills(CORE.slice(0, 3));
      const c = check('required skills')!;
      expect(c).toMatchObject({ ok: false, hard: true });
      expect(c.detail).toContain('incremental-implementation');
      expect(c.detail).toContain('code-review-and-quality');
      expect(c.detail).toContain('npx skills add addyosmani/agent-skills');
    });

    it('a required skill excluded by the profile: hard FAIL naming it separately', () => {
      writeProfile({ skills: { exclude: ['test-driven-*'] } });
      installSkills(CORE);
      const c = check('required skills')!;
      expect(c).toMatchObject({ ok: false, hard: true });
      expect(c.detail).toContain('excluded by the profile');
      expect(c.detail).toContain('test-driven-development');
      expect(c.detail).not.toContain('missing:');
    });

    it('profile-required extras count; collisions and rejected roots only warn', () => {
      mkdirSync(join(home, '.config'), { recursive: true });
      writeProfile({ skills: { required: ['my-extra'], extraRoots: [join(home, 'other-skills')] } });
      installSkills([...CORE, 'dup']);
      mkdirSync(join(home, 'other-skills', 'dup'), { recursive: true });
      writeFileSync(join(home, 'other-skills', 'dup', 'SKILL.md'), '---\nname: dup\n---\n');
      const r = environmentChecks({ home, env: {}, fs: nodeFs });
      expect(r.checks.find((c) => c.name === 'required skills')!.detail).toContain('my-extra');
      expect(r.checks.find((c) => c.name === 'skill name collisions')).toMatchObject({ ok: false, hard: false });
      writeProfile({ skills: { extraRoots: [join(home, '.ssh')] } });
      mkdirSync(join(home, '.ssh'), { recursive: true });
      expect(environmentChecks({ home, env: {}, fs: nodeFs }).checks.find((c) => c.name === 'skill roots rejected')).toMatchObject({ ok: false, hard: false });
    });
  });

  describe('tracker command', () => {
    it('warns when the fetch command binary does not resolve; ok when it does; absent without a tracker', () => {
      const profile = { tracker: { fetchCommand: 'acme-tracker get {KEY} --json' } } as never;
      expect(trackerChecks(profile, () => undefined)).toEqual([{ name: 'tracker command', ok: false, hard: false, detail: expect.stringContaining('acme-tracker') }]);
      expect(trackerChecks(profile, (b) => `/usr/local/bin/${b}`)[0]).toMatchObject({ ok: true });
      expect(trackerChecks({ tracker: {} } as never, () => undefined)).toEqual([]);
      expect(trackerChecks({ tracker: { fetchCommand: 'FOO=1 acme-tracker {KEY}' } } as never, () => undefined)[0]!.detail).toContain('"acme-tracker"');
    });

    it('is part of the environment checks only when a resolver is given', () => {
      writeProfile({ tracker: { fetchCommand: 'acme-tracker get {KEY}' } });
      expect(environmentChecks({ home, env: {}, fs: nodeFs }).checks.some((c) => c.name === 'tracker command')).toBe(false);
      expect(check('tracker command')).toMatchObject({ ok: false, hard: false });
    });
  });

  describe('ancestor config walk', () => {
    it('is clean when no ancestor holds opencode config', () => {
      expect(ancestorConfigCheck(ws, nodeFs)).toMatchObject({ ok: true, hard: true });
    });

    it('finds config at every level above the run dir: .specs, the workspace and its parents', () => {
      writeFileSync(join(ws, 'opencode.jsonc'), '{}');
      mkdirSync(join(ws, '.specs', '.opencode'), { recursive: true });
      writeFileSync(join(home, 'opencode.json'), '{}'); // the parent of the workspace
      const c = ancestorConfigCheck(ws, nodeFs);
      expect(c.ok).toBe(false);
      expect(c.detail).toContain(join(ws, 'opencode.jsonc'));
      expect(c.detail).toContain(join(ws, '.specs', '.opencode'));
      expect(c.detail).toContain(join(home, 'opencode.json'));
    });

    it('walks all the way up: a config far above the workspace is found', () => {
      const deep = join(home, 'a', 'b', 'c', 'work');
      mkdirSync(deep, { recursive: true });
      mkdirSync(join(home, 'a', '.opencode'), { recursive: true });
      writeFileSync(join(home, 'a', '.opencode', 'opencode.json'), '{}');
      expect(ancestorConfigCheck(deep, nodeFs).detail).toContain(join(home, 'a', '.opencode'));
    });

    it('a ~/.opencode that only holds the installer\'s bin is not config', () => {
      mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
      expect(ancestorConfigCheck(ws, nodeFs).ok).toBe(true);
    });
  });
});

/** An in-memory PATH: files, and symlinks that realpath resolves (one level is enough here). */
function fakePathFs(files: string[], links: Record<string, string> = {}) {
  return {
    exists: (p: string) => files.includes(p) || p in links,
    realpath: (p: string) => links[p] ?? p,
  };
}

describe('cli on PATH', () => {
  const BIN = '/Users/alice/src/nightgem/bin/nightgem.mjs';
  const CHECKOUT = '/Users/alice/src/nightgem';
  const env = { PATH: '/usr/bin:/Users/alice/.npm/bin:/opt/bin' };
  const check = (fsx: ReturnType<typeof fakePathFs>, e: Record<string, string> = env) => cliOnPathCheck({ env: e, fs: fsx, cliBinPath: BIN });

  it('ok when nightgem on the PATH resolves (through the link) to this checkout', () => {
    const c = check(fakePathFs([BIN], { '/Users/alice/.npm/bin/nightgem': BIN }));
    expect(c).toMatchObject({ name: 'cli on PATH', ok: true, hard: false });
    expect(c.detail).toContain(CHECKOUT);
  });

  it('missing: a soft warning that suggests npm link in this checkout', () => {
    const c = check(fakePathFs([BIN]));
    expect(c).toMatchObject({ ok: false, hard: false });
    expect(c.detail).toContain(`\`npm link\` in ${CHECKOUT}`);
    expect(check(fakePathFs([BIN]), {})).toMatchObject({ ok: false, hard: false });
  });

  it('stale: names the other checkout and suggests unlink then link', () => {
    const other = '/Users/alice/old/nightgem/bin/nightgem.mjs';
    const c = check(fakePathFs([BIN, other], { '/Users/alice/.npm/bin/nightgem': other }));
    expect(c).toMatchObject({ ok: false, hard: false });
    expect(c.detail).toContain('/Users/alice/old/nightgem');
    expect(c.detail).toContain(`\`npm unlink -g nightgem && npm link\` in ${CHECKOUT}`);
  });

  it('uses the env PATH it is given, first match wins, relative entries are ignored', () => {
    const other = '/Users/alice/old/nightgem/bin/nightgem.mjs';
    const fsx = fakePathFs([BIN, other], { '/first/nightgem': other, '/Users/alice/.npm/bin/nightgem': BIN });
    expect(check(fsx, { PATH: '/first:/Users/alice/.npm/bin' }).ok).toBe(false);
    expect(check(fsx, { PATH: 'bin:/Users/alice/.npm/bin' }).ok).toBe(true);
  });

  it('doctor() runs it only when an env is given, as a soft check that never changes the verdict', async () => {
    const base = { exec: fakeExec(), fs: fakePathFs([BIN]), workspaceRoot: WS, nodePath: '/n/node', lockIsFree: async () => true, cliBinPath: BIN };
    expect((await doctor(base)).checks.some((c) => c.name === 'cli on PATH')).toBe(false);
    const r = await doctor({ ...base, env });
    expect(find(r, 'cli on PATH')).toMatchObject({ ok: false, hard: false });
    expect(hasHardFailure(r)).toBe(hasHardFailure(await doctor(base)));
  });
});

describe('compact output', () => {
  const longPaths = (i: number): string[] => [`/Users/alice/work/some/long/skills/root/number-${i}/${'deep/'.repeat(8)}skill-${i}`, `/Users/alice/.agents/skills/${'nested/'.repeat(8)}skill-${i}`];
  const detection = {
    available: [],
    collisions: Array.from({ length: 13 }, (_, i) => ({ name: `skill-${i}`, paths: longPaths(i) })),
    missingRequired: [],
    excludedRequired: [],
    rootRejected: [],
    outsideRoots: [],
  } as never;

  it('13 skill collisions with long paths become one summary line, in the default output only', () => {
    const c = skillChecks(detection).find((x) => x.name === 'skill name collisions');
    expect(c!.detail.length).toBeGreaterThan(MAX_LINE);
    const lines = formatDoctor({ checks: [c!] }).split('\n');
    expect(lines).toEqual(['warn  skill name collisions: 13 skill names collide (the first root wins); run `doctor --verbose` for the list']);
    const verbose = formatDoctor({ checks: [c!] }, { verbose: true });
    expect(verbose).toContain(c!.detail);
    expect(verbose).toContain('skill-12');
  });

  it('caps every default line at MAX_LINE: long details, newlines, and long names are cut with a pointer to --verbose', () => {
    const checks: DoctorCheck[] = [
      { name: 'remote urls', ok: false, hard: true, detail: 'x'.repeat(900) },
      { name: 'profile', ok: false, hard: true, detail: '/p/profile.jsonc: workspaceRoot rejected:\n  - a\n  - b' },
      { name: 'tracker command', ok: true, hard: false, detail: `${'y'.repeat(300)} -> /bin/y` },
      { name: 'short', ok: true, hard: false, detail: 'fine' },
    ];
    const lines = formatDoctor({ checks }).split('\n');
    expect(lines).toHaveLength(checks.length);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(MAX_LINE);
    expect(lines[0]).toContain('run `doctor --verbose`');
    expect(lines[1]).toContain('workspaceRoot rejected:');
    expect(lines[1]).toContain('run `doctor --verbose`');
    expect(lines[3]).toBe('ok    short: fine');
    // verbose is the old, full output
    const verbose = formatDoctor({ checks }, { verbose: true });
    expect(verbose).toContain('x'.repeat(900));
    expect(verbose).toContain('\n  - b');
  });

  it('a rejected workspace keeps its reasons on one line when they fit', () => {
    const c = profileCheckForTest();
    expect(formatDoctor({ checks: [c] })).toBe(`FAIL  profile: /p/profile.jsonc: workspaceRoot rejected: is the home directory; contains a symlink`);
  });

  it('launch warnings are capped too', () => {
    const line = formatWarning({ name: 'remote pushurls', ok: false, hard: false, detail: 'z'.repeat(600) });
    expect(line.length).toBeLessThanOrEqual(MAX_LINE);
    expect(line.startsWith('warning: remote pushurls: ')).toBe(true);
    expect(line).toContain('run `doctor --verbose`');
    expect(formatWarning({ name: 'a', ok: false, hard: false, detail: 'short' })).toBe('warning: a: short');
    expect(compactLine('p: ', { name: 'a', ok: false, hard: false, detail: 'k'.repeat(900) }, true)).toHaveLength(903);
  });

  it('exit semantics are untouched: hard failures are still the only blockers, however the lines are cut', () => {
    const r = { checks: [{ name: 'a', ok: false, hard: false, detail: 'q'.repeat(500) }, { name: 'b', ok: false, hard: true, detail: 'q'.repeat(500) }] };
    expect(hasHardFailure(r)).toBe(true);
    expect(hardFailures(r).map((c) => c.name)).toEqual(['b']);
    expect(hasHardFailure({ checks: [r.checks[0]!] })).toBe(false);
  });
});

function profileCheckForTest(): DoctorCheck {
  return profileErrorCheck(new ProfileError('invalid-workspace', '/p/profile.jsonc', 'rejected', { reasons: ['is the home directory', 'contains a symlink'] }));
}
