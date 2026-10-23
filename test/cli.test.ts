import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli.ts';
import { cliInvocation, realExec } from '../src/cli-deps.ts';
import { realCliDeps } from '../src/wiring.ts';
import type { CliDeps, ExecFn, ExecResult } from '../src/cli-deps.ts';
import { attemptsOf, parseRunManifest, RunContextSnapshot, RunManifest } from '../src/contracts.ts';
import { launch, report, status, stop } from '../src/launcher.ts';
import { realRenderers } from '../src/render.ts';
import { writeRunContext } from '../src/wiring.ts';
import { runPaths } from '../src/paths.ts';
import { writeReport } from '../src/report.ts';
import { defaultLockPath, readControlFlags, readManifest, writeControlFlags } from '../src/state.ts';
import { makeRunContext } from './fixtures/run-context.ts';

const SLUG = 'demo-run';
const PASSWORD = 'SUPER-SECRET-PASSWORD-VALUE';
const NOW = new Date('2026-10-21T22:00:00Z');

let home: string;
let workspaceRoot: string;
let log: string[];
let manifests: Map<string, RunManifest>;
let lines: string[];

interface ExecEnv {
  power?: string;
  bootstrapExit?: number;
  jobState?: 'running' | 'loaded' | 'absent';
}

function makeExec(env: ExecEnv = {}): ExecFn {
  return async (cmd, args): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
    if (key === 'opencode --version') return ok('opencode v2.0.29\n');
    if (key === 'pmset -g batt') {
      log.push('exec:pmset');
      return ok(`Now drawing from '${env.power ?? 'AC Power'}'\n`);
    }
    if (cmd === 'df') {
      return ok('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/x 1 1 99999999 1% 1 1 0% /\n');
    }
    if (cmd === '/bin/sh') {
      const bin = args[1]?.replace('command -v ', '');
      return ok(`/opt/homebrew/bin/${bin}\n`);
    }
    if (cmd === 'launchctl' && args[0] === 'print') {
      const s = env.jobState ?? 'absent';
      log.push('exec:launchctl print');
      return s === 'absent' ? { stdout: '', stderr: 'not found', exitCode: 113 } : ok(s === 'running' ? 'state = running\n' : 'state = not running\n');
    }
    if (cmd === 'launchctl' && args[0] === 'bootstrap') {
      log.push(`exec:launchctl bootstrap ${args[1]}`);
      const exitCode = env.bootstrapExit ?? 0;
      return { stdout: '', stderr: exitCode ? 'Bootstrap failed: 5' : '', exitCode };
    }
    if (cmd === 'launchctl' && args[0] === 'bootout') {
      log.push(`exec:launchctl bootout ${args[1]}`);
      return ok();
    }
    if (cmd === 'launchctl' && args[0] === 'kill') {
      log.push(`exec:launchctl kill ${args.slice(1).join(' ')}`);
      return ok();
    }
    return { stdout: '', stderr: `unexpected: ${key}`, exitCode: 1 };
  };
}

function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    home,
    nodePath: '/n/bin/node',
    orchestratorEntry: '/o/nightgem-orchestrator.mjs',
    model: 'anthropic/claude-opus-5-5',
    uid: 501,
    now: () => NOW,
    resolveRunContext: async () => makeRunContext(workspaceRoot),
    resolveWorkspace: async () => workspaceRoot,
    renderers: realRenderers,
    readManifest: async (slug) => manifests.get(slug),
    writeManifest: async (slug, m) => {
      log.push(`deps:writeManifest ${m.state}`);
      manifests.set(slug, m);
    },
    writeRunContext: async (_dir, snap) => {
      log.push('deps:writeRunContext');
      writeRunContext(runPaths(SLUG, { home, workspaceRoot }).controlDir, snap);
    },
    readControlFlags: async () => ({ softStop: false, hardStop: false, heartbeatTs: NOW.getTime() - 30_000 }),
    resetStopFlags: (dir) => realCliDeps(home).resetStopFlags!(dir),
    readRunContext: (dir) => realCliDeps(home).readRunContext!(dir),
    acquireLock: async () => {
      log.push('deps:acquireLock');
      return { release: async () => void log.push('deps:release') };
    },
    releaseLock: async () => void log.push('deps:releaseLock'),
    lockHolder: () => realCliDeps(home).lockHolder(),
    lockIsFree: async () => true,
    buildBaseline: async (paths) => {
      log.push('deps:buildBaseline');
      return paths.map((p) => ({
        name: p.split('/').pop()!,
        path: p,
        defaultBranch: 'master',
        baseline: { head: 'abc', branch: 'master', porcelainHash: 'h', stashCount: 0 },
      }));
    },
    writeReport: async (slug) => {
      log.push('deps:writeReport');
      return runPaths(slug, { home, workspaceRoot }).reportMd;
    },
    ...over,
  };
}

const io = () => ({ out: (l: string) => void lines.push(l) });
const fs = { exists: () => true };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-cli-'));
  workspaceRoot = join(home, 'workspace');
  log = [];
  lines = [];
  manifests = new Map();
  mkdirSync(join(workspaceRoot, 'acme-api', '.git'), { recursive: true });
  const specs = runPaths(SLUG, { home, workspaceRoot }).specsDir;
  mkdirSync(specs, { recursive: true });
  writeFileSync(
    join(specs, 'SPEC.md'),
    '# Spec: demo JIRA-9\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-api` | x |\n',
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedManifest(over: Record<string, unknown> = {}): RunManifest {
  const p = runPaths(SLUG, { home, workspaceRoot });
  const m = RunManifest.parse({
    schemaVersion: 2,
    workspaceRoot: p.workspaceRoot,
    slug: SLUG,
    budgetUsd: 100,
    state: 'running',
    phase: 'build',
    launchdLabel: `com.example.nightgem.${SLUG}`,
    controlDir: p.controlDir,
    runDir: p.runDir,
    xdgDataHome: p.xdgDataHome,
    model: 'anthropic/claude-opus-5-5',
    createdAt: NOW.toISOString(),
    costUsd: 42.5,
    knownSessionIds: ['s1', 's2', 's3'],
    serverUrl: 'http://127.0.0.1:54321',
    ...over,
  });
  manifests.set(SLUG, m);
  return m;
}

describe('launch', () => {
  it('runs the steps in order and writes a private plist', async () => {
    const res = await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    const order = log.filter((l) => !l.startsWith('exec:launchctl print'));
    expect(order).toEqual([
      'exec:pmset', // doctor
      'deps:buildBaseline',
      'deps:acquireLock',
      'deps:writeRunContext', // the snapshot first, then RUN.json v2
      'deps:writeManifest launching',
      'exec:launchctl bootstrap gui/501',
    ]);
    const p = runPaths(SLUG, { home, workspaceRoot });
    expect(statSync(p.controlDir).mode & 0o777).toBe(0o700);
    expect(statSync(res.plistPath).mode & 0o777).toBe(0o600);
    expect(res.plistPath).toBe(join(p.controlDir, `dev.nightgem.${SLUG}.plist`));
    const xml = readFileSync(res.plistPath, 'utf8');
    expect(xml).toContain(`<string>${p.runDir}</string>`);
    expect(xml).toContain('<string>/n/bin/node</string>');
    expect(xml).toContain('<string>/o/nightgem-orchestrator.mjs</string>');
    expect(xml).not.toMatch(/KeepAlive<\/key>\s*<true/);

    const m = manifests.get(SLUG)!;
    expect(m).toMatchObject({ state: 'launching', phase: 'plan', budgetUsd: 50, costMultiplier: 1 });
    expect(m.repos.map((r) => r.name)).toEqual(['acme-api']);
    expect(log).not.toContain('deps:release');
    const out = lines.join('\n');
    expect(out).toContain(SLUG);
    expect(out).toContain(p.orchestratorLog);
    expect(out).toContain(`/n/bin/node `);
    expect(out).toMatch(new RegExp(`bin/nightgem\\.mjs status ${SLUG}`));
    expect(out).toContain(p.reportMd);
  });

  it('freezes the resolved run context into the control dir (0600) and summarises it in RUN.json v2', async () => {
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    const p = runPaths(SLUG, { home, workspaceRoot });
    const file = p.runContextJson;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const snap = RunContextSnapshot.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(snap).toEqual(makeRunContext(workspaceRoot));
    const m = manifests.get(SLUG)!;
    expect(m.schemaVersion).toBe(2);
    expect(m.workspaceRoot).toBe(workspaceRoot);
    expect(m.profile).toEqual({ path: snap.profile.path, sha256: snap.profile.sha256 });
    expect(m.instructions).toEqual({ sha256: snap.instructions.sha256 });
  });

  it('rejects a context that is not a valid snapshot before creating anything', async () => {
    const base = makeRunContext(workspaceRoot);
    const stub: RunContextSnapshot = { ...base, profile: { path: '', sha256: '', data: base.profile.data } };
    await expect(launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps({ resolveRunContext: async () => stub }), exec: makeExec(), fs, io: io(), parentEnv: {} })).rejects.toThrow();
    expect(log).toEqual([]);
    expect(manifests.size).toBe(0);
    expect(existsSync(runPaths(SLUG, { home, workspaceRoot }).controlDir)).toBe(false);
  });

  it('warns about verify tools missing from the JOB path, but still launches', async () => {
    const out: string[] = [];
    const only = { exists: (p: string) => !p.endsWith('/npm'), readText: (p: string) => (p.endsWith('/package.json') ? '{"scripts":{"test":"x"}}' : undefined) };
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs: only, io: { out: (l) => void out.push(l) }, parentEnv: {} });
    expect(out.some((l) => /^warning: toolchain acme-api: .*npm/.test(l))).toBe(true);
    expect(manifests.get(SLUG)!.state).toBe('launching');
  });

  it('warns about a profile repos.<name>.tools entry missing from the JOB path, and still checks npm', async () => {
    const base = makeRunContext(workspaceRoot);
    const ctx: RunContextSnapshot = { ...base, profile: { ...base.profile, data: { ...base.profile.data, repos: { 'acme-api': { tools: ['sometool'] } } } } };
    const out: string[] = [];
    const only = { exists: (p: string) => !p.endsWith('/npm') && !p.endsWith('/sometool'), readText: (p: string) => (p.endsWith('/package.json') ? '{"scripts":{"test":"x"}}' : undefined) };
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps({ resolveRunContext: async () => ctx }), exec: makeExec(), fs: only, io: { out: (l) => void out.push(l) }, parentEnv: {} });
    const warn = out.find((l) => /^warning: toolchain acme-api:/.test(l));
    expect(warn).toMatch(/sometool/);
    expect(warn).toMatch(/npm/);
    expect(manifests.get(SLUG)!.state).toBe('launching');
  });

  it('validates the slug first (before the spec, doctor, lock or any exec) with a clear message', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { stdout: '', stderr: '', exitCode: 1 };
    };
    await expect(launch({ slug: 'Bad Slug', budgetUsd: 5, deps: makeDeps(), exec, fs, io: io() })).rejects.toThrow(/Invalid slug "Bad Slug" \(expected kebab-case/);
    expect(calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it('forwards repo override and cost multiplier', async () => {
    mkdirSync(join(workspaceRoot, 'other', '.git'), { recursive: true });
    await launch({ slug: SLUG, budgetUsd: 1, repos: ['other'], costMultiplier: 10, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    const m = manifests.get(SLUG)!;
    expect(m.costMultiplier).toBe(10);
    expect(m.repos.map((r) => r.name)).toEqual(['other']);
  });

  it('releases the lock and marks the run failed when bootstrap fails', async () => {
    await expect(
      launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec({ bootstrapExit: 5 }), fs, io: io(), parentEnv: {} }),
    ).rejects.toThrow(/bootstrap failed/);
    const tail = log.slice(log.indexOf('deps:acquireLock'));
    expect(tail).toEqual([
      'deps:acquireLock',
      'deps:writeRunContext',
      'deps:writeManifest launching',
      'exec:launchctl bootstrap gui/501',
      'deps:writeManifest failed',
      'deps:release',
    ]);
    expect(manifests.get(SLUG)!.state).toBe('failed');
    expect(manifests.get(SLUG)!.stopReason).toMatch(/launch failed/);
  });

  it('aborts on a doctor hard failure before touching anything', async () => {
    await expect(
      launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec({ power: 'Battery Power' }), fs, io: io() }),
    ).rejects.toThrow(/AC power/);
    expect(log).not.toContain('deps:buildBaseline');
    expect(log).not.toContain('deps:acquireLock');
    expect(existsSync(runPaths(SLUG, { home, workspaceRoot }).controlDir)).toBe(false);
  });

  it('aborts when the lock cannot be taken, creating no manifest', async () => {
    const deps = makeDeps({
      acquireLock: async () => {
        throw new Error('lock held');
      },
    });
    await expect(launch({ slug: SLUG, budgetUsd: 50, deps, exec: makeExec(), fs, io: io() })).rejects.toThrow('lock held');
    expect(manifests.size).toBe(0);
  });

  it('rejects an invalid slug, bad budget, unapproved spec and an already loaded job', async () => {
    const base = { deps: makeDeps(), exec: makeExec(), fs, io: io() };
    await expect(launch({ ...base, slug: 'Bad Slug', budgetUsd: 5 })).rejects.toThrow(/Invalid slug/);
    await expect(launch({ ...base, slug: SLUG, budgetUsd: 0 })).rejects.toThrow(/Invalid budget/);
    writeFileSync(runPaths(SLUG, { home, workspaceRoot }).specMd, '# t\n\nStatus: DRAFT\n');
    await expect(launch({ ...base, slug: SLUG, budgetUsd: 5 })).rejects.toThrow(/not approved/);
    writeFileSync(runPaths(SLUG, { home, workspaceRoot }).specMd, '# t\n\nStatus: APPROVED\n\n## Affected repos\n| a | b |\n|--|--|\n| `acme-api` | x |\n');
    await expect(launch({ ...base, exec: makeExec({ jobState: 'loaded' }), slug: SLUG, budgetUsd: 5 })).rejects.toThrow(/already loaded/);
    expect(log).not.toContain('deps:acquireLock');
  });
});

describe('stop', () => {
  it('sends SIGTERM through launchctl when the job runs', async () => {
    seedManifest();
    const r = await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() });
    expect(r).toBe('signalled');
    expect(log).toContain(`exec:launchctl kill SIGTERM gui/501/com.example.nightgem.${SLUG}`);
    expect(log).not.toContain('deps:writeReport');
  });

  it('writes the report and marks the run stopped when the job is not loaded', async () => {
    seedManifest();
    const r = await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    expect(r).toBe('stopped');
    expect(log).toEqual(expect.arrayContaining(['deps:writeReport', 'deps:writeManifest stopped', 'deps:releaseLock']));
    expect(manifests.get(SLUG)!.state).toBe('stopped');
  });

  it('is a no-op for terminal runs and errors on unknown runs', async () => {
    seedManifest({ state: 'completed' });
    expect(await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec(), io: io() })).toBe('already-terminal');
    manifests.clear();
    await expect(stop({ slug: SLUG, deps: makeDeps(), exec: makeExec(), io: io() })).rejects.toThrow(/No run found/);
  });
});

describe('status', () => {
  it('prints the run summary and best-effort attach instructions, never the password', async () => {
    const m = seedManifest();
    mkdirSync(m.controlDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(m.controlDir, 'server.pw'), PASSWORD, { mode: 0o600 });
    await status({ slug: SLUG, deps: makeDeps(), io: io() });
    const out = lines.join('\n');
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('running');
    expect(out).toContain('build');
    expect(out).toContain('$42.50 / $100.00 (42.5%)');
    expect(out).toContain('Sessions:   3');
    expect(out).toContain('30s ago');
    expect(out).toContain('http://127.0.0.1:54321');
    expect(out).toContain(runPaths(SLUG, { home, workspaceRoot }).orchestratorLog);
    expect(out).toContain(runPaths(SLUG, { home, workspaceRoot }).reportMd);
    expect(out).toContain('best effort');
    expect(out).toContain(`OPENCODE_SERVER_PASSWORD=$(cat ${join(m.controlDir, 'server.pw')}) opencode --server http://127.0.0.1:54321`);
    expect(out).toContain('/api/pair');
    expect(out).toContain('unverified');
  });

  it('flags a stale heartbeat on a live run', async () => {
    seedManifest();
    const deps = makeDeps({ readControlFlags: async () => ({ softStop: false, hardStop: false, heartbeatTs: NOW.getTime() - 10 * 60_000 }) });
    await status({ slug: SLUG, deps, io: io() });
    expect(lines.join('\n')).toMatch(/Heartbeat:\s+10m ago \(STALE\)/);
  });

  it('lists all runs when no slug is given', async () => {
    seedManifest();
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, '{}');
    await status({ deps: makeDeps(), io: io() });
    expect(lines).toEqual([`${SLUG}  running  build  $42.50/$100.00 (43%)`]);
  });

  it('ignores folders in .specs whose names are not run slugs, such as .obsidian', async () => {
    seedManifest();
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, '{}');
    mkdirSync(join(workspaceRoot, '.specs', '.obsidian'), { recursive: true });
    mkdirSync(join(workspaceRoot, '.specs', 'Notes Folder', '.run'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.specs', 'Notes Folder', '.run', 'RUN.json'), '{}');
    await status({ deps: makeDeps(), io: io() });
    expect(lines).toEqual([`${SLUG}  running  build  $42.50/$100.00 (43%)`]);
  });

  it('skips a run whose manifest cannot be read with a one-line warning instead of aborting the list', async () => {
    seedManifest();
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, '{}');
    const broken = runPaths('broken-run', { home, workspaceRoot });
    mkdirSync(broken.runDir, { recursive: true });
    writeFileSync(broken.runJson, 'not json');
    const errs: string[] = [];
    const deps = makeDeps({
      readManifest: async (slug) => {
        if (slug === 'broken-run') throw new Error('Unexpected token n in JSON\nat line 1');
        return manifests.get(slug);
      },
    });
    await status({ deps, io: { out: (l) => void lines.push(l), err: (l) => void errs.push(l) } });
    expect(lines).toEqual([`${SLUG}  running  build  $42.50/$100.00 (43%)`]);
    expect(errs).toEqual(['warning: skipping broken-run: cannot read its RUN.json (Unexpected token n in JSON)']);
  });

  it('says so when there are no runs', async () => {
    await status({ deps: makeDeps(), io: io() });
    expect(lines).toEqual(['No runs found.']);
  });
});

describe('report and commander surface', () => {
  it('report calls deps.writeReport', async () => {
    const path = await report({ slug: SLUG, deps: makeDeps(), io: io() });
    expect(log).toEqual(['deps:writeReport']);
    expect(path).toBe(runPaths(SLUG, { home, workspaceRoot }).reportMd);
  });

  it('parses launch options through commander', async () => {
    mkdirSync(join(workspaceRoot, 'other', '.git'), { recursive: true });
    const program = buildProgram({ deps: makeDeps(), exec: makeExec(), fs, io: io() });
    await program.parseAsync(['launch', SLUG, '--budget', '12.5', '--repos', 'other', '--cost-multiplier', '3'], { from: 'user' });
    const m = manifests.get(SLUG)!;
    expect(m).toMatchObject({ budgetUsd: 12.5, costMultiplier: 3 });
    expect(m.repos.map((r) => r.name)).toEqual(['other']);
  });

  it('--soft-pct writes softPct into RUN.json, is marked testing-only in the help, and is range checked', async () => {
    const program = buildProgram({ deps: makeDeps(), exec: makeExec(), fs, io: io() });
    expect(program.commands.find((c) => c.name() === 'launch')!.helpInformation()).toMatch(/--soft-pct <fraction>\s+TESTING ONLY/);
    await program.parseAsync(['launch', SLUG, '--budget', '2', '--soft-pct', '0.3'], { from: 'user' });
    expect(manifests.get(SLUG)).toMatchObject({ budgetUsd: 2, softPct: 0.3 });
  });

  it('without --soft-pct the manifest keeps the contract default; out-of-range values are refused before anything runs', async () => {
    await launch({ slug: SLUG, budgetUsd: 1, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(manifests.get(SLUG)!.softPct).toBe(0.85);
    manifests.clear();
    for (const bad of ['0.05', '0.96', '1', 'abc', '-0.3']) {
      const program = buildProgram({ deps: makeDeps(), exec: makeExec(), fs, io: io() });
      await expect(program.parseAsync(['launch', SLUG, '--budget', '2', '--soft-pct', bad], { from: 'user' }), bad).rejects.toThrow(/--soft-pct must be/);
    }
    await expect(launch({ slug: SLUG, budgetUsd: 1, softPct: 2, deps: makeDeps(), exec: makeExec(), fs, io: io() })).rejects.toThrow(/Invalid soft threshold/);
    expect(manifests.size).toBe(0);
  });

  it('requires --budget and exposes all subcommands', async () => {
    const program = buildProgram({ deps: makeDeps() });
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['doctor', 'install', 'launch', 'profile', 'render', 'report', 'resume', 'status', 'stop', 'uninstall']);
    await expect(program.parseAsync(['launch', SLUG], { from: 'user' })).rejects.toThrow(/--budget/);
  });

  it('realCliDeps is wired: real entry path, no "not wired" stubs', async () => {
    const d = realCliDeps(home);
    expect(d.orchestratorEntry).toMatch(/bin\/nightgem-orchestrator\.mjs$/);
    expect(d.model).toBe(process.env.NIGHTGEM_MODEL ?? 'anthropic/claude-opus-5-5');
    await expect(d.readManifest('nope')).rejects.toThrow(/Profile not found/); // the workspace comes from the profile
    expect(await d.lockIsFree()).toBe(true);
  });
});


describe('launch: refuses a slug that already has a run (#9)', () => {
  const resumable = ['stopped', 'aborted-budget', 'failed', 'stalled'] as const;
  // a `failed` run that never started is retryable (see below), so the refused cases have started
  const attemptsFor = (state: string): void => void seedManifest({ state, startedAt: '2026-10-21T22:00:30.000Z' });

  for (const state of resumable) {
    it(`refuses a ${state} run and points to resume, without writing`, async () => {
      attemptsFor(state);
      const before = JSON.stringify(manifests.get(SLUG));
      const run = launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
      await expect(run).rejects.toThrow(new RegExp(`already exists \\(state: ${state}\\)`));
      await expect(run).rejects.toThrow(new RegExp(`resume ${SLUG} --budget <usd>`));
      expect(JSON.stringify(manifests.get(SLUG))).toBe(before);
      expect(log.filter((l) => l.startsWith('deps:write') || l.startsWith('deps:acquire') || l.includes('bootstrap'))).toEqual([]);
    });
  }

  it('refuses a completed run and suggests a new slug, not resume', async () => {
    attemptsFor('completed');
    const err = await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/already exists \(state: completed\).*new slug/);
    expect((err as Error).message).not.toMatch(/resume/);
    expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
  });

  for (const state of ['launching', 'running', 'winding-down', 'stopping'] as const) {
    it(`refuses a ${state} run and points to status and stop`, async () => {
      attemptsFor(state);
      const before = JSON.stringify(manifests.get(SLUG));
      const err = await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), fs, io: io(), parentEnv: {} }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(new RegExp(`already exists \\(state: ${state}\\).*still active.* status ${SLUG}.* stop ${SLUG}`));
      expect(JSON.stringify(manifests.get(SLUG))).toBe(before);
      expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
    });
  }

  it('lets launch retry a failed run that never started, and overwrites its manifest', async () => {
    seedManifest({ state: 'failed', stopReason: 'launch failed: boom', endedAt: NOW.toISOString(), knownSessionIds: [], costUsd: 0 });
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    const m = manifests.get(SLUG)!;
    expect(m).toMatchObject({ state: 'launching', budgetUsd: 50 });
    expect(m.stopReason).toBeUndefined();
    expect(log).toContain('deps:writeManifest launching');
  });

  const startedFailures: Array<[string, Record<string, unknown>]> = [
    ['startedAt', { startedAt: '2026-10-21T22:00:30.000Z' }],
    ['rootSessions', { rootSessions: [{ phase: 'plan', sessionId: 's1' }] }],
    ['attempts', { attempts: [{ n: 1, startedAt: '2026-10-21T22:00:30.000Z', budgetUsd: 5, costAtStartUsd: 0 }] }],
  ];
  for (const [what, over] of startedFailures) {
    it(`still refuses a failed run with ${what}, pointing at resume`, async () => {
      seedManifest({ state: 'failed', ...over });
      const before = JSON.stringify(manifests.get(SLUG));
      const err = await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(new RegExp(`already exists \\(state: failed\\).*resume ${SLUG} --budget <usd>`));
      expect(JSON.stringify(manifests.get(SLUG))).toBe(before);
      expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
    });
  }

  it('refuses a RUN.json on disk that the reader cannot parse, and leaves it untouched', async () => {
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, '{not json');
    const deps = makeDeps({ readManifest: async () => { throw new Error('corrupt'); } });
    await expect(launch({ slug: SLUG, budgetUsd: 50, deps, exec: makeExec(), fs, io: io(), parentEnv: {} })).rejects.toThrow(/already exists/);
    expect(readFileSync(p.runJson, 'utf8')).toBe('{not json');
    expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
  });

  it('still launches a fresh slug', async () => {
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(manifests.get(SLUG)!.state).toBe('launching');
  });
});

describe('launch: the launcher is the sole v2 RUN.json writer', () => {
  it('resolves the run context once and records skills, profile and instructions in RUN.json', async () => {
    let resolved = 0;
    const ctx = makeRunContext(workspaceRoot, {
      skills: {
        available: [{ name: 'tdd', root: '/Users/alice/skills', path: '/Users/alice/skills/tdd' }],
        excluded: [{ name: 'noisy', path: '/Users/alice/skills/noisy', reason: 'excluded by profile' }],
        missingRequired: [],
        collisions: [],
        roots: [],
        excludedRequired: [],
        rootRejected: [],
        outsideRoots: [],
      },
    });
    const withRequired: RunContextSnapshot = { ...ctx, profile: { ...ctx.profile, data: { ...ctx.profile.data, skills: { ...ctx.profile.data.skills, required: ['tdd'] } } } };
    const deps = makeDeps({
      resolveRunContext: async () => {
        resolved++;
        return withRequired;
      },
    });
    await launch({ slug: SLUG, budgetUsd: 5, deps, exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(resolved).toBe(1);
    const m = manifests.get(SLUG)!;
    expect(m.schemaVersion).toBe(2);
    expect(m.workspaceRoot).toBe(workspaceRoot);
    expect(m.skills).toEqual({ available: withRequired.skills.available, excluded: withRequired.skills.excluded, required: ['tdd'] });
    expect(m.instructions?.sha256).toBe(withRequired.instructions.sha256);
    expect(m.runDir).toBe(runPaths(SLUG, { home, workspaceRoot }).runDir);
    expect(m.launchdLabel).toBe(`dev.nightgem.${SLUG}`);
  });

  it('does not write the snapshot when the lock cannot be taken', async () => {
    const deps = makeDeps({ acquireLock: async () => { throw new Error('lock held'); } });
    await expect(launch({ slug: SLUG, budgetUsd: 5, deps, exec: makeExec(), fs, io: io() })).rejects.toThrow('lock held');
    expect(log).not.toContain('deps:writeRunContext');
  });
});

describe('status and report never write a v1 RUN.json (AD1)', () => {
  const V1 = 'demo';

  function realDeps(): CliDeps {
    const p = () => runPaths(V1, { home, workspaceRoot });
    return makeDeps({
      readManifest: async (slug) => (existsSync(runPaths(slug, { home, workspaceRoot }).runJson) ? readManifest(runPaths(slug, { home, workspaceRoot }).runJson) : undefined),
      writeManifest: async () => {
        throw new Error('status/report must not write RUN.json');
      },
      writeReport: async () => {
        await writeReport({ paths: p() });
        return p().reportMd;
      },
    });
  }

  function seedV1(): { file: string; before: Buffer } {
    const p = runPaths(V1, { home, workspaceRoot });
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'manifest-v1.json'), 'utf8')) as Record<string, unknown>;
    fixture['runDir'] = p.runDir;
    fixture['controlDir'] = p.controlDir;
    fixture['xdgDataHome'] = p.xdgDataHome;
    fixture['launchdLabel'] = `com.example.nightgem.${V1}`;
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, `${JSON.stringify(fixture, null, 4)}\n`);
    return { file: p.runJson, before: readFileSync(p.runJson) };
  }

  it('leaves a v1 RUN.json byte-identical after status (one run and the listing) and report', async () => {
    const { file, before } = seedV1();
    const deps = realDeps();
    await status({ slug: V1, deps, io: io() });
    expect(lines.join('\n')).toContain('completed');
    lines.length = 0;
    await status({ deps, io: io() });
    expect(lines.join('\n')).toContain(`${V1}  completed`);
    await report({ slug: V1, deps, io: io() });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).schemaVersion).toBe(1);
  });

  it('keeps the old launchd label of a v1 run for stop (no label rewriting)', async () => {
    seedV1();
    const r = await stop({ slug: V1, deps: realDeps(), exec: makeExec({ jobState: 'running' }), io: io() });
    // the fixture run is terminal: stop is a no-op and, again, writes nothing
    expect(r).toBe('already-terminal');
  });
});

describe('cliInvocation', () => {
  it('is the absolute node plus this checkout\'s bin, shell-quoted when needed', () => {
    expect(cliInvocation('/n/bin/node')).toMatch(/^\/n\/bin\/node \/.*\/bin\/nightgem\.mjs$/);
    expect(cliInvocation('/Users/alice/my node/bin/node').startsWith("'/Users/alice/my node/bin/node' ")).toBe(true);
  });
});

describe('doctor without a profile', () => {
  it('does not crash when the run context cannot be resolved; it still reports the other checks', async () => {
    const codes: number[] = [];
    const deps = makeDeps({
      resolveRunContext: async () => {
        throw new Error('Profile not found');
      },
    });
    const program = buildProgram({ deps, exec: makeExec(), fs, io: io(), onExit: (c) => void codes.push(c) });
    await program.parseAsync(['doctor'], { from: 'user' });
    expect(lines.join('\n')).toContain('opencode');
  });
});

describe('doctor with a profile that lists repos', () => {
  it('checks the toolchain of each listed repo (configured tools plus the defaults) on the job PATH', async () => {
    const base = makeRunContext(workspaceRoot);
    const ctx: RunContextSnapshot = { ...base, profile: { ...base.profile, data: { ...base.profile.data, repos: { 'acme-api': { tools: ['sometool'] }, 'acme-web': { tools: [] } } } } };
    const probe = { exists: (p: string) => !p.endsWith('/sometool'), readText: () => undefined };
    const program = buildProgram({ deps: makeDeps({ resolveRunContext: async () => ctx }), exec: makeExec(), fs: probe, io: io(), onExit: () => undefined });
    await program.parseAsync(['doctor'], { from: 'user' });
    const out = lines.join('\n');
    expect(out).toMatch(/warn {2}toolchain acme-api: not on the job PATH: sometool/);
    expect(out).toMatch(/ok {4}toolchain acme-web:/);
  });
});

describe('doctor output', () => {
  const LONG = `/Users/alice/work/${'a-long-directory/'.repeat(20)}end`;
  const preflight = async () => [
    { name: 'remote urls', ok: true, hard: true, detail: `${LONG} ${LONG}` },
    { name: 'skill name collisions', ok: false, hard: false, detail: `13 names ${LONG}` },
    { name: 'multi', ok: true, hard: false, detail: 'first line\n  - second line' },
  ];
  async function run(args: string[], over: Partial<CliDeps> = {}, exec: ExecFn = makeExec()) {
    const codes: number[] = [];
    const program = buildProgram({ deps: makeDeps({ preflight, ...over }), exec, fs: { exists: (p) => !p.endsWith('/nightgem') }, io: io(), env: { PATH: '/usr/bin' }, onExit: (c) => void codes.push(c) });
    await program.parseAsync(['doctor', ...args], { from: 'user' });
    lines = lines.join('\n').split('\n');
    return codes;
  }

  it('prints one line per check, each at most 200 characters, and soft findings exit 0', async () => {
    const codes = await run([]);
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200);
    expect(lines.some((l) => l.includes('multi: first line'))).toBe(true);
    expect(lines.join('\n')).not.toContain('second line');
    expect(lines.join('\n')).toContain('run `doctor --verbose`');
    expect(lines.some((l) => l.startsWith('warn  cli on PATH: nightgem is not on the PATH'))).toBe(true);
    expect(codes).toEqual([]);
  });

  it('--verbose prints the full detail', async () => {
    await run(['--verbose']);
    const out = lines.join('\n');
    expect(out).toContain(`${LONG} ${LONG}`);
    expect(out).toContain('first line\n  - second line');
    expect(lines.some((l) => l.length > 200)).toBe(true);
  });

  it('a hard failure still exits 1, with or without --verbose, and a long soft one does not', async () => {
    for (const args of [[], ['--verbose']]) {
      lines = [];
      expect(await run(args, {}, makeExec({ power: 'Battery Power' }))).toEqual([1]);
      expect(lines.some((l) => l.startsWith('FAIL  AC power'))).toBe(true);
    }
  });
});

describe('profile commands', () => {
  let profilePath: string;
  let exitCodes: number[];
  let errLines: string[];
  // built at runtime so this file itself carries no user-specific terms
  const BANNED = ['zz', 'secret', 'term'].join('');

  function program(env: Record<string, string | undefined>) {
    return buildProgram({
      deps: makeDeps(),
      exec: makeExec(),
      fs,
      io: { out: (l) => void lines.push(l), err: (l) => void errLines.push(l) },
      env,
      onExit: (c) => void exitCodes.push(c),
    });
  }

  beforeEach(() => {
    exitCodes = [];
    errLines = [];
    profilePath = join(home, 'my-profile.jsonc');
    writeFileSync(
      profilePath,
      `// comment\n{ "version": 1, "workspaceRoot": "~/workspace", "tracker": { "notes": "n" }, "audit": { "bannedTerms": ["${BANNED}"] } }\n`,
    );
  });

  it('path: NIGHTGEM_PROFILE wins, else the default location under HOME', async () => {
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'path'], { from: 'user' });
    await program({}).parseAsync(['profile', 'path'], { from: 'user' });
    expect(lines).toEqual([profilePath, join(home, '.config', 'nightgem', 'profile.jsonc')]);
  });

  it('show: ~ is expanded; banned terms are hidden without --json and printed with it', async () => {
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'show'], { from: 'user' });
    const text = lines.join('\n');
    expect(text).toContain(`"workspaceRoot": "${workspaceRoot}"`);
    expect(text).not.toContain(BANNED);
    lines.length = 0;
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'show', '--json'], { from: 'user' });
    const parsed = JSON.parse(lines.join('\n')) as { workspaceRoot: string; tracker: { notes: string }; audit: { bannedTerms: string[] } };
    expect(parsed.workspaceRoot).toBe(workspaceRoot);
    expect(parsed.tracker.notes).toBe('n');
    expect(parsed.audit.bannedTerms).toEqual([BANNED]);
    expect(errLines).toEqual([]);
    expect(lines.join('\n')).toContain(BANNED);
  });

  it('validate: OK exits clean; a bad profile prints the zod issues and exits 1', async () => {
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'validate'], { from: 'user' });
    expect(lines.join('\n')).toContain('Profile OK');
    expect(exitCodes).toEqual([]);
    writeFileSync(profilePath, '{ "version": 1, "workspaceRoot": "~/workspace", "bogus": true }');
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'validate'], { from: 'user' });
    expect(exitCodes).toEqual([1]);
    expect(errLines.join('\n')).toMatch(/bogus|Unrecognized/);
  });

  it('validate: AD11 reasons for a workspace root equal to HOME; missing profile exits 1', async () => {
    writeFileSync(profilePath, '{ "version": 1, "workspaceRoot": "~" }');
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['profile', 'validate'], { from: 'user' });
    expect(exitCodes).toEqual([1]);
    expect(errLines.length).toBeGreaterThan(1);
    errLines.length = 0;
    await program({ NIGHTGEM_PROFILE: join(home, 'nope.jsonc') }).parseAsync(['profile', 'validate'], { from: 'user' });
    expect(exitCodes).toEqual([1, 1]);
    expect(errLines.join('\n')).toContain('Profile not found');
  });
});

describe('doctor --audit-repo', () => {
  let repo: string;
  let exitCodes: number[];
  let errLines: string[];
  const BANNED = ['zz', 'secret', 'term'].join('');

  function program(env: Record<string, string | undefined>) {
    return buildProgram({
      deps: makeDeps(),
      exec: realExec,
      fs,
      io: { out: (l) => void lines.push(l), err: (l) => void errLines.push(l) },
      env,
      onExit: (c) => void exitCodes.push(c),
    });
  }

  beforeEach(() => {
    exitCodes = [];
    errLines = [];
    repo = join(home, 'audited');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const homePath = ['', 'Users', 'carol', 'notes.txt'].join('/');
    writeFileSync(join(repo, 'a.txt'), `line one\nsee ${homePath}\nmail ${['dev', 'corp.test'].join('@')} and ${['ABC', '123'].join('-')}\nclean ${BANNED}\n`);
    writeFileSync(join(repo, 'b.txt'), 'nothing to see\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
  });

  it('prints file:line:col kind match for the generic hits and exits 1', async () => {
    await program({ NIGHTGEM_PROFILE: join(home, 'none.jsonc') }).parseAsync(['doctor', '--audit-repo', '--dir', repo], { from: 'user' });
    const hits = lines.filter((l) => /^\S+:\d+:\d+ /.test(l));
    expect(hits.map((l) => l.split(' ')[1])).toEqual(['home-path', 'email', 'ticket-key']);
    expect(hits[0]).toMatch(/^a\.txt:2:5 home-path /);
    expect(exitCodes).toEqual([1]);
    expect(errLines.join('\n')).toContain('generic checks only');
    expect(lines.join('\n')).not.toContain(`${BANNED}`);
  });

  it('adds the profile bannedTerms when a profile exists', async () => {
    const profilePath = join(home, 'p.jsonc');
    writeFileSync(profilePath, `{ "version": 1, "workspaceRoot": "~/workspace", "audit": { "bannedTerms": ["${BANNED}"] } }`);
    await program({ NIGHTGEM_PROFILE: profilePath }).parseAsync(['doctor', '--audit-repo', '--dir', repo], { from: 'user' });
    expect(lines.some((l) => l.startsWith('a.txt:4:7 banned-term '))).toBe(true);
    expect(exitCodes).toEqual([1]);
  });

  it('exits clean on a repo without hits', async () => {
    const clean = join(home, 'clean');
    mkdirSync(clean);
    execFileSync('git', ['init', '-q'], { cwd: clean });
    writeFileSync(join(clean, 'x.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: clean });
    await program({ NIGHTGEM_PROFILE: join(home, 'none.jsonc') }).parseAsync(['doctor', '--audit-repo', '--dir', clean], { from: 'user' });
    expect(exitCodes).toEqual([]);
    expect(lines.at(-1)).toMatch(/^audit: 0 hit/);
  });
});

// AD3: an existing run is found through the paths its manifest recorded, never through a path rebuilt from the slug.
describe('name-agnostic run lookup (AD3)', () => {
  const heartbeatTs = (): number => NOW.getTime() - 5 * 60_000;
  const otherRoot = (): string => join(home, 'Library', 'Application Support', 'other-tool', SLUG);

  function foreignManifest(version: 1 | 2, controlDir: string): RunManifest {
    const p = runPaths(SLUG, { home, workspaceRoot });
    const base = {
      schemaVersion: version,
      slug: SLUG,
      budgetUsd: 100,
      state: 'running',
      phase: 'build',
      launchdLabel: `com.other.tool.${SLUG}`,
      serverUrl: 'http://127.0.0.1:54321',
      controlDir,
      runDir: p.runDir,
      xdgDataHome: join(controlDir, 'xdg-data'),
      model: 'anthropic/claude-opus-5-5',
      createdAt: NOW.toISOString(),
      ...(version === 2 ? { workspaceRoot } : {}),
    };
    const m = parseRunManifest(base);
    manifests.set(SLUG, m);
    return m;
  }

  it.each([1, 2] as const)('status reads the heartbeat from a v%i manifest\'s controlDir under another root', async (version) => {
    const dir = otherRoot();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeControlFlags(dir, { heartbeatTs: heartbeatTs() });
    foreignManifest(version, dir);
    // the slug-derived path holds nothing: a rebuilt path would print "never"
    const real = realCliDeps(home, { env: {} });
    await status({ slug: SLUG, deps: makeDeps({ readControlFlags: real.readControlFlags }), io: io() });
    expect(lines.join('\n')).toMatch(/Heartbeat:\s+5m ago/);
    expect(lines.join('\n')).toContain(`cat ${join(dir, 'server.pw')}`);
  });

  it('stop signals the recorded launchd label, not one rebuilt from the slug', async () => {
    foreignManifest(2, otherRoot());
    const r = await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() });
    expect(r).toBe('signalled');
    expect(log).toContain(`exec:launchctl kill SIGTERM gui/501/com.other.tool.${SLUG}`);
  });

  it('refuses a manifest whose slug is not the requested one in status and stop', async () => {
    const m = foreignManifest(2, otherRoot());
    manifests.set(SLUG, { ...m, slug: 'other-run' });
    await expect(status({ slug: SLUG, deps: makeDeps(), io: io() })).rejects.toThrow(/records the slug "other-run"/);
    await expect(stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() })).rejects.toThrow(/records the slug/);
    expect(log.some((l) => l.startsWith('exec:launchctl'))).toBe(false);
  });

  it.each([
    ['dot-dot slash', `../../evil.${SLUG}`],
    ['slash', `a/b.${SLUG}`],
    ['space', `a b.${SLUG}`],
    ['semicolon', `a;touch x.${SLUG}`],
    ['command substitution', `$(id).${SLUG}`],
    ['backtick', `\`id\`.${SLUG}`],
    ['no slug suffix', 'com.other.tool.another-run'],
  ])('stop refuses a %s launchd label without calling launchctl', async (_n, label) => {
    const m = foreignManifest(2, otherRoot());
    manifests.set(SLUG, { ...m, launchdLabel: label });
    await expect(stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() })).rejects.toThrow(/launchd label/);
    expect(log.some((l) => l.startsWith('exec:launchctl'))).toBe(false);
  });

  it.each([
    ['relative', `relative/${SLUG}`, /not an absolute path/],
    ['mismatched', '/Users/alice/Library/Application Support/other-tool/not-this-run', new RegExp(`does not end in /${SLUG}`)],
    ['traversal', `/Users/alice/x/../${SLUG}`, /not an absolute path/],
  ])('refuses a %s controlDir in status and stop', async (_n, dir, msg) => {
    foreignManifest(2, dir);
    await expect(status({ slug: SLUG, deps: makeDeps(), io: io() })).rejects.toThrow(msg);
    await expect(stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() })).rejects.toThrow(msg);
    expect(log.some((l) => l.startsWith('exec:launchctl kill'))).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// #9 resume: stop on a crashed run, status with attempts, the stale control dir, --budget parsing
// ---------------------------------------------------------------------------

const DEAD_PID = 99_999_999;

function writeLockFile(pid: number, slug = SLUG): string {
  const lockPath = defaultLockPath(home);
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ pid, token: 'tok', ts: NOW.toISOString(), slug })}\n`);
  return lockPath;
}

/** Deps with the REAL lock (state.ts) under the temp HOME. */
function realLockDeps(over: Partial<CliDeps> = {}): CliDeps {
  const real = realCliDeps(home);
  return makeDeps({ acquireLock: (s) => real.acquireLock(s), releaseLock: (s) => real.releaseLock(s), lockHolder: () => real.lockHolder(), lockIsFree: () => real.lockIsFree(), ...over });
}

describe('stop on a run whose job is not running (crash -> stop -> resume)', () => {
  const openAttempt = { n: 1, startedAt: '2026-10-21T21:00:00.000Z', budgetUsd: 100, costAtStartUsd: 0, costUsd: 37.25 };

  it('closes the open attempt, marks the run stopped-after-crash and keeps the recorded attempt cost', async () => {
    seedManifest({ attempts: [openAttempt] });
    const r = await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    expect(r).toBe('stopped');
    const m = manifests.get(SLUG)!;
    expect(m).toMatchObject({ state: 'stopped', endedAt: NOW.toISOString(), stopReason: 'stopped-after-crash', costUsd: 42.5 });
    expect(m.attempts).toEqual([{ ...openAttempt, endedAt: NOW.toISOString(), state: 'stopped', stopReason: 'stopped-after-crash', costUsd: 37.25 }]);
    expect(log.filter((l) => l === 'deps:writeManifest stopped')).toHaveLength(1);
    expect(log).toContain('deps:writeReport');
  });

  it('writes out the implicit attempt of a manifest without attempts, closed', async () => {
    seedManifest();
    await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    const m = manifests.get(SLUG)!;
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts![0]).toMatchObject({ n: 1, state: 'stopped', stopReason: 'stopped-after-crash', endedAt: NOW.toISOString(), costUsd: 42.5 });
  });

  it('never lowers a recorded cost: an attempt cost above what is cumulative stays', async () => {
    seedManifest({ costUsd: 10, attempts: [{ ...openAttempt, costUsd: 12 }] });
    await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    expect(manifests.get(SLUG)!.attempts![0]!.costUsd).toBe(12);
  });

  it('fills a missing attempt cost from what the run spent since the attempt began', async () => {
    seedManifest({ costUsd: 42.5, attempts: [{ n: 1, startedAt: openAttempt.startedAt, budgetUsd: 100, costAtStartUsd: 0, endedAt: '2026-10-21T21:30:00.000Z', state: 'stopped' }, { n: 2, startedAt: '2026-10-21T21:40:00.000Z', budgetUsd: 5, costAtStartUsd: 30 }] });
    await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    const attempts = manifests.get(SLUG)!.attempts!;
    expect(attempts[0]!.endedAt).toBe('2026-10-21T21:30:00.000Z'); // the closed one is untouched
    expect(attempts[1]).toMatchObject({ n: 2, state: 'stopped', costUsd: 12.5 });
  });

  it('boots out a loaded job that is not running', async () => {
    seedManifest({ attempts: [openAttempt] });
    await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'loaded' }), io: io() });
    expect(log).toContain(`exec:launchctl bootout gui/501/com.example.nightgem.${SLUG}`);
    expect(log.some((l) => l.startsWith('exec:launchctl kill'))).toBe(false);
  });

  it('does not touch launchd bootout when no job is loaded', async () => {
    seedManifest({ attempts: [openAttempt] });
    await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    expect(log.some((l) => l.includes('bootout'))).toBe(false);
  });

  it('releases a lock held by a dead pid', async () => {
    seedManifest({ attempts: [openAttempt] });
    const lockPath = writeLockFile(DEAD_PID);
    await stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
    expect(existsSync(lockPath)).toBe(false);
  });

  describe('a live lock holder (R2)', () => {
    const live = (over: Record<string, unknown> = {}): string => {
      const lockPath = defaultLockPath(home);
      mkdirSync(join(lockPath, '..'), { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.ppid, token: 'tok', ts: NOW.toISOString(), slug: SLUG, ...over })}\n`);
      return lockPath;
    };

    it('a live holder for this slug means a launch or resume is in progress: refuse, write nothing', async () => {
      const before = seedManifest({ attempts: [openAttempt] });
      const lockPath = live();
      await expect(stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'absent' }), io: io() })).rejects.toThrow(/launch or resume of "demo-run" is in progress.*Wait a few seconds/s);
      expect(manifests.get(SLUG)).toEqual(before);
      expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('a live holder at manifest.pid (an old lock with no slug) means the same', async () => {
      seedManifest({ attempts: [openAttempt], pid: process.ppid });
      live({ slug: undefined });
      await expect(stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'absent' }), io: io() })).rejects.toThrow(/in progress/);
      expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
    });

    it('it also protects the repair of a stopped run whose attempt is open', async () => {
      seedManifest({ state: 'stopped', endedAt: '2026-10-21T21:50:00.000Z', attempts: [openAttempt] });
      live();
      await expect(stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec(), io: io() })).rejects.toThrow(/in progress/);
      expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
    });

    it('a live holder for another run does not block, and its lock is left alone', async () => {
      seedManifest({ attempts: [openAttempt] });
      const lockPath = live({ slug: 'other-run' });
      await stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
      expect(manifests.get(SLUG)!.state).toBe('stopped');
      expect(existsSync(lockPath)).toBe(true);
    });

    it('a dead holder for this slug does not block and is released', async () => {
      seedManifest({ attempts: [openAttempt], pid: DEAD_PID });
      const lockPath = live({ pid: DEAD_PID });
      await stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'absent' }), io: io() });
      expect(manifests.get(SLUG)!.state).toBe('stopped');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('a running job is still SIGTERMed even though the orchestrator holds the lock for this slug', async () => {
      seedManifest({ attempts: [openAttempt] });
      live();
      expect(await stop({ slug: SLUG, deps: realLockDeps(), exec: makeExec({ jobState: 'running' }), io: io() })).toBe('signalled');
    });
  });

  it.each([
    ['launchctl missing', { stdout: '', stderr: 'spawn launchctl ENOENT', exitCode: 127 }],
    ['a permission error', { stdout: '', stderr: 'Operation not permitted', exitCode: 1 }],
  ])('refuses to mark the run stopped when launchctl print fails with %s (unknown, not "not loaded")', async (_n, failure) => {
    const before = seedManifest({ attempts: [openAttempt] });
    const exec: ExecFn = async (cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? failure : makeExec()(cmd, args));
    await expect(stop({ slug: SLUG, deps: makeDeps(), exec, io: io() })).rejects.toThrow(/Cannot tell whether the launchd job .* is running/);
    expect(manifests.get(SLUG)).toEqual(before);
    expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
  });

  it.each([
    ['exit 113', { stdout: '', stderr: '', exitCode: 113 }],
    ['the "could not find service" wording', { stdout: '', stderr: 'Could not find service "x" in domain for user gui: 501', exitCode: 1 }],
  ])('treats %s as not loaded', async (_n, failure) => {
    seedManifest({ attempts: [openAttempt] });
    const exec: ExecFn = async (cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? failure : makeExec()(cmd, args));
    expect(await stop({ slug: SLUG, deps: makeDeps(), exec, io: io() })).toBe('stopped');
  });

  it('a failing report does not undo the stop', async () => {
    seedManifest({ attempts: [openAttempt] });
    const errs: string[] = [];
    const deps = makeDeps({ writeReport: async () => { throw new Error('report boom'); } });
    await stop({ slug: SLUG, deps, exec: makeExec({ jobState: 'absent' }), io: { out: (l) => void lines.push(l), err: (l) => void errs.push(l) } });
    expect(manifests.get(SLUG)!.state).toBe('stopped');
    expect(errs.join('\n')).toContain('report boom');
  });

  it('a stopped run whose attempt is still open (older stop) gets that attempt closed, so it can be resumed', async () => {
    seedManifest({ state: 'stopped', endedAt: '2026-10-21T21:50:00.000Z', stopReason: 'stopped by user (launchd job was not running)', attempts: [openAttempt] });
    const r = await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec(), io: io() });
    expect(r).toBe('stopped');
    expect(manifests.get(SLUG)!.attempts![0]).toMatchObject({ endedAt: '2026-10-21T21:50:00.000Z', state: 'stopped' });
    expect(manifests.get(SLUG)!.stopReason).toMatch(/older|launchd job was not running/);
  });

  it('a completed run is left alone, even with no endedAt', async () => {
    seedManifest({ state: 'completed' });
    expect(await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec(), io: io() })).toBe('already-terminal');
    expect(log).not.toContain('deps:writeManifest completed');
  });

  it('a failed launch that never started is left alone (the slug stays retryable)', async () => {
    seedManifest({ state: 'failed', stopReason: 'launch failed: x' });
    expect(await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec(), io: io() })).toBe('already-terminal');
    expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
  });

  it('still SIGTERMs a running job and writes nothing', async () => {
    seedManifest({ attempts: [openAttempt] });
    expect(await stop({ slug: SLUG, deps: makeDeps(), exec: makeExec({ jobState: 'running' }), io: io() })).toBe('signalled');
    expect(log.filter((l) => l.startsWith('deps:write'))).toEqual([]);
  });
});

describe('status with attempts', () => {
  it('a single attempt prints exactly the old Cost line and no Attempt line', async () => {
    seedManifest({ attempts: [{ n: 1, startedAt: '2026-10-21T21:00:00.000Z', budgetUsd: 100, costAtStartUsd: 0, costUsd: 42.5 }] });
    await status({ slug: SLUG, deps: makeDeps(), io: io() });
    const out = lines.join('\n');
    expect(out).toContain('Cost:       $42.50 / $100.00 (42.5%)\n');
    expect(out).not.toContain('Attempt:');
    expect(out).not.toContain('run total');
  });

  it('after a resume shows the attempt, its budget, attempt spend over that budget and the cumulative cost beside it', async () => {
    seedManifest({
      budgetUsd: 5,
      costUsd: 44.5,
      attempts: [
        { n: 1, startedAt: '2026-10-21T21:00:00.000Z', endedAt: '2026-10-21T21:50:00.000Z', state: 'aborted-budget', budgetUsd: 40, costAtStartUsd: 0, costUsd: 40.5 },
        { n: 2, startedAt: '2026-10-21T22:00:00.000Z', budgetUsd: 5, costAtStartUsd: 40.5, costUsd: 4 },
      ],
    });
    await status({ slug: SLUG, deps: makeDeps(), io: io() });
    const out = lines.join('\n');
    expect(out).toMatch(/^Attempt:    2 \(budget \$5\.00\)$/m);
    expect(out).toContain('Cost:       $4.00 / $5.00 (80.0%)  run total $44.50');
  });

  it('after a rolled-back resume shows the last attempt that really ran as current, and says a later one failed to start', async () => {
    seedManifest({
      state: 'stopped',
      budgetUsd: 40,
      costUsd: 44.5,
      attempts: [
        { n: 1, startedAt: '2026-10-21T21:00:00.000Z', endedAt: '2026-10-21T21:50:00.000Z', state: 'stopped', budgetUsd: 40, costAtStartUsd: 0, costUsd: 30 },
        { n: 2, startedAt: '2026-10-21T22:00:00.000Z', endedAt: '2026-10-21T22:10:00.000Z', state: 'stopped', budgetUsd: 40, costAtStartUsd: 30, costUsd: 14.5 },
        { n: 3, startedAt: '2026-10-21T22:20:00.000Z', endedAt: '2026-10-21T22:20:05.000Z', state: 'failed', stopReason: 'resume-failed', budgetUsd: 7, costAtStartUsd: 44.5, costUsd: 0 },
      ],
    });
    await status({ slug: SLUG, deps: makeDeps(), io: io() });
    const out = lines.join('\n');
    expect(out).toMatch(/^Attempt:    2 \(budget \$40\.00; 1 later attempt failed to start\)$/m);
    expect(out).toContain('Cost:       $14.50 / $40.00 (36.3%)  run total $44.50');
  });

  it('falls back to the spend since the attempt began when no attempt cost is recorded yet', async () => {
    seedManifest({
      budgetUsd: 10,
      costUsd: 45,
      attempts: [
        { n: 1, startedAt: '2026-10-21T21:00:00.000Z', endedAt: '2026-10-21T21:50:00.000Z', state: 'stopped', budgetUsd: 40, costAtStartUsd: 0, costUsd: 40 },
        { n: 2, startedAt: '2026-10-21T22:00:00.000Z', budgetUsd: 10, costAtStartUsd: 40 },
      ],
    });
    await status({ slug: SLUG, deps: makeDeps(), io: io() });
    expect(lines.join('\n')).toContain('Cost:       $5.00 / $10.00 (50.0%)  run total $45.00');
  });

  it('the listing keeps one line for a single attempt and adds the attempt for several', async () => {
    seedManifest();
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(p.runJson, '{}');
    await status({ deps: makeDeps(), io: io() });
    expect(lines).toEqual([`${SLUG}  running  build  $42.50/$100.00 (43%)`]);
    lines.length = 0;
    seedManifest({
      budgetUsd: 5,
      costUsd: 44.5,
      attempts: [
        { n: 1, startedAt: '2026-10-21T21:00:00.000Z', endedAt: '2026-10-21T21:50:00.000Z', state: 'stopped', budgetUsd: 40, costAtStartUsd: 0, costUsd: 40.5 },
        { n: 2, startedAt: '2026-10-21T22:00:00.000Z', budgetUsd: 5, costAtStartUsd: 40.5, costUsd: 4 },
      ],
    });
    await status({ deps: makeDeps(), io: io() });
    expect(lines).toEqual([`${SLUG}  running  build  $4.00/$5.00 (80%)  attempt 2, run total $44.50`]);
  });
});

describe('launch on a slug whose control dir is left over from an earlier run (#9)', () => {
  it('clears the stop flags (and only those) before the job starts', async () => {
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.controlDir, { recursive: true, mode: 0o700 });
    writeControlFlags(p.controlDir, { hardStop: true, softStop: true, heartbeatTs: 123 });
    writeFileSync(join(p.controlDir, 'leftover.txt'), 'x');
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(readControlFlags(p.controlDir)).toEqual({ hardStop: false, softStop: false, heartbeatTs: 123 });
    expect(existsSync(join(p.controlDir, 'leftover.txt'))).toBe(true);
  });

  it('a fresh slug with no control.json gets none written', async () => {
    const p = runPaths(SLUG, { home, workspaceRoot });
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(existsSync(join(p.controlDir, 'control.json'))).toBe(false);
  });

  it('retrying a never-started failed slug launches with clear flags', async () => {
    seedManifest({ state: 'failed', stopReason: 'launch failed: x' });
    const p = runPaths(SLUG, { home, workspaceRoot });
    mkdirSync(p.controlDir, { recursive: true, mode: 0o700 });
    writeControlFlags(p.controlDir, { hardStop: true });
    await launch({ slug: SLUG, budgetUsd: 50, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {} });
    expect(readControlFlags(p.controlDir).hardStop).toBe(false);
    expect(manifests.get(SLUG)!.state).toBe('launching');
  });

  it('a failing reset releases the lock and writes no manifest', async () => {
    const deps = makeDeps({ resetStopFlags: () => { throw new Error('flags boom'); } });
    await expect(launch({ slug: SLUG, budgetUsd: 50, deps, exec: makeExec(), fs, io: io(), parentEnv: {} })).rejects.toThrow('flags boom');
    expect(manifests.size).toBe(0);
    expect(log).toContain('deps:release');
  });
});

describe('resume --budget through commander', () => {
  const parse = async (args: string[]): Promise<void> => {
    const program = buildProgram({ deps: makeDeps(), exec: makeExec(), fs, io: io() });
    await program.parseAsync(['resume', ...args], { from: 'user' });
  };

  it.each([
    ['zero', ['x-run', '--budget', '0']],
    ['negative', ['x-run', '--budget', '-3']],
    ['NaN', ['x-run', '--budget', 'abc']],
    ['Infinity', ['x-run', '--budget', 'Infinity']],
    ['empty', ['x-run', '--budget', '']],
  ])('refuses a %s budget before reading or writing anything', async (_n, args) => {
    seedManifest({ state: 'stopped' });
    await expect(parse(args)).rejects.toThrow(/--budget must be a positive number/);
    expect(log).toEqual([]);
  });

  it('requires --budget (there is no default)', async () => {
    seedManifest({ state: 'stopped' });
    await expect(parse([SLUG])).rejects.toThrow(/--budget/);
    expect(log).toEqual([]);
  });

  it('is listed in the help with the budget flag', () => {
    const help = buildProgram({ deps: makeDeps() }).commands.find((c) => c.name() === 'resume')!.helpInformation();
    expect(help).toMatch(/--budget <usd>/);
    expect(help).toMatch(/required/);
  });

  it('refuses a missing run with a clear message', async () => {
    await expect(parse(['nope-run', '--budget', '5'])).rejects.toThrow(/No run found for "nope-run"/);
  });
});
