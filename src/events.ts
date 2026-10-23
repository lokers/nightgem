/**
 * Event pump and ledger feed.
 *
 * Consumes `api.events()` (SSE of the per-run server) and
 *  - appends a REDACTED copy of every event to `events.jsonl` (recv time added, heartbeats and text deltas skipped);
 *  - tracks session ids, busy/idle per session (`session.execution.started` -> busy, `...succeeded|failed|interrupted`
 *    -> idle) and the last event time per session;
 *  - auto-rejects every `permission.asked` immediately, records a defect and calls `onPermissionRejected`;
 *  - reconnects and fully reconciles after `silenceMs` without any frame (heartbeats count as frames) and after a
 *    dropped stream;
 *  - `reconcile()` polls `listSessions` (+ `getSession` for known ids the list missed), feeds `ledger.ingestSession`,
 *    appends `ledger.toCostLines` to `cost.jsonl`, sweeps pending permissions and returns the ledger level. It runs
 *    every `reconcileIntervalMs` (45 s), after every terminal execution event, on every reconnect, and (throttled)
 *    after `session.usage.updated` so thresholds trip quickly.
 *
 * SSE is for speed only: the ledger is only ever fed from `Session.Info` polls (the source of truth).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { HEARTBEAT_EVENT_TYPE, isRunApiError } from './client.ts';
import type { BudgetLedger, BudgetLevel } from './budget.ts';
import {
  CostLine,
  PermissionRequest,
  isExecutionTerminal,
  type Defect,
  type Phase,
  type RunApi,
  type ServerEvent,
  type SessionInfo,
} from './contracts.ts';
import type { RunPaths } from './paths.ts';
import { appendJsonl } from './state.ts';

export const DEFAULT_RECONCILE_INTERVAL_MS = 45_000;
export const DEFAULT_SILENCE_MS = 2 * 60_000;
export const DEFAULT_USAGE_RECONCILE_MS = 5_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const MAX_LOGGED_STRING = 2_000;
const REDACTED = '[REDACTED]';

/** `RunApi` plus the optional authoritative busy list implemented by `RunClient`. */
export type PumpApi = RunApi & { listActiveSessions?: () => Promise<string[]> };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_SUBSTRINGS = ['password', 'passwd', 'secret', 'apikey', 'api_key', 'api-key', 'authorization', 'cookie', 'credential', 'privatekey', 'private_key'];

/** Object keys whose value must never reach events.jsonl. `tokens` (usage counters) is NOT a secret. */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_KEY_SUBSTRINGS.some((s) => k.includes(s))) return true;
  return k === 'token' || /[a-z0-9][_-]token$/.test(k) || /[a-z]Token$/.test(key);
}

const STRING_PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/g, 'Basic [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, 'jwt-[REDACTED]'],
  [/\b[a-f0-9]{48}\b/g, REDACTED],
  [/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, (_m, name) => `${name}=${REDACTED}`],
];

export function redactString(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join(REDACTED);
  for (const [re, rep] of STRING_PATTERNS) out = out.replace(re, rep as string);
  if (out.length > MAX_LOGGED_STRING) out = `${out.slice(0, MAX_LOGGED_STRING)}…[truncated ${out.length - MAX_LOGGED_STRING} chars]`;
  return out;
}

/** Deep, non-mutating redaction of an event (or any JSON value). */
export function redactValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 20) return '[TRUNCATED: too deep]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) && v !== null && v !== undefined && typeof v !== 'boolean' && typeof v !== 'object' ? REDACTED : redactValue(v, secrets, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pump
// ---------------------------------------------------------------------------

export interface TerminalInfo {
  sessionId: string;
  type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted';
  parentId: string | undefined;
  /** Local clock ms. */
  at: number;
}

export interface PermissionRejectedInfo {
  defect: Defect;
  request: PermissionRequest;
  /** False when the reply failed (e.g. already cancelled by an earlier reject in the same session). */
  replied: boolean;
}

export interface SessionState {
  id: string;
  parentId: string | undefined;
  agent: string | undefined;
  busy: boolean;
  /** Local clock ms of the last event for this session (`undefined`: only seen via polling). */
  lastEventAt: number | undefined;
  lastTerminal: TerminalInfo['type'] | undefined;
}

export interface PumpStats {
  events: number;
  logged: number;
  reconnects: number;
  silences: number;
  reconciles: number;
  reconcileErrors: number;
  rejectedPermissions: number;
  logErrors: number;
}

export interface EventPumpOptions {
  api: PumpApi;
  ledger: BudgetLedger;
  paths: Pick<RunPaths, 'eventsJsonl' | 'costJsonl'>;
  phaseOf: (sessionId: string) => Phase;
  onTerminal?: (info: TerminalInfo) => void;
  onPermissionRejected?: (info: PermissionRejectedInfo) => void;
  /** Called when the stream was silent for `silenceMs` (just before the reconnect). */
  onSilence?: (silentForMs: number) => void;
  /** Every non-heartbeat event, after it was logged and tracked. Lets the caller watch for e.g. `session.error`. */
  onEvent?: (ev: ServerEvent) => void;
  /** Stream drops, failed polls and failed log writes. Never throws into the pump. */
  onError?: (err: unknown, where: 'stream' | 'reconcile' | 'log' | 'permission' | 'callback') => void;
  clock?: Clock;
  reconcileIntervalMs?: number;
  silenceMs?: number;
  usageReconcileMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Extra literal secrets to scrub from events.jsonl (the server password etc.). */
  secrets?: string[];
  /** Also log `*.delta` events (default false: they dominate volume and carry no audit value). */
  logDeltas?: boolean;
}

export interface EventPump {
  /** Start consuming events and the timers. Idempotent. */
  start(): void;
  /** Stop the stream, timers and in-flight work. Does NOT run a final reconcile (call `reconcile()` first). */
  stop(): Promise<void>;
  /** Poll the server, feed the ledger, append cost lines, sweep pending permissions. Resolves to the ledger level. */
  reconcile(): Promise<BudgetLevel>;
  sessionIds(): string[];
  sessions(): SessionState[];
  isBusy(sessionId: string): boolean;
  busySessionIds(): string[];
  lastEventAt(sessionId: string): number | undefined;
  /** True while a tool call of this session has started (`session.tool.called`) and not ended (`.success` / `.failed`). */
  hasRunningTool(sessionId: string): boolean;
  /** Local clock ms the oldest in-flight tool call of this session started (undefined: none). */
  runningToolSince(sessionId: string): number | undefined;
  /** Local clock ms of the last non-heartbeat event of any session (undefined: none yet). */
  lastActivityAt(): number | undefined;
  /** Defects recorded by the pump (permission asks) in order. */
  defects(): Defect[];
  stats(): PumpStats;
}

const isHeartbeat = (type: string): boolean => type === HEARTBEAT_EVENT_TYPE;
const sessionIdOf = (ev: ServerEvent): string | undefined => {
  const id = ev.data?.sessionID;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};

export function createEventPump(opts: EventPumpOptions): EventPump {
  const clock = opts.clock ?? realClock;
  const api = opts.api;
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
  const usageReconcileMs = opts.usageReconcileMs ?? DEFAULT_USAGE_RECONCILE_MS;
  const reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const secrets = opts.secrets ?? [];

  const sessionMap = new Map<string, SessionState>();
  const busySince = new Map<string, number>();
  /** Per session: tool call id -> local ms it started. */
  const tools = new Map<string, Map<string, number>>();
  const rejected = new Set<string>();
  const defectList: Defect[] = [];
  const background = new Set<Promise<unknown>>();
  const stat: PumpStats = { events: 0, logged: 0, reconnects: 0, silences: 0, reconciles: 0, reconcileErrors: 0, rejectedPermissions: 0, logErrors: 0 };

  let started = false;
  let stopped = false;
  let loop: Promise<void> | undefined;
  let streamAbort: AbortController | undefined;
  let lastFrameAt = clock.now();
  let lastActivity: number | undefined;
  let reconcileTimer: unknown;
  let usageTimer: unknown;
  let silenceTimer: unknown;
  let backoffTimer: unknown;
  let wakeBackoff: (() => void) | undefined;

  const safe = (cb: (() => void) | undefined): void => {
    try {
      cb?.();
    } catch (err) {
      opts.onError?.(err, 'callback');
    }
  };
  const track = <T>(p: Promise<T>): Promise<T> => {
    background.add(p);
    const done = (): void => void background.delete(p);
    p.then(done, done);
    return p;
  };

  // --- session bookkeeping ----------------------------------------------------

  function ensure(id: string): SessionState {
    let s = sessionMap.get(id);
    if (!s) {
      s = { id, parentId: undefined, agent: undefined, busy: false, lastEventAt: undefined, lastTerminal: undefined };
      sessionMap.set(id, s);
    }
    return s;
  }

  function setBusy(s: SessionState, busy: boolean, at: number): void {
    s.busy = busy;
    if (busy) busySince.set(s.id, at);
    else {
      busySince.delete(s.id);
      tools.delete(s.id); // an idle session cannot have a tool in flight (an interrupt never sends `.failed` for every call)
    }
  }

  // --- events.jsonl -----------------------------------------------------------

  function skipLogging(ev: ServerEvent): boolean {
    if (isHeartbeat(ev.type)) return true;
    return !opts.logDeltas && ev.type.endsWith('.delta');
  }

  function logEvent(ev: ServerEvent, at: number): void {
    if (skipLogging(ev)) return;
    try {
      const line = JSON.stringify({ ...(redactValue(ev, secrets) as Record<string, unknown>), recv: at });
      mkdirSync(dirname(opts.paths.eventsJsonl), { recursive: true });
      appendFileSync(opts.paths.eventsJsonl, `${line}\n`, { mode: 0o644 });
      stat.logged++;
    } catch (err) {
      stat.logErrors++;
      opts.onError?.(err, 'log');
    }
  }

  // --- permission auto-reject -------------------------------------------

  async function rejectPermission(req: PermissionRequest): Promise<void> {
    if (rejected.has(req.id)) return;
    rejected.add(req.id);
    let replied = true;
    try {
      await api.replyPermission(req.sessionID, req.id, 'reject');
    } catch (err) {
      replied = false;
      opts.onError?.(err, 'permission');
    }
    stat.rejectedPermissions++;
    const what = `${req.action}${req.resources.length > 0 ? ` ${req.resources.join(' | ')}` : ''}`;
    const defect: Defect = {
      ts: new Date(clock.now()).toISOString(),
      kind: 'permission-asked',
      message: redactString(`permission.asked auto-rejected: ${what}`, secrets).slice(0, 400) + (replied ? '' : ' (reply failed; probably already cancelled)'),
      sessionId: req.sessionID,
    };
    defectList.push(defect);
    safe(() => opts.onPermissionRejected?.({ defect, request: req, replied }));
  }

  // --- reconcile --------------------------------------------------------------

  let running: Promise<BudgetLevel> | undefined;
  let queued: Promise<BudgetLevel> | undefined;

  async function doReconcile(): Promise<BudgetLevel> {
    stat.reconciles++;
    const now = clock.now();
    const listed = await api.listSessions({ order: 'asc' });
    const byId = new Map<string, SessionInfo>(listed.map((s) => [s.id, s]));

    // known ids the list did not return (page cap, races): ask individually
    for (const id of [...sessionMap.keys()]) {
      if (byId.has(id)) continue;
      try {
        byId.set(id, await api.getSession(id));
      } catch (err) {
        // 404 for a session we only guessed at is fine; anything else surfaces
        if (!(isRunApiError(err) && err.isNotFound)) opts.onError?.(err, 'reconcile');
      }
    }

    for (const info of byId.values()) {
      const s = ensure(info.id);
      if (info.parentID !== undefined) s.parentId = info.parentID;
      if (info.agent !== undefined) s.agent = info.agent;
      opts.ledger.ingestSession(info);
    }

    // busy correction: authoritative active list when the client has it, else the `time.idle` heuristic
    if (api.listActiveSessions) {
      try {
        const active = new Set(await api.listActiveSessions());
        for (const id of active) setBusy(ensure(id), true, busySince.get(id) ?? now);
        for (const s of sessionMap.values()) if (s.busy && !active.has(s.id)) setBusy(s, false, now);
      } catch (err) {
        opts.onError?.(err, 'reconcile');
      }
    } else {
      for (const s of sessionMap.values()) {
        const since = busySince.get(s.id);
        const idle = byId.get(s.id)?.time.idle;
        if (s.busy && since !== undefined && idle !== undefined && idle >= since) setBusy(s, false, now);
      }
    }

    for (const line of opts.ledger.toCostLines(opts.phaseOf)) appendJsonl(opts.paths.costJsonl, CostLine, line);

    // asks we missed while disconnected
    try {
      for (const req of await api.listPendingPermissions()) await rejectPermission(req);
    } catch (err) {
      opts.onError?.(err, 'permission');
    }

    return opts.ledger.check();
  }

  function reconcile(): Promise<BudgetLevel> {
    if (queued) return queued;
    const prev = running ?? Promise.resolve(undefined);
    const p: Promise<BudgetLevel> = prev
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        const r = doReconcile();
        running = r;
        return r;
      });
    queued = p;
    return p;
  }

  /** Reconcile from a timer/event path: never rejects, counts errors. */
  function reconcileQuietly(): Promise<BudgetLevel | undefined> {
    return track(
      reconcile().catch((err: unknown) => {
        stat.reconcileErrors++;
        opts.onError?.(err, 'reconcile');
        return undefined;
      }),
    );
  }

  function scheduleReconcileTimer(): void {
    if (stopped) return;
    reconcileTimer = clock.setTimeout(() => {
      void reconcileQuietly().finally(scheduleReconcileTimer);
    }, reconcileIntervalMs);
  }

  function scheduleUsageReconcile(): void {
    if (usageTimer !== undefined || stopped) return;
    usageTimer = clock.setTimeout(() => {
      usageTimer = undefined;
      void reconcileQuietly();
    }, usageReconcileMs);
  }

  // --- event handling -----------------------------------------------------------

  function handle(ev: ServerEvent, at: number): void {
    stat.events++;
    if (isHeartbeat(ev.type)) return;
    lastActivity = at;
    logEvent(ev, at);

    safe(() => opts.onEvent?.(ev));

    const sid = sessionIdOf(ev);
    const s = sid ? ensure(sid) : undefined;
    if (s) s.lastEventAt = at;

    switch (ev.type) {
      case 'session.created': {
        if (!s) break;
        const parent = ev.data.parentID;
        if (typeof parent === 'string') s.parentId = parent;
        if (typeof ev.data.agent === 'string') s.agent = ev.data.agent;
        break;
      }
      case 'session.execution.started':
        if (s) setBusy(s, true, at);
        break;
      case 'session.tool.called': {
        const id = typeof ev.data.id === 'string' ? ev.data.id : undefined;
        if (s && id) {
          const m = tools.get(s.id) ?? new Map<string, number>();
          if (!m.has(id)) m.set(id, at);
          tools.set(s.id, m);
        }
        break;
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = typeof ev.data.id === 'string' ? ev.data.id : undefined;
        if (s && id) {
          const m = tools.get(s.id);
          m?.delete(id);
          if (m?.size === 0) tools.delete(s.id);
        }
        break;
      }
      case 'session.usage.updated':
      case 'session.step.ended':
        scheduleUsageReconcile();
        break;
      case 'permission.asked': {
        const parsed = PermissionRequest.safeParse(ev.data);
        if (parsed.success) void track(rejectPermission(parsed.data));
        else opts.onError?.(new Error(`unparseable permission.asked: ${parsed.error.issues[0]?.message ?? 'invalid'}`), 'permission');
        break;
      }
      default:
        if (isExecutionTerminal(ev.type) && s) {
          setBusy(s, false, at);
          s.lastTerminal = ev.type as TerminalInfo['type'];
          const info: TerminalInfo = { sessionId: s.id, type: ev.type as TerminalInfo['type'], parentId: s.parentId, at };
          // reconcile first so the callback sees an up-to-date ledger
          void track(reconcileQuietly().then(() => safe(() => opts.onTerminal?.(info))));
        }
    }
  }

  // --- stream loop ----------------------------------------------------------------

  function sleepBackoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wakeBackoff = resolve;
      backoffTimer = clock.setTimeout(() => {
        wakeBackoff = undefined;
        resolve();
      }, ms);
    });
  }

  async function consume(): Promise<void> {
    let attempt = 0;
    let first = true;
    while (!stopped) {
      const ac = new AbortController();
      streamAbort = ac;
      lastFrameAt = clock.now();
      if (!first) {
        stat.reconnects++;
        void reconcileQuietly(); // reconcile on every reconnect
      }
      first = false;

      const aborted = new Promise<'aborted'>((resolve) => ac.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
      let iterator: AsyncIterator<ServerEvent> | undefined;
      try {
        iterator = api.events({ signal: ac.signal })[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next === 'aborted' || next.done) break;
          const at = clock.now();
          lastFrameAt = at;
          attempt = 0;
          handle(next.value, at);
        }
      } catch (err) {
        if (!stopped && !ac.signal.aborted) opts.onError?.(err, 'stream');
      } finally {
        void Promise.resolve(iterator?.return?.()).catch(() => undefined);
      }
      if (stopped) break;

      // stream ended, broke, or was aborted for silence: back off, then reconnect
      const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt);
      attempt++;
      await sleepBackoff(delay);
    }
  }

  function scheduleSilenceCheck(): void {
    if (stopped) return;
    const every = Math.max(10, Math.min(10_000, Math.floor(silenceMs / 4)));
    silenceTimer = clock.setTimeout(() => {
      const quiet = clock.now() - lastFrameAt;
      if (quiet >= silenceMs && streamAbort && !streamAbort.signal.aborted) {
        stat.silences++;
        lastFrameAt = clock.now();
        safe(() => opts.onSilence?.(quiet));
        streamAbort.abort(); // loop reconnects and reconciles
      }
      scheduleSilenceCheck();
    }, every);
  }

  // --- public ---------------------------------------------------------------------

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      lastFrameAt = clock.now();
      loop = consume();
      scheduleReconcileTimer();
      scheduleSilenceCheck();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      for (const t of [reconcileTimer, usageTimer, silenceTimer, backoffTimer]) if (t !== undefined) clock.clearTimeout(t);
      usageTimer = undefined;
      streamAbort?.abort();
      wakeBackoff?.();
      await loop?.catch(() => undefined);
      await Promise.allSettled([...background]);
    },

    reconcile,

    sessionIds: () => [...sessionMap.keys()],
    sessions: () => [...sessionMap.values()].map((s) => ({ ...s })),
    isBusy: (id) => sessionMap.get(id)?.busy ?? false,
    busySessionIds: () => [...sessionMap.values()].filter((s) => s.busy).map((s) => s.id),
    lastEventAt: (id) => sessionMap.get(id)?.lastEventAt,
    hasRunningTool: (id) => (tools.get(id)?.size ?? 0) > 0,
    runningToolSince: (id) => {
      const m = tools.get(id);
      return m && m.size > 0 ? Math.min(...m.values()) : undefined;
    },
    lastActivityAt: () => lastActivity,
    defects: () => [...defectList],
    stats: () => ({ ...stat }),
  };
}
