/**
 * Contract tests for src/client.ts: a fake fetch replays the recorded opencode 2.0.29 fixtures
 * (test/fixtures/opencode-2.0.29/recorded/) and asserts method, path, auth header, request body and response parsing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HEARTBEAT_EVENT_TYPE, RunApiError, basicAuthHeader, createRunApi, parseSseStream } from '../src/client.ts';
import { SessionCreatedData, SessionUsageData, type ServerEvent } from '../src/contracts.ts';
import { RECORDED_FIXTURES, REPO_ROOT } from './fixtures/paths.ts';

const FIXTURES = join(REPO_ROOT, RECORDED_FIXTURES);
const readJson = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const readJsonl = (name: string): any[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const PASSWORD = 'pw-test-0123456789';
const BASE = 'http://127.0.0.1:4096';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

interface Call {
  method: string;
  url: URL;
  path: string;
  auth: string | null;
  contentType: string | null;
  body: any;
  signal: AbortSignal | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      path: url.pathname,
      auth: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return jsonRes({ message: `no route ${call.method} ${call.path}` }, 404);
    return handler(call);
  };
  return { calls, fetchImpl };
}

function clientFor(routes: Record<string, Handler>) {
  const f = fakeFetch(routes);
  return { ...f, api: createRunApi({ baseUrl: BASE, password: PASSWORD, fetchImpl: f.fetchImpl }) };
}

/** Encode events as SSE wire frames, optionally split into awkward chunk sizes. */
function sseBody(frames: string[], chunkSize = 17): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.join(''));
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(off, off + chunkSize));
      off += chunkSize;
    },
  });
}

const toFrame = (ev: any): string => {
  const { recv: _recv, ...wire } = ev;
  void _recv;
  return `data: ${JSON.stringify(wire)}\n\n`;
};

async function collect(it: AsyncIterable<ServerEvent>): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('auth', () => {
  it('uses Basic auth with the fixed user "opencode"', () => {
    expect(basicAuthHeader(PASSWORD)).toBe(AUTH);
  });

  it('sends the auth header on every call, and never puts the password in an error message', async () => {
    const { api, calls } = clientFor({ 'GET /api/agent': () => jsonRes({ message: 'unauthorized' }, 401) });
    const err = await api.listAgents().catch((e) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect(calls[0]?.auth).toBe(AUTH);
    expect(String(err.message)).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(PASSWORD);
  });
});

describe('recorded request/response contract', () => {
  it('getInfo: GET /api/info', async () => {
    const { api, calls } = clientFor({ 'GET /api/info': () => jsonRes({ version: '2.0.29', pid: 1, urls: [], paths: { tmp: '/t' } }) });
    expect((await api.getInfo()).version).toBe('2.0.29');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/info', auth: AUTH });
  });

  it('listActiveSessions: GET /api/session/active -> ids of running sessions (shape from the recorded log)', async () => {
    const { api, calls } = clientFor({ 'GET /api/session/active': () => jsonRes({ data: { ses_a: { type: 'running' }, ses_b: { type: 'running' } } }) });
    expect(await api.listActiveSessions()).toEqual(['ses_a', 'ses_b']);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/session/active', auth: AUTH });
  });

  it('listAgents: GET /api/agent unwraps {location, data}', async () => {
    // No agent list was recorded; the shape below follows Agent.Info in the recorded OpenAPI document.
    const { api, calls } = clientFor({
      'GET /api/agent': () =>
        jsonRes({
          location: { directory: '/run' },
          data: [
            {
              id: 'fixer',
              name: 'fixer',
              mode: 'subagent',
              hidden: false,
              request: {},
              permissions: [
                { action: '*', resource: '*', effect: 'allow' },
                { action: 'shell', resource: 'git push *', effect: 'deny' },
              ],
            },
          ],
        }),
    });
    const agents = await api.listAgents();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/agent', auth: AUTH });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.permissions.at(-1)).toEqual({ action: 'shell', resource: 'git push *', effect: 'deny' });
  });

  it('createSession: POST /api/session with an explicit model, parses session.create.json', async () => {
    const rec = readJson('session.create.json');
    const { api, calls } = clientFor({ 'POST /api/session': () => jsonRes(rec.body, rec.status) });
    const model = { providerID: 'anthropic', id: 'claude-opus-5-5' };
    const s = await api.createSession({ model, agent: 'orchestrator', title: 'plan', parentId: 'ses_parent' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/session', auth: AUTH, contentType: 'application/json' });
    expect(calls[0]?.body).toEqual({ model, agent: 'orchestrator', parentID: 'ses_parent', title: 'plan' });
    expect(s.id).toBe(rec.body.data.id);
    expect(s.cost).toBe(0);
    expect(s.location.directory).toBe(rec.body.data.location.directory);
  });

  it('createSession: omits unset optional fields but always sends model', async () => {
    const rec = readJson('session.create.json');
    const { api, calls } = clientFor({ 'POST /api/session': () => jsonRes(rec.body) });
    await api.createSession({ model: { providerID: 'anthropic', id: 'm', variant: 'high' } });
    expect(calls[0]?.body).toEqual({ model: { providerID: 'anthropic', id: 'm', variant: 'high' } });
  });

  it('prompt: POST /api/session/:id/prompt, accepts session.prompt.json', async () => {
    const rec = readJson('session.prompt.json');
    const { api, calls } = clientFor({ 'POST /api/session/ses_a/prompt': () => jsonRes(rec.body, rec.status) });
    await api.prompt('ses_a', { text: 'Reply with exactly the single word: pong', delivery: 'steer', resume: true });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/session/ses_a/prompt', auth: AUTH });
    expect(calls[0]?.body).toEqual({ text: 'Reply with exactly the single word: pong', delivery: 'steer', resume: true });
  });

  it('prompt: a 409 surfaces as RunApiError with status 409', async () => {
    const { api } = clientFor({ 'POST /api/session/ses_a/prompt': () => jsonRes({ message: 'busy' }, 409) });
    const err = (await api.prompt('ses_a', { text: 'x' }).catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    expect(err.status).toBe(409);
    expect(err.isConflict).toBe(true);
  });

  it('interrupt: both recorded shapes (idle=false, running=true)', async () => {
    const misc = readJson('misc.responses.json');
    let running = false;
    const { api, calls } = clientFor({
      'POST /api/session/ses_a/interrupt': () => jsonRes(running ? misc['POST /api/session/{id}/interrupt (running)'].body : misc['POST /api/session/{id}/interrupt (idle)'].body),
    });
    expect(await api.interrupt('ses_a')).toBe(false);
    running = true;
    expect(await api.interrupt('ses_a')).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/session/ses_a/interrupt', auth: AUTH });
    expect(calls[0]?.body).toBeUndefined();
  });

  it('getSession: GET /api/session/:id parses session.get.json (cost, tokens, outcome, idle)', async () => {
    const rec = readJson('session.get.json');
    const id = rec.body.data.id;
    const { api, calls } = clientFor({ [`GET /api/session/${id}`]: () => jsonRes(rec.body) });
    const s = await api.getSession(id);
    expect(calls[0]).toMatchObject({ method: 'GET', auth: AUTH });
    expect(s.cost).toBeCloseTo(0.00267965, 8);
    expect(s.tokens?.cache.write).toBe(21418);
    expect(s.outcome).toBe('succeeded');
    expect(s.time.idle).toBeTypeOf('number');
  });

  it('getSession: percent-encodes ids', async () => {
    const { api, calls } = clientFor({});
    await api.getSession('a/b').catch(() => undefined);
    expect(calls[0]?.path).toBe('/api/session/a%2Fb');
  });

  it('listSessions: cursor pagination, order and parentID query, limit cap', async () => {
    const rec = readJson('session.get.json').body.data;
    const mk = (id: string) => ({ ...rec, id });
    const { api, calls } = clientFor({
      'GET /api/session': (c) =>
        c.url.searchParams.get('cursor') === 'c1'
          ? jsonRes({ data: [mk('ses_3')], cursor: { previous: null, next: null } })
          : jsonRes({ data: [mk('ses_1'), mk('ses_2')], cursor: { previous: null, next: 'c1' } }),
    });
    const all = await api.listSessions({ order: 'asc', parentId: 'ses_root' });
    expect(all.map((s) => s.id)).toEqual(['ses_1', 'ses_2', 'ses_3']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get('order')).toBe('asc');
    expect(calls[0]?.url.searchParams.get('parentID')).toBe('ses_root');
    expect(calls[1]?.url.searchParams.get('cursor')).toBe('c1');
    expect(calls[1]?.url.searchParams.has('order')).toBe(false);

    const capped = await api.listSessions({ limit: 2 });
    expect(capped.map((s) => s.id)).toEqual(['ses_1', 'ses_2']);
  });

  it('listPendingPermissions: global and per-session, parse permission.pending.json', async () => {
    const rec = readJson('permission.pending.json');
    const { api, calls } = clientFor({
      'GET /api/permission/request': () => jsonRes(rec.global),
      [`GET /api/session/${rec.session.data[0].sessionID}/permission`]: () => jsonRes(rec.session),
    });
    const global = await api.listPendingPermissions();
    expect(global[0]).toMatchObject({ id: rec.global.data[0].id, action: 'shell', resources: ['echo hello-from-spike'] });
    const sid = rec.session.data[0].sessionID;
    const scoped = await api.listPendingPermissions(sid);
    expect(scoped).toHaveLength(1);
    expect(calls.map((c) => c.path)).toEqual(['/api/permission/request', `/api/session/${sid}/permission`]);
  });

  it('replyPermission: POST .../permission/:rid/reply {decision}, 204 No Content', async () => {
    const { api, calls } = clientFor({ 'POST /api/session/ses_a/permission/per_1/reply': () => new Response(null, { status: 204 }) });
    await api.replyPermission('ses_a', 'per_1', 'once');
    await api.replyPermission('ses_a', 'per_1', 'reject');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/session/ses_a/permission/per_1/reply', auth: AUTH });
    expect(calls[0]?.body).toEqual({ decision: 'once' });
    expect(calls[1]?.body).toMatchObject({ decision: 'reject' });
    expect(typeof calls[1]?.body.message).toBe('string');
  });

  it('evalPermission: POST /api/session/:id/permission -> effect; an "ask" leaves nothing pending', async () => {
    let effect = 'deny';
    const { api, calls } = clientFor({
      'POST /api/session/ses_e/permission': () => jsonRes({ data: { id: 'per_9', effect } }),
      'POST /api/session/ses_e/permission/per_9/reply': () => new Response(null, { status: 204 }),
    });
    const input = { sessionId: 'ses_e', action: 'shell', resources: ['git push origin main'], agent: 'fixer' };
    expect(await api.evalPermission(input)).toBe('deny');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ action: 'shell', resources: ['git push origin main'], agent: 'fixer' });

    effect = 'ask';
    expect(await api.evalPermission(input)).toBe('ask');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ path: '/api/session/ses_e/permission/per_9/reply' });
    expect(calls[2]?.body).toMatchObject({ decision: 'reject' });
  });

  it('typed errors tell 429 / 5xx / transport failures apart', async () => {
    const mk = async (status: number): Promise<RunApiError> => {
      const err: unknown = await clientFor({ 'GET /api/agent': () => jsonRes({ message: 'x' }, status) }).api.listAgents().catch((e: unknown) => e);
      return err as RunApiError;
    };
    const e429 = await mk(429);
    const e503 = await mk(503);
    const e404 = await mk(404);
    expect([e429.status, e429.isRateLimited, e429.isServerError, e429.isTransient]).toEqual([429, true, false, true]);
    expect([e503.status, e503.isRateLimited, e503.isServerError, e503.isTransient]).toEqual([503, false, true, true]);
    expect([e404.isNotFound, e404.isTransient]).toEqual([true, false]);

    const net = createRunApi({
      baseUrl: BASE,
      password: PASSWORD,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const eNet = (await net.listAgents().catch((e) => e)) as RunApiError;
    expect([eNet.kind, eNet.status, eNet.isTransient]).toEqual(['network', undefined, true]);
  });

  it('a malformed body is a parse error, not a crash', async () => {
    const { api } = clientFor({ 'GET /api/session/ses_a': () => jsonRes({ data: { id: 'ses_a' } }) });
    const err = (await api.getSession('ses_a').catch((e) => e)) as RunApiError;
    expect(err).toBeInstanceOf(RunApiError);
    expect(err.kind).toBe('parse');
  });
});

describe('SSE: GET /api/event', () => {
  const sseFiles = readdirSync(FIXTURES).filter((f) => /^events-.*\.jsonl$/.test(f));

  it('has recorded SSE samples to replay', () => {
    expect(sseFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of sseFiles) {
    it(`parses every recorded event of ${file} (arbitrary chunk boundaries)`, async () => {
      const recorded = readJsonl(file);
      const { api, calls } = clientFor({
        'GET /api/event': () => new Response(sseBody(recorded.map(toFrame), 23), { headers: { 'content-type': 'text/event-stream' } }),
      });
      const events = await collect(api.events());
      expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/event', auth: AUTH });
      expect(events).toHaveLength(recorded.length);
      expect(events.map((e) => e.type)).toEqual(recorded.map((e) => e.type));
      expect(events.map((e) => e.id)).toEqual(recorded.map((e) => e.id));
    });
  }

  it('payload schemas fit the recorded session.created / session.usage.updated events', async () => {
    const recorded = readJsonl('events-s1-s.jsonl');
    const { api } = clientFor({ 'GET /api/event': () => new Response(sseBody(recorded.map(toFrame))) });
    const events = await collect(api.events());
    const created = events.find((e) => e.type === 'session.created');
    expect(SessionCreatedData.parse(created?.data).sessionID).toMatch(/^ses_/);
    const usage = events.find((e) => e.type === 'session.usage.updated');
    expect(SessionUsageData.parse(usage?.data).cost).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('session.execution.succeeded');
  });

  it('surfaces heartbeat comment frames as server.heartbeat, handles CRLF and multi-line data', async () => {
    const frames = [
      ': heartbeat\n\n',
      'data: {"type":"a.b","data":{"x":1}}\r\n\r\n',
      'event: message\ndata: {"type":\ndata: "c.d","data":{}}\n\n',
      'data: not-json\n\n',
      'data: {"nottype":1}\n\n',
    ];
    const { api } = clientFor({ 'GET /api/event': () => new Response(sseBody(frames, 5)) });
    const events = await collect(api.events());
    expect(events.map((e) => e.type)).toEqual([HEARTBEAT_EVENT_TYPE, 'a.b', 'c.d']);
  });

  it('parseSseStream returns raw frames', async () => {
    const out: unknown[] = [];
    for await (const f of parseSseStream(sseBody([': hi\n\n', 'id: 7\nevent: e\ndata: x\n\n']))) out.push(f);
    expect(out).toEqual([{ comment: 'hi' }, { id: '7', event: 'e', data: 'x' }]);
  });

  it('ends quietly when the signal aborts, even while waiting for data', async () => {
    const ac = new AbortController();
    const { api } = clientFor({
      'GET /api/event': () => {
        // never closes; honour the abort the way fetch does (the body stream errors)
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c2) {
            ctrl = c2;
            c2.enqueue(new TextEncoder().encode(toFrame({ type: 'server.connected', data: {} })));
          },
        });
        ac.signal.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
        return new Response(body);
      },
    });
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of api.events({ signal: ac.signal })) {
        seen.push(e.type);
        ac.abort();
      }
    })();
    await run;
    expect(seen).toEqual(['server.connected']);
  });

  it('a connection drop (not an abort) is surfaced as a typed stream error; a clean close just ends', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(toFrame({ type: 'server.connected', data: {} })));
      },
      pull() {
        throw new Error('socket hang up');
      },
    });
    const { api } = clientFor({ 'GET /api/event': () => new Response(broken) });
    const seen: string[] = [];
    const err: unknown = await (async () => {
      for await (const e of api.events()) seen.push(e.type);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(['server.connected']);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe('stream');
  });

  it('a non-200 connect (e.g. 401, 503) throws a typed http error', async () => {
    const { api } = clientFor({ 'GET /api/event': () => jsonRes({ message: 'no' }, 503) });
    const err = await collect(api.events()).catch((e) => e as RunApiError);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).isServerError).toBe(true);
  });
});

describe('shell: POST /api/session/:id/shell', () => {
  const ended = (sessionID: string, command: string, fields: Record<string, unknown>, output = 'OUT-SECRET\n') =>
    toFrame({ type: 'session.shell.ended', data: { sessionID, shell: { id: 'sh_1', command, cwd: '/r', ...fields }, output: { output, cursor: 0, size: output.length, truncated: false } } });

  /** An SSE response that stays open until the request is aborted (like the real server). */
  const openSse = (frames: string[], signal: AbortSignal | null): Response => {
    const bytes = new TextEncoder().encode(frames.join(''));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          signal?.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      }),
    );
  };

  it('subscribes to the event stream BEFORE posting, then returns the matching session.shell.ended (status, exit, output)', async () => {
    const { api, calls } = clientFor({
      'GET /api/event': (c) =>
        openSse(
          [
            toFrame({ type: 'server.connected', data: {} }),
            ended('ses_other', 'echo hi', { status: 'exited', exit: 0 }), // other session
            ended('ses_1', 'echo other', { status: 'exited', exit: 0 }), // other command
            ended('ses_1', 'echo hi', { status: 'exited', exit: 3 }, 'hello'),
          ],
          c.signal,
        ),
      'POST /api/session/ses_1/shell': () => new Response(null, { status: 204 }),
    });
    const r = await api.shell('ses_1', 'echo hi');
    expect(r).toEqual({ status: 'exited', exit: 3, output: 'hello' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/event', 'POST /api/session/ses_1/shell']);
    expect(calls[1]!.body).toEqual({ command: 'echo hi' });
    expect(calls[1]!.auth).toBe(AUTH);
    expect(calls[0]!.signal?.aborted).toBe(true); // the subscription is torn down afterwards
  });

  it('a command that did not exit normally has no exit code', async () => {
    const { api } = clientFor({
      'GET /api/event': (c) => openSse([toFrame({ type: 'server.connected', data: {} }), ended('ses_1', 'sleep 99', { status: 'timeout' })], c.signal),
      'POST /api/session/ses_1/shell': () => new Response(null, { status: 204 }),
    });
    expect(await api.shell('ses_1', 'sleep 99')).toMatchObject({ status: 'timeout', exit: undefined });
  });

  it('gives up with a typed stream error when session.shell.ended never arrives', async () => {
    const { api } = clientFor({
      'GET /api/event': (c) => openSse([toFrame({ type: 'server.connected', data: {} })], c.signal),
      'POST /api/session/ses_1/shell': () => new Response(null, { status: 204 }),
    });
    const err = await api.shell('ses_1', 'echo hi', { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunApiError);
    expect((err as RunApiError).kind).toBe('stream');
  });

  it('an HTTP error on the post (e.g. unknown session) is a typed http error and nothing is left subscribed', async () => {
    let signal: AbortSignal | null = null;
    const { api } = clientFor({
      'GET /api/event': (c) => {
        signal = c.signal;
        return openSse([toFrame({ type: 'server.connected', data: {} })], c.signal);
      },
      'POST /api/session/ses_1/shell': () => jsonRes({ _tag: 'SessionNotFoundError', message: 'no' }, 404),
    });
    const err = await api.shell('ses_1', 'echo hi').catch((e: unknown) => e);
    expect((err as RunApiError).isNotFound).toBe(true);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('percent-encodes the session id', async () => {
    const { api, calls } = clientFor({
      'GET /api/event': (c) => openSse([toFrame({ type: 'server.connected', data: {} }), ended('a b', 'x', { status: 'exited', exit: 0 })], c.signal),
      'POST /api/session/a%20b/shell': () => new Response(null, { status: 204 }),
    });
    await api.shell('a b', 'x');
    expect(calls[1]!.url.pathname).toBe('/api/session/a%20b/shell');
  });
});
