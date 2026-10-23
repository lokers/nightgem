/**
 * Orchestrator core: the run loop. Every dependency is injected; `runOrchestrator` never throws.
 *
 * Flow: load RUN.json (terminal => no-op) -> take the lock -> render appends and start the run server -> protect files ->
 * wait for agents -> preflight -> start the event pump -> phases plan, build, review, report (each in a NEW root
 * session) with the watchdog, budget handling, tripwires and heartbeat -> finalize (always).
 *
 * State transitions (RUN.json `state`):
 *
 *   launching/any non-terminal -> running                      (startup done)
 *   running -> winding-down                                    soft limit (once): ledger `soft` or watchdog `wallclock-soft`
 *   running|winding-down -> stopping                           hard budget, tripwire, SIGTERM/SIGINT (stop sequence)
 *
 * Soft sequence (the run stays `winding-down` until its final state):
 *   wind-down prompt -> (root and children idle, or the 10 min deadline) -> interrupt rounds over every non-root busy
 *   session (no hardStop flag) -> a short review-lite phase (new root, prompt `phase-review-lite`, 10 min cap, writes
 *   FINAL_REVIEW.md, no fix-ups) -> report phase. A hard trip anywhere in between skips straight to the stop sequence.
 *
 * Final states (terminal):
 *
 *   all four normal phases finished              -> completed       (stopReason `budget-soft` / `wallclock-soft` only if the
 *                                                                    soft limit tripped during the report phase itself)
 *   soft wind-down (budget)                      -> aborted-budget  stopReason `budget-soft`
 *   soft wind-down (wall clock, T-30 min)        -> failed          stopReason `wallclock-soft`
 *   ledger hard (any time, even in report)       -> aborted-budget  stopReason `budget-hard`
 *   tripwire violation (spec repo/protected)     -> failed          stopReason `tripwire:<kind>`
 *   SIGTERM / SIGINT                             -> stopped         stopReason `signal:<SIG>`
 *   watchdog `stalled`                           -> stalled         stopReason = watchdog reason
 *   watchdog `wallclock`                         -> failed          stopReason `wallclock`
 *   preflight failed                             -> failed          stopReason `preflight-failed`
 *   server process died / failed to start        -> failed          stopReason `server-exited` / `server-start-failed`
 *   any exception                                -> failed          stopReason `exception: <message>`
 *
 * Attempts: every run is one or more attempts (the first launch, then each `resume`). The last entry of `RUN.json.attempts`
 * is the attempt this process runs. At start it must be open, carry the manifest's `budgetUsd`, and the control flags must
 * be clear (the `resume` CLI resets them); otherwise the run fails with an `attempt-invariant` defect and touches nothing
 * else. A manifest without `attempts` (v1, or a fresh launch) gets its implicit attempt 1 written at start. `finalize`
 * closes the open attempt on every end path in the same write that sets the final state: `endedAt`, `state`,
 * `stopReason` and `costUsd` (the attempt spend, multiplied, not cumulative). `RUN.json.costUsd` stays the cumulative run cost.
 *
 * Exit code: 0 for `completed`, 1 otherwise (`FinalState.exitCode`). A restart on a terminal run is a no-op (exit 0).
 * Violations in OTHER workspace repos never stop the run: they become `tripwire-other-repo` defects and are re-baselined.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BudgetLedger } from './budget.ts';
import { isRunApiError } from './client.ts';
import {
  attemptsOf,
  isTerminalRunState,
  parseModelRef,
  TaskEvent,
  type ControlFlags,
  type Defect,
  type Phase,
  type RunApi,
  type RepoBaseline,
  type RunManifest,
  type RunState,
  type WorktreeEntry,
  type ServerEvent,
} from './contracts.ts';
import { redactString, redactValue, type Clock, type EventPump, type EventPumpOptions } from './events.ts';
import type { RunPaths } from './paths.ts';
import type { PromptVars } from './prompts.ts';
import type { StartRunServerInput } from './server.ts';
import {
  acquireLock,
  isRestartNoop,
  readJsonl,
  readControlFlags,
  readLockInfo,
  readManifest,
  StateError,
  touchHeartbeat,
  updateControlFlags,
  updateManifest,
  type LockOptions,
  type ReleaseLock,
} from './state.ts';
import type { Baseline, ProtectedFile, TripwireInput, Violation } from './tripwires.ts';
import { progressMarker, type Watchdog, type WatchdogAction, type WatchdogError } from './watchdog.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PHASE_ORDER: readonly Phase[] = ['plan', 'build', 'review', 'report'];
/** Prompt of the short review that replaces the full review phase after a soft wind-down. */
export const REVIEW_LITE_PROMPT = 'phase-review-lite';
export type SoftReason = 'budget-soft' | 'wallclock-soft';
export const FINAL_REVIEW_FILE = 'FINAL_REVIEW.md';
export const RUN_COMPLETE_FILE = 'run-complete.json';
export const APPEND_AGENTS = ['orchestrator', 'fixer', 'designer', 'oracle'] as const;
/** Agents that must be registered before the preflight (slim registers them 2-15 s after start). */
export const REQUIRED_AGENTS = ['orchestrator', 'fixer', 'oracle'] as const;

/** `RunApi` plus the authoritative busy list (implemented by `RunClient`). */
export type ServerApi = RunApi & { listActiveSessions(): Promise<string[]> };

export interface ServerHandle {
  api: ServerApi;
  url: string;
  port: number;
  pid: number;
  version?: string;
  stop(): Promise<void>;
  /** Resolves when the server process ends (crash, or after `stop()`). */
  exited: Promise<unknown>;
  hasExited(): boolean;
}

export interface PreflightContext {
  api: ServerApi;
  server: ServerHandle;
  manifest: RunManifest;
  paths: RunPaths;
}
export interface PreflightResult {
  ok: boolean;
  failures: string[];
}

/** State-module functions. `realStateOps` binds the real ones. */
export interface StateOps {
  readManifest(path: string): RunManifest;
  updateManifest(path: string, fn: (m: RunManifest) => RunManifest | void): RunManifest;
  acquireLock(lockPath: string, opts?: LockOptions): ReleaseLock;
  /** Who holds the lock (read-only), for the CLI -> orchestrator handoff. */
  lockInfo(lockPath: string): { pid: number; slug?: string } | undefined;
  updateControlFlags(controlDir: string, patch: Partial<ControlFlags>): ControlFlags;
  /** Read-only: the start-up assertion that no stop flag survived from an earlier attempt. */
  readControlFlags(controlDir: string): ControlFlags;
  touchHeartbeat(controlDir: string, nowMs: number): ControlFlags;
  readTasks(path: string): TaskEvent[];
  exists(path: string): boolean;
}

export const realStateOps: StateOps = {
  readManifest,
  updateManifest: (path, fn) => updateManifest(path, fn),
  acquireLock,
  lockInfo: readLockInfo,
  updateControlFlags,
  readControlFlags,
  touchHeartbeat,
  readTasks: (path) => readJsonl(path, TaskEvent).items,
  exists: (path) => existsSync(path),
};

export interface SignalSource {
  /** Subscribe; returns the unsubscribe function. */
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): () => void;
}

export interface OrchestratorConfig {
  /** Watchdog tick and supervision loop period. */
  tickMs: number;
  heartbeatMs: number;
  tripwireMs: number;
  /** Wind-down: hard cap before moving on to the report phase. */
  windDownMaxMs: number;
  /** Wind-down: nothing busy for this long counts as idle. */
  windDownQuietMs: number;
  /** Review-lite (soft path): hard cap. */
  reviewLiteMaxMs: number;
  /** `git fetch` per spec repo at startup. */
  prefetchTimeoutMs: number;
  /** Stop sequence: total interrupt window and poll period. */
  stopSequenceMs: number;
  stopPollMs: number;
  /** After a phase marker: wait at most this long for the root to go idle. */
  phaseSettleMs: number;
  settleStepMs: number;
  agentWaitMs: number;
  /** Guard for calls that can hang on a dead server (final reconcile, pump stop). */
  shutdownStepMs: number;
  /** Retries for createSession/prompt on transient errors. */
  retries: number;
  retryDelayMs: number;
  /** Handoff: how long to wait for the CLI (same run) to let go of the lock, and the poll period. */
  lockWaitMs: number;
  lockPollMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  tickMs: 15_000,
  heartbeatMs: 30_000,
  tripwireMs: 5 * 60_000,
  windDownMaxMs: 10 * 60_000,
  windDownQuietMs: 15_000,
  reviewLiteMaxMs: 10 * 60_000,
  prefetchTimeoutMs: 3 * 60_000,
  stopSequenceMs: 30_000,
  stopPollMs: 3_000,
  phaseSettleMs: 60_000,
  settleStepMs: 5_000,
  agentWaitMs: 60_000,
  shutdownStepMs: 30_000,
  retries: 3,
  retryDelayMs: 5_000,
  lockWaitMs: 60_000,
  lockPollMs: 1_000,
};

/** The workspace facts handed to every prompt as vars. */
export interface PromptContext {
  workspaceRoot: string;
  workspaceInstructions: string;
  skillsList: string;
}

export interface OrchestratorDeps {
  slug: string;
  paths: RunPaths;
  /** The orchestrator's own pid (lock owner). */
  pid: number;
  lockPath: string;
  /** `providerID/modelID` for `small_model` and the light agents. */
  smallModel: string;
  opencodeBin: string;
  /** Installed oh-my-opencode-slim version, recorded in RUN.json when known. */
  slimVersion?: string;
  sandbox: boolean;
  /** Extra inputs for `startRunServer` (home, workspaceRoot, pushInsteadOf, insteadOf, extraWriteSubpaths, ...). `home` and `workspaceRoot` are required. */
  serverInput: Pick<StartRunServerInput, 'home' | 'workspaceRoot' | 'safety'> & Partial<StartRunServerInput>;
  /**
   * Workspace facts the prompts use: the wiring fills them from the frozen `run-context.json` (instructions text, skills list).
   */
  promptContext: PromptContext;

  clock: Clock;
  state: StateOps;
  ledger: BudgetLedger;
  watchdog: Watchdog;
  signals: SignalSource;
  /** Structured decision log (written to orchestrator.log by the real wiring). Called with already redacted fields. */
  logger: (event: string, fields: Record<string, unknown>) => void;
  /** Literal secrets to scrub from logs and defects. */
  secrets?: string[];

  renderPrompt: (name: string, vars: PromptVars) => string;
  startServer: (input: StartRunServerInput) => Promise<ServerHandle>;
  waitForAgents: (api: ServerApi, required: readonly string[], timeoutMs: number) => Promise<string[]>;
  /** Real impl: `preflightRules` + haiku canary. */
  preflight: (ctx: PreflightContext) => Promise<PreflightResult>;
  createPump: (opts: EventPumpOptions) => EventPump;
  checkTripwires: (input: TripwireInput) => Promise<Violation[]>;
  protectFiles: (paths: readonly string[]) => Promise<ProtectedFile[]>;
  headSha: (repoPath: string) => Promise<string>;
  writeReport: (paths: RunPaths) => Promise<unknown>;
  /** bootout + plist delete. */
  cleanupLaunchd: () => Promise<void>;
  /** `git fetch origin --prune` of one spec repo, outside the sandbox. Never throws on a non-zero exit. */
  fetchRepo?: (repoPath: string, timeoutMs: number) => Promise<{ exitCode: number; timedOut?: boolean; stderr?: string }>;
  /** Fresh tripwire baseline of a repo (used to report a change in another workspace repo only once). */
  rebaseline?: (repoPath: string) => Promise<RepoBaseline>;
  /** The run's `$TMPDIR` (outside the control dir) and its removal at the end of the run. */
  tmpDir?: string;
  removeTmp?: () => void | Promise<void>;

  config?: Partial<OrchestratorConfig>;
}

export interface FinalState {
  state: RunState;
  stopReason?: string;
  /** 0 for `completed`, else 1. */
  exitCode: 0 | 1;
  /** True when the run was already terminal (or the lock was held) and nothing was done. */
  noop: boolean;
  error?: string;
}

type StopKind = 'hard-budget' | 'tripwire' | 'signal' | 'stalled' | 'wallclock' | 'server-exited';
interface StopRequest {
  kind: StopKind;
  state: RunState;
  stopReason: string;
  /** Run the interrupt sequence (and which flag to set) before shutting down. */
  sequence: 'hard' | 'graceful' | 'none';
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// runOrchestrator
// ---------------------------------------------------------------------------

export async function runOrchestrator(deps: OrchestratorDeps): Promise<FinalState> {
  try {
    return await new Run(deps).run();
  } catch (err) {
    // Last resort: Run.run already guards every step, so this is a bug path.
    try {
      deps.logger('orchestrator.crash', { error: errMsg(err) });
    } catch {
      /* nothing left to do */
    }
    return { state: 'failed', stopReason: `exception: ${errMsg(err)}`, exitCode: 1, noop: false, error: errMsg(err) };
  }
}

class Run {
  private readonly cfg: OrchestratorConfig;
  private readonly clock: Clock;
  private readonly st: StateOps;
  private readonly mpath: string;
  private readonly secrets: string[];

  private server: ServerHandle | undefined;
  private pump: EventPump | undefined;
  private releaseLock: ReleaseLock | undefined;
  private unsubs: Array<() => void> = [];
  private heartbeatTimer: unknown;
  private heartbeatOn = false;

  private currentPhase: Phase = 'plan';
  private rootIds: string[] = [];
  private currentRoot: string | undefined;
  private rootCreatedAt = 0;
  private readonly phaseBySession = new Map<string, Phase>();

  private stopReq: StopRequest | undefined;
  private softPending = false;
  private softHandled = false;
  private softReason: SoftReason | undefined;
  /** The wind-down is waiting for the agents to settle (nudges are off, the phase is about to be cut short). */
  private windingDown = false;
  private skipToReport = false;
  /** The wind-down tail (interrupt rounds, review-lite) has run. */
  private tailDone = false;
  /** The current phase is the review-lite of the soft path. */
  private lite = false;
  private readonly completedPhases = new Set<Phase>();
  private windDownStartedAt = 0;
  private readonly mutedRepos = new Set<string>();
  private quietSince: number | undefined;
  private lastTripwireAt = 0;
  private protectedFiles: ProtectedFile[] = [];
  private readonly errors: WatchdogError[] = [];

  private wakeFn: (() => void) | undefined;
  private shuttingDown: Promise<void> | undefined;
  private final: { state: RunState; stopReason?: string } | undefined;
  private manifestState: RunManifest | undefined;

  constructor(private readonly d: OrchestratorDeps) {
    this.cfg = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...d.config };
    this.clock = d.clock;
    this.st = d.state;
    this.mpath = d.paths.runJson;
    this.secrets = d.secrets ?? [];
  }

  // --- logging / small helpers ------------------------------------------------------

  private log(event: string, fields: Record<string, unknown> = {}): void {
    try {
      this.d.logger(event, redactValue({ ts: new Date(this.clock.now()).toISOString(), ...fields }, this.secrets) as Record<string, unknown>);
    } catch {
      /* logging must never break the run */
    }
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private safeUpdate(fn: (m: RunManifest) => RunManifest | void): void {
    try {
      this.manifestState = this.st.updateManifest(this.mpath, fn);
    } catch (err) {
      this.log('manifest.update_failed', { error: errMsg(err) });
    }
  }

  private setState(state: RunState, extra: Partial<RunManifest> = {}): void {
    this.safeUpdate((m) => {
      Object.assign(m, extra, { state });
    });
    this.log('state', { state, ...extra });
  }

  private addDefect(kind: string, message: string, sessionId?: string): void {
    const defect: Defect = {
      ts: this.iso(),
      kind,
      message: redactString(message, this.secrets).slice(0, 500),
      ...(sessionId ? { sessionId } : {}),
    };
    this.safeUpdate((m) => {
      m.defects.push(defect);
    });
    this.log('defect', { ...defect });
  }

  private sleep(ms: number): Promise<void> {
    // something that needs attention already arrived: do not sleep through it
    if (this.stopReq || (this.softPending && !this.softHandled)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let h: unknown;
      const done = (): void => {
        this.clock.clearTimeout(h);
        if (this.wakeFn === done) this.wakeFn = undefined;
        resolve();
      };
      h = this.clock.setTimeout(done, ms);
      this.wakeFn = done;
    });
  }

  /** Cut the current supervision sleep short (a stop request or budget event arrived). */
  private wake(): void {
    this.wakeFn?.();
  }

  private async plainSleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => this.clock.setTimeout(resolve, ms));
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> {
    let h: unknown;
    const timeout = new Promise<'timeout'>((resolve) => {
      h = this.clock.setTimeout(() => resolve('timeout'), ms);
    });
    try {
      const r = await Promise.race([p, timeout]);
      if (r === 'timeout') {
        this.log('timeout', { what, ms });
        return undefined;
      }
      return r;
    } finally {
      this.clock.clearTimeout(h);
    }
  }

  private async retrying<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        this.noteError(err);
        const transient = isRunApiError(err) && err.isTransient;
        if (!transient || attempt >= this.cfg.retries) throw err;
        this.log('retry', { what, attempt: attempt + 1, error: errMsg(err) });
        await this.plainSleep(this.cfg.retryDelayMs);
      }
    }
  }

  private noteError(err: unknown): void {
    if (!isRunApiError(err)) return;
    const ts = this.clock.now();
    if (err.isRateLimited) this.errors.push({ kind: '429', ts });
    else if (err.isServerError) this.errors.push({ kind: '5xx', ts });
    if (this.errors.length > 50) this.errors.splice(0, this.errors.length - 50);
  }

  private requestStop(req: StopRequest): void {
    if (this.stopReq) return;
    this.stopReq = req;
    this.log('stop.requested', { ...req });
    this.wake();
  }

  // --- main ---------------------------------------------------------------------------

  async run(): Promise<FinalState> {
    // 1. load and lock
    let manifest: RunManifest;
    try {
      manifest = this.st.readManifest(this.mpath);
    } catch (err) {
      this.log('manifest.unreadable', { error: errMsg(err) });
      return { state: 'failed', stopReason: 'manifest-unreadable', exitCode: 1, noop: true, error: errMsg(err) };
    }
    if (isRestartNoop(manifest)) {
      this.log('restart.noop', { state: manifest.state });
      return { state: manifest.state, ...(manifest.stopReason ? { stopReason: manifest.stopReason } : {}), exitCode: 0, noop: true };
    }
    try {
      this.releaseLock = await this.takeLock(manifest);
    } catch (err) {
      this.log('lock.failed', { error: errMsg(err) });
      return { state: manifest.state, stopReason: 'lock-held', exitCode: 1, noop: true, error: errMsg(err) };
    }
    this.manifestState = manifest;

    try {
      await this.main(manifest);
    } catch (err) {
      this.log('exception', { error: errMsg(err), stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join(' | ') : undefined });
      this.addDefect('orchestrator-exception', errMsg(err));
      this.final ??= { state: 'failed', stopReason: `exception: ${errMsg(err)}`.slice(0, 300) };
    }
    return this.finalize();
  }

  /**
   * Take the global lock. The CLI took it under its own pid right before `launchctl bootstrap`; launchd starts us at once,
   * so the CLI may still be alive for a moment. A holder that is this same run (lock slug, or the pid the CLI recorded in
   * RUN.json) is waited for; a dead holder is taken over by `acquireLock`; any other live holder is `lock-held` at once.
   */
  private async takeLock(manifest: RunManifest): Promise<ReleaseLock> {
    const deadline = this.clock.now() + this.cfg.lockWaitMs;
    for (;;) {
      try {
        return this.st.acquireLock(this.d.lockPath, { pid: this.d.pid, slug: this.d.slug });
      } catch (err) {
        const held = err instanceof StateError && err.code === 'lock-held';
        const info = held ? this.st.lockInfo(this.d.lockPath) : undefined;
        const sameRun = info !== undefined && info.pid !== this.d.pid && (info.slug === this.d.slug || (manifest.pid !== undefined && info.pid === manifest.pid));
        if (!sameRun || this.clock.now() >= deadline) throw err;
        this.log('lock.waiting', { holderPid: info.pid });
        await this.plainSleep(this.cfg.lockPollMs);
      }
    }
  }

  private async main(manifest: RunManifest): Promise<void> {
    // signals first, so a SIGTERM during startup is honoured
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      this.unsubs.push(
        this.d.signals.on(sig, () => this.requestStop({ kind: 'signal', state: 'stopped', stopReason: `signal:${sig}`, sequence: 'graceful' })),
      );
    }
    const violation = this.startInvariantViolation(manifest);
    if (violation) {
      // Fail loudly and change nothing else: a closed attempt, a wrong budget or a stale stop flag means the resume
      // transition did not happen as designed, and running on would stop or overspend wrongly.
      this.log('attempt.invariant_failed', { message: violation });
      this.addDefect('attempt-invariant', violation);
      this.final = { state: 'failed', stopReason: 'attempt-invariant' };
      return;
    }
    // children of earlier attempts' roots keep their phase
    for (const r of manifest.rootSessions) this.phaseBySession.set(r.sessionId, r.phase);
    const startedAt = manifest.startedAt ?? this.iso();
    this.setState('running', {
      pid: this.d.pid,
      ...(manifest.startedAt ? {} : { startedAt }),
      // a v1 manifest or a fresh launch has no attempts yet: record the implicit attempt 1
      ...(manifest.attempts === undefined ? { attempts: [{ n: 1, startedAt, budgetUsd: manifest.budgetUsd, costAtStartUsd: 0 }] } : {}),
    });
    const attempt = attemptsOf(this.manifestState ?? manifest).at(-1);
    this.log('attempt.start', {
      attempt: attempt?.n,
      budgetUsd: this.d.ledger.budgetUsd,
      costAtStartUsd: this.d.ledger.costAtStartUsd,
      baselineUsd: this.d.ledger.baselineUsd,
      attemptSpendUsd: this.d.ledger.attemptSpendUsd,
      cumulativeUsd: this.d.ledger.cumulativeUsd,
      priorCostUsd: manifest.costUsd,
    });
    this.startHeartbeat();

    if (!(await this.startup(manifest))) return;

    const model = (this.manifestState ?? manifest).model;
    parseModelRef(model); // fail early on a malformed model

    for (const phase of PHASE_ORDER) {
      if (this.stopReq) break;
      if (this.skipToReport && phase !== 'report') {
        this.log('phase.skipped', { phase, reason: 'wind-down' });
        continue;
      }
      const outcome = await this.runPhase(phase, model);
      if (outcome === 'done') this.completedPhases.add(phase);
      // a soft wind-down was announced: settle, interrupt, review-lite, then straight to the report
      if (!this.stopReq && this.skipToReport && !this.tailDone) await this.windDownTail(model);
    }

    if (this.stopReq) {
      await this.handleStop(this.stopReq);
      return;
    }
    this.final = this.normalFinal();
  }

  /**
   * The start-up assertions (see the header). Returns a message when one fails, else undefined. The last attempt is the one
   * this process runs; for a manifest without `attempts` it is the implicit attempt, which is open by construction.
   */
  private startInvariantViolation(manifest: RunManifest): string | undefined {
    const last = attemptsOf(manifest).at(-1);
    if (!last) return 'RUN.json has an empty attempts list: there is no attempt to run';
    if (last.endedAt !== undefined) {
      return `attempt ${last.n} is already closed (endedAt ${last.endedAt}); the resume transition must append a new open attempt`;
    }
    if (last.budgetUsd !== manifest.budgetUsd) {
      return `attempt ${last.n} budget $${last.budgetUsd} does not match RUN.json budgetUsd $${manifest.budgetUsd}`;
    }
    if (this.d.ledger.budgetUsd !== manifest.budgetUsd) {
      return `the ledger budget $${this.d.ledger.budgetUsd} does not match RUN.json budgetUsd $${manifest.budgetUsd}`;
    }
    try {
      const flags = this.st.readControlFlags(this.d.paths.controlDir);
      const set = [flags.hardStop ? 'hardStop' : '', flags.softStop ? 'softStop' : ''].filter(Boolean);
      if (set.length > 0) return `control.json still has ${set.join(' and ')} set; the resume CLI must reset the stop flags before the attempt starts`;
    } catch (err) {
      return `control.json cannot be read: ${errMsg(err)}`;
    }
    return undefined;
  }

  /** `completed` only if all four normal phases finished; otherwise the soft limit that cut the run short decides. */
  private normalFinal(): { state: RunState; stopReason?: string } {
    const all = PHASE_ORDER.every((p) => this.completedPhases.has(p));
    if (all) return { state: 'completed', ...(this.softHandled && this.softReason ? { stopReason: this.softReason } : {}) };
    if (this.softReason === 'wallclock-soft') return { state: 'failed', stopReason: 'wallclock-soft' };
    if (this.softHandled) return { state: 'aborted-budget', stopReason: 'budget-soft' };
    return { state: 'failed', stopReason: 'phases-incomplete' };
  }

  // --- startup ------------------------------------------------------------------------

  /** Returns false when the run must end (final state already decided). */
  private async startup(manifest: RunManifest): Promise<boolean> {
    // 2. render appends into the control dir, start the server
    const appendsDir = join(this.d.paths.controlDir, 'appends');
    const appendNames: string[] = [];
    try {
      mkdirSync(appendsDir, { recursive: true, mode: 0o700 });
      for (const agent of APPEND_AGENTS) {
        const name = `${agent}_append`;
        writeFileSync(join(appendsDir, `${name}.md`), this.d.renderPrompt(name, this.promptVars()), { mode: 0o600 });
        appendNames.push(`${name}.md`);
      }
    } catch (err) {
      this.addDefect('render-failed', errMsg(err));
      this.final = { state: 'failed', stopReason: 'render-failed' };
      return false;
    }

    await this.prefetch();
    if (this.stopReq) return this.afterEarlyStop();

    try {
      this.server = await this.d.startServer({
        ...this.d.serverInput,
        slug: this.d.slug,
        model: manifest.model,
        smallModel: this.d.smallModel,
        opencodeBin: this.d.opencodeBin,
        sandbox: this.d.sandbox,
        appendsDir,
      });
    } catch (err) {
      this.log('server.start_failed', { error: errMsg(err) });
      this.addDefect('server-start-failed', errMsg(err));
      this.final = { state: 'failed', stopReason: 'server-start-failed' };
      return false;
    }
    const server = this.server;
    void server.exited.then(() => {
      if (!this.shuttingDown) this.requestStop({ kind: 'server-exited', state: 'failed', stopReason: 'server-exited', sequence: 'none' });
    });
    this.safeUpdate((m) => {
      m.serverUrl = server.url;
      m.port = server.port;
      if (server.version) m.opencodeVersion = server.version;
      if (this.d.slimVersion) m.slimVersion = this.d.slimVersion;
    });
    if (this.stopReq) return this.afterEarlyStop();

    // protect the files that define the run (the run-dir files exist once the server is started)
    try {
      const run = this.d.paths.runDir;
      const files = [
        this.d.paths.specMd,
        join(run, 'opencode.json'),
        join(run, '.opencode', 'oh-my-opencode-slim.jsonc'),
        ...appendNames.map((n) => join(run, '.opencode', 'oh-my-opencode-slim', n)),
      ];
      this.protectedFiles = await this.d.protectFiles(files);
      this.log('protected', { count: this.protectedFiles.length });
    } catch (err) {
      this.addDefect('protect-failed', errMsg(err));
      this.final = { state: 'failed', stopReason: 'protect-failed' };
      return false;
    }

    // agents registered, then preflight
    try {
      await this.d.waitForAgents(server.api, REQUIRED_AGENTS, this.cfg.agentWaitMs);
    } catch (err) {
      this.addDefect('agents-not-ready', errMsg(err));
      this.final = { state: 'failed', stopReason: 'agents-not-ready' };
      return false;
    }
    if (this.stopReq) return this.afterEarlyStop();

    let pre: PreflightResult;
    try {
      pre = await this.d.preflight({ api: server.api, server, manifest: this.manifestState ?? manifest, paths: this.d.paths });
    } catch (err) {
      pre = { ok: false, failures: [`preflight threw: ${errMsg(err)}`] };
    }
    if (!pre.ok) {
      this.log('preflight.failed', { failures: pre.failures });
      this.addDefect('preflight-failed', pre.failures.join('; ') || 'preflight failed');
      this.final = { state: 'failed', stopReason: 'preflight-failed' };
      return false;
    }
    this.log('preflight.ok', {});
    if (this.stopReq) return this.afterEarlyStop();

    // 3. pump (after the preflight, so the evaluator's stray asks never show up as defects)
    this.d.ledger.onEvent((e) => {
      this.log('ledger.event', { ledgerEvent: e });
      if (e === 'hard') {
        this.requestStop({ kind: 'hard-budget', state: 'aborted-budget', stopReason: 'budget-hard', sequence: 'hard' });
      } else {
        this.softPending = true;
        this.softReason ??= 'budget-soft';
        this.wake();
      }
    });
    this.pump = this.d.createPump(this.pumpOptions(server.api));
    this.pump.start();
    return true;
  }

  /**
   * Fetch every spec repo (a real default branch) before the sandboxed server exists: the run itself can only fetch through the
   * fetch-only wrapper and has no network to GitHub over ssh. A failure is a warning defect; the run goes on with local refs.
   */
  private async prefetch(): Promise<void> {
    const fetchRepo = this.d.fetchRepo;
    if (!fetchRepo) return;
    const repos = (this.manifestState?.repos ?? []).filter((r) => r.defaultBranch !== '-');
    await Promise.all(
      repos.map(async (r) => {
        const started = this.clock.now();
        const res = await this.withTimeout(
          fetchRepo(r.path, this.cfg.prefetchTimeoutMs).catch((err: unknown) => ({ exitCode: 127, stderr: errMsg(err), timedOut: false })),
          this.cfg.prefetchTimeoutMs + 15_000,
          `prefetch ${r.name}`,
        );
        const exitCode = res?.exitCode ?? 124;
        this.log('prefetch', { repo: r.path, exitCode, timedOut: res === undefined || res.timedOut === true, ms: this.clock.now() - started });
        if (exitCode !== 0) {
          this.addDefect('prefetch-failed', `git fetch origin --prune failed in ${r.path} (exit ${exitCode}${res?.stderr ? `: ${res.stderr}` : ''}); the run continues on local refs`);
        }
      }),
    );
  }

  private pumpOptions(api: ServerApi): EventPumpOptions {
    return {
      api,
      ledger: this.d.ledger,
      paths: this.d.paths,
      phaseOf: (id) => this.phaseOfSession(id),
      clock: this.clock,
      secrets: this.secrets,
      onTerminal: (info) => {
        this.log('terminal', { sessionId: info.sessionId, type: info.type });
        this.wake();
      },
      onPermissionRejected: (info) => {
        this.addDefect('permission-asked', info.defect.message, info.defect.sessionId);
      },
      onSilence: (ms) => this.log('sse.silence', { ms }),
      onError: (err, where) => {
        this.noteError(err);
        this.log('pump.error', { where, error: errMsg(err) });
      },
      onEvent: (ev) => this.onServerEvent(ev),
    };
  }

  private afterEarlyStop(): boolean {
    // a stop request arrived during startup: let finalize/handleStop run with whatever exists
    this.final = this.stopFinal(this.stopReq!);
    return false;
  }

  private stopFinal(req: StopRequest): { state: RunState; stopReason: string } {
    return { state: req.state, stopReason: req.stopReason };
  }

  private onServerEvent(ev: ServerEvent): void {
    if (ev.type === 'session.error') this.errors.push({ kind: 'session-error', ts: this.clock.now() });
  }

  // --- heartbeat ----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatOn = true;
    const beat = (): void => {
      if (!this.heartbeatOn) return;
      try {
        this.st.touchHeartbeat(this.d.paths.controlDir, this.clock.now());
      } catch (err) {
        this.log('heartbeat.failed', { error: errMsg(err) });
      }
      this.heartbeatTimer = this.clock.setTimeout(beat, this.cfg.heartbeatMs);
    };
    beat();
  }

  private stopHeartbeat(): void {
    this.heartbeatOn = false;
    if (this.heartbeatTimer !== undefined) this.clock.clearTimeout(this.heartbeatTimer);
  }

  // --- phases -------------------------------------------------------------------------

  private promptVars(extra: Record<string, string | number> = {}): PromptVars {
    const p = this.d.paths;
    return {
      slug: this.d.slug,
      specsDir: p.specsDir,
      specMd: p.specMd,
      planMd: p.planMd,
      statusMd: p.statusMd,
      decisionsMd: p.decisionsMd,
      decisionsJsonl: p.decisionsJsonl,
      tasksJsonl: p.tasksJsonl,
      reportMd: p.reportMd,
      eventsDir: p.runDir,
      workspaceRoot: this.d.promptContext.workspaceRoot,
      workspaceInstructions: this.d.promptContext.workspaceInstructions,
      skillsList: this.d.promptContext.skillsList,
      ...extra,
    };
  }

  private phaseOfSession(id: string): Phase {
    let cur: string | undefined = id;
    const parents = new Map(this.pump?.sessions().map((s) => [s.id, s.parentId]) ?? []);
    const chain: string[] = [];
    for (let i = 0; i < 20 && cur !== undefined; i++) {
      const known = this.phaseBySession.get(cur);
      if (known) {
        for (const c of chain) this.phaseBySession.set(c, known);
        return known;
      }
      chain.push(cur);
      cur = parents.get(cur);
    }
    return this.currentPhase;
  }

  private async runPhase(phase: Phase, model: string, opts: { lite?: boolean } = {}): Promise<'done' | 'wound-down' | 'stop' | 'capped'> {
    const lite = opts.lite === true;
    this.currentPhase = phase;
    this.lite = lite;
    const api = this.server!.api;
    const ref = parseModelRef(model);
    const session = await this.retrying('createSession', () =>
      api.createSession({ model: ref, agent: 'orchestrator', title: `${this.d.slug} ${lite ? 'review-lite' : phase}` }),
    );
    this.currentRoot = session.id;
    this.rootIds.push(session.id);
    this.rootCreatedAt = this.clock.now();
    this.phaseBySession.set(session.id, phase);
    this.d.ledger.addRootSession(session.id);
    this.safeUpdate((m) => {
      m.phase = phase;
      m.rootSessions.push({ phase, sessionId: session.id, costUsd: 0 });
      if (!m.knownSessionIds.includes(session.id)) m.knownSessionIds.push(session.id);
    });
    this.log('phase.start', { phase, rootId: session.id, lite });

    const text = this.d.renderPrompt(lite ? REVIEW_LITE_PROMPT : `phase-${phase}`, this.promptVars());
    await this.retrying('prompt', () => api.prompt(session.id, { text }));

    const outcome = await this.supervise(phase, session.id, lite ? { capMs: this.cfg.reviewLiteMaxMs } : {});
    this.lite = false;
    this.log('phase.end', { phase, outcome, lite });
    if (!lite && outcome === 'done' && phase === 'review' && !(this.runCompleteSeen() && this.finalReviewExists())) {
      this.addDefect('run-complete-missing', 'review phase ended without run-complete.json and FINAL_REVIEW.md');
    }
    return outcome;
  }

  /**
   * After the wind-down: interrupt whatever is still busy below the roots (never with the hardStop flag), then a short
   * review-lite in a NEW root, unless the full review already finished. The report phase follows in the main loop.
   */
  private async windDownTail(model: string): Promise<void> {
    this.tailDone = true;
    this.windingDown = false;
    await this.windDownInterrupts();
    if (this.stopReq) return;
    if (this.runCompleteSeen() && this.finalReviewExists()) {
      this.log('review_lite.skipped', { reason: 'the full review already finished' });
      return;
    }
    const outcome = await this.runPhase('review', model, { lite: true });
    if (outcome === 'capped') {
      this.addDefect('review-lite-timeout', `review-lite did not write ${FINAL_REVIEW_FILE} within ${Math.round(this.cfg.reviewLiteMaxMs / 60_000)} minutes; cut short`);
      await this.windDownInterrupts();
      try {
        if (this.currentRoot) await this.server!.api.interrupt(this.currentRoot);
      } catch (err) {
        this.noteError(err);
        this.log('interrupt.failed', { id: this.currentRoot, error: errMsg(err) });
      }
    }
  }

  private tasks(): TaskEvent[] {
    try {
      return this.st.readTasks(this.d.paths.tasksJsonl);
    } catch {
      return [];
    }
  }

  private runCompleteSeen(): boolean {
    return this.st.exists(join(this.d.paths.runDir, RUN_COMPLETE_FILE));
  }
  private finalReviewExists(): boolean {
    return this.st.exists(join(this.d.paths.specsDir, FINAL_REVIEW_FILE));
  }

  private phaseDone(phase: Phase): boolean {
    if (this.tasks().some((t) => t.id === `phase:${phase}` && t.state === 'done')) return true;
    return phase === 'review' && this.runCompleteSeen() && this.finalReviewExists();
  }

  private nextTask(): string {
    const latest = new Map<string, TaskEvent>();
    for (const t of this.tasks()) latest.set(t.id, t);
    for (const t of latest.values()) {
      if (/^(phase|integration|wind-down):/.test(t.id)) continue;
      if (['todo', 'running', 'verifying', 'fixing'].includes(t.state)) return t.id;
    }
    return 'the remaining work of this phase (check the board)';
  }

  /**
   * Waits for the phase to finish. Returns 'done', 'wound-down' (soft limit), 'capped' (review-lite ran out of time) or
   * 'stop' (stop requested).
   */
  private async supervise(phase: Phase, rootId: string, opts: { capMs?: number } = {}): Promise<'done' | 'wound-down' | 'stop' | 'capped'> {
    const api = this.server!.api;
    this.quietSince = undefined;
    for (;;) {
      if (this.stopReq) return 'stop';
      this.d.ledger.check();
      if (this.stopReq) return 'stop';
      await this.maybeSoft(phase, rootId);

      await this.maybeTripwires();
      if (this.stopReq) return 'stop';

      if (this.lite ? this.liteDone() : this.phaseDone(phase)) {
        await this.settle(rootId);
        return 'done';
      }
      if (this.windingDown && phase !== 'report' && this.windDownFinished()) return 'wound-down';
      if (opts.capMs !== undefined && this.clock.now() - this.rootCreatedAt >= opts.capMs) return 'capped';

      await this.watchdogTick(phase, rootId, api);
      if (this.stopReq) return 'stop';
      this.recordProgress();

      await this.sleep(this.cfg.tickMs);
    }
  }

  /** Review-lite is done when FINAL_REVIEW.md exists (it writes no run-complete.json) or the usual review markers are there. */
  private liteDone(): boolean {
    return this.finalReviewExists() || this.phaseDone('review');
  }

  private async settle(rootId: string): Promise<void> {
    const deadline = this.clock.now() + this.cfg.phaseSettleMs;
    while (!this.stopReq && this.pump?.isBusy(rootId) && this.clock.now() < deadline) await this.sleep(this.cfg.settleStepMs);
  }

  // --- watchdog -----------------------------------------------------------------------

  /** Mirror the worktrees the agents announce in tasks.jsonl into RUN.json (deduped by path), for the report and the progress marker. */
  private syncWorktrees(): void {
    const latest = new Map<string, TaskEvent>();
    for (const t of this.tasks()) latest.set(t.id, t);
    const known = new Set((this.manifestState?.worktrees ?? []).map((w) => w.path));
    const fresh: WorktreeEntry[] = [];
    for (const t of latest.values()) {
      if (/^(phase|wind-down):/.test(t.id) || t.repo === '_run' || !t.worktree.startsWith('/') || known.has(t.worktree)) continue;
      known.add(t.worktree);
      const integration = t.worktree.endsWith('/_integration');
      fresh.push({ repo: t.repo, path: t.worktree, branch: t.branch, kind: integration ? 'integration' : 'task', ...(integration ? {} : { task: t.id }) });
    }
    if (fresh.length === 0) return;
    this.safeUpdate((m) => {
      for (const w of fresh) if (!m.worktrees.some((x) => x.path === w.path)) m.worktrees.push(w);
    });
    this.log('worktrees', { added: fresh.map((w) => w.path) });
  }

  private async progress(): Promise<string> {
    this.syncWorktrees();
    const worktrees = (this.manifestState?.worktrees ?? []).map((w) => w.path);
    const shas = await Promise.allSettled(worktrees.map((p) => this.d.headSha(p)));
    return progressMarker(
      this.tasks(),
      shas.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
    );
  }

  private async watchdogTick(phase: Phase, rootId: string, api: ServerApi): Promise<void> {
    const now = this.clock.now();
    const sessions = (this.pump?.sessions() ?? []).map((s) => ({
      id: s.id,
      busy: s.busy,
      lastEventTs: s.lastEventAt ?? (s.id === rootId ? this.rootCreatedAt : now),
      ...(this.pump?.runningToolSince(s.id) !== undefined ? { runningToolSinceTs: this.pump.runningToolSince(s.id)! } : {}),
    }));
    if (!sessions.some((s) => s.id === rootId)) sessions.push({ id: rootId, busy: false, lastEventTs: this.rootCreatedAt });
    // run-complete only matters in the review phase; elsewhere the watchdog must not go terminal on it
    const inReview = phase === 'review' && !this.lite;
    this.d.watchdog.observe({
      rootId,
      sessions,
      progressMarker: await this.progress(),
      runCompleteSeen: inReview && this.runCompleteSeen(),
      finalReviewExists: inReview && this.finalReviewExists(),
      errors: [...this.errors],
    });
    const actions = this.d.watchdog.tick(now);
    const snap = this.d.watchdog.snapshot();
    if (this.manifestState?.nudges !== snap.nudges) {
      this.safeUpdate((m) => {
        m.nudges = snap.nudges;
      });
    }
    for (const action of actions) await this.applyAction(action, phase, rootId, api);
  }

  private async applyAction(a: WatchdogAction, phase: Phase, rootId: string, api: ServerApi): Promise<void> {
    this.log('watchdog.action', { ...a });
    switch (a.type) {
      case 'nudge': {
        if (this.windingDown && phase !== 'report') return;
        const reason = a.reason ? `\n\nNote: ${a.reason}. Fix that first.` : '';
        const text = this.d.renderPrompt('nudge', this.promptVars({ phase, nextTask: this.nextTask() })) + reason;
        try {
          await api.prompt(rootId, { text });
        } catch (err) {
          this.noteError(err);
          this.log('nudge.failed', { error: errMsg(err) });
        }
        return;
      }
      case 'abort-session':
        try {
          await api.interrupt(a.id);
        } catch (err) {
          this.noteError(err);
          this.log('abort.failed', { id: a.id, error: errMsg(err) });
        }
        return;
      case 'backoff':
        return; // informational: the watchdog itself suppresses nudges until the end of the backoff
      case 'stalled':
        this.requestStop({ kind: 'stalled', state: 'stalled', stopReason: a.reason ?? 'stalled', sequence: 'none' });
        return;
      case 'wallclock-soft':
        if (!this.softHandled && !this.softPending) {
          this.softReason = 'wallclock-soft';
          this.softPending = true;
          this.log('wallclock.soft', {});
          this.wake();
        }
        return;
      case 'wallclock':
        this.requestStop({ kind: 'wallclock', state: 'failed', stopReason: 'wallclock', sequence: 'none' });
        return;
      case 'complete': {
        // wd is terminal now; re-arm it so the report phase keeps its nudge/hung protection
        this.d.watchdog.restore({ ...this.d.watchdog.snapshot(), done: false });
        return;
      }
    }
  }

  // --- budget -------------------------------------------------------------------------

  private async maybeSoft(phase: Phase, rootId: string): Promise<void> {
    if (!this.softPending || this.softHandled) return;
    this.softHandled = true;
    const reason: SoftReason = this.softReason ?? 'budget-soft';
    this.softReason = reason;
    // the thresholds compare the attempt spend with the attempt's budget; the cumulative cost is logged beside it
    const attemptSpendUsd = this.d.ledger.attemptSpendUsd;
    this.log('budget.soft', {
      phase,
      reason,
      attemptSpendUsd,
      cumulativeUsd: this.d.ledger.cumulativeUsd,
      budgetUsd: this.d.ledger.budgetUsd,
    });
    if (phase === 'report') return; // already writing the narrative; just remember it for stopReason
    this.windingDown = true;
    this.skipToReport = true;
    this.windDownStartedAt = this.clock.now();
    this.quietSince = undefined;
    this.safeUpdate((m) => {
      m.state = 'winding-down';
      m.stopReason = reason;
    });
    try {
      this.st.updateControlFlags(this.d.paths.controlDir, { softStop: true });
    } catch (err) {
      this.log('softflag.failed', { error: errMsg(err) });
    }
    const text = this.d.renderPrompt(
      'wind-down',
      this.promptVars({
        reason: reason === 'wallclock-soft' ? 'wall clock soft limit reached (30 minutes left)' : 'budget soft limit reached',
        costUsd: attemptSpendUsd.toFixed(2),
        budgetUsd: this.d.ledger.budgetUsd.toFixed(2),
      }),
    );
    try {
      await this.server!.api.prompt(rootId, { text, delivery: 'steer' });
    } catch (err) {
      this.noteError(err);
      this.log('winddown.prompt_failed', { error: errMsg(err) });
    }
  }

  private windDownFinished(): boolean {
    const now = this.clock.now();
    if (now - this.windDownStartedAt >= this.cfg.windDownMaxMs) {
      this.log('winddown.timeout', {});
      return true;
    }
    const busy = (this.pump?.busySessionIds().length ?? 0) > 0;
    if (busy) {
      this.quietSince = undefined;
      return false;
    }
    this.quietSince ??= now;
    return now - this.quietSince >= this.cfg.windDownQuietMs;
  }

  // --- tripwires ----------------------------------------------------------------------

  private async maybeTripwires(): Promise<void> {
    const now = this.clock.now();
    if (this.lastTripwireAt === 0) this.lastTripwireAt = now;
    if (now - this.lastTripwireAt < this.cfg.tripwireMs) return;
    this.lastTripwireAt = now;
    const repos = (this.manifestState?.repos ?? []).filter((r) => !this.mutedRepos.has(r.path));
    const specRepos = new Set(repos.filter((r) => r.defaultBranch !== '-').map((r) => r.path));
    const baseline: Baseline = Object.fromEntries(repos.map((r) => [r.path, r.baseline]));
    let violations: Violation[];
    try {
      violations = await this.d.checkTripwires({ baseline, repos: repos.map((r) => r.path), protectedFiles: this.protectedFiles });
    } catch (err) {
      this.log('tripwire.check_failed', { error: errMsg(err) });
      return;
    }
    this.log('tripwire.checked', { violations: violations.length });
    if (violations.length === 0) return;

    // a change in a spec repo or a protected file is a hard stop; a change in another workspace repo is recorded once
    const isOther = (v: Violation): boolean => !v.kind.startsWith('protected-') && !specRepos.has(v.path);
    const hard = violations.filter((v) => !isOther(v));
    const other = violations.filter(isOther);
    await this.recordOtherRepos(other);
    if (hard.length === 0) return;
    for (const v of hard) this.addDefect(`tripwire:${v.kind}`, v.message);
    this.requestStop({ kind: 'tripwire', state: 'failed', stopReason: `tripwire:${hard[0]!.kind}`, sequence: 'hard' });
  }

  /** One `tripwire-other-repo` defect per changed repo, then re-baseline it so the same change is not reported again. */
  private async recordOtherRepos(violations: Violation[]): Promise<void> {
    const byRepo = new Map<string, Violation[]>();
    for (const v of violations) byRepo.set(v.path, [...(byRepo.get(v.path) ?? []), v]);
    for (const [path, vs] of byRepo) {
      const kinds = vs.map((v) => v.kind).join(', ');
      this.addDefect('tripwire-other-repo', `Another repository changed during the run (${kinds}): ${path}. The run was not stopped; the change was re-baselined.`);
      this.log('tripwire.other_repo', { path, kinds });
      let fresh: RepoBaseline | undefined;
      try {
        fresh = await this.d.rebaseline?.(path);
      } catch (err) {
        this.log('rebaseline.failed', { path, error: errMsg(err) });
      }
      if (fresh) {
        const baseline = fresh;
        this.safeUpdate((m) => {
          const r = m.repos.find((x) => x.path === path);
          if (r) r.baseline = baseline;
        });
      } else {
        this.mutedRepos.add(path); // cannot re-baseline: stop watching it rather than report every five minutes
      }
    }
  }

  // --- ledger -> RUN.json -------------------------------------------------------------

  private recordProgress(): void {
    this.recordLedger();
    const known = new Set(this.manifestState?.knownSessionIds ?? []);
    const ids = (this.pump?.sessionIds() ?? []).filter((id) => !known.has(id));
    if (ids.length === 0) return;
    this.safeUpdate((m) => {
      for (const id of ids) if (!m.knownSessionIds.includes(id)) m.knownSessionIds.push(id);
    });
  }

  /**
   * Mirror the ledger into RUN.json.
   * - `costUsd` is the run's CUMULATIVE cost (all attempts; the next resume reads it as `costAtStartUsd`). It never
   *   decreases: before the first reconcile of an attempt the ledger has seen no session, so its total is not yet the truth.
   * - `rootSessions[].costUsd` is the cumulative cost of that root's PHASE across all attempts (every root of a phase shows
   *   the same figure, as before). It is not a per-root or per-attempt cost: nothing may sum it. The report reads
   *   `cost.jsonl` and `costUsd`, never this field.
   * - the open (last) attempt's `costUsd` is the live attempt spend (multiplied, not cumulative).
   */
  private recordLedger(): void {
    const total = this.d.ledger.total();
    const mult = this.d.ledger.costMultiplier;
    const phases = this.d.ledger.perPhase((id) => this.phaseOfSession(id));
    const attemptSpend = this.d.ledger.attemptSpendUsd;
    const cur = this.manifestState;
    const cumulative = Math.max(total.effectiveUsd, cur?.costUsd ?? 0);
    const last = cur?.attempts?.at(-1);
    const unchanged =
      cur !== undefined &&
      cur.costUsd === cumulative &&
      cur.costEstimatedUsd === total.estimatedUsd * mult &&
      cur.rootSessions.every((r) => r.costUsd === Math.max(r.costUsd, phases[r.phase].effectiveUsd)) &&
      (last === undefined || last.endedAt !== undefined || last.costUsd === attemptSpend);
    if (unchanged) return;
    this.safeUpdate((m) => {
      m.costUsd = Math.max(total.effectiveUsd, m.costUsd);
      m.costEstimatedUsd = total.estimatedUsd * mult;
      for (const r of m.rootSessions) r.costUsd = Math.max(r.costUsd, phases[r.phase].effectiveUsd);
      const open = m.attempts?.at(-1);
      if (open && open.endedAt === undefined) open.costUsd = attemptSpend;
    });
  }

  // --- stopping -----------------------------------------------------------------------

  private async handleStop(req: StopRequest): Promise<void> {
    this.final = this.stopFinal(req);
    this.log('stop.handling', { ...req });
    this.setState('stopping');
    if (req.sequence !== 'none') await this.stopSequence(req.sequence === 'hard');
  }

  /** Interrupt children (deepest first), then the root, repeatedly, until quiet or the window closes. */
  private async stopSequence(hardFlag: boolean): Promise<void> {
    const server = this.server;
    if (!server) return;
    if (hardFlag) {
      try {
        this.st.updateControlFlags(this.d.paths.controlDir, { hardStop: true });
      } catch (err) {
        this.log('hardflag.failed', { error: errMsg(err) });
      }
    }
    const deadline = this.clock.now() + this.cfg.stopSequenceMs;
    let quiet = 0;
    for (;;) {
      const r = await this.interruptRound(server.api);
      quiet = r.active === 0 && r.interrupted === 0 ? quiet + 1 : 0;
      if (quiet >= 2 || this.clock.now() >= deadline) break;
      await this.plainSleep(this.cfg.stopPollMs);
    }
    this.log('stop.sequence_done', { hardFlag });
  }

  /**
   * Wind-down deadline passed (or everything went idle): interrupt every busy NON-root session, deepest first, in rounds
   * until two quiet rounds or the stop window closes. No hardStop flag: the agents may still finish their last commit.
   */
  private async windDownInterrupts(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const deadline = this.clock.now() + this.cfg.stopSequenceMs;
    let quiet = 0;
    for (;;) {
      if (this.stopReq) return;
      const r = await this.interruptRound(server.api, { roots: false });
      quiet = r.active === 0 && r.interrupted === 0 ? quiet + 1 : 0;
      if (quiet >= 2 || this.clock.now() >= deadline) break;
      await this.plainSleep(this.cfg.stopPollMs);
    }
    this.log('winddown.interrupts_done', {});
  }

  private depthOf(id: string, parents: Map<string, string | undefined>): number {
    let d = 0;
    for (let cur = parents.get(id); cur !== undefined && d < 20; cur = parents.get(cur)) d++;
    return d;
  }

  private async interruptRound(api: ServerApi, opts: { roots?: boolean } = {}): Promise<{ active: number; interrupted: number }> {
    const withRoots = opts.roots !== false;
    let active: string[];
    try {
      active = await api.listActiveSessions();
    } catch (err) {
      this.log('active.failed', { error: errMsg(err) });
      active = this.pump?.busySessionIds() ?? [];
    }
    const roots = new Set(this.rootIds);
    const parents = new Map(this.pump?.sessions().map((s) => [s.id, s.parentId]) ?? []);
    const children = active.filter((id) => !roots.has(id)).sort((a, b) => this.depthOf(b, parents) - this.depthOf(a, parents));
    const rootOrder = withRoots ? [...(this.currentRoot ? [this.currentRoot] : []), ...active.filter((id) => roots.has(id) && id !== this.currentRoot)] : [];
    if (!withRoots) active = children;
    let interrupted = 0;
    for (const id of [...children, ...rootOrder]) {
      try {
        if (await api.interrupt(id)) interrupted++;
        this.log('interrupt', { id });
      } catch (err) {
        this.noteError(err);
        this.log('interrupt.failed', { id, error: errMsg(err) });
      }
    }
    return { active: active.length, interrupted };
  }

  /** Final reconcile, pump stop, server stop. Idempotent. */
  private shutdownRuntime(): Promise<void> {
    this.shuttingDown ??= (async () => {
      // Always reconcile the ledger once more while the server API may still answer, even when the pump never
      // started (preflight failure, early stop): the preflight canary session is a run session with real cost.
      // Without a pump, an unstarted one is built only to reuse its reconcile (ledger ingest + cost.jsonl).
      try {
        const reconciler = this.pump ?? (this.server ? this.d.createPump(this.pumpOptions(this.server.api)) : undefined);
        if (reconciler) await this.withTimeout(reconciler.reconcile(), this.cfg.shutdownStepMs, 'final-reconcile');
      } catch (err) {
        this.log('final_reconcile.failed', { error: errMsg(err) });
      }
      if (this.pump) {
        try {
          await this.withTimeout(this.pump.stop(), this.cfg.shutdownStepMs, 'pump-stop');
        } catch (err) {
          this.log('pump_stop.failed', { error: errMsg(err) });
        }
      }
      if (this.server) {
        try {
          await this.server.stop();
        } catch (err) {
          this.log('server_stop.failed', { error: errMsg(err) });
        }
      }
    })();
    return this.shuttingDown;
  }

  // --- finalize (always) ----------------------------------------------------------------

  private async finalize(): Promise<FinalState> {
    const fin = this.final ?? { state: 'failed' as RunState, stopReason: 'no-final-state' };
    try {
      await this.shutdownRuntime();
    } catch (err) {
      this.log('shutdown.failed', { error: errMsg(err) });
    }
    this.stopHeartbeat();
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.recordLedger();
    try {
      this.syncWorktrees();
    } catch (err) {
      this.log('worktrees.failed', { error: errMsg(err) });
    }
    const attemptSpendUsd = this.d.ledger.attemptSpendUsd;
    this.safeUpdate((m) => {
      // a manifest without `attempts` (v1, or the start write never landed) gets its implicit attempt first, from the
      // top-level fields as they were before this final write
      if (m.attempts === undefined) m.attempts = attemptsOf(m).map((a) => ({ ...a }));
      m.state = fin.state;
      if (fin.stopReason !== undefined) m.stopReason = fin.stopReason;
      m.endedAt = this.iso();
      // close the open attempt in the same write, on every end path; a closed one (a failed start assertion) is left alone
      const open = m.attempts.at(-1);
      if (open && open.endedAt === undefined) {
        open.endedAt = m.endedAt;
        open.state = isTerminalRunState(fin.state) ? fin.state : 'failed';
        if (fin.stopReason !== undefined) open.stopReason = fin.stopReason;
        open.costUsd = attemptSpendUsd;
      }
    });
    this.log('final', { ...fin });
    try {
      await this.d.writeReport(this.d.paths);
    } catch (err) {
      this.log('report.failed', { error: errMsg(err) });
    }
    try {
      await this.d.removeTmp?.();
    } catch (err) {
      this.log('tmp.cleanup_failed', { error: errMsg(err) });
    }
    try {
      this.releaseLock?.();
    } catch (err) {
      this.log('lock.release_failed', { error: errMsg(err) });
    }
    try {
      await this.d.cleanupLaunchd();
    } catch (err) {
      this.log('launchd.cleanup_failed', { error: errMsg(err) });
    }
    return {
      state: fin.state,
      ...(fin.stopReason !== undefined ? { stopReason: fin.stopReason } : {}),
      exitCode: fin.state === 'completed' ? 0 : 1,
      noop: false,
    };
  }
}
