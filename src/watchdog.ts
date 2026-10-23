/**
 * Watchdog state machine. Pure: no timers, no I/O. The caller feeds it observations
 * (`observe`) and asks for actions at a given time (`tick(now)`); every timestamp is epoch
 * milliseconds from the injected clock.
 *
 * Action semantics (what the orchestrator must wire):
 * - `nudge`: prompt the root session ("continue"). Carries an optional `reason`.
 * - `abort-session`: interrupt that session (hung: busy with no events for `hungMs`).
 * - `backoff`: informational and emitted once per escalation. The watchdog itself suppresses
 *   nudges until `untilTs`; the caller should not prompt anything before then.
 * - `wallclock-soft`: emitted once, `wallclockSoftLeadMs` before the wall clock. Not terminal: the caller starts the soft
 *   wind-down. Disabled when the wall clock is not longer than the lead.
 * - `stalled`, `wallclock`, `complete`: terminal. Each is emitted once; afterwards `tick`
 *   returns `[]`. The caller stops the run.
 */
import { createHash } from 'node:crypto';

import type { TaskEvent } from './contracts.ts';

export const FINAL_REVIEW_MISSING = 'final review missing';

export interface WatchdogConfig {
  /** Root idle time before a nudge. Default 3 min. */
  idleMs: number;
  /** Busy session with no events for this long is aborted. Default 40 min. A session with a running tool call is exempt, see `toolMaxMs`. */
  hungMs: number;
  /** A session with a tool call in flight is not hung until the call has run this long. Default 60 min. */
  toolMaxMs: number;
  /** Maximum nudges per run. Default 10. */
  maxNudges: number;
  /** Consecutive nudges without progress that mean "stalled". Default 3. */
  stallNudges: number;
  /** First backoff delay. Default 1 min. */
  backoffBaseMs: number;
  /** Backoff ceiling. Default 45 min. */
  backoffCapMs: number;
  /** Run wall clock. Default 10 h. */
  wallclockMs: number;
  /** The soft wind-down starts this long before the wall clock. Default 30 min. */
  wallclockSoftLeadMs: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  idleMs: 3 * 60_000,
  hungMs: 40 * 60_000,
  toolMaxMs: 60 * 60_000,
  maxNudges: 10,
  stallNudges: 3,
  backoffBaseMs: 60_000,
  backoffCapMs: 45 * 60_000,
  wallclockMs: 10 * 60 * 60_000,
  wallclockSoftLeadMs: 30 * 60_000,
};

export type WatchdogClock = () => number;

export interface WatchdogSession {
  id: string;
  busy: boolean;
  /** Epoch ms of the last event seen for this session. */
  lastEventTs: number;
  /** Epoch ms the oldest tool call still in flight in this session started (undefined: none running). */
  runningToolSinceTs?: number;
}

export interface WatchdogError {
  kind: '429' | '5xx' | 'session-error';
  /** Epoch ms. */
  ts: number;
}

export interface WatchdogObservation {
  rootId: string;
  sessions: WatchdogSession[];
  progressMarker: string;
  runCompleteSeen: boolean;
  finalReviewExists: boolean;
  errors: WatchdogError[];
}

export type WatchdogAction =
  | { type: 'nudge'; reason?: string }
  | { type: 'abort-session'; id: string }
  | { type: 'backoff'; untilTs: number }
  | { type: 'stalled'; reason?: string }
  | { type: 'wallclock-soft' }
  | { type: 'wallclock' }
  | { type: 'complete' };

/** JSON-serialisable persistent state. */
export interface WatchdogSnapshot {
  startedAt: number;
  nudges: number;
  /** Nudges sent since the progress marker last changed. */
  nudgesSinceProgress: number;
  lastNudgeTs: number;
  lastMarker: string | null;
  backoffStreak: number;
  backoffUntil: number;
  /** A backoff has been escalated but not yet announced through `tick`. */
  backoffPending: boolean;
  lastErrorTs: number;
  /** Session id -> time we last asked for it to be aborted. */
  abortedAt: Record<string, number>;
  finalReviewNudged: boolean;
  done: boolean;
  /** `wallclock-soft` has been emitted. Absent in snapshots written before it existed. */
  wallclockSoftSent?: boolean;
}

export interface Watchdog {
  observe(obs: WatchdogObservation): void;
  tick(now: number): WatchdogAction[];
  snapshot(): WatchdogSnapshot;
  restore(snapshot: WatchdogSnapshot): void;
}

/**
 * Progress marker: a hash of the task state transitions (consecutive repeats of the same
 * id/state/attempt are ignored) plus the set of latest commit SHAs. It changes iff a task
 * reached a new state or a new commit appeared.
 */
export function progressMarker(
  taskEvents: ReadonlyArray<Pick<TaskEvent, 'id' | 'state' | 'attempt'>>,
  headShas: readonly string[],
): string {
  const last = new Map<string, string>();
  const transitions: string[] = [];
  for (const e of taskEvents) {
    const key = `${e.state}:${e.attempt}`;
    if (last.get(e.id) === key) continue;
    last.set(e.id, key);
    transitions.push(`${e.id}:${key}`);
  }
  const shas = [...new Set(headShas)].sort();
  return createHash('sha256').update(JSON.stringify([transitions, shas])).digest('hex');
}

export function createWatchdog(
  config: Partial<WatchdogConfig> = {},
  clock: WatchdogClock = Date.now,
  initial?: WatchdogSnapshot,
): Watchdog {
  const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG, ...config };

  let st: WatchdogSnapshot = initial ? { ...initial, abortedAt: { ...initial.abortedAt } } : fresh(clock());
  let obs: WatchdogObservation | undefined;

  function fresh(startedAt: number): WatchdogSnapshot {
    return {
      startedAt,
      nudges: 0,
      nudgesSinceProgress: 0,
      lastNudgeTs: 0,
      lastMarker: null,
      backoffStreak: 0,
      backoffUntil: 0,
      backoffPending: false,
      lastErrorTs: 0,
      abortedAt: {},
      finalReviewNudged: false,
      done: false,
    };
  }

  function observe(o: WatchdogObservation): void {
    obs = o;

    if (st.lastMarker !== null && st.lastMarker !== o.progressMarker) {
      st.nudgesSinceProgress = 0;
      st.backoffStreak = 0;
    }
    st.lastMarker = o.progressMarker;

    const fresher = o.errors.filter((e) => e.ts > st.lastErrorTs).sort((a, b) => a.ts - b.ts);
    for (const e of fresher) {
      st.lastErrorTs = e.ts;
      // Errors landing inside an active backoff are in-flight fallout: they do not escalate.
      if (e.ts < st.backoffUntil) continue;
      st.backoffStreak += 1;
      const delay = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (st.backoffStreak - 1));
      st.backoffUntil = e.ts + delay;
      st.backoffPending = true;
    }
  }

  function tick(now: number): WatchdogAction[] {
    if (st.done) return [];
    const finish = (a: WatchdogAction): WatchdogAction[] => {
      st.done = true;
      return [a];
    };

    if (now - st.startedAt > cfg.wallclockMs) return finish({ type: 'wallclock' });
    if (!obs) return [];
    if (obs.runCompleteSeen && obs.finalReviewExists) return finish({ type: 'complete' });

    const actions: WatchdogAction[] = [];
    if (!st.wallclockSoftSent && cfg.wallclockMs > cfg.wallclockSoftLeadMs && now - st.startedAt > cfg.wallclockMs - cfg.wallclockSoftLeadMs) {
      st.wallclockSoftSent = true;
      actions.push({ type: 'wallclock-soft' });
    }

    for (const s of obs.sessions) {
      if (!s.busy) {
        delete st.abortedAt[s.id];
        continue;
      }
      if (now - s.lastEventTs < cfg.hungMs) continue;
      // a tool call in flight (a long build, a test run) is work, not a hang, until it has run for `toolMaxMs`
      if (s.runningToolSinceTs !== undefined && now - s.runningToolSinceTs <= cfg.toolMaxMs) continue;
      const prev = st.abortedAt[s.id];
      if (prev !== undefined && now - prev < cfg.hungMs) continue;
      st.abortedAt[s.id] = now;
      actions.push({ type: 'abort-session', id: s.id });
    }

    if (st.backoffPending) {
      st.backoffPending = false;
      actions.push({ type: 'backoff', untilTs: st.backoffUntil });
    }
    if (now < st.backoffUntil) return actions;

    const root = obs.sessions.find((s) => s.id === obs!.rootId);
    const anyBusy = obs.sessions.some((s) => s.busy);
    if (anyBusy) return actions;

    const reason = obs.runCompleteSeen && !obs.finalReviewExists ? FINAL_REVIEW_MISSING : undefined;
    const idleSince = Math.max(root?.lastEventTs ?? 0, st.lastNudgeTs, st.startedAt);
    const idleEnough = now - idleSince >= cfg.idleMs;
    const finalReviewNow = reason !== undefined && !st.finalReviewNudged;
    if (!idleEnough && !finalReviewNow) return actions;

    if (st.nudgesSinceProgress >= cfg.stallNudges) {
      return [...actions, ...finish({ type: 'stalled', reason: `${st.nudgesSinceProgress} nudges without progress` })];
    }
    if (st.nudges >= cfg.maxNudges) {
      return [...actions, ...finish({ type: 'stalled', reason: `max nudges (${cfg.maxNudges}) reached` })];
    }

    st.nudges += 1;
    st.nudgesSinceProgress += 1;
    st.lastNudgeTs = now;
    if (reason !== undefined) st.finalReviewNudged = true;
    actions.push(reason === undefined ? { type: 'nudge' } : { type: 'nudge', reason });
    return actions;
  }

  return {
    observe,
    tick,
    snapshot: () => ({ ...st, abortedAt: { ...st.abortedAt } }),
    restore(s) {
      st = { ...s, abortedAt: { ...s.abortedAt } };
    },
  };
}
