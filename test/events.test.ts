/**
 * Tests for src/events.ts against a fake RunApi driven by the recorded opencode 2.0.29 fixtures
 * (test/fixtures/opencode-2.0.29/recorded/) and a manual clock.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BudgetLedger, type BudgetEvent } from '../src/budget.ts';
import { HEARTBEAT_EVENT_TYPE } from '../src/client.ts';
import {
  CostLine,
  PermissionRequest,
  ServerEvent,
  SessionInfo,
  type CreateSessionInput,
  type EvalPermissionInput,
  type ListSessionsInput,
  type PermissionReply,
  type Phase,
  type PromptInput,
} from '../src/contracts.ts';
import {
  createEventPump,
  isSecretKey,
  redactString,
  redactValue,
  type Clock,
  type EventPump,
  type EventPumpOptions,
  type PermissionRejectedInfo,
  type PumpApi,
  type TerminalInfo,
} from '../src/events.ts';
import { RECORDED_FIXTURES, REPO_ROOT } from './fixtures/paths.ts';

const FIXTURES = join(REPO_ROOT, RECORDED_FIXTURES);
const readJson = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const readEvents = (name: string): ServerEvent[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const { recv: _recv, ...wire } = JSON.parse(l);
      void _recv;
      return ServerEvent.parse(wire);
    });

const S1 = readEvents('events-s1-s.jsonl');
const S2 = readEvents('events-s2-s.jsonl');
const S4 = readEvents('events-s4-deleg.jsonl');
const S7 = readEvents('events-s7.jsonl');
const S1_SESSION = SessionInfo.parse(readJson('session.get.json').body.data);
const S1_ID = S1_SESSION.id;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
};

// --- manual clock -------------------------------------------------------------------

class FakeClock implements Clock {
  t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  /** Advance time, firing due timers in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
  pending(): number {
    return this.timers.size;
  }
}

// --- fake RunApi ----------------------------------------------------------------------

interface Conn {
  signal: AbortSignal | undefined;
  push(ev: ServerEvent): void;
  end(): void;
  fail(err: Error): void;
  aborted: boolean;
}

class FakeApi implements PumpApi {
  conns: Conn[] = [];
  sessions: SessionInfo[] = [];
  pending: PermissionRequest[] = [];
  replies: Array<{ sessionId: string; requestId: string; reply: PermissionReply }> = [];
  replyError: Error | undefined;
  listCalls = 0;
  listError: Error | undefined;
  getCalls: string[] = [];
  listActiveSessions: (() => Promise<string[]>) | undefined;

  get conn(): Conn {
    const c = this.conns.at(-1);
    if (!c) throw new Error('no connection yet');
    return c;
  }

  events(opts: { signal?: AbortSignal } = {}): AsyncIterable<ServerEvent> {
    const queue: Array<{ ev?: ServerEvent; end?: true; err?: Error }> = [];
    let wake: (() => void) | undefined;
    const conn: Conn = {
      signal: opts.signal,
      aborted: false,
      push: (ev) => {
        queue.push({ ev });
        wake?.();
      },
      end: () => {
        queue.push({ end: true });
        wake?.();
      },
      fail: (err) => {
        queue.push({ err });
        wake?.();
      },
    };
    // Deliberately does NOT end the iterator on abort: the pump must not depend on a well-behaved stream.
    opts.signal?.addEventListener('abort', () => {
      conn.aborted = true;
    });
    this.conns.push(conn);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ServerEvent>> => {
          for (;;) {
            const item = queue.shift();
            if (item?.err) throw item.err;
            if (item?.end) return { done: true, value: undefined };
            if (item?.ev) return { done: false, value: item.ev };
            await new Promise<void>((r) => (wake = r));
          }
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  async listSessions(_input?: ListSessionsInput): Promise<SessionInfo[]> {
    this.listCalls++;
    if (this.listError) throw this.listError;
    return this.sessions;
  }
  async getSession(id: string): Promise<SessionInfo> {
    this.getCalls.push(id);
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error('not found');
    return s;
  }
  async listPendingPermissions(): Promise<PermissionRequest[]> {
    return this.pending;
  }
  async replyPermission(sessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    this.replies.push({ sessionId, requestId, reply });
    if (this.replyError) throw this.replyError;
  }
  async listAgents(): Promise<never[]> {
    return [];
  }
  async evalPermission(_i: EvalPermissionInput): Promise<'allow'> {
    return 'allow';
  }
  async createSession(_i: CreateSessionInput): Promise<SessionInfo> {
    return S1_SESSION;
  }
  async prompt(_id: string, _i: PromptInput): Promise<void> {}
  async interrupt(_id: string): Promise<boolean> {
    return false;
  }
}

const session = (id: string, cost: number, extra: Record<string, unknown> = {}): SessionInfo =>
  SessionInfo.parse({ ...S1_SESSION, id, cost, ...extra, time: { created: 1_000, updated: 2_000, ...((extra.time as object) ?? {}) } });

// --- harness ----------------------------------------------------------------------------

let dir: string;
let clock: FakeClock;
let api: FakeApi;
let pump: EventPump | undefined;
let terminals: TerminalInfo[];
let rejections: PermissionRejectedInfo[];
let silences: number[];
let errors: Array<{ where: string; err: unknown }>;

const eventsFile = (): string => join(dir, 'events.jsonl');
const costFile = (): string => join(dir, 'cost.jsonl');
const readLines = (file: string): any[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function ledgerWith(budgetUsd = 100, now = () => new Date('2026-10-21T10:00:00.000Z')): BudgetLedger {
  return new BudgetLedger({ budgetUsd, softPct: 0.85, hardPct: 1, costMultiplier: 1, now });
}

function make(over: Partial<EventPumpOptions> = {}): EventPump {
  pump = createEventPump({
    api,
    ledger: ledgerWith(),
    paths: { eventsJsonl: eventsFile(), costJsonl: costFile() },
    phaseOf: (): Phase => 'build',
    clock,
    onTerminal: (i) => terminals.push(i),
    onPermissionRejected: (i) => rejections.push(i),
    onSilence: (ms) => silences.push(ms),
    onError: (err, where) => errors.push({ where, err }),
    reconcileIntervalMs: 45_000,
    silenceMs: 120_000,
    ...over,
  });
  return pump;
}

async function feed(events: ServerEvent[]): Promise<void> {
  for (const ev of events) api.conn.push(ev);
  await flush();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ng-events-'));
  clock = new FakeClock();
  api = new FakeApi();
  pump = undefined;
  terminals = [];
  rejections = [];
  silences = [];
  errors = [];
});

afterEach(async () => {
  await pump?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------

describe('redaction', () => {
  it('redacts secret-looking keys but keeps usage `tokens`', () => {
    for (const k of ['password', 'OPENCODE_SERVER_PASSWORD', 'authorization', 'Authorization', 'token', 'accessToken', 'access_token', 'api_key', 'apiKey', 'client_secret', 'cookie', 'Set-Cookie']) {
      expect(isSecretKey(k), k).toBe(true);
    }
    for (const k of ['tokens', 'input', 'cost', 'sessionID', 'command', 'cache']) expect(isSecretKey(k), k).toBe(false);

    const input = {
      type: 'x',
      data: {
        password: 'hunter2hunter2',
        headers: { Authorization: 'Basic b3BlbmNvZGU6c2VjcmV0cGFzc3dvcmQ=', accept: 'json' },
        tokens: { input: 4, output: 4 },
        nested: [{ token: 'abc', refreshToken: 'def', ok: 1 }],
      },
    };
    const snapshot = JSON.stringify(input);
    const out = redactValue(input) as any;
    expect(JSON.stringify(input)).toBe(snapshot); // not mutated
    expect(out.data.password).toBe('[REDACTED]');
    expect(out.data.headers.Authorization).toBe('[REDACTED]');
    expect(out.data.headers.accept).toBe('json');
    expect(out.data.tokens).toEqual({ input: 4, output: 4 });
    expect(out.data.nested[0]).toEqual({ token: '[REDACTED]', refreshToken: '[REDACTED]', ok: 1 });
  });

  it('redacts secret-looking strings, extra literal secrets, and truncates huge strings', () => {
    const pw = 'f00dfacecafebeef0123456789abcdef0123456789abcdef';
    const s = redactString(
      `curl -H "Authorization: Bearer abcdef1234567890" -u opencode:${pw} sk-ant-abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstuvwx OPENCODE_SERVER_PASSWORD=swordfish123 GH_TOKEN=invalid mine:LITERAL-SECRET-VALUE`,
      ['LITERAL-SECRET-VALUE'],
    );
    expect(s).not.toMatch(/abcdef1234567890|f00dface|sk-ant|ghp_abc|swordfish|LITERAL-SECRET/);
    expect(s).toContain('OPENCODE_SERVER_PASSWORD=[REDACTED]');
    expect(redactString('Basic configuration of the thing')).toBe('Basic configuration of the thing');
    expect(redactString('x'.repeat(5_000)).length).toBeLessThan(2_100);
    // git shas and ids are left alone
    expect(redactString('commit 788a60532bd66fe194b79f3944606cef6b68b891 ses_ea1fa15a6ffed3yg9evBd9FQkB')).toContain('788a60532bd66fe194b79f3944606cef6b68b891');
  });
});

describe('events.jsonl', () => {
  it('appends a redacted copy of each event (heartbeats and deltas skipped, recv time added)', async () => {
    make({ secrets: ['SUPER-SECRET-LITERAL'] }).start();
    await flush();
    const tainted = ServerEvent.parse({
      type: 'session.tool.called',
      data: {
        sessionID: S1_ID,
        input: { command: 'echo SUPER-SECRET-LITERAL && echo ok', env: { OPENCODE_SERVER_PASSWORD: 'f00dfacecafebeef0123456789abcdef0123456789abcdef' } },
        authorization: 'Basic b3BlbmNvZGU6c2VjcmV0cGFzc3dvcmQ=',
        token: 'tok_123',
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await feed([...S1, { type: HEARTBEAT_EVENT_TYPE, data: {} }, tainted]);

    const lines = readLines(eventsFile());
    const types = lines.map((l) => l.type);
    const expected = [...S1, tainted].filter((e) => !e.type.endsWith('.delta'));
    expect(types).toEqual(expected.map((e) => e.type));
    expect(types).not.toContain(HEARTBEAT_EVENT_TYPE);
    expect(types).not.toContain('session.text.delta');
    for (const l of lines) expect(l.recv).toBe(clock.t);

    const raw = readFileSync(eventsFile(), 'utf8');
    expect(raw).not.toMatch(/SUPER-SECRET-LITERAL|f00dface|b3BlbmNvZGU6|tok_123/);
    const last = lines.at(-1);
    expect(last.data.input.command).toBe('echo [REDACTED] && echo ok');
    expect(last.data.input.env.OPENCODE_SERVER_PASSWORD).toBe('[REDACTED]');
    expect(last.data.authorization).toBe('[REDACTED]');
    expect(last.data.token).toBe('[REDACTED]');
    expect(last.data.tokens).toEqual({ input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  it('logDeltas: true keeps delta events', async () => {
    make({ logDeltas: true }).start();
    await flush();
    await feed(S1);
    expect(readLines(eventsFile()).map((l) => l.type)).toContain('session.text.delta');
  });

  it('a failing log write is reported, never thrown into the stream', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file, not a dir');
    const p = make({ paths: { eventsJsonl: join(dir, 'blocker', 'events.jsonl'), costJsonl: costFile() } });
    p.start();
    await flush();
    await feed(S1.slice(0, 4));
    expect(errors.filter((e) => e.where === 'log').length).toBeGreaterThan(0);
    expect(p.stats().logErrors).toBeGreaterThan(0);
    expect(p.isBusy(S1_ID)).toBe(true); // tracking carried on
  });
});

describe('in-flight tool calls (a running tool is not a hung session)', () => {
  it('tracks tool.called .. success/failed per session, from the recorded fixtures', async () => {
    const p = make();
    p.start();
    await flush();
    // S4: one delegated tool call, started and finished
    const called = S4.findIndex((e) => e.type === 'session.tool.called');
    const callSession = S4[called]!.data.sessionID as string;
    await feed(S4.slice(0, called + 1));
    expect(p.hasRunningTool(callSession)).toBe(true);
    expect(p.runningToolSince(callSession)).toBe(clock.t);
    await clock.advance(10 * 60_000);
    expect(p.runningToolSince(callSession)).toBe(clock.t - 10 * 60_000);
    const ended = S4.findIndex((e, i) => i > called && e.type === 'session.tool.success');
    await feed(S4.slice(called + 1, ended + 1));
    expect(p.hasRunningTool(callSession)).toBe(false);
    expect(p.runningToolSince(callSession)).toBeUndefined();
  });

  it('a failed (interrupted) call ends it too; the whole S7 stream leaves nothing in flight', async () => {
    const p = make();
    p.start();
    await flush();
    const shellCall = S7.findIndex((e) => e.type === 'session.tool.called' && (e.data.input as Record<string, unknown> | undefined)?.command !== undefined);
    expect(shellCall).toBeGreaterThan(0);
    const sid = S7[shellCall]!.data.sessionID as string;
    await feed(S7.slice(0, shellCall + 1));
    expect(p.hasRunningTool(sid)).toBe(true);
    await feed(S7.slice(shellCall + 1));
    expect(p.hasRunningTool(sid)).toBe(false);
    for (const id of p.sessionIds()) expect(p.hasRunningTool(id), id).toBe(false);
  });

  it('the oldest in-flight call counts, and a session going idle drops its tools', async () => {
    const p = make();
    p.start();
    await flush();
    const ev = (type: string, data: Record<string, unknown>): ServerEvent => ServerEvent.parse({ type, data: { sessionID: 'ses_t', ...data } });
    await feed([ev('session.execution.started', {}), ev('session.tool.called', { id: 'a', input: {} })]);
    const first = clock.t;
    await clock.advance(5_000);
    await feed([ev('session.tool.called', { id: 'b', input: {} })]);
    expect(p.runningToolSince('ses_t')).toBe(first);
    await feed([ev('session.tool.success', { id: 'a' })]);
    expect(p.hasRunningTool('ses_t')).toBe(true);
    expect(p.runningToolSince('ses_t')).toBe(first + 5_000);
    await feed([ev('session.execution.interrupted', {})]); // an interrupt may never send `.failed` for call b
    expect(p.hasRunningTool('ses_t')).toBe(false);
  });
});

describe('session tracking: busy/idle and last event time', () => {
  it('tracks ids, busy on execution.started, idle on succeeded, with last event time', async () => {
    api.sessions = [S1_SESSION];
    const p = make();
    p.start();
    await flush();

    const started = S1.findIndex((e) => e.type === 'session.execution.started');
    await feed(S1.slice(0, started + 1));
    expect(p.sessionIds()).toEqual([S1_ID]);
    expect(p.isBusy(S1_ID)).toBe(true);
    expect(p.busySessionIds()).toEqual([S1_ID]);
    expect(p.lastEventAt(S1_ID)).toBe(clock.t);
    expect(p.lastActivityAt()).toBe(clock.t);
    expect(p.sessions()[0]?.agent).toBe('fixer');

    await clock.advance(30_000); // time passes with no events (still within the silence window)
    expect(p.lastEventAt(S1_ID)).toBe(clock.t - 30_000);

    await feed(S1.slice(started + 1));
    expect(p.isBusy(S1_ID)).toBe(false);
    expect(p.busySessionIds()).toEqual([]);
    expect(p.sessions()[0]?.lastTerminal).toBe('session.execution.succeeded');
  });

  it('trailing events after a terminal event do not flip the session back to busy', async () => {
    const p = make();
    p.start();
    await flush();
    await feed(S1);
    await feed([ServerEvent.parse({ type: 'session.usage.updated', data: { sessionID: S1_ID, cost: 1 } })]);
    expect(p.isBusy(S1_ID)).toBe(false);
  });

  it('records parent links and tracks parent/child busy state (delegation fixture)', async () => {
    const p = make();
    p.start();
    await flush();
    await feed(S4);
    const created = S4.filter((e) => e.type === 'session.created');
    const root = created[0]?.data.sessionID as string;
    const child = created[1]?.data.sessionID as string;
    expect(p.sessionIds().sort()).toEqual([root, child].sort());
    const byId = new Map(p.sessions().map((s) => [s.id, s]));
    expect(byId.get(child)?.parentId).toBe(root);
    expect(byId.get(root)?.parentId).toBeUndefined();
    // S4 ends with both executions succeeded
    expect(p.busySessionIds()).toEqual([]);
  });

  it('interrupted and failed executions are terminal too', async () => {
    const p = make();
    p.start();
    await flush();
    await feed([
      ServerEvent.parse({ type: 'session.execution.started', data: { sessionID: 'ses_a' } }),
      ServerEvent.parse({ type: 'session.execution.started', data: { sessionID: 'ses_b' } }),
    ]);
    expect(p.busySessionIds().sort()).toEqual(['ses_a', 'ses_b']);
    await feed([
      ServerEvent.parse({ type: 'session.execution.interrupted', data: { sessionID: 'ses_a', reason: 'user' } }),
      ServerEvent.parse({ type: 'session.execution.failed', data: { sessionID: 'ses_b' } }),
    ]);
    expect(p.busySessionIds()).toEqual([]);
    await flush();
    expect(terminals.map((t) => [t.sessionId, t.type]).sort()).toEqual([
      ['ses_a', 'session.execution.interrupted'],
      ['ses_b', 'session.execution.failed'],
    ]);
  });

  it('reconcile corrects a missed terminal event via time.idle (no active-list support)', async () => {
    const p = make();
    p.start();
    await flush();
    await feed([ServerEvent.parse({ type: 'session.execution.started', created: 5_000, data: { sessionID: 'ses_a' } })]);
    expect(p.isBusy('ses_a')).toBe(true);
    api.sessions = [session('ses_a', 0.1, { time: { created: 1_000, updated: 9_000, idle: clock.t + 1 } })];
    await p.reconcile();
    expect(p.isBusy('ses_a')).toBe(false);
  });

  it('reconcile trusts listActiveSessions when the client has it (finds sessions whose start was missed)', async () => {
    const p = make();
    p.start();
    await flush();
    await feed([ServerEvent.parse({ type: 'session.execution.started', data: { sessionID: 'ses_a' } })]);
    api.sessions = [session('ses_a', 0.1), session('ses_b', 0.1, { parentID: 'ses_a' })];
    api.listActiveSessions = async () => ['ses_b'];
    await p.reconcile();
    expect(p.isBusy('ses_a')).toBe(false);
    expect(p.isBusy('ses_b')).toBe(true);
    expect(p.sessions().find((s) => s.id === 'ses_b')?.parentId).toBe('ses_a');
  });
});

describe('permission auto-reject (AD2.5)', () => {
  const asked = S2.filter((e) => e.type === 'permission.asked');

  it('rejects permission.asked immediately, records a defect and calls the callback', async () => {
    const p = make();
    p.start();
    await flush();
    const first = asked[0]!;
    const req = PermissionRequest.parse(first.data);
    // feed everything up to and including the ask
    await feed(S2.slice(0, S2.indexOf(first) + 1));
    expect(api.replies).toEqual([{ sessionId: req.sessionID, requestId: req.id, reply: 'reject' }]);
    expect(rejections).toHaveLength(1);
    const r = rejections[0]!;
    expect(r.replied).toBe(true);
    expect(r.defect.kind).toBe('permission-asked');
    expect(r.defect.sessionId).toBe(req.sessionID);
    expect(r.defect.message).toContain('shell');
    expect(r.defect.message).toContain('echo hello-from-spike');
    expect(p.defects()).toEqual([r.defect]);
    expect(p.stats().rejectedPermissions).toBe(1);
  });

  it('rejects every ask of a full recorded stream, once per request id', async () => {
    const p = make();
    p.start();
    await flush();
    await feed(S2);
    await feed([asked[0]!]); // duplicate delivery of the same ask
    expect(api.replies.map((r) => r.requestId)).toEqual(asked.map((e) => (e.data as any).id));
    expect(api.replies.every((r) => r.reply === 'reject')).toBe(true);
    expect(p.defects()).toHaveLength(asked.length);
  });

  it('still records the defect when the reply fails (e.g. cancelled by an earlier reject)', async () => {
    api.replyError = new Error('PermissionNotFoundError');
    const p = make();
    p.start();
    await flush();
    await feed([asked[0]!]);
    expect(rejections[0]?.replied).toBe(false);
    expect(rejections[0]?.defect.message).toContain('reply failed');
    expect(errors.some((e) => e.where === 'permission')).toBe(true);
  });

  it('reconcile sweeps pending asks that arrived while disconnected (permission.pending.json)', async () => {
    const pending = PermissionRequest.array().parse(readJson('permission.pending.json').global.data);
    api.pending = pending;
    const p = make();
    p.start();
    await flush();
    await p.reconcile();
    expect(api.replies).toEqual([{ sessionId: pending[0]!.sessionID, requestId: pending[0]!.id, reply: 'reject' }]);
    await p.reconcile(); // idempotent
    expect(api.replies).toHaveLength(1);
    expect(p.defects()).toHaveLength(1);
  });
});

describe('silence -> reconnect -> reconcile', () => {
  it('reconnects after 2 minutes without any frame and reconciles', async () => {
    api.sessions = [S1_SESSION];
    const p = make({ reconcileIntervalMs: 1e9 });
    p.start();
    await flush();
    expect(api.conns).toHaveLength(1);
    await feed([S1[0]!]);

    await clock.advance(119_000);
    expect(api.conns).toHaveLength(1);
    expect(silences).toEqual([]);
    expect(api.listCalls).toBe(0);

    await clock.advance(11_000); // silence check + 1 s reconnect backoff elapse
    expect(silences).toHaveLength(1);
    expect(silences[0]).toBeGreaterThanOrEqual(120_000);
    expect(api.conns[0]?.aborted).toBe(true);
    expect(api.conns).toHaveLength(2);
    expect(p.stats().reconnects).toBe(1);
    expect(p.stats().silences).toBe(1);
    expect(api.listCalls).toBeGreaterThanOrEqual(1); // full reconcile on reconnect
    expect(p.sessionIds()).toContain(S1_ID);
    expect(readLines(costFile()).map((l) => l.sessionId)).toEqual([S1_ID]);
  });

  it('heartbeat frames count as life: no reconnect while heartbeats keep coming', async () => {
    const p = make({ reconcileIntervalMs: 1e9 });
    p.start();
    await flush();
    for (let i = 0; i < 12; i++) {
      await clock.advance(10_000);
      await feed([{ type: HEARTBEAT_EVENT_TYPE, data: {} }]);
    }
    expect(api.conns).toHaveLength(1);
    expect(silences).toEqual([]);
    // heartbeats are liveness only: no session activity recorded
    expect(p.lastActivityAt()).toBeUndefined();
    // and then they stop
    await clock.advance(125_000);
    expect(silences).toHaveLength(1);
  });

  it('a dropped stream (error or clean close) reconnects with backoff and reconciles', async () => {
    const p = make({ reconcileIntervalMs: 1e9 });
    p.start();
    await flush();
    api.conn.fail(new Error('socket hang up'));
    await flush();
    expect(errors.map((e) => e.where)).toEqual(['stream']);
    await clock.advance(1_000);
    expect(api.conns).toHaveLength(2);
    expect(api.listCalls).toBeGreaterThanOrEqual(1);

    api.conn.end();
    await flush();
    await clock.advance(1_999); // backoff doubles while no event arrived in between
    expect(api.conns).toHaveLength(2);
    await clock.advance(1);
    expect(api.conns).toHaveLength(3);
    expect(p.stats().reconnects).toBe(2);
  });
});

describe('reconcile and the ledger', () => {
  it('appends cost lines (schema-valid, phase from phaseOf) and only the changes on later polls', async () => {
    const child = session('ses_child', 0.002, { parentID: S1_ID });
    api.sessions = [S1_SESSION, child];
    const p = make({ phaseOf: (id) => (id === S1_ID ? 'plan' : 'build') });
    p.start();
    await flush();

    expect(await p.reconcile()).toBe('ok');
    const first = readLines(costFile());
    expect(first).toHaveLength(2);
    for (const l of first) CostLine.parse(l);
    expect(first.map((l) => [l.sessionId, l.phase, l.parentId, l.source])).toEqual([
      [S1_ID, 'plan', null, 'session-info'],
      ['ses_child', 'build', S1_ID, 'session-info'],
    ]);
    expect(first.at(-1).totalUsd).toBeCloseTo(S1_SESSION.cost + 0.002, 8);

    await p.reconcile(); // unchanged -> no new lines
    expect(readLines(costFile())).toHaveLength(2);

    api.sessions = [session(S1_ID, 0.5), child];
    await p.reconcile();
    const lines = readLines(costFile());
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatchObject({ sessionId: S1_ID, costUsd: 0.5 });
  });

  it('falls back to getSession for known sessions missing from the list', async () => {
    const p = make();
    p.start();
    await flush();
    await feed([ServerEvent.parse({ type: 'session.created', data: { sessionID: S1_ID } })]);
    api.sessions = [];
    await p.reconcile().catch(() => undefined);
    expect(api.getCalls).toEqual([S1_ID]);
    expect(errors.filter((e) => e.where === 'reconcile')).toHaveLength(1); // generic "not found" is surfaced
  });

  it('surfaces soft and hard levels from a ledger with a small budget (sticky, one event each)', async () => {
    const ledger = ledgerWith(1);
    const events: BudgetEvent[] = [];
    ledger.onEvent((e) => events.push(e));
    const p = make({ ledger });
    p.start();
    await flush();

    api.sessions = [session('ses_a', 0.5)];
    expect(await p.reconcile()).toBe('ok');
    api.sessions = [session('ses_a', 0.9)]; // 90% of $1 >= soft 85%
    expect(await p.reconcile()).toBe('soft');
    expect(events).toEqual(['soft']);
    api.sessions = [session('ses_a', 0.9), session('ses_b', 0.2)]; // 110% >= hard
    expect(await p.reconcile()).toBe('hard');
    expect(events).toEqual(['soft', 'hard']);
    expect(await p.reconcile()).toBe('hard');
    expect(events).toEqual(['soft', 'hard']);
  });

  it('a failed poll rejects reconcile() but the timer path only counts it', async () => {
    api.listError = new Error('HTTP 503');
    const p = make();
    p.start();
    await flush();
    await expect(p.reconcile()).rejects.toThrow(/503/);
    await clock.advance(45_000);
    expect(p.stats().reconcileErrors).toBe(1);
    expect(errors.some((e) => e.where === 'reconcile')).toBe(true);
    api.listError = undefined;
    api.sessions = [S1_SESSION];
    await clock.advance(45_000);
    expect(readLines(costFile())).toHaveLength(1); // recovered
  });

  it('concurrent reconcile() calls are serialized and coalesced', async () => {
    api.sessions = [S1_SESSION];
    const p = make();
    p.start();
    await flush();
    await Promise.all([p.reconcile(), p.reconcile(), p.reconcile(), p.reconcile()]);
    expect(api.listCalls).toBeLessThanOrEqual(2);
    expect(readLines(costFile())).toHaveLength(1);
  });
});

describe('reconcile triggers', () => {
  it('runs every reconcileIntervalMs (45 s) and the interval is configurable', async () => {
    api.sessions = [S1_SESSION];
    make().start();
    await flush();
    expect(api.listCalls).toBe(0);
    await clock.advance(44_999);
    expect(api.listCalls).toBe(0);
    await clock.advance(1);
    expect(api.listCalls).toBe(1);
    await clock.advance(45_000);
    expect(api.listCalls).toBe(2);
  });

  it('configurable interval', async () => {
    make({ reconcileIntervalMs: 10_000 }).start();
    await flush();
    await clock.advance(30_000);
    expect(api.listCalls).toBe(3);
  });

  it('reconciles after every terminal execution event, and calls onTerminal afterwards', async () => {
    api.sessions = [S1_SESSION];
    const order: string[] = [];
    const p = make({
      onTerminal: (i) => {
        order.push(`terminal:${i.sessionId}:listCalls=${api.listCalls}`);
        terminals.push(i);
      },
    });
    p.start();
    await flush();
    await feed(S1);
    await flush();
    expect(api.listCalls).toBeGreaterThanOrEqual(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ sessionId: S1_ID, type: 'session.execution.succeeded', parentId: undefined });
    expect(order[0]).toMatch(/listCalls=[1-9]/); // ledger was refreshed before the callback
    expect(readLines(costFile())).toHaveLength(1);
  });

  it('session.usage.updated triggers a throttled reconcile (one per window)', async () => {
    api.sessions = [S1_SESSION];
    const p = make({ usageReconcileMs: 5_000, reconcileIntervalMs: 1e9 });
    p.start();
    await flush();
    const usage = (cost: number) => ServerEvent.parse({ type: 'session.usage.updated', data: { sessionID: S1_ID, cost } });
    await feed([usage(0.1), usage(0.2), usage(0.3)]);
    expect(api.listCalls).toBe(0);
    await clock.advance(5_000);
    expect(api.listCalls).toBe(1);
    await feed([usage(0.4)]);
    await clock.advance(5_000);
    expect(api.listCalls).toBe(2);
  });
});

describe('stop()', () => {
  it('stops the stream and every timer; nothing runs afterwards', async () => {
    api.sessions = [S1_SESSION];
    const p = make();
    p.start();
    await flush();
    await feed([S1[0]!]);
    await p.stop();
    expect(api.conns[0]?.aborted).toBe(true);
    expect(clock.pending()).toBe(0);
    const calls = api.listCalls;
    await clock.advance(600_000);
    expect(api.listCalls).toBe(calls);
    expect(api.conns).toHaveLength(1);
    await p.stop(); // idempotent
  });

  it('stop() while the pump waits in reconnect backoff does not hang', async () => {
    const p = make();
    p.start();
    await flush();
    api.conn.end();
    await flush();
    await p.stop();
    expect(api.conns).toHaveLength(1);
  });

  it('start() twice does not open a second stream', async () => {
    const p = make();
    p.start();
    p.start();
    await flush();
    expect(api.conns).toHaveLength(1);
  });
});
