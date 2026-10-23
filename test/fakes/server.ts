/**
 * Test doubles for the orchestrator: a manual clock that can drive a whole run, a scriptable fake run server
 * (RunApi + event source + `ServerHandle`) and a signal source. Everything is deterministic; nothing here uses real timers.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RunApiError } from '../../src/client.ts';
import {
  ServerEvent,
  SessionInfo,
  type CreateSessionInput,
  type EvalPermissionInput,
  type ListSessionsInput,
  type PermissionEffect,
  type PermissionReply,
  type PermissionRequest,
  type Phase,
  type PromptInput,
  type TaskEvent,
} from '../../src/contracts.ts';
import type { Clock } from '../../src/events.ts';
import type { ServerApi, ServerHandle, SignalSource } from '../../src/orchestrator.ts';
import type { RunPaths } from '../../src/paths.ts';

export const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(start = 1_800_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  pending(): number {
    return this.timers.size;
  }
  private next(): [number, { at: number; fn: () => void }] | undefined {
    return [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  }
  /** Fire due timers up to `t + ms`, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const n = this.next();
      if (!n || n[1].at > target) break;
      this.timers.delete(n[0]);
      this.t = Math.max(this.t, n[1].at);
      n[1].fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
  /** Jump from timer to timer until `promise` settles (or `maxSimMs` of simulated time passed). */
  async runUntil<T>(promise: Promise<T>, maxSimMs = 24 * 3_600_000): Promise<T> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    const limit = this.t + maxSimMs;
    await flush();
    while (!settled) {
      const n = this.next();
      if (!n) {
        await flush(30);
        if (settled) break;
        throw new Error('FakeClock deadlock: promise pending and no timers left');
      }
      if (n[1].at > limit) throw new Error(`FakeClock: simulated time limit (${maxSimMs} ms) exceeded`);
      this.timers.delete(n[0]);
      this.t = Math.max(this.t, n[1].at);
      n[1].fn();
      await flush();
    }
    return promise;
  }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export class FakeSignals implements SignalSource {
  private handlers = new Map<string, Set<() => void>>();
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): () => void {
    const set = this.handlers.get(signal) ?? new Set();
    set.add(handler);
    this.handlers.set(signal, set);
    return () => set.delete(handler);
  }
  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    for (const h of this.handlers.get(signal) ?? []) h();
  }
  listenerCount(): number {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
}

// ---------------------------------------------------------------------------
// Fake run server
// ---------------------------------------------------------------------------

export type PromptKind = 'phase-plan' | 'phase-build' | 'phase-review' | 'phase-review-lite' | 'phase-report' | 'nudge' | 'wind-down' | 'other';

export function promptKind(text: string): PromptKind {
  if (/^Phase: review,? ?-?lite\b/.test(text)) return 'phase-review-lite'; // the real prompt reads "Phase: review, lite (run ..."
  const m = /^Phase: (plan|build|review|report) /.exec(text);
  if (m) return `phase-${m[1]}` as PromptKind;
  if (text.startsWith('You went idle')) return 'nudge';
  if (text.startsWith('WIND-DOWN')) return 'wind-down';
  return 'other';
}

export interface PromptRecord {
  sessionId: string;
  text: string;
  kind: PromptKind;
  at: number;
  input: PromptInput;
}

interface FakeSession {
  id: string;
  parentId: string | undefined;
  agent: string | undefined;
  cost: number;
  busy: boolean;
  created: number;
  updated: number;
}

interface Conn {
  push(ev: ServerEvent): void;
  end(): void;
  closed: boolean;
}

export class FakeServer implements ServerApi, ServerHandle {
  readonly api: ServerApi = this;
  url = 'http://127.0.0.1:49999';
  port = 49999;
  pid = 99999;
  version = '2.0.29';

  sessions = new Map<string, FakeSession>();
  prompts: PromptRecord[] = [];
  /** Session ids in the order `interrupt()` was called. */
  interrupts: string[] = [];
  created: Array<{ id: string; input: CreateSessionInput }> = [];
  replies: Array<{ sessionId: string; requestId: string; reply: PermissionReply }> = [];
  conns: Conn[] = [];
  listCalls = 0;
  stopped = false;
  stopCalls = 0;
  pending: PermissionRequest[] = [];

  /** Script hooks. */
  onPrompt: ((p: PromptRecord, srv: FakeServer) => void) | undefined;
  onInterrupt: ((id: string, wasBusy: boolean, srv: FakeServer) => void) | undefined;
  onCreate: ((id: string, input: CreateSessionInput, srv: FakeServer) => void) | undefined;
  /** Throw this from `createSession` (any call whose 1-based index is in `failCreateAt`). */
  createError: Error | undefined;
  failCreateAt = new Set<number>();
  createCalls = 0;
  /** While set, `listSessions` throws it. */
  listError: Error | undefined;
  /** When true, interrupting a busy child while the parent is idle wakes the parent (recorded OpenCode behaviour). */
  childWakesParent = false;
  /** Called at the moment each interrupt happens; lets tests observe the world at that instant. */
  interruptProbe: ((id: string) => void) | undefined;

  private seq = 0;
  private resolveExit!: (v: unknown) => void;
  exited: Promise<unknown> = new Promise((r) => (this.resolveExit = r));
  private exitedFlag = false;

  constructor(
    readonly clock: FakeClock,
    readonly paths: RunPaths,
  ) {}

  hasExited(): boolean {
    return this.exitedFlag;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    this.stopped = true;
    for (const c of this.conns) c.end();
    this.exitedFlag = true;
    this.resolveExit({ exitCode: 0 });
  }
  /** Simulate the server process dying. */
  crash(): void {
    this.exitedFlag = true;
    for (const c of this.conns) c.end();
    this.resolveExit({ exitCode: 137 });
  }

  // --- events ---------------------------------------------------------------------

  emit(type: string, data: Record<string, unknown>): void {
    const ev = ServerEvent.parse({ id: `evt_${++this.seq}`, type, created: this.clock.now(), data });
    for (const c of this.conns) if (!c.closed) c.push(ev);
  }

  events(opts: { signal?: AbortSignal } = {}): AsyncIterable<ServerEvent> {
    const queue: Array<ServerEvent | 'end'> = [];
    let wake: (() => void) | undefined;
    const conn: Conn = {
      closed: false,
      push: (ev) => {
        queue.push(ev);
        wake?.();
      },
      end: () => {
        queue.push('end');
        wake?.();
      },
    };
    opts.signal?.addEventListener('abort', () => (conn.closed = true));
    this.conns.push(conn);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ServerEvent>> => {
          for (;;) {
            const item = queue.shift();
            if (item === 'end') return { done: true, value: undefined };
            if (item) return { done: false, value: item };
            await new Promise<void>((r) => (wake = r));
          }
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  // --- scripting helpers --------------------------------------------------------------

  info(s: FakeSession): SessionInfo {
    return SessionInfo.parse({
      id: s.id,
      ...(s.parentId ? { parentID: s.parentId } : {}),
      ...(s.agent ? { agent: s.agent } : {}),
      cost: s.cost,
      time: { created: s.created, updated: s.updated },
      location: { directory: this.paths.runDir },
    });
  }

  private add(id: string, parentId: string | undefined, agent: string | undefined): FakeSession {
    const s: FakeSession = { id, parentId, agent, cost: 0, busy: false, created: this.clock.now(), updated: this.clock.now() };
    this.sessions.set(id, s);
    this.emit('session.created', { sessionID: id, ...(parentId ? { parentID: parentId } : {}), ...(agent ? { agent } : {}) });
    return s;
  }

  /** A root session created out of band (e.g. the preflight canary): no events, just a session with a cost. */
  seedSession(usd: number, agent = 'orchestrator'): string {
    const id = `ses_seed_${++this.seq}`;
    this.add(id, undefined, agent).cost = usd;
    return id;
  }

  /** A child session (slim background task). */
  spawnChild(parentId: string, agent = 'fixer', busy = true): string {
    const id = `ses_child_${++this.seq}`;
    this.add(id, parentId, agent);
    if (busy) this.setBusy(id, true);
    return id;
  }

  setBusy(id: string, busy: boolean, terminal: 'succeeded' | 'failed' | 'interrupted' = 'succeeded'): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    if (busy === s.busy) return;
    s.busy = busy;
    s.updated = this.clock.now();
    this.emit(busy ? 'session.execution.started' : `session.execution.${terminal}`, { sessionID: id });
  }

  addCost(id: string, usd: number): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    s.cost += usd;
    s.updated = this.clock.now();
    this.emit('session.usage.updated', { sessionID: id, cost: s.cost });
  }

  /** Total cost over all sessions. */
  totalCost(): number {
    return [...this.sessions.values()].reduce((n, s) => n + s.cost, 0);
  }

  appendTask(ev: Partial<TaskEvent> & { id: string; state: TaskEvent['state']; phase: Phase }): void {
    const line = {
      ts: new Date(this.clock.now()).toISOString(),
      repo: '_run',
      branch: '-',
      worktree: this.paths.specsDir,
      attempt: 0,
      verify: [],
      ...ev,
    };
    mkdirSync(dirname(this.paths.tasksJsonl), { recursive: true });
    appendFileSync(this.paths.tasksJsonl, `${JSON.stringify(line)}\n`);
  }

  markPhaseDone(phase: Phase): void {
    this.appendTask({ id: `phase:${phase}`, state: 'done', phase });
  }

  /** review-lite writes FINAL_REVIEW.md only (no run-complete.json). */
  writeFinalReview(): void {
    writeFileSync(join(this.paths.specsDir, 'FINAL_REVIEW.md'), '# Final review (lite)\n');
  }

  /** The agent works on the review-lite phase: busy now, after `afterMs` it writes FINAL_REVIEW.md and goes idle. */
  completeLite(sessionId: string, opts: { afterMs?: number; costUsd?: number } = {}): void {
    this.setBusy(sessionId, true);
    this.clock.setTimeout(() => {
      if (this.stopped) return;
      if (opts.costUsd) this.addCost(sessionId, opts.costUsd);
      this.writeFinalReview();
      this.setBusy(sessionId, false);
    }, opts.afterMs ?? 30_000);
  }

  /** A tool call starts / ends in a session (the events the watchdog's hung detection relies on). */
  toolCalled(sessionId: string, id: string, input: Record<string, unknown> = { command: 'npm test' }): void {
    this.emit('session.tool.called', { sessionID: sessionId, id, input });
  }
  toolEnded(sessionId: string, id: string, ok = true): void {
    this.emit(ok ? 'session.tool.success' : 'session.tool.failed', { sessionID: sessionId, id });
  }

  writeRunComplete(): void {
    writeFileSync(join(this.paths.runDir, 'run-complete.json'), `${JSON.stringify({ type: 'run.complete', ts: new Date(this.clock.now()).toISOString(), summary: 'done', finalReviewPath: join(this.paths.specsDir, 'FINAL_REVIEW.md') })}\n`);
    writeFileSync(join(this.paths.specsDir, 'FINAL_REVIEW.md'), '# Final review\n');
  }

  /**
   * The agent works on a phase: the root goes busy now, and after `afterMs` it spends `costUsd`, writes the phase artifacts
   * (`phase:<name>` done; for review also run-complete.json + FINAL_REVIEW.md) and goes idle.
   */
  completePhase(sessionId: string, phase: Phase, opts: { afterMs?: number; costUsd?: number } = {}): void {
    this.setBusy(sessionId, true);
    this.clock.setTimeout(() => {
      if (this.stopped) return;
      if (opts.costUsd) this.addCost(sessionId, opts.costUsd);
      if (phase === 'review') this.writeRunComplete();
      this.markPhaseDone(phase);
      this.setBusy(sessionId, false);
    }, opts.afterMs ?? 30_000);
  }

  askPermission(sessionId: string, action = 'shell', resources: string[] = ['echo hi']): PermissionRequest {
    const req = { id: `per_${++this.seq}`, sessionID: sessionId, action, resources } as PermissionRequest;
    this.emit('permission.asked', { ...req });
    return req;
  }

  // --- RunApi ----------------------------------------------------------------------------

  async listAgents(): Promise<never[]> {
    return [];
  }
  async evalPermission(_i: EvalPermissionInput): Promise<PermissionEffect> {
    return 'allow';
  }
  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const index = ++this.createCalls;
    if (this.createError && (this.failCreateAt.size === 0 || this.failCreateAt.has(index))) throw this.createError;
    const id = `ses_root_${++this.seq}`;
    this.created.push({ id, input });
    const s = this.add(id, input.parentId, input.agent);
    this.onCreate?.(id, input, this);
    return this.info(s);
  }
  async prompt(sessionId: string, input: PromptInput): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new RunApiError({ kind: 'http', message: 'not found', method: 'POST', path: '/prompt', status: 404 });
    const rec: PromptRecord = { sessionId, text: input.text, kind: promptKind(input.text), at: this.clock.now(), input };
    this.prompts.push(rec);
    this.onPrompt?.(rec, this);
  }
  async interrupt(sessionId: string): Promise<boolean> {
    this.interrupts.push(sessionId);
    this.interruptProbe?.(sessionId);
    const s = this.sessions.get(sessionId);
    const wasBusy = s?.busy ?? false;
    if (s && wasBusy) {
      this.setBusy(sessionId, false, 'interrupted');
      if (this.childWakesParent && s.parentId) {
        const parent = this.sessions.get(s.parentId);
        if (parent && !parent.busy) this.setBusy(parent.id, true);
      }
    }
    this.onInterrupt?.(sessionId, wasBusy, this);
    return wasBusy;
  }
  async getSession(id: string): Promise<SessionInfo> {
    const s = this.sessions.get(id);
    if (!s) throw new RunApiError({ kind: 'http', message: 'not found', method: 'GET', path: `/api/session/${id}`, status: 404 });
    return this.info(s);
  }
  async listSessions(_input?: ListSessionsInput): Promise<SessionInfo[]> {
    this.listCalls++;
    if (this.listError) throw this.listError;
    return [...this.sessions.values()].map((s) => this.info(s));
  }
  async listPendingPermissions(): Promise<PermissionRequest[]> {
    return this.pending;
  }
  async replyPermission(sessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    this.replies.push({ sessionId, requestId, reply });
  }
  async listActiveSessions(): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.busy).map((s) => s.id);
  }
}
