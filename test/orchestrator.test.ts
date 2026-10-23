/**
 * Orchestrator core tests. Real state module (temp dirs), real event pump, real ledger and watchdog; fake server,
 * fake clock, fake signals. Simulated time only: a whole multi-hour run takes milliseconds.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BudgetLedger } from '../src/budget.ts';
import { RunApiError } from '../src/client.ts';
import { RunManifest, type Phase, type RepoBaseline, type RunState } from '../src/contracts.ts';
import { createEventPump } from '../src/events.ts';
import {
  APPEND_AGENTS,
  PHASE_ORDER,
  realStateOps,
  runOrchestrator,
  windDownParked,
  type FinalState,
  type OrchestratorConfig,
  type OrchestratorDeps,
  type PreflightResult,
  type StateOps,
} from '../src/orchestrator.ts';
import { runPaths, type RunPaths } from '../src/paths.ts';
import { renderPrompt } from '../src/prompts.ts';
import { readControlFlags, readManifest, writeControlFlags, writeManifest } from '../src/state.ts';
import type { Violation } from '../src/tripwires.ts';
import { createWatchdog, type WatchdogConfig } from '../src/watchdog.ts';
import { FakeClock, FakeServer, FakeSignals, type PromptRecord } from './fakes/server.ts';

const SLUG = 'demo-run';
const SECRET = 'f00dfacecafebeef0123456789abcdef0123456789abcdef';
const PHASE_OF_KIND: Record<string, Phase> = { 'phase-plan': 'plan', 'phase-build': 'build', 'phase-review': 'review', 'phase-report': 'report' };

interface Opts {
  budgetUsd?: number;
  state?: RunState;
  repos?: RunManifest['repos'];
  watchdog?: Partial<WatchdogConfig>;
  config?: Partial<OrchestratorConfig>;
  preflight?: () => Promise<PreflightResult>;
  /** Replaces the default "every phase completes after 30 s for $0.5" script. */
  script?: (rec: PromptRecord, srv: FakeServer, h: Harness) => void;
  startServerError?: Error;
  secrets?: string[];
  writeReportError?: Error;
  cleanupError?: Error;
  serverStopError?: Error;
  /** `RUN.json.pid` as the CLI records it. */
  manifestPid?: number;
  /** Pre-fetch of the spec repos: exit code per repo path (default 0), or an Error / 'hang'. */
  fetch?: (repo: string) => { exitCode: number; stderr?: string } | Error | 'hang';
  /** Re-baseline of other repos (default: a fresh fake baseline). */
  rebaseline?: (repo: string) => Promise<RepoBaseline>;
}

interface Harness {
  clock: FakeClock;
  server: FakeServer;
  signals: FakeSignals;
  paths: RunPaths;
  home: string;
  lockPath: string;
  deps: OrchestratorDeps;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  stateHistory: RunState[];
  beats: number[];
  reportStates: RunState[];
  cleanupCalls: number;
  startInputs: Array<Record<string, unknown>>;
  /** The vars of every `renderPrompt` call. */
  promptVarsSeen: Array<Record<string, string | number>>;
  /** Order of notable startup events: 'fetch:<path>', 'startServer'. */
  startupLog: string[];
  tmpRemovals: number;
  headShaCalls: string[];
  rebaselined: string[];
  appendFiles: string[];
  protectCalls: string[][];
  tripwireCalls: Array<{ baseline: unknown; repos: readonly string[]; protectedFiles: readonly unknown[] }>;
  violationsQueue: Violation[][];
  manifest(): RunManifest;
  run(maxSimMs?: number): Promise<FinalState>;
  start0: number;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ng-orch-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Default script: every phase prompt makes the root work for 30 s, spend $0.5 and finish the phase. */
function autoPhases(rec: PromptRecord, srv: FakeServer): void {
  const phase = PHASE_OF_KIND[rec.kind];
  if (phase) srv.completePhase(rec.sessionId, phase, { afterMs: 30_000, costUsd: 0.5 });
  else if (rec.kind === 'phase-review-lite') srv.completeLite(rec.sessionId, { afterMs: 20_000, costUsd: 0.2 });
}

function makeHarness(o: Opts = {}): Harness {
  const home = mkdtempSync(join(root, 'home-'));
  const workspaceRoot = join(home, 'workspace');
  const paths = runPaths(SLUG, { home, workspaceRoot });
  mkdirSync(paths.runDir, { recursive: true });
  mkdirSync(paths.controlDir, { recursive: true });
  writeFileSync(paths.specMd, '# SPEC\n');

  const clock = new FakeClock();
  const start0 = clock.now();
  const manifest = RunManifest.parse({
    schemaVersion: 2,
    workspaceRoot,
    slug: SLUG,
    budgetUsd: o.budgetUsd ?? 10,
    state: o.state ?? 'launching',
    phase: 'plan',
    launchdLabel: 'dev.nightgem.demo-run',
    controlDir: paths.controlDir,
    runDir: paths.runDir,
    xdgDataHome: paths.xdgDataHome,
    model: 'anthropic/claude-opus-5-5',
    createdAt: new Date(start0).toISOString(),
    repos: o.repos ?? [],
    ...(o.manifestPid ? { pid: o.manifestPid } : {}),
  });
  writeManifest(paths.runJson, manifest);

  const server = new FakeServer(clock, paths);
  if (o.serverStopError) {
    server.stop = async () => {
      server.stopCalls++;
      throw o.serverStopError;
    };
  }
  const signals = new FakeSignals();
  const lockPath = join(home, 'run.lock');

  const h = { clock, server, signals, paths, home, lockPath } as Harness;
  h.logs = [];
  h.stateHistory = [];
  h.beats = [];
  h.reportStates = [];
  h.cleanupCalls = 0;
  h.startInputs = [];
  h.promptVarsSeen = [];
  h.startupLog = [];
  h.tmpRemovals = 0;
  h.headShaCalls = [];
  h.rebaselined = [];
  h.appendFiles = [];
  h.protectCalls = [];
  h.tripwireCalls = [];
  h.violationsQueue = [];
  h.start0 = start0;

  const state: StateOps = {
    ...realStateOps,
    updateManifest: (p, fn) => {
      const m = realStateOps.updateManifest(p, fn);
      if (h.stateHistory.at(-1) !== m.state) h.stateHistory.push(m.state);
      return m;
    },
    touchHeartbeat: (dir, ms) => {
      h.beats.push(ms);
      return realStateOps.touchHeartbeat(dir, ms);
    },
  };

  server.onPrompt = (rec, srv) => (o.script ?? autoPhases)(rec, srv, h);

  const ledger = new BudgetLedger({
    budgetUsd: o.budgetUsd ?? 10,
    softPct: 0.85,
    hardPct: 1,
    costMultiplier: 1,
    now: () => new Date(clock.now()),
  });

  h.deps = {
    slug: SLUG,
    paths,
    pid: 4242,
    lockPath,
    smallModel: 'anthropic/claude-haiku-5-5',
    opencodeBin: '/opt/homebrew/bin/opencode',
    sandbox: true,
    serverInput: { home, workspaceRoot, safety: { workspaceRoot, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } } },
    promptContext: { workspaceRoot, workspaceInstructions: 'Follow each repo AGENTS.md.', skillsList: 'skill-a, skill-b' },
    clock,
    state,
    ledger,
    watchdog: createWatchdog(o.watchdog ?? {}, () => clock.now()),
    signals,
    logger: (event, fields) => h.logs.push({ event, fields }),
    secrets: o.secrets ?? [],
    renderPrompt: (name, vars) => {
      h.promptVarsSeen.push(vars);
      return renderPrompt(name, vars);
    },
    tmpDir: join(root, 'run-tmp', `nightgem-${SLUG}`),
    removeTmp: () => {
      h.tmpRemovals++;
    },
    fetchRepo: async (repo) => {
      h.startupLog.push(`fetch:${repo}`);
      const r = o.fetch?.(repo) ?? { exitCode: 0 };
      if (r === 'hang') return new Promise(() => undefined);
      if (r instanceof Error) throw r;
      return r;
    },
    rebaseline: async (repo) => {
      h.rebaselined.push(repo);
      return o.rebaseline ? o.rebaseline(repo) : { head: 'new-head', branch: 'main', porcelainHash: 'new-hash', stashCount: 0 };
    },
    startServer: async (input) => {
      h.startupLog.push('startServer');
      h.startInputs.push(input as unknown as Record<string, unknown>);
      if (input.appendsDir) h.appendFiles = readdirSync(input.appendsDir).sort();
      if (o.startServerError) throw o.startServerError;
      return server;
    },
    waitForAgents: async () => ['orchestrator', 'fixer', 'oracle'],
    preflight: o.preflight ?? (async () => ({ ok: true, failures: [] })),
    createPump: createEventPump,
    checkTripwires: async (input) => {
      h.tripwireCalls.push(input);
      return h.violationsQueue.shift() ?? [];
    },
    protectFiles: async (paths) => {
      h.protectCalls.push([...paths]);
      return paths.map((p) => ({ path: p, sha256: 'x' }));
    },
    headSha: async (repo) => {
      h.headShaCalls.push(repo);
      return 'sha-1';
    },
    writeReport: async () => {
      h.reportStates.push(readManifest(paths.runJson).state);
      if (o.writeReportError) throw o.writeReportError;
    },
    cleanupLaunchd: async () => {
      h.cleanupCalls++;
      if (o.cleanupError) throw o.cleanupError;
    },
    config: o.config ?? {},
  };
  h.manifest = () => readManifest(paths.runJson);
  h.run = (maxSimMs) => clock.runUntil(runOrchestrator(h.deps), maxSimMs);
  return h;
}

const kinds = (h: Harness): string[] => h.server.prompts.map((p) => p.kind);
const rootPhaseOrder = (h: Harness): string[] => h.manifest().rootSessions.map((r) => r.phase);

// ---------------------------------------------------------------------------------------------------------------

describe('startup: restart no-op and lock', () => {
  it.each(['completed', 'failed', 'stalled', 'aborted-budget', 'stopped'] as const)('a terminal run (%s) is a no-op: exit 0, nothing started', async (state) => {
    const h = makeHarness({ state });
    const before = readFileSync(h.paths.runJson, 'utf8');
    const res = await h.run();
    expect(res).toMatchObject({ state, exitCode: 0, noop: true });
    expect(h.startInputs).toHaveLength(0);
    expect(h.reportStates).toEqual([]);
    expect(h.cleanupCalls).toBe(0);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(readFileSync(h.paths.runJson, 'utf8')).toBe(before);
  });

  it('takes over a stale lock left by the CLI (dead pid) and releases it at the end', async () => {
    const h = makeHarness();
    writeFileSync(h.lockPath, `${JSON.stringify({ pid: 999_999, token: 'cli', ts: new Date().toISOString() })}\n`);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('a lock held by a live process is respected: nothing runs, exit 1, run untouched', async () => {
    const h = makeHarness();
    writeFileSync(h.lockPath, `${JSON.stringify({ pid: process.pid, token: 'other', ts: new Date().toISOString() })}\n`);
    const res = await h.run();
    expect(res).toMatchObject({ exitCode: 1, noop: true, stopReason: 'lock-held' });
    expect(h.startInputs).toHaveLength(0);
    expect(h.manifest().state).toBe('launching');
    expect(existsSync(h.lockPath)).toBe(true); // not ours: left alone
  });
});

describe('lock handoff from the CLI (launchd starts us while the CLI may still be alive)', () => {
  const holder = (h: Harness, fields: Record<string, unknown>): void =>
    writeFileSync(h.lockPath, `${JSON.stringify({ pid: process.pid, token: 'cli', ts: new Date().toISOString(), ...fields })}\n`);

  it('waits for a live holder that is this run (lock slug) and proceeds once it lets go', async () => {
    const h = makeHarness();
    holder(h, { slug: SLUG });
    h.clock.setTimeout(() => rmSync(h.lockPath), 20_000); // the CLI exits
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.logs.filter((l) => l.event === 'lock.waiting').length).toBeGreaterThanOrEqual(19);
    expect(h.beats[0]! - h.start0).toBeGreaterThanOrEqual(20_000); // nothing started before the handoff
    expect(existsSync(h.lockPath)).toBe(false);
  });

  it('also recognises the holder by the pid the CLI recorded in RUN.json', async () => {
    const h = makeHarness({ manifestPid: process.pid });
    holder(h, {}); // old lock format: no slug
    h.clock.setTimeout(() => rmSync(h.lockPath), 5_000);
    expect((await h.run()).state).toBe('completed');
  });

  it('gives up after 60 s: lock-held, exit 1, nothing started, the foreign lock untouched', async () => {
    const h = makeHarness();
    holder(h, { slug: SLUG });
    const res = await h.run();
    expect(res).toMatchObject({ exitCode: 1, noop: true, stopReason: 'lock-held' });
    expect(h.clock.now() - h.start0).toBeGreaterThanOrEqual(60_000);
    expect(h.clock.now() - h.start0).toBeLessThan(65_000);
    expect(h.startInputs).toHaveLength(0);
    expect(existsSync(h.lockPath)).toBe(true);
  });

  it('re-reads RUN.json under the lock: a run that went terminal while we waited is a no-op, with the lock released and nothing finalized', async () => {
    const h = makeHarness();
    holder(h, { slug: SLUG });
    h.clock.setTimeout(() => {
      // a `stop` (or a rolled-back resume) finished the run while the CLI still held the lock
      writeManifest(h.paths.runJson, RunManifest.parse({ ...h.manifest(), state: 'stopped', endedAt: '2026-01-01T00:00:00.000Z', stopReason: 'stopped-after-crash' }));
      rmSync(h.lockPath);
    }, 3_000);
    const before = (): string => readFileSync(h.paths.runJson, 'utf8');
    const res = await h.run();
    expect(res).toMatchObject({ state: 'stopped', stopReason: 'stopped-after-crash', exitCode: 0, noop: true });
    expect(h.startInputs).toHaveLength(0);
    expect(h.reportStates).toEqual([]);
    expect(h.cleanupCalls).toBe(0);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.manifest().state).toBe('stopped');
    expect(h.manifest().attempts).toBeUndefined(); // no attempt was written or closed
    expect(before()).toBe(readFileSync(h.paths.runJson, 'utf8'));
    expect(h.logs.some((l) => l.event === 'restart.noop' && l.fields.afterLock === true)).toBe(true);
  });

  it('runs the start-up assertions on the copy read under the lock', async () => {
    const h = makeHarness();
    holder(h, { slug: SLUG });
    h.clock.setTimeout(() => {
      // the resume transition landed after our first read: an attempt list whose last attempt is closed breaks the invariant
      writeManifest(h.paths.runJson, RunManifest.parse({ ...h.manifest(), startedAt: '2026-01-01T00:00:00.000Z', attempts: [{ ...OLD, budgetUsd: 10 }] }));
      rmSync(h.lockPath);
    }, 3_000);
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'attempt-invariant' });
    expect(h.startInputs).toHaveLength(0);
    expect(h.manifest().attempts![0]).toEqual({ ...OLD, budgetUsd: 10 });
  });

  it('a lock held by a different live run is lock-held at once (no waiting)', async () => {
    const h = makeHarness();
    holder(h, { slug: 'some-other-run' });
    const res = await h.run();
    expect(res).toMatchObject({ exitCode: 1, noop: true, stopReason: 'lock-held' });
    expect(h.clock.now()).toBe(h.start0);
    expect(h.logs.some((l) => l.event === 'lock.waiting')).toBe(false);
  });
});

describe('startup: failures end in failed + report', () => {
  it('preflight failure -> failed, defect, report, server stopped, pump never started', async () => {
    const h = makeHarness({ preflight: async () => ({ ok: false, failures: ['fixer: shell git push expected deny, got allow'] }) });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'preflight-failed', exitCode: 1, noop: false });
    const m = h.manifest();
    expect(m.state).toBe('failed');
    expect(m.defects.map((d) => d.kind)).toEqual(['preflight-failed']);
    expect(m.defects[0]?.message).toContain('git push');
    expect(m.endedAt).toBeDefined();
    expect(h.reportStates).toEqual(['failed']); // the report sees the final state
    expect(h.server.stopCalls).toBe(1);
    expect(h.server.conns).toHaveLength(0); // no pump, so no event stream
    expect(h.server.created).toHaveLength(0); // no phase session
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.cleanupCalls).toBe(1);
  });

  it('preflight failure still books the canary session cost (cost.jsonl + RUN.json), reconciling before server.stop', async () => {
    const h = makeHarness({
      preflight: async () => {
        h.server.seedSession(0.01); // the haiku canary, created on the run server
        return { ok: false, failures: ['canary: denied'] };
      },
    });
    const listsAtStop: number[] = [];
    const realStop = h.server.stop.bind(h.server);
    h.server.stop = async () => {
      listsAtStop.push(h.server.listCalls);
      await realStop();
    };
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'preflight-failed' });
    expect(h.manifest().costUsd).toBeCloseTo(0.01, 6);
    const lines = readFileSync(h.paths.costJsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ phase: 'plan', costUsd: 0.01 });
    expect(h.server.stopCalls).toBe(1);
    expect(listsAtStop[0]).toBeGreaterThan(0); // reconciled before the server was stopped
    expect(h.server.conns).toHaveLength(0); // still no event stream
  });

  it('a dead server on finalize: no throw, the failed reconcile is logged, the server is still stopped', async () => {
    const h = makeHarness({ preflight: async () => ({ ok: false, failures: ['x'] }) });
    h.server.listError = new Error('connection refused');
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'preflight-failed', noop: false });
    const log = h.logs.find((l) => l.event === 'final_reconcile.failed');
    expect(log?.fields.error).toContain('connection refused');
    expect(h.server.stopCalls).toBe(1);
    expect(h.reportStates).toEqual(['failed']);
  });

  it('a preflight that throws counts as a failure', async () => {
    const h = makeHarness({
      preflight: async () => {
        throw new Error('canary exploded');
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'preflight-failed' });
    expect(h.manifest().defects[0]?.message).toContain('canary exploded');
  });

  it('server start failure -> failed + report + lock released', async () => {
    const h = makeHarness({ startServerError: new Error('port in use') });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'server-start-failed', exitCode: 1 });
    expect(h.reportStates).toEqual(['failed']);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.cleanupCalls).toBe(1);
  });

  it('secrets never reach the log or RUN.json', async () => {
    const h = makeHarness({ startServerError: new Error(`cannot start, password ${SECRET} rejected`), secrets: [SECRET] });
    await h.run();
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
    expect(readFileSync(h.paths.runJson, 'utf8')).not.toContain(SECRET);
    expect(h.manifest().defects[0]?.message).toContain('[REDACTED]');
  });
});

describe('pre-fetch of the spec repos (outside the sandbox, before the server)', () => {
  const specRepo = (name: string) => ({ name, path: `/tmp/${name}`, defaultBranch: 'main', baseline: { head: 'a'.repeat(40), branch: 'main', porcelainHash: 'h', stashCount: 0 } });
  const otherRepo = { name: 'misc', path: '/tmp/misc', defaultBranch: '-', baseline: { head: 'b'.repeat(40), branch: 'main', porcelainHash: 'h', stashCount: 0 } };

  it('fetches every spec repo (not the other workspace repos) before startRunServer, and logs the exit code of each', async () => {
    const h = makeHarness({ repos: [specRepo('one'), specRepo('two'), otherRepo] });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.startupLog.filter((e) => e !== 'startServer').sort()).toEqual(['fetch:/tmp/one', 'fetch:/tmp/two']);
    expect(h.startupLog.at(-1)).toBe('startServer');
    const logs = h.logs.filter((l) => l.event === 'prefetch');
    expect(logs.map((l) => [l.fields.repo, l.fields.exitCode]).sort()).toEqual([['/tmp/one', 0], ['/tmp/two', 0]]);
    expect(h.manifest().defects).toEqual([]);
  });

  it('a failed fetch is a warning defect and the run goes on with local refs', async () => {
    const h = makeHarness({ repos: [specRepo('one'), specRepo('two')], fetch: (repo) => (repo.endsWith('one') ? { exitCode: 128, stderr: 'fatal: Could not read from remote repository.' } : { exitCode: 0 }) });
    const res = await h.run();
    expect(res.state).toBe('completed');
    const defects = h.manifest().defects;
    expect(defects.map((d) => d.kind)).toEqual(['prefetch-failed']);
    expect(defects[0]?.message).toContain('/tmp/one');
    expect(defects[0]?.message).toContain('exit 128');
    expect(defects[0]?.message).toContain('local refs');
    expect(h.logs.find((l) => l.event === 'prefetch' && l.fields.repo === '/tmp/one')?.fields.exitCode).toBe(128);
    expect(h.startupLog).toContain('startServer');
  });

  it('a fetch that throws or hangs (past the 3 min timeout) does not block the start', async () => {
    const h = makeHarness({ repos: [specRepo('one'), specRepo('two')], fetch: (repo) => (repo.endsWith('one') ? new Error('spawn git ENOENT') : 'hang') });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.manifest().defects.map((d) => d.kind)).toEqual(['prefetch-failed', 'prefetch-failed']);
    const hang = h.logs.find((l) => l.event === 'prefetch' && l.fields.repo === '/tmp/two')!;
    expect(hang.fields.exitCode).toBe(124);
    expect(hang.fields.timedOut).toBe(true);
    const server = h.startInputs[0];
    expect(server).toBeDefined();
    expect(Date.parse(String(h.logs.find((l) => l.event === 'preflight.ok')?.fields.ts)) - h.start0).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it('a pre-fetch that is not wired (no fetchRepo) is skipped silently', async () => {
    const h = makeHarness({ repos: [specRepo('one')] });
    delete h.deps.fetchRepo;
    expect((await h.run()).state).toBe('completed');
    expect(h.logs.some((l) => l.event === 'prefetch')).toBe(false);
  });
});

describe('worktrees and the run tmp dir', () => {
  it('populates RUN.json worktrees from tasks.jsonl (deduped by path) and feeds the worktree HEADs to the progress marker', async () => {
    const wt = (task: string) => `/Users/x/work/acme-web/.worktrees/${SLUG}/${task}`;
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') {
          srv.appendTask({ id: 'api', state: 'running', phase: 'build', repo: 'acme-web', branch: 'feat/api', worktree: wt('api') });
          srv.appendTask({ id: 'api', state: 'verifying', phase: 'build', repo: 'acme-web', branch: 'feat/api', worktree: wt('api') });
          srv.appendTask({ id: 'ui', state: 'running', phase: 'build', repo: 'acme-web', branch: 'feat/ui', worktree: wt('ui') });
          srv.appendTask({ id: 'integration', state: 'running', phase: 'build', repo: 'acme-web', branch: 'feat/int', worktree: `/Users/x/work/acme-web/.worktrees/${SLUG}/_integration` });
          h.clock.setTimeout(() => srv.completePhase(rec.sessionId, 'build', { afterMs: 1_000 }), 40_000);
          srv.setBusy(rec.sessionId, true);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    const wts = h.manifest().worktrees;
    expect(wts.map((w) => w.path).sort()).toEqual([wt('api'), wt('ui'), `/Users/x/work/acme-web/.worktrees/${SLUG}/_integration`].sort());
    expect(wts.find((w) => w.path === wt('api'))).toMatchObject({ repo: 'acme-web', branch: 'feat/api', task: 'api', kind: 'task' });
    expect(wts.find((w) => w.path.endsWith('_integration'))).toMatchObject({ kind: 'integration' });
    expect(wts.find((w) => w.path.endsWith('_integration'))?.task).toBeUndefined();
    // phase markers and the placeholder repo never become worktrees; the HEADs are asked for (progress marker input)
    expect(wts.some((w) => w.repo === '_run')).toBe(false);
    expect(new Set(h.headShaCalls)).toEqual(new Set(wts.map((w) => w.path)));
  });

  it('removes the run tmp dir at the end, whatever the outcome', async () => {
    const ok = makeHarness();
    await ok.run();
    expect(ok.tmpRemovals).toBe(1);
    const bad = makeHarness({ preflight: async () => ({ ok: false, failures: ['x'] }) });
    await bad.run();
    expect(bad.tmpRemovals).toBe(1);
    const noServer = makeHarness({ startServerError: new Error('boom') });
    await noServer.run();
    expect(noServer.tmpRemovals).toBe(1);
  });

  it('a failing tmp cleanup is logged and never fails the run', async () => {
    const h = makeHarness();
    h.deps.removeTmp = () => {
      throw new Error('EBUSY');
    };
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.logs.some((l) => l.event === 'tmp.cleanup_failed')).toBe(true);
  });

  it('the log keeps the ledger level under ledgerEvent, not event', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 8.5), 20_000);
          return;
        }
        if (rec.kind === 'wind-down') return void hh.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        autoPhases(rec, srv);
      },
    });
    await h.run();
    const l = h.logs.find((x) => x.event === 'ledger.event')!;
    expect(l.fields.ledgerEvent).toBe('soft');
    expect(l.fields).not.toHaveProperty('event');
  });
});

describe('normal run', () => {
  it('runs plan -> build -> review -> report in four NEW root sessions and completes', async () => {
    const h = makeHarness();
    const res = await h.run();
    expect(res).toEqual({ state: 'completed', exitCode: 0, noop: false });

    // four fresh roots, explicit model, agent orchestrator
    expect(h.server.created).toHaveLength(4);
    for (const c of h.server.created) {
      expect(c.input.model).toEqual({ providerID: 'anthropic', id: 'claude-opus-5-5' });
      expect(c.input.agent).toBe('orchestrator');
      expect(c.input.parentId).toBeUndefined();
    }
    expect(new Set(h.server.created.map((c) => c.id)).size).toBe(4);
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'phase-review', 'phase-report']);
    expect(h.server.prompts.map((p) => p.sessionId)).toEqual(h.server.created.map((c) => c.id));
    // first message is the rendered phase prompt, strictly rendered (no placeholder left)
    for (const p of h.server.prompts) expect(p.text).not.toMatch(/\{\{/);
    expect(h.server.prompts[0]?.text).toContain(h.paths.specMd);

    const m = h.manifest();
    expect(m.state).toBe('completed');
    expect(m.stopReason).toBeUndefined();
    expect(m.phase).toBe('report');
    expect(m.rootSessions.map((r) => [r.phase, r.sessionId])).toEqual(PHASE_ORDER.map((p, i) => [p, h.server.created[i]!.id]));
    expect(m.rootSessions.map((r) => r.costUsd)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(m.costUsd).toBeCloseTo(2.0, 8);
    expect(m.costEstimatedUsd).toBe(0);
    expect(m.knownSessionIds).toHaveLength(4);
    expect(m.serverUrl).toBe(h.server.url);
    expect(m.pid).toBe(4242);
    expect(m.startedAt).toBeDefined();
    expect(m.endedAt).toBeDefined();
    expect(m.defects).toEqual([]);

    // state machine and ordering of the finalization
    expect(h.stateHistory).toEqual(['running', 'completed']);
    expect(h.reportStates).toEqual(['completed']);
    expect(h.server.stopCalls).toBe(1);
    expect(h.cleanupCalls).toBe(1);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.signals.listenerCount()).toBe(0);

    // artifacts of the pump: events.jsonl and cost.jsonl
    expect(existsSync(h.paths.eventsJsonl)).toBe(true);
    const costLines = readFileSync(h.paths.costJsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect([...new Set(costLines.map((l) => l.phase))].sort()).toEqual(['build', 'plan', 'report', 'review']);
  });

  it('renders the appends into a dir handed to startRunServer, and protects the run-defining files', async () => {
    const h = makeHarness();
    await h.run();
    expect(h.startInputs).toHaveLength(1);
    const input = h.startInputs[0]!;
    expect(input).toMatchObject({ slug: SLUG, model: 'anthropic/claude-opus-5-5', smallModel: 'anthropic/claude-haiku-5-5', sandbox: true, opencodeBin: '/opt/homebrew/bin/opencode', home: h.home });
    expect(typeof input.appendsDir).toBe('string');
    expect(h.appendFiles).toEqual(['designer_append.md', 'fixer_append.md', 'oracle_append.md', 'orchestrator_append.md']);
    for (const f of h.appendFiles) expect(readFileSync(join(input.appendsDir as string, f), 'utf8')).not.toMatch(/\{\{/);

    const run = h.paths.runDir;
    expect(h.protectCalls).toHaveLength(1);
    expect(h.protectCalls[0]).toEqual([
      h.paths.specMd,
      join(run, 'opencode.json'),
      join(run, '.opencode', 'oh-my-opencode-slim.jsonc'),
      ...APPEND_AGENTS.map((a) => join(run, '.opencode', 'oh-my-opencode-slim', `${a}_append.md`)),
    ]);
  });

  it('records the detected slim version (and the opencode version) in RUN.json; nothing when unknown', async () => {
    const known = makeHarness();
    known.deps.slimVersion = '3.0.4';
    await known.run();
    expect(known.manifest()).toMatchObject({ slimVersion: '3.0.4', opencodeVersion: '2.0.29' });
    const unknown = makeHarness();
    await unknown.run();
    expect(unknown.manifest().slimVersion).toBeUndefined();
  });

  it('hands the prompt context (workspace root, instructions, skills list) to every rendered prompt', async () => {
    const h = makeHarness();
    await h.run();
    expect(h.promptVarsSeen.length).toBeGreaterThan(4);
    for (const vars of h.promptVarsSeen) {
      expect(vars).toMatchObject({ workspaceRoot: h.deps.promptContext.workspaceRoot, workspaceInstructions: 'Follow each repo AGENTS.md.', skillsList: 'skill-a, skill-b' });
    }
    expect(h.deps.serverInput.workspaceRoot).toBe(h.paths.workspaceRoot);
  });

  it('writes a heartbeat into the control flags every 30 s', async () => {
    const h = makeHarness();
    await h.run();
    const elapsed = h.clock.now() - h.start0;
    expect(h.beats.length).toBeGreaterThanOrEqual(Math.floor(elapsed / 30_000));
    expect(h.beats[0]).toBe(h.start0);
    for (let i = 1; i < h.beats.length; i++) expect(h.beats[i]! - h.beats[i - 1]!).toBe(30_000);
    const flags = readControlFlags(h.paths.controlDir);
    expect(flags.heartbeatTs).toBe(h.beats.at(-1));
    expect(flags.softStop).toBe(false);
    expect(flags.hardStop).toBe(false);
  });

  it('the report phase is not started before review wrote run-complete.json + FINAL_REVIEW.md', async () => {
    const h = makeHarness();
    let reviewSession = '';
    h.server.onPrompt = (rec, srv) => {
      if (rec.kind === 'phase-review') {
        reviewSession = rec.sessionId;
        // only the phase marker first; the run-complete files arrive 90 s later
        srv.setBusy(rec.sessionId, true);
        h.clock.setTimeout(() => {
          srv.setBusy(rec.sessionId, false);
          srv.writeRunComplete();
        }, 90_000);
        return;
      }
      autoPhases(rec, srv);
    };
    const res = await h.run();
    expect(res.state).toBe('completed');
    const review = h.server.prompts.find((p) => p.kind === 'phase-review')!;
    const report = h.server.prompts.find((p) => p.kind === 'phase-report')!;
    expect(report.at - review.at).toBeGreaterThanOrEqual(90_000);
    expect(reviewSession).toBe(review.sessionId);
    expect(h.manifest().defects).toEqual([]);
  });

  it('a review that ends on the phase marker alone completes, with a run-complete-missing defect', async () => {
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-review') {
          srv.setBusy(rec.sessionId, true);
          h.clock.setTimeout(() => {
            srv.markPhaseDone('review');
            srv.setBusy(rec.sessionId, false);
          }, 20_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.manifest().defects.map((d) => d.kind)).toEqual(['run-complete-missing']);
  });
});

describe('budget: soft', () => {
  /** Build spends up to the soft limit ($0.5 + $8.5 of $10); the root goes idle 5 s after the wind-down prompt. */
  function softHarness(opts: { busyChild?: boolean; lite?: (rec: PromptRecord, srv: FakeServer, h: Harness) => void } = {}): Harness {
    const h: Harness = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          if (opts.busyChild) srv.spawnChild(rec.sessionId); // never finishes on its own
          h.clock.setTimeout(() => srv.addCost(rec.sessionId, 8.5), 20_000);
        } else if (rec.kind === 'wind-down') {
          h.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        } else if (rec.kind === 'phase-review-lite' && opts.lite) {
          opts.lite(rec, srv, h);
        } else {
          autoPhases(rec, srv);
        }
      },
    });
    return h;
  }

  it('soft -> winding-down + softStop flag + wind-down prompt, then review-lite (new root), then the report; ends aborted-budget/budget-soft', async () => {
    const h = softHarness();
    const res = await h.run();
    expect(res).toEqual({ state: 'aborted-budget', stopReason: 'budget-soft', exitCode: 1, noop: false });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down', 'phase-review-lite', 'phase-report']); // full review skipped
    expect(rootPhaseOrder(h)).toEqual(['plan', 'build', 'review', 'report']);
    const roots = h.manifest().rootSessions.map((r) => r.sessionId);
    expect(new Set(roots).size).toBe(4); // review-lite is a NEW root session
    expect(h.stateHistory).toEqual(['running', 'winding-down', 'aborted-budget']);
    const wd = h.server.prompts.find((p) => p.kind === 'wind-down')!;
    expect(wd.sessionId).toBe(h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId);
    expect(wd.text).toContain('budget soft limit reached');
    expect(wd.text).toContain('$9.00');
    expect(wd.text).toContain('$10.00');
    expect(readControlFlags(h.paths.controlDir)).toMatchObject({ softStop: true, hardStop: false });
    expect(h.manifest().stopReason).toBe('budget-soft');
    expect(h.reportStates).toEqual(['aborted-budget']);
    expect(h.server.interrupts).toEqual([]); // nothing was busy below the roots
    expect(existsSync(join(h.paths.specsDir, 'FINAL_REVIEW.md'))).toBe(true);
    expect(h.manifest().defects.map((d) => d.kind)).toEqual([]);
    // the orchestrator records that the review in the files is the lite one (a resume must not take it for the full review)
    expect(JSON.parse(readFileSync(join(h.paths.controlDir, 'review-lite.json'), 'utf8'))).toMatchObject({ attempt: 1 });
  });

  it('waits for idle (no busy child), then review-lite, then the report phase', async () => {
    const h = softHarness();
    await h.run();
    const wd = h.server.prompts.find((p) => p.kind === 'wind-down')!;
    const lite = h.server.prompts.find((p) => p.kind === 'phase-review-lite')!;
    const report = h.server.prompts.find((p) => p.kind === 'phase-report')!;
    // root idle 5 s after the prompt, then 15 s of quiet, then the next tick
    expect(lite.at - wd.at).toBeGreaterThanOrEqual(20_000);
    expect(lite.at - wd.at).toBeLessThan(60_000);
    expect(report.at - lite.at).toBeGreaterThanOrEqual(20_000); // review-lite works for 20 s first
  });

  it('a child that never goes idle: at the 10 minute deadline it is interrupted (no hardStop flag) BEFORE review-lite and the report', async () => {
    const h = softHarness({ busyChild: true });
    const order: string[] = [];
    h.server.interruptProbe = (id) => {
      order.push(`interrupt:${id.startsWith('ses_child') ? 'child' : 'root'}@${h.clock.now() - h.start0}:flag=${readControlFlags(h.paths.controlDir).hardStop}`);
    };
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-soft' });
    const wd = h.server.prompts.find((p) => p.kind === 'wind-down')!;
    const lite = h.server.prompts.find((p) => p.kind === 'phase-review-lite')!;
    const report = h.server.prompts.find((p) => p.kind === 'phase-report')!;
    expect(lite.at - wd.at).toBeGreaterThanOrEqual(10 * 60_000);
    expect(lite.at - wd.at).toBeLessThan(10 * 60_000 + 30_000);
    const child = [...h.server.sessions.values()].find((x) => x.id.startsWith('ses_child'))!;
    expect(h.server.interrupts).toEqual([child.id]); // only the non-root busy session
    expect(order).toHaveLength(1);
    expect(order[0]).toMatch(/^interrupt:child@.*:flag=false$/);
    const interruptAt = h.start0 + Number(/@(\d+):/.exec(order[0]!)![1]);
    expect(interruptAt).toBeLessThanOrEqual(lite.at);
    expect(interruptAt).toBeLessThan(report.at);
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(false);
  });

  it('review-lite is capped at 10 minutes: a defect, the lite root is interrupted, the report still runs', async () => {
    const h = softHarness({ lite: (rec, srv) => srv.setBusy(rec.sessionId, true) }); // never writes FINAL_REVIEW.md
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-soft' });
    const lite = h.server.prompts.find((p) => p.kind === 'phase-review-lite')!;
    const report = h.server.prompts.find((p) => p.kind === 'phase-report')!;
    expect(report.at - lite.at).toBeGreaterThanOrEqual(10 * 60_000);
    expect(report.at - lite.at).toBeLessThan(10 * 60_000 + 60_000);
    expect(h.server.interrupts).toContain(lite.sessionId);
    expect(h.manifest().defects.map((d) => d.kind)).toContain('review-lite-timeout');
  });

  it('a hard trip during review-lite skips straight to the stop sequence (no report phase)', async () => {
    const h = softHarness({
      lite: (rec, srv, hh) => {
        srv.setBusy(rec.sessionId, true);
        hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 5), 10_000); // 9.5 + 5 > 10
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-hard' });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down', 'phase-review-lite']);
    expect(h.stateHistory).toEqual(['running', 'winding-down', 'stopping', 'aborted-budget']);
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(true);
  });

  it('the review-lite root is exempt from the run-complete watchdog: FINAL_REVIEW.md alone finishes it', async () => {
    const h = softHarness();
    await h.run();
    expect(h.logs.some((l) => l.event === 'phase.end' && l.fields.lite === true && l.fields.outcome === 'done')).toBe(true);
  });

  it('soft tripping during the report phase does not wind anything down; all four phases finished, so it is completed (budget-soft)', async () => {
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-report') {
          srv.completePhase(rec.sessionId, 'report', { afterMs: 30_000, costUsd: 7.5 }); // 1.5 + 7.5 = 9.0 >= 8.5
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'completed', stopReason: 'budget-soft', exitCode: 0 });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'phase-review', 'phase-report']);
    expect(h.stateHistory).toEqual(['running', 'completed']);
  });

  it('full completion without any soft trip is completed with no stopReason', async () => {
    const h = makeHarness();
    const res = await h.run();
    expect(res).toEqual({ state: 'completed', exitCode: 0, noop: false });
    expect(kinds(h)).not.toContain('phase-review-lite');
  });
});

describe('wall clock soft limit (T-30 min)', () => {
  it('starts the soft wind-down 30 min before the wall clock; review-lite and report follow; ends failed/wallclock-soft', async () => {
    const h = makeHarness({
      watchdog: { wallclockMs: 60 * 60_000, hungMs: 10 * 3_600_000 },
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') srv.setBusy(rec.sessionId, true); // working "forever"
        else if (rec.kind === 'wind-down') hh.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toEqual({ state: 'failed', stopReason: 'wallclock-soft', exitCode: 1, noop: false });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down', 'phase-review-lite', 'phase-report']);
    const wd = h.server.prompts.find((p) => p.kind === 'wind-down')!;
    expect(wd.at - h.start0).toBeGreaterThanOrEqual(30 * 60_000);
    expect(wd.at - h.start0).toBeLessThan(31 * 60_000);
    expect(wd.text).toContain('wall clock soft limit');
    expect(h.stateHistory).toEqual(['running', 'winding-down', 'failed']);
    expect(h.manifest().stopReason).toBe('wallclock-soft');
    expect(h.clock.now() - h.start0).toBeLessThan(60 * 60_000); // the hard wall clock never fired
    expect(readControlFlags(h.paths.controlDir)).toMatchObject({ softStop: true, hardStop: false });
  });

  it('the hard wall clock still stops the run if the wind-down sequence does not finish in time', async () => {
    const h = makeHarness({
      watchdog: { wallclockMs: 35 * 60_000, hungMs: 10 * 3_600_000 }, // soft at 5 min
      script: (rec, srv) => {
        if (['phase-build', 'phase-review-lite', 'phase-report'].includes(rec.kind)) srv.setBusy(rec.sessionId, true); // never finish
        else if (rec.kind === 'wind-down') return; // the root ignores it
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'wallclock' });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down', 'phase-review-lite', 'phase-report']);
  });
});

describe('budget: hard', () => {
  it('stops with children busy: hardStop flag first, deepest children first, then the root, repeated; aborted-budget', async () => {
    let flagAtFirstInterrupt: boolean | undefined;
    let child = '';
    let grandchild = '';
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          child = srv.spawnChild(rec.sessionId, 'fixer');
          grandchild = srv.spawnChild(child, 'explorer');
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 11), 40_000); // way past the $10 hard limit
          return;
        }
        autoPhases(rec, srv);
      },
    });
    h.server.childWakesParent = true;
    h.server.interruptProbe = () => {
      flagAtFirstInterrupt ??= readControlFlags(h.paths.controlDir).hardStop;
    };
    const res = await h.run();
    expect(res).toEqual({ state: 'aborted-budget', stopReason: 'budget-hard', exitCode: 1, noop: false });

    const buildRoot = h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId;
    expect(h.server.interrupts.slice(0, 3)).toEqual([grandchild, child, buildRoot]);
    expect(flagAtFirstInterrupt).toBe(true);
    // repeated until two quiet rounds in a row (root is interrupted every round, children only while active)
    expect(h.server.interrupts.length).toBeGreaterThan(3);
    expect(h.server.interrupts.slice(3).every((id) => id === buildRoot)).toBe(true);
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build']); // no further phases, no narrative

    expect(h.stateHistory).toEqual(['running', 'stopping', 'aborted-budget']);
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(true);
    const m = h.manifest();
    expect(m.costUsd).toBeCloseTo(11.5, 8);
    expect(m.stopReason).toBe('budget-hard');
    expect(h.server.stopCalls).toBe(1);
    expect(h.reportStates).toEqual(['aborted-budget']);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.cleanupCalls).toBe(1);
  });

  it('keeps going for the whole window while busy sessions keep coming back (children wake the parent)', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 11), 20_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    // a stubborn root: every interrupt immediately restarts it
    h.server.onInterrupt = (id, _was, srv) => {
      if (srv.stopped) return;
      h.clock.setTimeout(() => srv.setBusy(id, true), 100);
    };
    const t0 = h.clock.now();
    let hardAt = 0;
    h.server.interruptProbe = () => {
      hardAt ||= h.clock.now();
    };
    const res = await h.run();
    expect(res.state).toBe('aborted-budget');
    const rounds = h.server.interrupts.filter((id) => id.startsWith('ses_root')).length;
    expect(rounds).toBeGreaterThanOrEqual(10); // 30 s / 3 s
    expect(h.clock.now() - hardAt).toBeGreaterThanOrEqual(30_000);
    expect(t0).toBeLessThan(hardAt);
  });

  it('hard tripping during the report phase skips the narrative and ends aborted-budget', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-report') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 20), 10_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-hard' });
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'phase-review', 'phase-report']);
    expect(h.server.interrupts).toContain(h.server.prompts.find((p) => p.kind === 'phase-report')!.sessionId);
    expect(h.reportStates).toEqual(['aborted-budget']);
  });

  it('hard after soft (wind-down in progress) still ends aborted-budget', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 8.5), 20_000); // soft
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 5), 60_000); // hard
          return;
        }
        if (rec.kind === 'wind-down') return; // root keeps working
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-hard' });
    expect(h.stateHistory).toEqual(['running', 'winding-down', 'stopping', 'aborted-budget']);
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down']);
  });

  it('a failing final reconcile is logged and the last ledger is used', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => {
            srv.addCost(rec.sessionId, 11);
            hh.clock.setTimeout(() => {
              srv.listError = new RunApiError({ kind: 'http', message: 'down', method: 'GET', path: '/api/session', status: 503 });
            }, 6_000);
          }, 20_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('aborted-budget');
    expect(h.logs.some((l) => l.event === 'final_reconcile.failed')).toBe(true);
    expect(h.manifest().costUsd).toBeCloseTo(11.5, 8);
  });
});

describe('permission auto-reject', () => {
  it('rejects permission.asked, records a defect in RUN.json, and the run carries on', async () => {
    let asked: { id: string; sessionID: string } | undefined;
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => {
            asked = srv.askPermission(rec.sessionId, 'shell', ['git push origin main']);
          }, 10_000);
          hh.clock.setTimeout(() => {
            srv.markPhaseDone('build');
            srv.setBusy(rec.sessionId, false);
          }, 40_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.server.replies).toEqual([{ sessionId: asked!.sessionID, requestId: asked!.id, reply: 'reject' }]);
    const defects = h.manifest().defects;
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ kind: 'permission-asked', sessionId: asked!.sessionID });
    expect(defects[0]?.message).toContain('git push origin main');
  });
});

describe('watchdog', () => {
  it('nudges an idle root (3 min), then stalls after 3 nudges without progress', async () => {
    const h = makeHarness({ script: () => undefined });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'stalled', exitCode: 1 });
    expect(res.stopReason).toMatch(/3 nudges without progress/);
    const nudges = h.server.prompts.filter((p) => p.kind === 'nudge');
    expect(nudges).toHaveLength(3);
    const planRoot = h.server.prompts[0]!;
    expect(planRoot.kind).toBe('phase-plan');
    expect(nudges.every((n) => n.sessionId === planRoot.sessionId)).toBe(true);
    expect(nudges[0]!.at - planRoot.at).toBeGreaterThanOrEqual(180_000);
    expect(nudges[0]!.at - planRoot.at).toBeLessThan(200_000);
    expect(nudges[0]!.text).toContain('`plan` phase');
    expect(nudges[0]!.text).not.toMatch(/\{\{/);
    expect(h.manifest().nudges).toBe(3);
    expect(h.manifest().state).toBe('stalled');
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'stalled', stopReason: res.stopReason, endedAt: h.manifest().endedAt });
    expect(h.reportStates).toEqual(['stalled']);
    expect(h.server.stopCalls).toBe(1);
    expect(h.server.interrupts).toEqual([]);
  });

  it('a nudge that unsticks the agent lets the run complete (nudges are counted)', async () => {
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-plan') return; // ignores the first message
        if (rec.kind === 'nudge') srv.completePhase(rec.sessionId, 'plan', { afterMs: 10_000, costUsd: 0.5 });
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.manifest().nudges).toBe(1);
    expect(kinds(h).filter((k) => k === 'nudge')).toHaveLength(1);
  });

  it('interrupts a hung session (busy, no events for the hung period, 20 min here), then the phase can finish', async () => {
    let hungAt = 0;
    const h = makeHarness({
      watchdog: { hungMs: 20 * 60_000 },
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true); // and silence from here on
          hungAt = h.clock.now();
          return;
        }
        autoPhases(rec, srv);
      },
    });
    h.server.onInterrupt = (id, wasBusy, srv) => {
      if (wasBusy && id === h.server.prompts.find((p) => p.kind === 'phase-build')?.sessionId) srv.markPhaseDone('build');
    };
    const res = await h.run();
    expect(res.state).toBe('completed');
    const buildRoot = h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId;
    expect(h.server.interrupts).toEqual([buildRoot]);
    expect(h.logs.some((l) => l.event === 'watchdog.action' && l.fields.type === 'abort-session' && l.fields.id === buildRoot)).toBe(true);
    const abortLog = h.logs.find((l) => l.event === 'watchdog.action' && l.fields.type === 'abort-session')!;
    const abortAt = Date.parse(abortLog.fields.ts as string);
    expect(abortAt - hungAt).toBeGreaterThanOrEqual(20 * 60_000);
    expect(abortAt - hungAt).toBeLessThan(21 * 60_000);
  });

  describe('hung detection with running tools', () => {
    function buildHang(withTool: boolean): Harness {
      const h: Harness = makeHarness({
        script: (rec, srv) => {
          if (rec.kind === 'phase-build') {
            srv.setBusy(rec.sessionId, true); // and silence from here on
            if (withTool) srv.toolCalled(rec.sessionId, 'tool-1');
            return;
          }
          autoPhases(rec, srv);
        },
      });
      h.server.onInterrupt = (id, wasBusy, srv) => {
        if (wasBusy && id === h.server.prompts.find((p) => p.kind === 'phase-build')?.sessionId) srv.markPhaseDone('build');
      };
      return h;
    }
    const abortAt = (h: Harness): number => Date.parse(h.logs.find((l) => l.event === 'watchdog.action' && l.fields.type === 'abort-session')!.fields.ts as string) - h.start0;

    it('default: a silent busy session is aborted after 40 min', async () => {
      const h = buildHang(false);
      expect((await h.run()).state).toBe('completed');
      expect(abortAt(h)).toBeGreaterThanOrEqual(40 * 60_000);
      expect(abortAt(h)).toBeLessThan(41 * 60_000);
    });

    it('a session with a tool call in flight is not hung until the tool has run for 60 min', async () => {
      const h = buildHang(true);
      expect((await h.run()).state).toBe('completed');
      const at = abortAt(h);
      expect(at).toBeGreaterThanOrEqual(60 * 60_000);
      expect(at).toBeLessThan(61 * 60_000);
    });

    it('when the tool ends the normal hung period applies again', async () => {
      const h = buildHang(true);
      const build = (): string => h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId;
      h.clock.setTimeout(() => h.server.toolEnded(build(), 'tool-1'), 50 * 60_000); // 50 min in: the tool ends, then silence
      expect((await h.run()).state).toBe('completed');
      const at = abortAt(h);
      expect(at).toBeGreaterThanOrEqual(90 * 60_000); // 50 min + 40 min of silence
      expect(at).toBeLessThan(91 * 60_000);
    });
  });

  it('429s back the watchdog off: no nudge while errors persist, nudging resumes after the backoff', async () => {
    const rateLimited = () => new RunApiError({ kind: 'http', message: 'rate limited', method: 'GET', path: '/api/session', status: 429 });
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-plan') {
          srv.listError = rateLimited(); // every poll fails until t+900 s
          h.clock.setTimeout(() => (srv.listError = undefined), 900_000);
        } else if (rec.kind === 'nudge') {
          srv.completePhase(rec.sessionId, 'plan', { afterMs: 10_000, costUsd: 0.5 });
        } else {
          autoPhases(rec, srv);
        }
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    const firstNudge = h.server.prompts.find((p) => p.kind === 'nudge')!;
    // Without the errors the first nudge lands at ~180 s. Polls fail every 45 s, so the backoff escalates
    // 1, 2, 4, 8 min (errors inside an active backoff do not escalate) and ends at ~1020 s.
    expect(firstNudge.at - h.start0).toBeGreaterThanOrEqual(900_000);
    const backoffs = h.logs.filter((l) => l.event === 'watchdog.action' && l.fields.type === 'backoff');
    expect(backoffs.length).toBeGreaterThanOrEqual(4);
    expect(h.logs.some((l) => l.event === 'pump.error')).toBe(true);
    expect(h.manifest().nudges).toBe(1);
  });

  it('wall clock exceeded -> failed/wallclock, report written', async () => {
    const h = makeHarness({
      watchdog: { wallclockMs: 30 * 60_000, hungMs: 10 * 3_600_000 },
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') srv.setBusy(rec.sessionId, true);
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'wallclock', exitCode: 1 });
    expect(h.reportStates).toEqual(['failed']);
    expect(h.clock.now() - h.start0).toBeGreaterThan(30 * 60_000);
    expect(h.clock.now() - h.start0).toBeLessThan(32 * 60_000);
  });
});

describe('tripwires', () => {
  const repo = { name: 'r', path: '/tmp/repo-x', defaultBranch: 'main', baseline: { head: 'a'.repeat(40), branch: 'main', porcelainHash: 'h', stashCount: 0 } };

  it('checks every 5 minutes with the manifest baseline and the protected files; a violation is a defect plus a hard stop', async () => {
    const h = makeHarness({
      repos: [repo],
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') srv.setBusy(rec.sessionId, true);
        else autoPhases(rec, srv);
      },
    });
    h.violationsQueue.push([], [{ kind: 'head', path: '/tmp/repo-x', message: 'HEAD changed in /tmp/repo-x' }]);
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'tripwire:head', exitCode: 1 });

    expect(h.tripwireCalls).toHaveLength(2);
    expect(h.tripwireCalls[0]).toMatchObject({ baseline: { '/tmp/repo-x': repo.baseline }, repos: ['/tmp/repo-x'] });
    expect(h.tripwireCalls[0]?.protectedFiles).toHaveLength(7); // SPEC.md, opencode.json, slim jsonc, 4 appends
    const m = h.manifest();
    expect(m.defects.map((d) => d.kind)).toEqual(['tripwire:head']);
    expect(m.defects[0]?.message).toContain('HEAD changed');
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(true);
    const buildRoot = h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId;
    expect(h.server.interrupts).toContain(buildRoot);
    expect(h.stateHistory).toEqual(['running', 'stopping', 'failed']);
    expect(h.reportStates).toEqual(['failed']);
    // 2nd check is at ~10 min
    expect(h.clock.now() - h.start0).toBeGreaterThanOrEqual(10 * 60_000);
    expect(h.clock.now() - h.start0).toBeLessThan(11 * 60_000);
  });

  const other = { name: 'other', path: '/tmp/other-repo', defaultBranch: '-', baseline: { head: 'b'.repeat(40), branch: 'main', porcelainHash: 'h0', stashCount: 0 } };
  const buildScript = (rec: PromptRecord, srv: FakeServer): void => {
    if (rec.kind === 'phase-build') srv.completePhase(rec.sessionId, 'build', { afterMs: 12 * 60_000, costUsd: 0.5 });
    else autoPhases(rec, srv);
  };

  it('a change in ANOTHER workspace repo is only a tripwire-other-repo defect: no stop, re-baselined, reported once', async () => {
    const h = makeHarness({ repos: [repo, other], script: buildScript });
    h.violationsQueue.push([{ kind: 'head', path: other.path, message: `HEAD changed in ${other.path}` }, { kind: 'porcelain', path: other.path, message: 'x' }], [], []);
    const res = await h.run();
    expect(res).toMatchObject({ state: 'completed', exitCode: 0 });
    const m = h.manifest();
    expect(m.defects.map((d) => d.kind)).toEqual(['tripwire-other-repo']); // one defect for the repo, both kinds listed
    expect(m.defects[0]?.message).toContain('head, porcelain');
    expect(m.defects[0]?.message).toContain(other.path);
    expect(h.rebaselined).toEqual([other.path]);
    expect(m.repos.find((r) => r.path === other.path)?.baseline.head).toBe('new-head');
    expect(m.repos.find((r) => r.path === repo.path)?.baseline.head).toBe(repo.baseline.head); // spec repo untouched
    expect(h.tripwireCalls[1]).toMatchObject({ baseline: { [other.path]: { head: 'new-head' } } }); // later checks use the new baseline
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(false);
    expect(h.server.interrupts).toEqual([]);
    expect(h.logs.some((l) => l.event === 'tripwire.other_repo')).toBe(true);
  });

  it('a spec-repo violation next to an other-repo one is still a hard stop; the other repo is recorded too', async () => {
    const h = makeHarness({ repos: [repo, other], script: buildScript });
    h.violationsQueue.push([
      { kind: 'branch', path: other.path, message: 'Branch changed in other' },
      { kind: 'head', path: repo.path, message: 'HEAD changed in spec repo' },
    ]);
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'tripwire:head' });
    expect(h.manifest().defects.map((d) => d.kind).sort()).toEqual(['tripwire-other-repo', 'tripwire:head']);
  });

  it('a protected-file violation is a hard stop whatever repo it sits next to', async () => {
    const h = makeHarness({ repos: [other], script: buildScript });
    h.violationsQueue.push([{ kind: 'protected-changed', path: '/x/opencode.json', message: 'Protected file modified' }]);
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'tripwire:protected-changed' });
  });

  it('a repo that cannot be re-baselined is muted instead of reported every five minutes', async () => {
    const h = makeHarness({
      repos: [other],
      script: buildScript,
      rebaseline: async () => {
        throw new Error('git is broken');
      },
    });
    h.violationsQueue.push([{ kind: 'git-error', path: other.path, message: 'Cannot inspect' }]);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.manifest().defects.map((d) => d.kind)).toEqual(['tripwire-other-repo']);
    expect(h.tripwireCalls.at(-1)).toMatchObject({ repos: [] });
  });

  it('a throwing tripwire check is logged and does not stop the run', async () => {
    const h = makeHarness({ repos: [repo] });
    h.deps.checkTripwires = async () => {
      throw new Error('git exploded');
    };
    const res = await h.run();
    expect(res.state).toBe('completed');
  });
});

describe('signals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s -> graceful stop (interrupt everything, no hardStop flag) -> stopped, report written', async (sig) => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          srv.spawnChild(rec.sessionId);
          hh.clock.setTimeout(() => hh.signals.emit(sig), 60_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    h.server.childWakesParent = true;
    const res = await h.run();
    expect(res).toMatchObject({ state: 'stopped', stopReason: `signal:${sig}`, exitCode: 1 });
    const buildRoot = h.server.prompts.find((p) => p.kind === 'phase-build')!.sessionId;
    expect(h.server.interrupts.length).toBeGreaterThanOrEqual(2);
    expect(h.server.interrupts[0]).not.toBe(buildRoot); // child first
    expect(h.server.interrupts).toContain(buildRoot);
    expect(readControlFlags(h.paths.controlDir).hardStop).toBe(false);
    expect(h.stateHistory).toEqual(['running', 'stopping', 'stopped']);
    expect(h.reportStates).toEqual(['stopped']);
    expect(h.server.stopCalls).toBe(1);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.cleanupCalls).toBe(1);
    expect(h.signals.listenerCount()).toBe(0);
  });

  it('a signal during server startup still ends in stopped + report', async () => {
    const h = makeHarness();
    const origStart = h.deps.startServer;
    h.deps.startServer = async (input) => {
      h.signals.emit('SIGTERM');
      return origStart(input);
    };
    const res = await h.run();
    expect(res).toMatchObject({ state: 'stopped', stopReason: 'signal:SIGTERM' });
    expect(h.server.created).toHaveLength(0);
    expect(h.server.stopCalls).toBe(1);
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'stopped', stopReason: 'signal:SIGTERM', endedAt: h.manifest().endedAt });
    expect(h.reportStates).toEqual(['stopped']);
  });
});

describe('failures and finalization', () => {
  it('an exception inside a phase -> failed + defect + report + lock released + server stopped + launchd cleaned', async () => {
    const h = makeHarness();
    h.server.createError = new Error('boom');
    h.server.failCreateAt = new Set([2]); // the build phase
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(res.stopReason).toBe('exception: boom');
    const m = h.manifest();
    expect(m.state).toBe('failed');
    expect(m.defects.map((d) => d.kind)).toEqual(['orchestrator-exception']);
    expect(m.endedAt).toBeDefined();
    expect(kinds(h)).toEqual(['phase-plan']);
    expect(h.reportStates).toEqual(['failed']);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.server.stopCalls).toBe(1);
    expect(h.cleanupCalls).toBe(1);
  });

  it('transient API errors are retried (5xx on createSession), non-transient are not', async () => {
    const h = makeHarness();
    h.server.createError = new RunApiError({ kind: 'http', message: 'bad gateway', method: 'POST', path: '/api/session', status: 502 });
    h.server.failCreateAt = new Set([1]);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(h.logs.some((l) => l.event === 'retry')).toBe(true);
  });

  it('the server process dying mid-run -> failed/server-exited + report', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.crash(), 20_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'server-exited', exitCode: 1 });
    expect(h.reportStates).toEqual(['failed']);
    expect(h.server.interrupts).toEqual([]); // nothing to interrupt on a dead server
  });

  it('finalization always runs: report, shutdown and cleanup errors never escape, the lock is still released', async () => {
    const h = makeHarness({
      writeReportError: new Error('report failed'),
      cleanupError: new Error('bootout failed'),
      serverStopError: new Error('kill failed'),
    });
    h.server.createError = new Error('boom');
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(h.reportStates).toEqual(['failed']);
    expect(h.cleanupCalls).toBe(1);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(h.logs.map((l) => l.event)).toEqual(expect.arrayContaining(['report.failed', 'server_stop.failed', 'launchd.cleanup_failed']));
    expect(h.manifest().state).toBe('failed');
  });

  it('runOrchestrator never throws, even with a broken logger and unreadable state', async () => {
    const h = makeHarness();
    h.deps.logger = () => {
      throw new Error('logger down');
    };
    await expect(h.run()).resolves.toMatchObject({ state: 'completed' });

    const h2 = makeHarness();
    rmSync(h2.paths.runJson);
    await expect(h2.run()).resolves.toMatchObject({ exitCode: 1, noop: true });
  });

  it('records the final ledger (costUsd, estimated part, per-phase root costs) even on failure', async () => {
    const h = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') {
          srv.completePhase(rec.sessionId, 'build', { afterMs: 10_000, costUsd: 1.25 });
          return;
        }
        autoPhases(rec, srv);
      },
    });
    h.server.createError = new Error('boom');
    h.server.failCreateAt = new Set([3]); // review
    const res = await h.run();
    expect(res.state).toBe('failed');
    const m = h.manifest();
    expect(m.costUsd).toBeCloseTo(1.75, 8);
    expect(m.rootSessions.map((r) => [r.phase, r.costUsd])).toEqual([
      ['plan', 0.5],
      ['build', 1.25],
    ]);
  });
});

describe('logging', () => {
  it('writes one structured line per decision', async () => {
    const h = makeHarness();
    await h.run();
    const events = h.logs.map((l) => l.event);
    for (const e of ['state', 'protected', 'preflight.ok', 'phase.start', 'phase.end', 'final']) expect(events).toContain(e);
    for (const l of h.logs) expect(typeof l.fields.ts).toBe('string');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Attempt lifecycle (T9a)
// ---------------------------------------------------------------------------------------------------------------

const lastAttempt = (h: Harness) => h.manifest().attempts!.at(-1)!;

/** Attempt 1 of a resumed run (closed after a hard stop; its budget was $5) and the open attempt 2 ($10 budget, $4 already spent). */
const OLD = { n: 1, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z', state: 'aborted-budget', stopReason: 'budget-hard', budgetUsd: 5, costAtStartUsd: 0, costUsd: 4 } as const;
const OPEN = { n: 2, startedAt: '2026-01-02T00:00:00.000Z', budgetUsd: 10, costAtStartUsd: 4 } as const;
const CostLineOf = (l: Record<string, unknown>) => ({ ...l }) as never;

/** One `tasks.jsonl` line, as an agent would write it. */
const taskLine = (id: string, state: string, phase: Phase, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ ts: '2026-01-01T00:40:00.000Z', id, repo: '_run', branch: '-', worktree: '/Users/alice/work/.specs/demo-run', state, attempt: 0, verify: [], phase, ...extra })}\n`;
const seedTasks = (h: Harness, ...lines: string[]): void => {
  mkdirSync(dirname(h.paths.tasksJsonl), { recursive: true });
  writeFileSync(h.paths.tasksJsonl, lines.join(''));
};
const runComplete = (h: Harness): string => join(h.paths.runDir, 'run-complete.json');
const finalReview = (h: Harness): string => join(h.paths.specsDir, 'FINAL_REVIEW.md');
const liteMarker = (h: Harness): string => join(h.paths.controlDir, 'review-lite.json');
/** The files a review leaves behind (the full one, or the lite one with `lite`). */
const seedReviewMarkers = (h: Harness, lite = false): void => {
  writeFileSync(runComplete(h), `${JSON.stringify({ type: 'run.complete', ts: '2026-01-01T00:50:00.000Z', summary: 'old', finalReviewPath: finalReview(h) })}\n`);
  writeFileSync(finalReview(h), '# Final review (attempt 1)\n');
  if (lite) writeFileSync(liteMarker(h), `${JSON.stringify({ attempt: 1, ts: '2026-01-01T00:50:00.000Z' })}\n`);
};

/**
 * A resumed run: attempt 1 spent $4 in one (old) plan root, recorded in cost.jsonl, and finished the plan phase
 * (`phase:plan` done in tasks.jsonl); attempt 2 has a $10 budget. Pass `tasks` to seed a different tasks.jsonl.
 */
function resumed(o: Opts = {}, tasks: string[] = [taskLine('phase:plan', 'done', 'plan')]): { h: Harness; oldRoot: string } {
  const h = makeHarness(o);
  seedTasks(h, ...tasks);
  const oldRoot = h.server.seedSession(4);
  const line = { ts: '2026-01-01T00:30:00.000Z', sessionId: oldRoot, parentId: null, phase: 'plan', costUsd: 4, estimated: false, source: 'session-info', totalUsd: 4 };
  mkdirSync(dirname(h.paths.costJsonl), { recursive: true });
  writeFileSync(h.paths.costJsonl, `${JSON.stringify(line)}\n`);
  writeManifest(
    h.paths.runJson,
    RunManifest.parse({
      ...h.manifest(),
      startedAt: OLD.startedAt,
      costUsd: 4,
      rootSessions: [{ phase: 'plan', sessionId: oldRoot, costUsd: 4 }],
      knownSessionIds: [oldRoot],
      attempts: [OLD, OPEN],
    }),
  );
  h.deps.ledger = new BudgetLedger({
    budgetUsd: 10,
    softPct: 0.85,
    hardPct: 1,
    costMultiplier: 1,
    now: () => new Date(h.clock.now()),
    costLines: [CostLineOf(line)],
    costAtStartUsd: 4,
  });
  return { h, oldRoot };
}

describe('attempt lifecycle: a fresh launch', () => {
  it('writes attempts[0] at start (open, with the budget and a zero cost at start) and closes it when the run completes', async () => {
    let atPlan: RunManifest | undefined;
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-plan') atPlan = hh.manifest();
        autoPhases(rec, srv);
      },
    });
    expect(h.manifest().attempts).toBeUndefined();
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(atPlan?.attempts).toEqual([{ n: 1, startedAt: atPlan!.startedAt, budgetUsd: 10, costAtStartUsd: 0 }]);
    const m = h.manifest();
    expect(m.attempts).toHaveLength(1);
    expect(m.attempts![0]).toEqual({
      n: 1,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      state: 'completed',
      budgetUsd: 10,
      costAtStartUsd: 0,
      costUsd: 2, // four phases at $0.5
    });
    expect(h.logs.find((l) => l.event === 'attempt.start')?.fields).toMatchObject({
      attempt: 1,
      budgetUsd: 10,
      costAtStartUsd: 0,
      baselineUsd: 0,
      priorCostUsd: 0,
    });
  });
});

describe('attempt lifecycle: every end path closes the open attempt', () => {
  const closedWith = (h: Harness, state: RunState, stopReason: string | undefined, costUsd: number): void => {
    const m = h.manifest();
    expect(m.attempts).toHaveLength(1);
    const a = m.attempts![0]!;
    expect(a).toMatchObject({ n: 1, state, endedAt: m.endedAt, budgetUsd: 10, costAtStartUsd: 0 });
    expect(a.stopReason).toBe(stopReason);
    expect(a.costUsd).toBeCloseTo(costUsd, 8);
    expect(m.state).toBe(state);
    expect(m.costUsd).toBeCloseTo(costUsd, 8);
  };

  it('soft wind-down (budget): aborted-budget / budget-soft', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 8.5), 20_000);
        } else if (rec.kind === 'wind-down') hh.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-soft' });
    closedWith(h, 'aborted-budget', 'budget-soft', 9.7); // plan .5 + build 8.5 + review-lite .2 + report .5
  });

  it('soft wind-down (wall clock): failed / wallclock-soft', async () => {
    const h = makeHarness({
      watchdog: { wallclockMs: 60 * 60_000, hungMs: 10 * 3_600_000 },
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') srv.setBusy(rec.sessionId, true);
        else if (rec.kind === 'wind-down') hh.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'wallclock-soft' });
    closedWith(h, 'failed', 'wallclock-soft', 1.2);
  });

  it('hard budget stop: aborted-budget / budget-hard', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 11), 40_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-hard' });
    closedWith(h, 'aborted-budget', 'budget-hard', 11.5);
  });

  it('tripwire violation: failed / tripwire:<kind>', async () => {
    const h = makeHarness({
      repos: [{ name: 'acme-api', path: '/Users/alice/work/acme-api', defaultBranch: 'main', baseline: { head: 'h1', branch: 'main', porcelainHash: 'p1', stashCount: 0 } }],
      script: (rec, srv) => {
        if (rec.kind === 'phase-plan') srv.setBusy(rec.sessionId, true);
        else autoPhases(rec, srv);
      },
    });
    h.violationsQueue.push([{ kind: 'head', path: '/Users/alice/work/acme-api', message: 'HEAD moved' }]);
    const res = await h.run();
    expect(res.state).toBe('failed');
    expect(res.stopReason).toBe('tripwire:head');
    const a = lastAttempt(h);
    expect(a).toMatchObject({ n: 1, state: 'failed', stopReason: res.stopReason, endedAt: h.manifest().endedAt });
  });

  it('user stop (SIGTERM): stopped / signal:SIGTERM', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => hh.signals.emit('SIGTERM'), 60_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'stopped', stopReason: 'signal:SIGTERM' });
    closedWith(h, 'stopped', 'signal:SIGTERM', 0.5);
  });

  it('failure (an exception in a phase): failed / exception', async () => {
    const h = makeHarness();
    h.server.createError = new Error('boom');
    h.server.failCreateAt = new Set([2]);
    const res = await h.run();
    expect(res.state).toBe('failed');
    closedWith(h, 'failed', 'exception: boom', 0.5);
  });

  it('the server dying: failed / server-exited', async () => {
    const h = makeHarness({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.crash(), 20_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'server-exited' });
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'failed', stopReason: 'server-exited' });
  });

  it('an early failure (preflight) closes the attempt too, with a zero spend', async () => {
    const h = makeHarness({ preflight: async () => ({ ok: false, failures: ['no'] }) });
    const res = await h.run();
    expect(res.stopReason).toBe('preflight-failed');
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'failed', stopReason: 'preflight-failed', costUsd: 0 });
  });

  it('a v1 manifest (no attempts, schema v1 on disk) gets its implicit attempt written at start and closed at the end', async () => {
    const h = makeHarness();
    const { workspaceRoot: _ws, attempts: _a, ...v1 } = h.manifest();
    writeFileSync(h.paths.runJson, `${JSON.stringify({ ...v1, schemaVersion: 1 })}\n`);
    expect(JSON.parse(readFileSync(h.paths.runJson, 'utf8')).attempts).toBeUndefined();
    const res = await h.run();
    expect(res.state).toBe('completed');
    const m = h.manifest();
    expect(m.attempts).toEqual([{ n: 1, startedAt: m.startedAt, endedAt: m.endedAt, state: 'completed', budgetUsd: 10, costAtStartUsd: 0, costUsd: 2 }]);
  });

  it('if the start write never landed, finalize builds the implicit attempt from the top-level fields and closes it', async () => {
    const h = makeHarness();
    let first = true;
    h.deps.state = {
      ...h.deps.state,
      updateManifest: (p, fn) =>
        realStateOps.updateManifest(p, (m) => {
          fn(m);
          if (first) {
            first = false;
            delete m.attempts; // simulate an older writer that drops the field
          }
        }),
    };
    const res = await h.run();
    expect(res.state).toBe('completed');
    const m = h.manifest();
    expect(m.attempts).toEqual([{ n: 1, startedAt: m.startedAt, endedAt: m.endedAt, state: 'completed', budgetUsd: 10, costAtStartUsd: 0, costUsd: 2 }]);
  });
});

describe('attempt lifecycle: start-up assertions', () => {
  const withAttempts = (h: Harness, attempts: unknown[], extra: Record<string, unknown> = {}): void => {
    writeManifest(h.paths.runJson, RunManifest.parse({ ...h.manifest(), startedAt: '2026-01-01T00:00:00.000Z', costUsd: 4, attempts, ...extra }));
  };
  const failedLoudly = async (h: Harness): Promise<void> => {
    const before = h.manifest().attempts ?? [];
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'attempt-invariant', exitCode: 1, noop: false });
    expect(h.startInputs).toHaveLength(0); // no server was started
    expect(h.server.prompts).toHaveLength(0);
    const m = h.manifest();
    expect(m.state).toBe('failed');
    expect(m.defects.map((d) => d.kind)).toEqual(['attempt-invariant']);
    expect(h.logs.some((l) => l.event === 'attempt.invariant_failed')).toBe(true);
    expect(h.reportStates).toEqual(['failed']);
    expect(h.cleanupCalls).toBe(1);
    expect(existsSync(h.lockPath)).toBe(false);
    expect(m.attempts!.slice(0, Math.max(0, before.length - 1))).toEqual(before.slice(0, -1)); // earlier attempts untouched
  };

  it('a last attempt that is already closed fails the start and is not rewritten', async () => {
    const h = makeHarness();
    withAttempts(h, [OLD]);
    await failedLoudly(h);
    expect(h.manifest().attempts).toEqual([OLD]);
    expect(h.manifest().defects[0]!.message).toContain('already closed');
  });

  it('an attempt budget that differs from RUN.json budgetUsd fails the start (the attempt is closed as failed)', async () => {
    const h = makeHarness();
    withAttempts(h, [OLD, { ...OPEN, budgetUsd: 7 }]);
    await failedLoudly(h);
    expect(h.manifest().defects[0]!.message).toContain('does not match');
    expect(lastAttempt(h)).toMatchObject({ n: 2, state: 'failed', stopReason: 'attempt-invariant' });
  });

  it('a ledger built for another budget fails the start', async () => {
    const h = makeHarness();
    h.deps.ledger = new BudgetLedger({ budgetUsd: 5, softPct: 0.85, hardPct: 1, costMultiplier: 1 });
    await failedLoudly(h);
    expect(h.manifest().defects[0]!.message).toContain('ledger budget');
  });

  it.each(['hardStop', 'softStop'] as const)('a leftover %s flag in control.json fails the start and is left as found', async (flag) => {
    const h = makeHarness();
    withAttempts(h, [OLD, OPEN]);
    writeControlFlags(h.paths.controlDir, { [flag]: true });
    await failedLoudly(h);
    expect(h.manifest().defects[0]!.message).toContain(flag);
    expect(readControlFlags(h.paths.controlDir)[flag]).toBe(true);
    expect(lastAttempt(h)).toMatchObject({ n: 2, state: 'failed', stopReason: 'attempt-invariant' });
  });

  it('an open attempt with a matching budget and clear flags starts normally', async () => {
    const h = makeHarness();
    withAttempts(h, [OLD, OPEN]);
    const res = await h.run();
    expect(res.state).toBe('completed');
  });
});

describe('attempt lifecycle: attempt 2', () => {

  it('logs the attempt number, budget, costAtStartUsd, baselineUsd and the prior cost at startup', async () => {
    const { h } = resumed();
    await h.run();
    expect(h.logs.find((l) => l.event === 'attempt.start')?.fields).toMatchObject({
      attempt: 2,
      budgetUsd: 10,
      costAtStartUsd: 4,
      baselineUsd: 4,
      priorCostUsd: 4,
    });
    // attempt spend and cumulative cost are 0 until the first reconcile, so the start line leaves them out
    expect(h.logs.find((l) => l.event === 'attempt.start')?.fields).not.toHaveProperty('attemptSpendUsd');
    expect(h.logs.find((l) => l.event === 'attempt.start')?.fields).not.toHaveProperty('cumulativeUsd');
  });

  it('recordLedger keeps RUN.json costUsd cumulative and writes the open attempt\'s live costUsd (the spend of this attempt)', async () => {
    let live: RunManifest | undefined;
    const { h } = resumed({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 3), 20_000);
          hh.clock.setTimeout(() => (live = hh.manifest()), 100_000);
          hh.clock.setTimeout(() => {
            srv.markPhaseDone('build');
            srv.setBusy(rec.sessionId, false);
          }, 110_000);
          return;
        }
        autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(live!.costUsd).toBeCloseTo(7, 8); // 4 (attempt 1, incl. the plan) + 3 build
    expect(live!.attempts![1]!.costUsd).toBeCloseTo(3, 8);
    expect(live!.attempts![1]!.endedAt).toBeUndefined();
    expect(live!.attempts![0]).toEqual(OLD);
    const m = h.manifest();
    expect(m.costUsd).toBeCloseTo(8, 8); // 4 + build 3 + review .5 + report .5 (the plan is done: not run again)
    expect(m.attempts![1]!.costUsd).toBeCloseTo(4, 8);
  });

  it('the wind-down prompt shows the ATTEMPT spend and the attempt budget; the soft log carries both figures', async () => {
    const { h } = resumed({
      script: (rec, srv, hh) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          hh.clock.setTimeout(() => srv.addCost(rec.sessionId, 9), 20_000);
        } else if (rec.kind === 'wind-down') hh.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-soft' });
    const wd = h.server.prompts.find((p) => p.kind === 'wind-down')!;
    expect(wd.text).toContain('spent $9.00 of $10.00'); // this attempt, not the $13.00 cumulative
    expect(wd.text).not.toContain('$13.00');
    expect(h.logs.find((l) => l.event === 'budget.soft')?.fields).toMatchObject({ attemptSpendUsd: 9, cumulativeUsd: 13, budgetUsd: 10 });

    const m = h.manifest();
    expect(m.attempts![0]).toEqual(OLD);
    expect(m.attempts![1]).toMatchObject({ n: 2, state: 'aborted-budget', stopReason: 'budget-soft', endedAt: m.endedAt, budgetUsd: 10, costAtStartUsd: 4 });
    expect(m.attempts![1]!.costUsd).toBeCloseTo(9.7, 8);
    expect(m.costUsd).toBeCloseTo(13.7, 8); // cumulative, the next resume's costAtStartUsd
  });

  it('rootSessions[].costUsd is the cumulative cost of the root\'s PHASE across attempts (every root of a phase shows it), not a per-attempt figure', async () => {
    const { h, oldRoot } = resumed();
    await h.run();
    const m = h.manifest();
    const plans = m.rootSessions.filter((r) => r.phase === 'plan');
    expect(plans.map((r) => r.sessionId)[0]).toBe(oldRoot);
    expect(plans).toHaveLength(1); // the plan was done in attempt 1: not planned again
    for (const r of plans) expect(r.costUsd).toBeCloseTo(4, 8); // attempt 1 only
    expect(m.rootSessions.find((r) => r.phase === 'build')!.costUsd).toBeCloseTo(0.5, 8);
    expect(m.attempts![1]!.costUsd).toBeCloseTo(1.5, 8); // build, review, report
  });

  it('seeds phaseBySession from rootSessions: a child of an old build root keeps the build phase in cost.jsonl', async () => {
    const h = makeHarness();
    const oldRoot = h.server.seedSession(1);
    const oldChild = h.server.spawnChild(oldRoot, 'fixer', false);
    const line = { ts: '2026-01-01T00:30:00.000Z', sessionId: oldRoot, parentId: null, phase: 'build', costUsd: 1, estimated: false, source: 'session-info', totalUsd: 1 };
    mkdirSync(dirname(h.paths.costJsonl), { recursive: true });
    writeFileSync(h.paths.costJsonl, `${JSON.stringify(line)}\n`);
    writeManifest(
      h.paths.runJson,
      RunManifest.parse({
        ...h.manifest(),
        startedAt: OLD.startedAt,
        costUsd: 1,
        rootSessions: [{ phase: 'build', sessionId: oldRoot, costUsd: 1 }],
        attempts: [{ ...OLD, costUsd: 1 }, { ...OPEN, costAtStartUsd: 1 }],
      }),
    );
    h.deps.ledger = new BudgetLedger({ budgetUsd: 10, softPct: 0.85, hardPct: 1, costMultiplier: 1, costLines: [CostLineOf(line)], costAtStartUsd: 1, now: () => new Date(h.clock.now()) });
    await h.run();
    const lines = readFileSync(h.paths.costJsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { sessionId: string; phase: string });
    expect(lines.filter((l) => l.sessionId === oldChild).map((l) => l.phase)).toEqual(['build']); // the current phase was plan
  });
});

describe('attempt lifecycle: a failed start never lowers the recorded figures', () => {
  /** A restart inside the same open attempt: the earlier process had already recorded $2.5 of attempt spend. */
  function restartedInsideAttempt(o: Opts = {}): Harness {
    const h = makeHarness(o);
    writeManifest(
      h.paths.runJson,
      RunManifest.parse({
        ...h.manifest(),
        startedAt: '2026-01-01T00:00:00.000Z',
        costUsd: 2.5,
        costEstimatedUsd: 0.5,
        attempts: [{ n: 1, startedAt: '2026-01-01T00:00:00.000Z', budgetUsd: 10, costAtStartUsd: 0, costUsd: 2.5 }],
      }),
    );
    return h;
  }

  it('a leftover stop flag: the attempt is closed as failed but keeps its recorded costUsd (2.5)', async () => {
    const h = restartedInsideAttempt();
    writeControlFlags(h.paths.controlDir, { hardStop: true });
    const res = await h.run();
    expect(res.stopReason).toBe('attempt-invariant');
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'failed', stopReason: 'attempt-invariant', costUsd: 2.5 });
    expect(h.manifest().costUsd).toBe(2.5);
    expect(h.manifest().costEstimatedUsd).toBe(0.5);
  });

  it('a server that fails to start (empty ledger): the attempt is closed as failed but keeps its recorded costUsd (2.5)', async () => {
    const h = restartedInsideAttempt({ startServerError: new Error('no port') });
    const res = await h.run();
    expect(res.stopReason).toBe('server-start-failed');
    expect(lastAttempt(h)).toMatchObject({ n: 1, state: 'failed', stopReason: 'server-start-failed', costUsd: 2.5 });
    expect(h.manifest().costUsd).toBe(2.5);
  });

  it('attempt 2, server start fails, empty ledger: costUsd, costEstimatedUsd and the phase cost of rootSessions stay as recorded', async () => {
    const { h } = resumed({ startServerError: new Error('no port') });
    writeManifest(h.paths.runJson, RunManifest.parse({ ...h.manifest(), costEstimatedUsd: 1 }));
    const res = await h.run();
    expect(res.stopReason).toBe('server-start-failed');
    const m = h.manifest();
    expect(m.costUsd).toBe(4);
    expect(m.costEstimatedUsd).toBe(1);
    expect(m.rootSessions[0]!.costUsd).toBe(4);
    expect(m.attempts![0]).toEqual(OLD);
    expect(m.attempts![1]).toMatchObject({ n: 2, state: 'failed', stopReason: 'server-start-failed', costUsd: 0, costAtStartUsd: 4 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Resume: phases, markers and parked tasks (T9b)
// ---------------------------------------------------------------------------------------------------------------

describe('resume: a fresh run is unchanged', () => {
  it('runs all four phases, renames nothing and writes no review-lite marker', async () => {
    const h = makeHarness();
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'phase-review', 'phase-report']);
    expect(h.logs.find((l) => l.event === 'resume.plan')?.fields).toMatchObject({ offset: 0, startPhase: 'plan', skipped: [] });
    expect(h.logs.some((l) => l.event === 'phase.skipped')).toBe(false);
    expect(h.logs.some((l) => l.event === 'marker.renamed')).toBe(false);
    expect(readdirSync(h.paths.runDir).filter((f) => f.includes('-attempt'))).toEqual([]);
    expect(readdirSync(h.paths.specsDir).filter((f) => f.includes('-attempt'))).toEqual([]);
    expect(existsSync(runComplete(h))).toBe(true);
    expect(existsSync(liteMarker(h))).toBe(false);
  });
});

describe('resume: phases (AD8)', () => {
  const planDone = taskLine('phase:plan', 'done', 'plan');
  const buildDone = taskLine('phase:build', 'done', 'build');
  const reviewDone = taskLine('phase:review', 'done', 'review');
  const reportDone = taskLine('phase:report', 'done', 'report');

  it('a plan finished in attempt 1 is skipped: exactly one plan root session over both attempts, and the run still ends completed', async () => {
    const { h, oldRoot } = resumed();
    const res = await h.run();
    expect(res).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(kinds(h)).toEqual(['phase-build', 'phase-review', 'phase-report']);
    expect(h.server.created.map((c) => c.input.title)).toEqual(['demo-run build', 'demo-run review', 'demo-run report']);
    expect(h.manifest().rootSessions.filter((r) => r.phase === 'plan').map((r) => r.sessionId)).toEqual([oldRoot]);
    expect(h.logs.find((l) => l.event === 'resume.plan')?.fields).toMatchObject({ offset: 1, startPhase: 'build', skipped: ['plan'] });
    expect(h.logs.find((l) => l.event === 'phase.skipped')?.fields).toMatchObject({ phase: 'plan', reason: 'done-in-earlier-attempt' });
    expect(lastAttempt(h)).toMatchObject({ n: 2, state: 'completed' });
  });

  it('with the plan, build and review done, only the report runs and the run ends completed', async () => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seedReviewMarkers(h);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-report']);
  });

  it('a build that was not finished is continued: only the unfinished phases get a root, and the earlier plan is not prompted again', async () => {
    const { h } = resumed({}, [planDone, taskLine('api', 'done', 'build'), taskLine('ui', 'running', 'build')]);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-build', 'phase-review', 'phase-report']);
    for (const p of h.server.prompts) expect(p.text).not.toMatch(/\bapi\b/); // the finished task is not asked for again
  });

  it('review genuinely done in attempt 1 (stopped during the report): only the report runs and the markers stay in place', async () => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seedReviewMarkers(h);
    const before = [readFileSync(runComplete(h), 'utf8'), readFileSync(finalReview(h), 'utf8')];
    await h.run();
    expect(kinds(h)).toEqual(['phase-report']);
    expect(h.logs.some((l) => l.event === 'marker.renamed')).toBe(false);
    expect([readFileSync(runComplete(h), 'utf8'), readFileSync(finalReview(h), 'utf8')]).toEqual(before);
    expect(readdirSync(h.paths.runDir).filter((f) => f.includes('-attempt'))).toEqual([]);
    expect(readdirSync(h.paths.specsDir).filter((f) => f.includes('-attempt'))).toEqual([]);
  });

  it('a wound-down attempt 1 (review-lite wrote phase:review and run-complete.json): build, the FULL review, then the report; the old markers are renamed', async () => {
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'phase-build') srv.appendTask({ id: 'docs', state: 'done', phase: 'build' }); // the re-opened task is finished
          autoPhases(rec, srv);
        },
      },
      [planDone, taskLine('docs', 'blocked', 'build', { blockedReason: 'wind-down: unfinished at soft stop' }), reviewDone],
    );
    seedReviewMarkers(h, true);
    const old = [readFileSync(runComplete(h), 'utf8'), readFileSync(finalReview(h), 'utf8'), readFileSync(liteMarker(h), 'utf8')];
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-build', 'phase-review', 'phase-report']);
    // the earlier files kept their content under the attempt suffix; the new review wrote fresh ones
    expect(readFileSync(join(h.paths.runDir, 'run-complete-attempt1.json'), 'utf8')).toBe(old[0]);
    expect(readFileSync(join(h.paths.specsDir, 'FINAL_REVIEW-attempt1.md'), 'utf8')).toBe(old[1]);
    expect(readFileSync(join(h.paths.controlDir, 'review-lite-attempt1.json'), 'utf8')).toBe(old[2]);
    expect(existsSync(liteMarker(h))).toBe(false);
    expect(readFileSync(finalReview(h), 'utf8')).not.toBe(old[1]);
    expect(readFileSync(runComplete(h), 'utf8')).toContain('"summary":"done"');
    expect(h.logs.filter((l) => l.event === 'marker.renamed')).toHaveLength(3);
    // the old events do not end the new phases early: the build lasts its full 30 s script
    const at = (k: string): number => h.server.prompts.find((p) => p.kind === k)!.at;
    expect(at('phase-review') - at('phase-build')).toBeGreaterThanOrEqual(30_000);
  });

  it('the old markers are renamed with the number of the previous attempt, and an earlier rename is never overwritten', async () => {
    const { h } = resumed({}, [planDone, reviewDone]);
    seedReviewMarkers(h, true);
    writeFileSync(join(h.paths.runDir, 'run-complete-attempt1.json'), 'older\n');
    await h.run();
    expect(readFileSync(join(h.paths.runDir, 'run-complete-attempt1.json'), 'utf8')).toBe('older\n');
    expect(readFileSync(join(h.paths.runDir, 'run-complete-attempt1-1.json'), 'utf8')).toContain('"summary":"old"');
  });

  it.each([
    ['the markers carry the review-lite marker', (h: Harness) => seedReviewMarkers(h, true)],
    ['run-complete.json is not a valid RunComplete', (h: Harness) => {
      seedReviewMarkers(h);
      writeFileSync(runComplete(h), '{"type":"run.complete"}\n');
    }],
    ['FINAL_REVIEW.md is missing', (h: Harness) => {
      seedReviewMarkers(h);
      rmSync(finalReview(h));
    }],
    ['run-complete.json is missing', (h: Harness) => {
      seedReviewMarkers(h);
      rmSync(runComplete(h));
    }],
  ])('phase:review done is not enough when %s: the review runs again', async (_why, seed) => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seed(h);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-review', 'phase-report']);
  });

  it.each(['budget-soft', 'wallclock-soft'])('an attempt that ended in a soft wind-down (%s; a v1 run has no review-lite marker) does not count its review as done', async (stopReason) => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seedReviewMarkers(h);
    writeManifest(h.paths.runJson, RunManifest.parse({ ...h.manifest(), attempts: [{ ...OLD, stopReason }, OPEN] }));
    await h.run();
    expect(kinds(h)).toEqual(['phase-review', 'phase-report']);
    expect(existsSync(join(h.paths.runDir, 'run-complete-attempt1.json'))).toBe(true);
  });

  it('a resume that was rolled back (resume-failed) is not the previous attempt: the soft-stop defence and the archive suffix look past it', async () => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seedReviewMarkers(h);
    const failed = { n: 2, startedAt: '2026-01-01T02:00:00.000Z', endedAt: '2026-01-01T02:00:05.000Z', state: 'failed', stopReason: 'resume-failed', budgetUsd: 10, costAtStartUsd: 4, costUsd: 0 };
    writeManifest(
      h.paths.runJson,
      RunManifest.parse({ ...h.manifest(), attempts: [{ ...OLD, stopReason: 'budget-soft' }, failed, { ...OPEN, n: 3 }] }),
    );
    await h.run();
    // attempt 1 wound down, so its review does not count even though attempt 2 (never ran) has another stop reason
    expect(kinds(h)).toEqual(['phase-review', 'phase-report']);
    expect(existsSync(join(h.paths.runDir, 'run-complete-attempt1.json'))).toBe(true);
    expect(existsSync(join(h.paths.runDir, 'run-complete-attempt2.json'))).toBe(false);
    expect(h.logs.find((l) => l.event === 'attempt.start')?.fields).toMatchObject({ attempt: 3 });
  });

  it('a phase:report done before the offset is ignored: the report runs and only a done line written after the offset ends it', async () => {
    const { h } = resumed(
      {
        script: (rec, srv, hh) => {
          if (rec.kind === 'phase-report') {
            srv.setBusy(rec.sessionId, true);
            hh.clock.setTimeout(() => {
              srv.markPhaseDone('report');
              srv.setBusy(rec.sessionId, false);
            }, 300_000);
          } else autoPhases(rec, srv);
        },
      },
      [planDone, buildDone, reviewDone, reportDone],
    );
    seedReviewMarkers(h);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-report']);
    const report = h.server.prompts.find((p) => p.kind === 'phase-report')!;
    expect(h.clock.now() - report.at).toBeGreaterThanOrEqual(300_000); // the stale line did not end it at once
    expect(h.logs.find((l) => l.event === 'resume.plan')?.fields).toMatchObject({ offset: 4, startPhase: 'report' });
  });

  it('a later phase done before the offset does not count when an earlier one has to run again', async () => {
    const { h } = resumed({}, [buildDone]); // no phase:plan: plan runs, then every later phase runs and finishes by its own new line
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'phase-review', 'phase-report']);
    const at = (k: string): number => h.server.prompts.find((p) => p.kind === k)!.at;
    expect(at('phase-build') - at('phase-plan')).toBeGreaterThanOrEqual(30_000);
  });

  it('a broken last line in tasks.jsonl is ignored with a warning, the next event still lands on its own line, and the run completes', async () => {
    const { h } = resumed({}, [planDone]);
    writeFileSync(h.paths.tasksJsonl, `${planDone}{"ts":"2026-01-01T00:41:00.000Z","id":"ap`); // torn write, no newline
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-build', 'phase-review', 'phase-report']);
    expect(h.logs.find((l) => l.event === 'tasks.malformed')?.fields).toMatchObject({ lines: 1 });
    const lines = readFileSync(h.paths.tasksJsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5); // plan, torn line, build, review, report
    expect(lines.slice(2).every((l) => (JSON.parse(l) as { state: string }).state === 'done')).toBe(true);
  });

  it('a review-lite whose marker could not be written (review-lite-marker-failed defect) makes the review not count as done', async () => {
    const { h } = resumed({}, [planDone, buildDone, reviewDone]);
    seedReviewMarkers(h);
    writeManifest(
      h.paths.runJson,
      RunManifest.parse({ ...h.manifest(), defects: [{ ts: '2026-01-01T00:55:00.000Z', kind: 'review-lite-marker-failed', message: 'cannot record the review-lite marker: EROFS' }] }),
    );
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-review', 'phase-report']);
    expect(existsSync(join(h.paths.runDir, 'run-complete-attempt1.json'))).toBe(true);
  });

  it('a rename that fails ends the start as failed / marker-rename-failed, before any phase runs', async () => {
    const { h } = resumed({}, [planDone, reviewDone]);
    seedReviewMarkers(h, true);
    h.deps.state = {
      ...h.deps.state,
      rename: () => {
        throw new Error('EPERM');
      },
    };
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'marker-rename-failed' });
    expect(h.manifest().defects.map((d) => d.kind)).toEqual(['marker-rename-failed']);
    expect(h.manifest().defects[0]!.message).toContain('EPERM');
    expect(h.startInputs).toHaveLength(0);
    expect(h.server.prompts).toHaveLength(0);
    expect(existsSync(runComplete(h))).toBe(true); // nothing was half-moved
  });

  it('an unreadable tasks.jsonl fails the start instead of planning again on top of finished work', async () => {
    const { h } = resumed();
    h.deps.state = {
      ...h.deps.state,
      readTasksChecked: () => {
        throw new Error('EACCES');
      },
    };
    const res = await h.run();
    expect(res).toMatchObject({ state: 'failed', stopReason: 'tasks-unreadable' });
    expect(h.server.prompts).toHaveLength(0);
  });

  it('a failed start assertion renames nothing', async () => {
    const { h } = resumed({}, [planDone, reviewDone]);
    seedReviewMarkers(h, true);
    writeControlFlags(h.paths.controlDir, { hardStop: true });
    const res = await h.run();
    expect(res.stopReason).toBe('attempt-invariant');
    expect(existsSync(runComplete(h))).toBe(true);
    expect(existsSync(finalReview(h))).toBe(true);
    expect(existsSync(liteMarker(h))).toBe(true);
    expect(readdirSync(h.paths.runDir).filter((f) => f.includes('-attempt'))).toEqual([]);
  });
});

describe('resume: parked tasks (AD9)', () => {
  const stalledBuild = (nudgeTexts: string[]) => (rec: PromptRecord, srv: FakeServer): void => {
    if (rec.kind === 'phase-build') return; // the build root ignores its prompt and idles
    if (rec.kind === 'nudge') {
      nudgeTexts.push(rec.text);
      srv.completePhase(rec.sessionId, 'build', { afterMs: 10_000, costUsd: 0.5 });
    } else autoPhases(rec, srv);
  };

  it('the nudge of a resumed build names a task the wind-down parked, not a done one nor one blocked for a real reason', async () => {
    const texts: string[] = [];
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'nudge') srv.appendTask({ id: 'docs', state: 'done', phase: 'build' }); // the nudge gets the parked task finished
          stalledBuild(texts)(rec, srv);
        },
      },
      [
        taskLine('phase:plan', 'done', 'plan'),
        taskLine('api', 'done', 'build', { repo: 'acme-api', branch: 'feat/api', worktree: '/Users/alice/work/acme-api/.worktrees/demo-run/api' }),
        taskLine('infra', 'blocked', 'build', { blockedReason: 'needs credentials' }),
        taskLine('docs', 'blocked', 'build', { blockedReason: 'wind-down: unfinished at soft stop' }),
      ],
    );
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('**docs**');
    expect(texts[0]).not.toContain('**api**');
    expect(texts[0]).not.toContain('**infra**');
  });

  it('a task skipped by the wind-down is re-opened too, but a wind-down tag written in THIS attempt is not', async () => {
    const texts: string[] = [];
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'phase-build') {
            // this attempt parks "later" again: it must not be handed back as pending work
            srv.appendTask({ id: 'later', state: 'blocked', phase: 'build', blockedReason: 'wind-down: parked again' });
            return;
          }
          stalledBuild(texts)(rec, srv);
        },
      },
      [
        taskLine('phase:plan', 'done', 'plan'),
        taskLine('later', 'todo', 'build'),
        taskLine('ui', 'skipped', 'build', { blockedReason: 'wind-down: never started' }),
      ],
    );
    await h.run();
    expect(texts[0]).toContain('**ui**');
    expect(texts[0]).not.toContain('**later**');
  });

  it('a nudge with no task left says so (a task blocked for another reason is not pending work)', async () => {
    const texts: string[] = [];
    const { h } = resumed({ script: stalledBuild(texts) }, [
      taskLine('phase:plan', 'done', 'plan'),
      taskLine('infra', 'skipped', 'build', { blockedReason: 'depends on a blocked task' }),
    ]);
    await h.run();
    expect(texts[0]).toContain('the remaining work of this phase');
  });

  const parkedTasks = [
    taskLine('phase:plan', 'done', 'plan'),
    taskLine('docs', 'blocked', 'build', { blockedReason: 'wind-down: unfinished at soft stop' }),
  ];

  it('a phase:build done written after the parking events and before the offset does not skip the build: it runs and names the parked task', async () => {
    const texts: string[] = [];
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'nudge') srv.appendTask({ id: 'docs', state: 'done', phase: 'build' }); // the parked task gets finished
          stalledBuild(texts)(rec, srv);
        },
      },
      [...parkedTasks, taskLine('phase:build', 'done', 'build')],
    );
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-build', 'nudge', 'phase-review', 'phase-report']);
    expect(h.logs.find((l) => l.event === 'resume.plan')?.fields).toMatchObject({ startPhase: 'build' });
    expect(texts[0]).toContain('**docs**');
  });

  it('a resumed build that writes phase:build while the parked task is untouched does not complete: the phase stays not done and the agent is nudged', async () => {
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'phase-build') srv.completePhase(rec.sessionId, 'build', { afterMs: 10_000, costUsd: 0.5 }); // writes phase:build only
          else if (rec.kind !== 'nudge') autoPhases(rec, srv);
        },
      },
      parkedTasks,
    );
    const res = await h.run();
    expect(res.state).not.toBe('completed');
    expect(res.state).toBe('stalled');
    expect(kinds(h)).not.toContain('phase-review');
    expect(kinds(h)).not.toContain('phase-report');
    const nudges = h.server.prompts.filter((p) => p.kind === 'nudge');
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0]!.text).toContain('**docs**');
    expect(h.logs.some((l) => l.event === 'phase.end' && l.fields.phase === 'build' && l.fields.outcome === 'done')).toBe(false);
  });

  it('once the parked task has a newer event after the offset (done, or blocked again with a real reason), phase:build counts', async () => {
    for (const again of [{ state: 'done' }, { state: 'blocked', blockedReason: 'needs credentials' }] as const) {
      const { h } = resumed(
        {
          script: (rec, srv) => {
            if (rec.kind === 'phase-build') {
              srv.appendTask({ id: 'docs', phase: 'build', ...again });
              srv.completePhase(rec.sessionId, 'build', { afterMs: 10_000, costUsd: 0.5 });
            } else autoPhases(rec, srv);
          },
        },
        parkedTasks,
      );
      const res = await h.run();
      expect(res.state, again.state).toBe('completed');
      expect(kinds(h), again.state).toEqual(['phase-build', 'phase-review', 'phase-report']);
    }
  });

  it('a task re-parked with the wind-down tag AFTER the offset, then phase:build: the build is not done (stalled), and the nudge does not name it', async () => {
    const { h } = resumed(
      {
        script: (rec, srv) => {
          if (rec.kind === 'phase-build') {
            srv.appendTask({ id: 'docs', state: 'blocked', phase: 'build', blockedReason: 'wind-down: still parked' });
            srv.completePhase(rec.sessionId, 'build', { afterMs: 10_000, costUsd: 0.5 }); // writes phase:build
          } else if (rec.kind !== 'nudge') autoPhases(rec, srv);
        },
      },
      parkedTasks,
    );
    const res = await h.run();
    expect(res.state).toBe('stalled');
    expect(kinds(h)).not.toContain('phase-review');
    expect(kinds(h)).not.toContain('phase-report');
    const nudges = h.server.prompts.filter((p) => p.kind === 'nudge');
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0]!.text).not.toContain('**docs**'); // parked in THIS attempt: not handed back as pending work
    expect(h.logs.some((l) => l.event === 'phase.end' && l.fields.phase === 'build' && l.fields.outcome === 'done')).toBe(false);
  });

  it('in the attempt that winds down, a build agent that parks a task and writes phase:build ends the build wound-down, not done', async () => {
    const h: Harness = makeHarness({
      script: (rec, srv) => {
        if (rec.kind === 'phase-build') {
          srv.setBusy(rec.sessionId, true);
          h.clock.setTimeout(() => srv.addCost(rec.sessionId, 8.5), 20_000);
        } else if (rec.kind === 'wind-down') {
          srv.appendTask({ id: 'docs', state: 'blocked', phase: 'build', blockedReason: 'wind-down: unfinished at soft stop' });
          srv.markPhaseDone('build'); // wrongly, but it must not count
          h.clock.setTimeout(() => srv.setBusy(rec.sessionId, false), 5_000);
        } else autoPhases(rec, srv);
      },
    });
    const res = await h.run();
    expect(res).toMatchObject({ state: 'aborted-budget', stopReason: 'budget-soft' });
    expect(h.logs.find((l) => l.event === 'phase.end' && l.fields.phase === 'build')?.fields.outcome).toBe('wound-down');
    expect(kinds(h)).toEqual(['phase-plan', 'phase-build', 'wind-down', 'phase-review-lite', 'phase-report']);
  });

  it('review fix-ups parked by a wind-down are not build work: a resume goes to the review, not back to build', async () => {
    const { h } = resumed({}, [
      taskLine('phase:plan', 'done', 'plan'),
      taskLine('phase:build', 'done', 'build'),
      taskLine('review-fix-1', 'blocked', 'review', { blockedReason: 'wind-down: unfinished at soft stop' }),
      taskLine('late-fix', 'todo', 'review'),
      taskLine('late-fix', 'skipped', 'build', { blockedReason: 'wind-down: x' }), // first event is in the review phase
    ]);
    const res = await h.run();
    expect(res.state).toBe('completed');
    expect(kinds(h)).toEqual(['phase-review', 'phase-report']);
  });

  it('windDownParked: only the latest event before the offset counts, and phase / integration / wind-down lines are not tasks', () => {
    const ev = (id: string, state: string, blockedReason?: string) =>
      JSON.parse(taskLine(id, state, 'build', blockedReason ? { blockedReason } : {})) as import('../src/contracts.ts').TaskEvent;
    const events = [
      ev('a', 'blocked', 'wind-down: x'),
      ev('b', 'skipped', 'wind-down: y'),
      ev('c', 'blocked', 'wind-down: z'),
      ev('c', 'done'),
      ev('d', 'blocked', 'needs credentials'),
      ev('integration:acme-api', 'blocked', 'wind-down: x'),
      ev('wind-down:note', 'blocked', 'wind-down: x'),
      ev('e', 'blocked', 'wind-down: late'),
    ];
    expect(windDownParked(events, 7)).toEqual(['a', 'b']); // e is after the offset
    expect(windDownParked(events, 8)).toEqual(['a', 'b', 'e']);
    expect(windDownParked(events, 0)).toEqual([]);
    expect(windDownParked(events, events.length)).toEqual(['a', 'b', 'e']); // "any": what phaseDone('build') asks
    const fixups = [ev('review-fix-1', 'blocked', 'wind-down: x'), { ...ev('r2', 'blocked', 'wind-down: x'), phase: 'review' as const }, ev('t', 'blocked', 'wind-down: x')];
    expect(windDownParked(fixups, fixups.length)).toEqual(['t']); // review fix-ups are not build work
  });
});
