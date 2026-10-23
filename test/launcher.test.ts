import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliDeps, ExecFn, ExecResult } from '../src/cli-deps.ts';
import { attemptsOf, RunManifest, type RunContextSnapshot } from '../src/contracts.ts';
import { resume, runLaunchGates } from '../src/launcher.ts';
import { integrationWorktree, runPaths, taskWorktree } from '../src/paths.ts';
import { realRenderers } from '../src/render.ts';
import { defaultLockPath, readControlFlags, writeControlFlags } from '../src/state.ts';
import { realCliDeps, writeRunContext } from '../src/wiring.ts';
import { makeRunContext } from './fixtures/run-context.ts';

const SLUG = 'demo-run';
const NOW = new Date('2026-10-21T22:00:00Z');

let home: string;
let workspaceRoot: string;
let calls: string[];
let lines: string[];

function makeExec(env: { power?: string; jobState?: 'loaded' | 'absent' } = {}): ExecFn {
  return async (cmd, args): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
    if (key === 'opencode --version') return ok('opencode v2.0.29\n');
    if (key === 'pmset -g batt') return ok(`Now drawing from '${env.power ?? 'AC Power'}'\n`);
    if (cmd === 'df') return ok('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/x 1 1 99999999 1% 1 1 0% /\n');
    if (cmd === '/bin/sh') return ok(`/opt/homebrew/bin/${args[1]?.replace('command -v ', '')}\n`);
    if (cmd === 'launchctl' && args[0] === 'print') {
      return env.jobState === 'loaded' ? ok('state = not running\n') : { stdout: '', stderr: 'not found', exitCode: 113 };
    }
    return { stdout: '', stderr: `unexpected: ${key}`, exitCode: 1 };
  };
}

function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  const forbidden = (name: string) => async (): Promise<never> => {
    throw new Error(`the gates must not call ${name}`);
  };
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
    readManifest: async () => undefined,
    writeManifest: forbidden('writeManifest'),
    writeRunContext: forbidden('writeRunContext'),
    readControlFlags: async () => ({ softStop: false, hardStop: false, heartbeatTs: 0 }),
    acquireLock: forbidden('acquireLock'),
    releaseLock: forbidden('releaseLock'),
    lockIsFree: async () => true,
    buildBaseline: forbidden('buildBaseline'),
    writeReport: forbidden('writeReport'),
    ...over,
  };
}

const io = () => ({ out: (l: string) => void lines.push(l) });
const fs = { exists: () => true };

function gates(over: Partial<Parameters<typeof runLaunchGates>[0]> = {}) {
  return runLaunchGates({ slug: SLUG, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {}, ...over });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-gates-'));
  workspaceRoot = join(home, 'workspace');
  calls = [];
  lines = [];
  mkdirSync(join(workspaceRoot, 'acme-api', '.git'), { recursive: true });
  const specs = runPaths(SLUG, { home, workspaceRoot }).specsDir;
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, 'SPEC.md'), '# Spec: demo JIRA-9\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-api` | x |\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('runLaunchGates', () => {
  it('returns the context, spec, label, paths and resolved binaries, and creates nothing', async () => {
    const g = await gates();
    expect(g.runContext).toEqual(makeRunContext(workspaceRoot));
    expect(g.spec.repos.map((r) => r.name)).toEqual(['acme-api']);
    expect(g.label).toBe(`dev.nightgem.${SLUG}`);
    expect(g.paths).toEqual(runPaths(SLUG, { home, workspaceRoot }));
    expect(g.opencodePath).toBe('/opt/homebrew/bin/opencode');
    expect(g.gitPath).toBe('/opt/homebrew/bin/git');
    expect(g.warnings).toEqual([]);
    // no control dir, run dir, baseline, lock or manifest (the forbidden deps would have thrown)
    expect(calls.filter((c) => c.startsWith('launchctl') && !c.startsWith('launchctl print'))).toEqual([]);
  });

  it('honours the repos override', async () => {
    mkdirSync(join(workspaceRoot, 'other', '.git'), { recursive: true });
    const g = await gates({ repos: ['other'] });
    expect(g.spec.repos.map((r) => r.name)).toEqual(['other']);
  });

  it('reuses a given run context instead of resolving one', async () => {
    const ctx = makeRunContext(workspaceRoot);
    const g = await gates({
      deps: makeDeps({
        resolveRunContext: async () => {
          throw new Error('must not resolve');
        },
      }),
      runContext: ctx,
    });
    expect(g.runContext).toEqual(ctx);
  });

  it('prints the doctor warnings and returns them', async () => {
    const only = { exists: (p: string) => !p.endsWith('/npm'), readText: (p: string) => (p.endsWith('/package.json') ? '{"scripts":{"test":"x"}}' : undefined) };
    const g = await gates({ fs: only });
    expect(g.warnings.some((l) => /^warning: toolchain acme-api: .*npm/.test(l))).toBe(true);
    expect(lines).toEqual(g.warnings);
  });

  it('rejects an invalid slug before any exec', async () => {
    await expect(gates({ slug: 'Bad Slug' })).rejects.toThrow(/Invalid slug "Bad Slug" \(expected kebab-case/);
    expect(calls).toEqual([]);
  });

  it('rejects a run context that is not a valid snapshot', async () => {
    const base = makeRunContext(workspaceRoot);
    const stub: RunContextSnapshot = { ...base, profile: { path: '', sha256: '', data: base.profile.data } };
    await expect(gates({ deps: makeDeps({ resolveRunContext: async () => stub }) })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects an unapproved spec', async () => {
    writeFileSync(runPaths(SLUG, { home, workspaceRoot }).specMd, '# t\n\nStatus: DRAFT\n');
    await expect(gates()).rejects.toThrow(/not approved/);
    expect(calls).toEqual([]);
  });

  it('runs afterLoad after the spec loads and before the doctor, and its error wins', async () => {
    const seen: string[] = [];
    await expect(
      gates({
        afterLoad: ({ spec, paths }) => {
          seen.push(`${spec.repos.length}:${paths.runJson}`, `exec calls so far: ${calls.length}`);
          throw new Error('caller refusal');
        },
      }),
    ).rejects.toThrow('caller refusal');
    expect(seen).toEqual([`1:${runPaths(SLUG, { home, workspaceRoot }).runJson}`, 'exec calls so far: 0']);
    // an afterLoad refusal also beats a doctor failure
    await expect(
      gates({
        exec: makeExec({ power: 'Battery Power' }),
        afterLoad: () => {
          throw new Error('caller refusal');
        },
      }),
    ).rejects.toThrow('caller refusal');
  });

  it('aborts on a doctor hard failure (AC power)', async () => {
    await expect(gates({ exec: makeExec({ power: 'Battery Power' }) })).rejects.toThrow(/doctor reported hard failures, not launching:[\s\S]*AC power/);
  });

  it('aborts when the lock is held', async () => {
    await expect(gates({ deps: makeDeps({ lockIsFree: async () => false }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*lock[\s\S]*another run holds the lock/);
  });

  it('aborts on a hard preflight finding such as a credentialed remote URL', async () => {
    const preflight = async () => [{ name: 'remote urls', ok: false, hard: true, detail: 'acme-api: origin embeds credentials' }];
    await expect(gates({ deps: makeDeps({ preflight }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*remote urls[\s\S]*embeds credentials/);
  });

  it('aborts when the preflight itself throws', async () => {
    const preflight = async () => {
      throw new Error('rule check exploded');
    };
    await expect(gates({ deps: makeDeps({ preflight }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*preflight[\s\S]*rule check exploded/);
  });

  it('aborts when the launchd job is already loaded', async () => {
    await expect(gates({ exec: makeExec({ jobState: 'loaded' }) })).rejects.toThrow(/launchd job dev\.nightgem\.demo-run is already loaded\. Run ".* stop demo-run" first\./);
  });
});


// ---------------------------------------------------------------------------
// resume (#9)
// ---------------------------------------------------------------------------

describe('resume', () => {
  const PREV_END = '2026-10-21T21:50:00.000Z';
  const DEAD_PID = 99_999_999;
  type JobMode = 'absent' | 'running' | 'loaded' | 'sticky';

  let manifest: RunManifest | undefined;
  let writes: RunManifest[];
  let events: string[];
  let job: JobMode;
  let bootstrapExit: number;
  let unloaded: boolean;
  let power: string;

  const p = () => runPaths(SLUG, { home, workspaceRoot });
  const lockPath = () => defaultLockPath(home);
  const repoPath = () => join(workspaceRoot, 'acme-api');

  function seed(over: Record<string, unknown> = {}): RunManifest {
    const paths = p();
    manifest = RunManifest.parse({
      schemaVersion: 2,
      workspaceRoot,
      slug: SLUG,
      budgetUsd: 40,
      state: 'aborted-budget',
      phase: 'build',
      launchdLabel: `dev.nightgem.${SLUG}`,
      controlDir: paths.controlDir,
      runDir: paths.runDir,
      xdgDataHome: paths.xdgDataHome,
      model: 'anthropic/claude-opus-5-5',
      createdAt: '2026-10-21T21:00:00.000Z',
      startedAt: '2026-10-21T21:00:10.000Z',
      endedAt: PREV_END,
      stopReason: 'budget-hard',
      costUsd: 42.5,
      serverUrl: 'http://127.0.0.1:54321',
      port: 54321,
      repos: [{ name: 'acme-api', path: repoPath(), defaultBranch: 'main', baseline: { head: 'old', branch: 'main', porcelainHash: 'old', stashCount: 0 } }],
      ...over,
    });
    mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    writeRunContext(paths.controlDir, makeRunContext(workspaceRoot));
    return manifest;
  }

  function makeWorktree(path: string, branch: string): void {
    mkdirSync(path, { recursive: true });
    const gitdir = `${path}.gitdir`;
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    writeFileSync(join(path, '.git'), `gitdir: ${gitdir}\n`);
  }

  function writeTasks(lines: object[]): void {
    mkdirSync(p().runDir, { recursive: true });
    writeFileSync(p().tasksJsonl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const ev = (id: string, state: string, over: Record<string, unknown> = {}) => ({
    ts: '2026-10-21T21:10:00.000Z',
    id,
    repo: 'acme-api',
    branch: `feat/${id}`,
    worktree: /^[a-z0-9-]+$/.test(id) ? taskWorktree(repoPath(), SLUG, id) : '-',
    state,
    phase: 'build',
    ...over,
  });

  function rexec(): ExecFn {
    return async (cmd, args): Promise<ExecResult> => {
      const key = `${cmd} ${args.join(' ')}`;
      const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
      if (key === 'opencode --version') return ok('opencode v2.0.29\n');
      if (key === 'pmset -g batt') return ok(`Now drawing from '${power}'\n`);
      if (cmd === 'df') return ok('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/x 1 1 99999999 1% 1 1 0% /\n');
      if (cmd === '/bin/sh') return ok(`/opt/homebrew/bin/${args[1]?.replace('command -v ', '')}\n`);
      if (cmd === 'launchctl' && args[0] === 'print') {
        events.push('print');
        if (job === 'absent' || (unloaded && job !== 'sticky')) return { stdout: '', stderr: 'not found', exitCode: 113 };
        return ok(job === 'running' ? 'state = running\n' : 'state = not running\n');
      }
      if (cmd === 'launchctl' && args[0] === 'bootout') {
        events.push(`bootout ${args[1]}`);
        unloaded = true;
        return ok();
      }
      if (cmd === 'launchctl' && args[0] === 'bootstrap') {
        events.push(`bootstrap ${args[1]}`);
        return { stdout: '', stderr: bootstrapExit ? 'Bootstrap failed: 5' : '', exitCode: bootstrapExit };
      }
      return { stdout: '', stderr: `unexpected: ${key}`, exitCode: 1 };
    };
  }

  function rdeps(over: Partial<CliDeps> = {}): CliDeps {
    const real = realCliDeps(home);
    return makeDeps({
      readManifest: async () => manifest,
      writeManifest: async (_s, m) => {
        events.push(`write:${m.state}`);
        writes.push(m);
        manifest = m;
      },
      resolveRunContext: async () => {
        throw new Error('resume must reuse the frozen run context, not resolve a new one');
      },
      readRunContext: (dir) => real.readRunContext!(dir),
      resetStopFlags: async (dir) => {
        events.push('resetStopFlags');
        await real.resetStopFlags!(dir);
      },
      acquireLock: async (slug) => {
        events.push('acquireLock');
        return real.acquireLock(slug);
      },
      releaseLock: (slug) => real.releaseLock(slug),
      lockIsFree: () => real.lockIsFree(),
      buildBaseline: async (paths) => {
        events.push('buildBaseline');
        return paths.map((path) => ({ name: path.split('/').pop()!, path, defaultBranch: 'main', baseline: { head: 'new', branch: 'main', porcelainHash: 'new', stashCount: 0 } }));
      },
      ...over,
    });
  }

  const go = (over: Partial<Parameters<typeof resume>[0]> = {}) =>
    resume({ slug: SLUG, budgetUsd: 7, deps: rdeps(), exec: rexec(), fs, io: io(), parentEnv: {}, sleep: async () => {}, bootoutWaitMs: 1500, ...over });

  /** Nothing was written, started or locked. */
  function expectUntouched(before: RunManifest): void {
    expect(writes).toEqual([]);
    expect(manifest).toEqual(before);
    expect(events.filter((e) => /^(bootstrap|bootout|resetStopFlags|buildBaseline|acquireLock)/.test(e))).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  }

  const openAttempts = (m: RunManifest | undefined) => attemptsOf(m!).filter((a) => a.endedAt === undefined);

  beforeEach(() => {
    manifest = undefined;
    writes = [];
    events = [];
    job = 'absent';
    unloaded = false;
    bootstrapExit = 0;
    power = 'AC Power';
  });

  describe('the happy path', () => {
    it('makes exactly one manifest write: a new open attempt, state launching, the new budget, end markers cleared', async () => {
      const before = seed();
      writeControlFlags(p().controlDir, { hardStop: true, softStop: true, heartbeatTs: 5 });
      const res = await go();

      expect(writes).toHaveLength(1);
      const m = manifest!;
      expect(m.state).toBe('launching');
      expect(m.budgetUsd).toBe(7);
      expect(m.pid).toBe(process.pid);
      expect(m.endedAt).toBeUndefined();
      expect(m.stopReason).toBeUndefined();
      expect(m.serverUrl).toBeUndefined();
      expect(m.port).toBeUndefined();
      expect(m.costUsd).toBe(42.5); // cumulative, untouched
      expect(m.startedAt).toBe(before.startedAt);
      expect(m.attempts).toEqual([
        // the implicit first attempt, written out as it was
        { n: 1, startedAt: '2026-10-21T21:00:10.000Z', endedAt: PREV_END, state: 'aborted-budget', stopReason: 'budget-hard', budgetUsd: 40, costAtStartUsd: 0, costUsd: 42.5 },
        { n: 2, startedAt: NOW.toISOString(), budgetUsd: 7, costAtStartUsd: 42.5 },
      ]);
      expect(openAttempts(m)).toHaveLength(1);
      expect(m.repos[0]!.baseline.head).toBe('new'); // the tripwire baseline was rebuilt
      expect(res.attempt).toBe(2);
      expect(res.label).toBe(`dev.nightgem.${SLUG}`);
    });

    it('resets both stop flags, keeps the heartbeat, and runs in the order lock, baseline, write, flags, bootstrap', async () => {
      seed();
      writeControlFlags(p().controlDir, { hardStop: true, softStop: true, heartbeatTs: 5 });
      await go();
      expect(readControlFlags(p().controlDir)).toEqual({ hardStop: false, softStop: false, heartbeatTs: 5 });
      expect(events.filter((e) => !e.startsWith('print'))).toEqual(['acquireLock', 'buildBaseline', 'write:launching', 'resetStopFlags', `bootstrap gui/501`]);
      expect(events.at(-1)).toBe('bootstrap gui/501'); // plist path follows
    });

    it('appends after explicit attempts and carries the cumulative cost as costAtStartUsd', async () => {
      seed({
        budgetUsd: 5,
        costUsd: 51,
        attempts: [
          { n: 1, startedAt: '2026-10-21T21:00:10.000Z', endedAt: '2026-10-21T21:30:00.000Z', state: 'aborted-budget', budgetUsd: 40, costAtStartUsd: 0, costUsd: 40.5 },
          { n: 2, startedAt: '2026-10-21T21:40:00.000Z', endedAt: PREV_END, state: 'aborted-budget', budgetUsd: 5, costAtStartUsd: 40.5, costUsd: 10.5 },
        ],
      });
      await go({ budgetUsd: 3 });
      const attempts = manifest!.attempts!;
      expect(attempts.map((a) => a.n)).toEqual([1, 2, 3]);
      expect(attempts.slice(0, 2)).toEqual(manifestSeedAttempts());
      expect(attempts[2]).toEqual({ n: 3, startedAt: NOW.toISOString(), budgetUsd: 3, costAtStartUsd: 51 });
      expect(manifest!.budgetUsd).toBe(3);

      function manifestSeedAttempts() {
        return [
          { n: 1, startedAt: '2026-10-21T21:00:10.000Z', endedAt: '2026-10-21T21:30:00.000Z', state: 'aborted-budget', budgetUsd: 40, costAtStartUsd: 0, costUsd: 40.5 },
          { n: 2, startedAt: '2026-10-21T21:40:00.000Z', endedAt: PREV_END, state: 'aborted-budget', budgetUsd: 5, costAtStartUsd: 40.5, costUsd: 10.5 },
        ];
      }
    });

    it.each(['stopped', 'aborted-budget', 'failed', 'stalled'] as const)('resumes a %s run', async (state) => {
      seed({ state });
      await go();
      expect(manifest!.state).toBe('launching');
    });

    it('uses the recorded launchd label for the plist and the bootstrap, even a legacy one', async () => {
      seed({ launchdLabel: `com.example.nightgem.${SLUG}` });
      const res = await go();
      expect(res.label).toBe(`com.example.nightgem.${SLUG}`);
      expect(res.plistPath).toBe(join(p().controlDir, `com.example.nightgem.${SLUG}.plist`));
      const xml = readFileSync(res.plistPath, 'utf8');
      expect(xml).toContain(`<string>com.example.nightgem.${SLUG}</string>`);
      expect(xml).toContain('<string>/o/nightgem-orchestrator.mjs</string>');
      expect(xml).toContain(`<string>${p().runDir}</string>`);
    });

    it('does not resolve a new run context: the frozen one is used (resolveRunContext throws in these deps)', async () => {
      seed();
      await expect(go()).resolves.toBeTruthy();
    });

    it('prints what happened and where to look', async () => {
      seed();
      await go();
      const out = lines.join('\n');
      expect(out).toContain(`Resumed ${SLUG} as attempt 2`);
      expect(out).toContain('$7.00 on top of $42.50');
      expect(out).toMatch(new RegExp(`bin/nightgem\\.mjs status ${SLUG}`));
    });

    it('keeps the lock for the orchestrator to take over (the CLI does not release it)', async () => {
      seed();
      await go();
      expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toMatchObject({ pid: process.pid, slug: SLUG });
    });
  });

  describe('eligibility refusals (nothing is written or touched)', () => {
    it('refuses a completed run and says to launch a new slug', async () => {
      const before = seed({ state: 'completed' });
      await expect(go()).rejects.toThrow(/completed.*launch a new slug/s);
      expectUntouched(before);
    });

    it.each(['launching', 'running', 'winding-down', 'stopping'] as const)('refuses an active %s run and points to status and stop', async (state) => {
      const before = seed({ state, endedAt: undefined, stopReason: undefined });
      const run = go();
      await expect(run).rejects.toThrow(new RegExp(`still active \\(state: ${state}\\)`));
      await expect(run).rejects.toThrow(/ status demo-run/);
      await expect(run).rejects.toThrow(/ stop demo-run/);
      expectUntouched(before);
    });

    it('refuses an unknown slug', async () => {
      await expect(go()).rejects.toThrow(/No run found for "demo-run"/);
      expect(writes).toEqual([]);
    });

    it('refuses a RUN.json that does not parse', async () => {
      const before = seed();
      const deps = rdeps({
        readManifest: async () => {
          throw new Error('Schema validation failed for RUN.json: budgetUsd');
        },
      });
      await expect(go({ deps })).rejects.toThrow(/RUN\.json that cannot be read.*Schema validation failed/s);
      expect(manifest).toEqual(before);
      expect(events).toEqual([]);
    });

    it('refuses an open last attempt (a crash) and says to run stop first', async () => {
      const before = seed({ attempts: [{ n: 1, startedAt: '2026-10-21T21:00:10.000Z', budgetUsd: 40, costAtStartUsd: 0, costUsd: 3 }] });
      const run = go();
      await expect(run).rejects.toThrow(/last attempt \(1\).*still open/s);
      await expect(run).rejects.toThrow(/ stop demo-run" first to close it/);
      expectUntouched(before);
    });

    it('counts an implicit attempt with no endedAt as open', async () => {
      const before = seed({ endedAt: undefined });
      await expect(go()).rejects.toThrow(/still open/);
      expectUntouched(before);
    });

    it('refuses a failed run that never started and points to launch', async () => {
      const before = seed({ state: 'failed', startedAt: undefined, endedAt: PREV_END, stopReason: 'launch failed: x' });
      await expect(go()).rejects.toThrow(/before it ever started.*launch demo-run --budget/s);
      expectUntouched(before);
    });

    it('refuses a manifest recording another slug', async () => {
      const before = seed();
      manifest = { ...before, slug: 'other-run' };
      await expect(go()).rejects.toThrow(/records the slug "other-run"/);
      expect(writes).toEqual([]);
    });

    it.each([
      ['relative controlDir', { controlDir: `relative/${SLUG}` }, /not an absolute path/],
      ['controlDir of another name', { controlDir: '/Users/alice/Library/Application Support/other-tool/not-this-run' }, /does not end in \/demo-run/],
      ['label with a shell metacharacter', { launchdLabel: `a;touch x.${SLUG}` }, /launchd label/],
      ['label without the slug suffix', { launchdLabel: 'com.other.tool.another-run' }, /launchd label/],
    ])('refuses a %s without calling launchctl', async (_n, over, msg) => {
      const before = seed();
      manifest = { ...before, ...over } as RunManifest;
      await expect(go()).rejects.toThrow(msg);
      expect(events).toEqual([]);
      expect(writes).toEqual([]);
    });

    it('refuses an invalid slug before reading anything', async () => {
      await expect(go({ slug: 'Bad Slug' })).rejects.toThrow(/Invalid slug/);
      expect(events).toEqual([]);
    });

    it('refuses when the frozen run context is missing', async () => {
      const before = seed();
      rmSync(p().runContextJson);
      await expect(go()).rejects.toThrow(/frozen run context cannot be read/);
      expectUntouched(before);
    });

    it('refuses a frozen run context for another workspace', async () => {
      const before = seed();
      writeRunContext(p().controlDir, makeRunContext(join(home, 'elsewhere')));
      await expect(go()).rejects.toThrow(/frozen run context is for the workspace/);
      expectUntouched(before);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses a budget of %s', async (budgetUsd) => {
      const before = seed();
      await expect(go({ budgetUsd })).rejects.toThrow(/Invalid budget/);
      expectUntouched(before);
    });
  });

  describe('the launchd job', () => {
    it('refuses a running job, writes nothing and releases the lock', async () => {
      const before = seed();
      job = 'running';
      await expect(go()).rejects.toThrow(/launchd job dev\.nightgem\.demo-run is running.* stop demo-run/s);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(events.some((e) => e.startsWith('bootout') || e.startsWith('bootstrap'))).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('boots out a loaded job that is not running, checks again, then resumes', async () => {
      seed();
      job = 'loaded';
      await go();
      const seq = events.filter((e) => e.startsWith('print') || e.startsWith('bootout') || e.startsWith('bootstrap') || e.startsWith('write'));
      // print (running?), bootout, print (gone), ... bootstrap strictly after the bootout, and the manifest after both
      expect(seq.indexOf(`bootout gui/501/dev.nightgem.${SLUG}`)).toBeGreaterThan(0);
      expect(seq.indexOf('bootstrap gui/501')).toBeGreaterThan(seq.indexOf(`bootout gui/501/dev.nightgem.${SLUG}`));
      expect(seq.indexOf('write:launching')).toBeGreaterThan(seq.indexOf(`bootout gui/501/dev.nightgem.${SLUG}`));
      expect(lines.join('\n')).toContain('Booted out the stale launchd job');
      expect(manifest!.state).toBe('launching');
    });

    it('refuses when the stale job is still loaded after the bootout, writing nothing', async () => {
      const before = seed();
      job = 'sticky';
      await expect(go()).rejects.toThrow(/still loaded after bootout/);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(events.some((e) => e.startsWith('bootstrap'))).toBe(false);
      expect(existsSync(lockPath())).toBe(false);
    });
  });

  describe('the run lock', () => {
    it('takes over a lock held by a dead pid', async () => {
      seed();
      writeFileSync(lockPath(), `${JSON.stringify({ pid: DEAD_PID, token: 't', ts: NOW.toISOString(), slug: 'older-run' })}\n`);
      await go();
      expect(manifest!.state).toBe('launching');
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    });

    it('refuses a lock held by a live foreign pid, with the remedy, and leaves everything alone', async () => {
      const before = seed();
      const foreign = `${JSON.stringify({ pid: process.ppid, token: 't', ts: NOW.toISOString(), slug: 'other-run' })}\n`;
      writeFileSync(lockPath(), foreign);
      const run = go();
      await expect(run).rejects.toThrow(new RegExp(`pid ${process.ppid}\\) holds the run lock`));
      await expect(run).rejects.toThrow(/status.*stop <slug>/s);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(readFileSync(lockPath(), 'utf8')).toBe(foreign); // the foreign lock is not ours to remove
      expect(events.some((e) => e.startsWith('bootout') || e.startsWith('bootstrap') || e === 'buildBaseline')).toBe(false);
    });

    it('refuses an unparsable lock file younger than 5 s', async () => {
      const before = seed();
      writeFileSync(lockPath(), '{"pid": 12');
      await expect(go()).rejects.toThrow(/being written by another process, or is unreadable and younger than 5 s/);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(existsSync(lockPath())).toBe(true);
    });

    it('takes over an unparsable lock file older than 5 s', async () => {
      seed();
      writeFileSync(lockPath(), '{"pid": 12');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath(), old, old);
      await go();
      expect(manifest!.state).toBe('launching');
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    });

    it('two resumes at once: exactly one wins, with one manifest write and one open attempt', async () => {
      seed();
      const results = await Promise.allSettled([go(), go()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(lost.reason)).toMatch(/holds the run lock/);
      expect(writes).toHaveLength(1);
      expect(manifest!.attempts).toHaveLength(2);
      expect(openAttempts(manifest)).toHaveLength(1);
      expect(events.filter((e) => e.startsWith('bootstrap'))).toHaveLength(1);
      expect(events.filter((e) => e === 'resetStopFlags')).toHaveLength(1);
    });

    it('a second resume that read the old state but gets the lock after the first has gone refuses on the re-check', async () => {
      const old = seed();
      await go();
      // the first CLI exited: its lock is now held by a dead pid, and the orchestrator has not taken it over yet.
      // The second CLI read RUN.json before the first one wrote it, so its first read still shows the terminal run.
      writeFileSync(lockPath(), `${JSON.stringify({ pid: DEAD_PID, token: 't', ts: NOW.toISOString(), slug: SLUG })}\n`);
      const afterFirst = JSON.stringify(manifest);
      let reads = 0;
      const deps = rdeps({ readManifest: async () => (++reads === 1 ? old : manifest) });
      await expect(go({ deps })).rejects.toThrow(/still active \(state: launching\)/);
      expect(reads).toBe(2);
      expect(writes).toHaveLength(1);
      expect(JSON.stringify(manifest)).toBe(afterFirst);
      expect(events.filter((e) => e.startsWith('bootstrap'))).toHaveLength(1);
      expect(existsSync(lockPath())).toBe(false); // the loser released what it had taken over
    });
  });

  describe('the worktree check', () => {
    it('passes when every started task and the integration worktree exist on their branches', async () => {
      seed();
      makeWorktree(taskWorktree(repoPath(), SLUG, 't1'), 'feat/t1');
      makeWorktree(taskWorktree(repoPath(), SLUG, 't2'), 'feat/t2');
      makeWorktree(integrationWorktree(repoPath(), SLUG), 'integration/demo');
      writeTasks([
        ev('t1', 'done'),
        ev('t2', 'blocked', { blockedReason: 'wind-down: unfinished' }),
        ev('t3', 'todo'),
        ev('t4', 'skipped', { blockedReason: 'wind-down: never started' }),
        ev('integration:acme-api', 'running', { branch: 'integration/demo', worktree: integrationWorktree(repoPath(), SLUG) }),
        ev('phase:build', 'running', { repo: '_run', branch: '-', worktree: '-' }),
      ]);
      await go();
      expect(manifest!.state).toBe('launching');
    });

    it('refuses before anything is written when worktrees are missing, and lists them', async () => {
      const before = seed();
      makeWorktree(taskWorktree(repoPath(), SLUG, 't1'), 'feat/t1');
      writeTasks([ev('t1', 'running'), ev('t2', 'done'), ev('integration:acme-api', 'verifying', { branch: 'integration/demo', worktree: integrationWorktree(repoPath(), SLUG) })]);
      let msg = '';
      await go().catch((e: Error) => void (msg = e.message));
      expect(msg).toMatch(/2 worktrees of started tasks are missing/);
      expect(msg).toContain(`t2: ${taskWorktree(repoPath(), SLUG, 't2')}: the worktree is missing`);
      expect(msg).toContain(`integration:acme-api: ${integrationWorktree(repoPath(), SLUG)}: the worktree is missing`);
      expect(msg).not.toContain('t1:');
      expect(msg).toMatch(/never rebuilds a worktree silently/);
      expectUntouched(before);
    });

    it('refuses a worktree whose branch is not the task branch', async () => {
      const before = seed();
      makeWorktree(taskWorktree(repoPath(), SLUG, 't1'), 'feat/other');
      writeTasks([ev('t1', 'running')]);
      await expect(go()).rejects.toThrow(/branch feat\/t1 is not checked out there \(found feat\/other\)/);
      expectUntouched(before);
    });

    it('refuses a worktree path outside the run\'s worktree root, even if it exists with the right branch', async () => {
      const before = seed();
      const outside = join(home, 'elsewhere', 't1');
      makeWorktree(outside, 'feat/t1');
      writeTasks([ev('t1', 'running', { worktree: outside })]);
      await expect(go()).rejects.toThrow(/outside the run's worktree root/);
      expectUntouched(before);
    });

    it('refuses a path that climbs out of the root with ..', async () => {
      const before = seed();
      const sneaky = `${worktreeRootOf()}/../../../../elsewhere/t1`;
      makeWorktree(join(home, 'elsewhere', 't1'), 'feat/t1');
      writeTasks([ev('t1', 'running', { worktree: sneaky })]);
      await expect(go()).rejects.toThrow(/outside the run's worktree root/);
      expectUntouched(before);

      function worktreeRootOf(): string {
        return join(repoPath(), '.worktrees', SLUG);
      }
    });

    it('does not check tasks that never started', async () => {
      seed();
      writeTasks([ev('t1', 'todo'), ev('t2', 'skipped', { blockedReason: 'wind-down: never started' })]);
      await go();
      expect(manifest!.state).toBe('launching');
    });

    it('uses the latest event of a task: started, then back to todo, is not checked', async () => {
      seed();
      writeTasks([ev('t1', 'running'), ev('t1', 'todo')]);
      await go();
      expect(manifest!.state).toBe('launching');
    });
  });

  describe('the gates run on the frozen context before anything is written', () => {
    it('a doctor hard failure refuses, writes nothing, leaves the stop flags and releases the lock', async () => {
      const before = seed();
      writeControlFlags(p().controlDir, { hardStop: true, heartbeatTs: 5 });
      power = 'Battery Power';
      await expect(go()).rejects.toThrow(/doctor reported hard failures[\s\S]*AC power/);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(readControlFlags(p().controlDir).hardStop).toBe(true);
      expect(existsSync(lockPath())).toBe(false);
      expect(events.some((e) => e.startsWith('bootstrap') || e === 'resetStopFlags')).toBe(false);
    });

    it('a credentialed remote refuses through the baseline step, writing nothing', async () => {
      const before = seed();
      const deps = rdeps({
        buildBaseline: async () => {
          throw new Error('acme-api: origin embeds credentials');
        },
      });
      await expect(go({ deps })).rejects.toThrow(/embeds credentials/);
      expect(writes).toEqual([]);
      expect(manifest).toEqual(before);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('checks the run\'s own repos, not the current spec', async () => {
      seed();
      writeFileSync(p().specMd, '# Spec: demo JIRA-9\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-web` | x |\n');
      mkdirSync(join(workspaceRoot, 'acme-web', '.git'), { recursive: true });
      let baselined: string[] = [];
      const deps = rdeps({
        buildBaseline: async (paths) => {
          baselined = paths;
          return [{ name: 'acme-api', path: paths[0]!, defaultBranch: 'main', baseline: { head: 'new', branch: 'main', porcelainHash: 'new', stashCount: 0 } }];
        },
      });
      await go({ deps });
      expect(baselined).toEqual([repoPath()]);
    });
  });

  describe('a failure after the manifest write rolls back', () => {
    function expectRolledBack(before: RunManifest, nextN: number): void {
      expect(events.filter((e) => e.startsWith('write:'))).toEqual(['write:launching', `write:${before.state}`]);
      const m = manifest!;
      expect(m.state).toBe(before.state);
      expect(m.budgetUsd).toBe(before.budgetUsd);
      expect(m.endedAt).toBe(before.endedAt);
      expect(m.stopReason).toBe(before.stopReason);
      expect(m.serverUrl).toBe(before.serverUrl);
      expect(m.repos).toEqual(before.repos);
      expect(openAttempts(m)).toEqual([]); // no attempt left open
      const failed = m.attempts!.at(-1)!;
      expect(failed).toEqual({ n: nextN, startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), state: 'failed', stopReason: 'resume-failed', budgetUsd: 7, costAtStartUsd: before.costUsd, costUsd: 0 });
      expect(m.attempts!.slice(0, -1)).toEqual(attemptsOf(before));
      expect(existsSync(lockPath())).toBe(false);
    }

    it('a failed bootstrap restores the terminal state and closes the new attempt as failed (resume-failed)', async () => {
      const before = seed();
      bootstrapExit = 5;
      await expect(go()).rejects.toThrow(/launchctl bootstrap failed \(exit 5\).*resume rolled back: demo-run is aborted-budget again/s);
      expectRolledBack(before, 2);
    });

    it('a failing stop-flag reset rolls back, and never reaches launchctl', async () => {
      const before = seed();
      const deps = rdeps({
        resetStopFlags: async () => {
          throw new Error('flags boom');
        },
      });
      await expect(go({ deps })).rejects.toThrow(/flags boom.*rolled back/s);
      expectRolledBack(before, 2);
      expect(events.some((e) => e.startsWith('bootstrap') || e.startsWith('bootout'))).toBe(false);
    });

    it('a failure to write the plist rolls back', async () => {
      const before = seed();
      rmSync(p().controlDir, { recursive: true, force: true });
      mkdirSync(join(p().controlDir, 'xdg-data'), { recursive: true });
      // the control dir has no run-context, so give resume one through a custom reader, and make the plist path a directory
      const ctx = makeRunContext(workspaceRoot);
      mkdirSync(join(p().controlDir, `dev.nightgem.${SLUG}.plist`), { recursive: true });
      const deps = rdeps({ readRunContext: async () => ctx });
      await expect(go({ deps })).rejects.toThrow(/rolled back/);
      expectRolledBack(before, 2);
      expect(events.some((e) => e.startsWith('bootstrap'))).toBe(false);
    });

    it('the run can be resumed again afterwards, as attempt 3', async () => {
      seed();
      bootstrapExit = 5;
      await go().catch(() => undefined);
      bootstrapExit = 0;
      events = [];
      writes = [];
      await go({ budgetUsd: 9 });
      expect(manifest!.attempts!.map((a) => [a.n, a.state ?? 'open'])).toEqual([[1, 'aborted-budget'], [2, 'failed'], [3, 'open']]);
      expect(manifest!.budgetUsd).toBe(9);
      expect(openAttempts(manifest)).toHaveLength(1);
    });

    it('rolls back an explicit-attempts manifest without touching its earlier attempts', async () => {
      const attempts = [{ n: 1, startedAt: '2026-10-21T21:00:10.000Z', endedAt: PREV_END, state: 'stopped', stopReason: 'x', budgetUsd: 40, costAtStartUsd: 0, costUsd: 42.5 }];
      const before = seed({ attempts, state: 'stopped' });
      bootstrapExit = 5;
      await expect(go()).rejects.toThrow(/rolled back/);
      expectRolledBack(before, 2);
    });

    it('reports a rollback that itself cannot be written, and still releases the lock', async () => {
      seed();
      bootstrapExit = 5;
      let n = 0;
      const deps = rdeps({
        writeManifest: async (_s, m) => {
          if (++n > 1) throw new Error('disk full');
          manifest = m;
          writes.push(m);
        },
      });
      await expect(go({ deps })).rejects.toThrow(/RUN\.json could not be restored \(disk full\).* stop demo-run/s);
      expect(existsSync(lockPath())).toBe(false);
    });

    it('does not roll back when the manifest write itself fails: nothing was written', async () => {
      const before = seed();
      let n = 0;
      const deps = rdeps({
        writeManifest: async () => {
          n++;
          throw new Error('disk full');
        },
      });
      await expect(go({ deps })).rejects.toThrow('disk full');
      expect(n).toBe(1);
      expect(manifest).toEqual(before);
      expect(existsSync(lockPath())).toBe(false);
      expect(events.some((e) => e.startsWith('bootstrap') || e === 'resetStopFlags')).toBe(false);
    });
  });
});
