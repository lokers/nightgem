/**
 * Thin fetch + SSE client for the opencode 2.0.29 v2 server API (`/api/*`, Basic auth, user `opencode`).
 * Implements `RunApi` from contracts.ts. No SDK: the 1.19.x SDK has drifted from the 2.0.29 routes (docs/opencode-notes.md).
 *
 * Wire facts (all verified live, see docs/opencode-notes.md; fixtures in test/fixtures/opencode-2.0.29/recorded/):
 * - Responses are wrapped: `{data: ...}`; `GET /api/agent` and `GET /api/permission/request` also carry `location`.
 *   `POST .../interrupt` returns `{interrupted}` unwrapped; the permission reply returns 204.
 * - The session routes use `:sessionID`; permission reply body is `{decision, message?}`.
 * - `GET /api/session` is cursor paginated (default page: newest 50).
 * - `POST /api/session/:id/permission` is the free rule evaluator. When it answers `ask` it ALSO leaves a pending
 *   request behind, so we reject that request again before returning (otherwise the event pump would see a stray ask).
 * - SSE: `data: {json}` frames separated by a blank line, `: heartbeat` comment frames about every 10 s.
 */
import { z } from 'zod';

import { APP } from './brand.ts';
import {
  AgentInfo,
  PermissionEffect,
  PermissionRequest,
  ServerEvent,
  SessionInfo,
  type CreateSessionInput,
  type EvalPermissionInput,
  type ListSessionsInput,
  type PermissionReply,
  type PromptInput,
  type RunApi,
} from './contracts.ts';

export const API_USERNAME = 'opencode';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Type of the synthetic event yielded for SSE `: heartbeat` comment frames (liveness only). */
export const HEARTBEAT_EVENT_TYPE = 'server.heartbeat';

const REJECT_MESSAGE = `${APP}: autonomous run, no human can approve this. Choose another approach.`;
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export type RunApiErrorKind = 'http' | 'network' | 'parse' | 'stream';

/** Typed client error. `status` is set for `http` errors so 429 and 5xx can be told apart. */
export class RunApiError extends Error {
  readonly kind: RunApiErrorKind;
  readonly status: number | undefined;
  readonly method: string;
  readonly path: string;
  /** Truncated response body (never contains request headers). */
  readonly body: string | undefined;

  constructor(init: { kind: RunApiErrorKind; message: string; method: string; path: string; status?: number; body?: string; cause?: unknown }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RunApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.body = init.body;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isServerError(): boolean {
    return this.status !== undefined && this.status >= 500;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** Worth retrying with backoff: 429, 5xx, or a transport failure. */
  get isTransient(): boolean {
    return this.isRateLimited || this.isServerError || this.kind === 'network' || this.kind === 'stream';
  }
}

export function isRunApiError(err: unknown): err is RunApiError {
  return err instanceof RunApiError;
}

export const ServerInfoPayload = z.looseObject({
  version: z.string(),
  pid: z.number().optional(),
  urls: z.array(z.string()).optional(),
});
export type ServerInfoPayload = z.infer<typeof ServerInfoPayload>;

/** `RunApi` plus calls the contract does not (yet) cover: the version handshake and the busy-session list. */
export interface RunClient extends RunApi {
  /** `GET /api/info`. */
  getInfo(): Promise<ServerInfoPayload>;
  /**
   * `GET /api/session/active`: ids of sessions with a running execution (root or child). This is the
   * authoritative busy list for the hard-stop sweep and the watchdog (docs/opencode-notes.md, "Children").
   */
  listActiveSessions(): Promise<string[]>;
  /**
   * `POST /api/session/:id/shell`, run to completion. The route answers 204 immediately and reports the result on the
   * event stream (`session.shell.ended`), so this subscribes first, posts, then waits for the matching event.
   * It runs in the server's own process env and sandbox, as NO agent: the permission rules and the guard plugin are
   * bypassed (docs/opencode-notes.md, "Shell outside the permission system"). Only for the preflight canary and tests, never for agent work.
   */
  shell(sessionId: string, command: string, opts?: ShellOptions): Promise<ShellResult>;
}

export interface ShellOptions {
  /** Give up waiting for `session.shell.ended` after this long (default 30 s). */
  timeoutMs?: number;
}

/**
 * Outcome of a `/shell` call. `output` is the merged stdout/stderr: callers must NEVER log it (it can hold secrets);
 * log `status` and `exit` only.
 */
export interface ShellResult {
  /** `exited` | `timeout` | `killed` | `running` */
  status: string;
  /** Exit code; undefined when the process did not exit normally (timeout, killed, signal). */
  exit: number | undefined;
  output: string;
}

export interface CreateRunApiOptions {
  baseUrl: string;
  password: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout for non-streaming calls. */
  timeoutMs?: number;
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${API_USERNAME}:${password}`).toString('base64')}`;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export interface SseFrame {
  event?: string;
  id?: string;
  /** Joined `data:` lines; `undefined` for comment-only frames. */
  data?: string;
  /** Comment text (without the leading `:`) when the frame had a comment line. */
  comment?: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') frame.event = value;
    else if (field === 'id') frame.id = value;
  }
  if (data.length > 0) frame.data = data.join('\n');
  return frame.data !== undefined || frame.comment !== undefined ? frame : undefined;
}

/**
 * Split an SSE byte stream into frames. Returns when the stream ends or `signal` aborts; throws a
 * `RunApiError(kind: 'stream')` when the connection breaks while not aborted.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  ctx: { method: string; path: string } = { method: 'GET', path: '/api/event' },
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (signal?.aborted) return;
        throw new RunApiError({ kind: 'stream', message: `SSE stream broke: ${errMessage(cause)}`, ...ctx, cause });
      }
      if (chunk.done) {
        buf += decoder.decode();
        break;
      }
      buf += decoder.decode(chunk.value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      if (buf.length > SSE_MAX_BUFFER) {
        throw new RunApiError({ kind: 'stream', message: 'SSE frame exceeds the buffer limit', ...ctx });
      }
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
    // A trailing frame without the final blank line is incomplete by spec; the server always terminates frames.
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DataEnvelope = <T extends z.ZodType>(schema: T) => z.looseObject({ data: schema });
const SessionsResponse = z.looseObject({
  data: z.array(SessionInfo),
  cursor: z.looseObject({ next: z.string().nullish() }).optional(),
});
const EvalResponse = DataEnvelope(z.looseObject({ id: z.string().optional(), effect: PermissionEffect }));
const InterruptResponse = z.looseObject({ interrupted: z.boolean() });
const ActiveResponse = z.looseObject({ data: z.record(z.string(), z.looseObject({ type: z.string().optional() })) });

export function createRunApi(opts: CreateRunApiOptions): RunClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const auth = basicAuthHeader(opts.password);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const enc = encodeURIComponent;

  async function send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { authorization: auth };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new RunApiError({ kind: 'network', message: `${method} ${path} failed: ${errMessage(cause)}`, method, path, cause });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RunApiError({
        kind: 'http',
        message: `${method} ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        method,
        path,
        status: res.status,
        body: text.slice(0, 2000),
      });
    }
    return res;
  }

  async function json<T extends z.ZodType>(method: string, path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    const res = await send(method, path, body);
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (cause) {
      throw new RunApiError({ kind: 'parse', message: `${method} ${path}: response is not JSON`, method, path, status: res.status, cause });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new RunApiError({
        kind: 'parse',
        message: `${method} ${path}: unexpected response shape: ${parsed.error.issues[0]?.message ?? 'invalid'} at ${parsed.error.issues[0]?.path.join('.') ?? '?'}`,
        method,
        path,
        status: res.status,
      });
    }
    return parsed.data;
  }

  async function noContent(method: string, path: string, body?: unknown): Promise<void> {
    const res = await send(method, path, body);
    await res.body?.cancel().catch(() => undefined);
  }

  const replyPermission = async (sessionId: string, requestId: string, reply: PermissionReply): Promise<void> => {
    const body: { decision: PermissionReply; message?: string } = { decision: reply };
    if (reply === 'reject') body.message = REJECT_MESSAGE;
    await noContent('POST', `/api/session/${enc(sessionId)}/permission/${enc(requestId)}/reply`, body);
  };

  const api: RunClient = {
    async getInfo() {
      return json('GET', '/api/info', ServerInfoPayload);
    },

    async listActiveSessions() {
      const r = await json('GET', '/api/session/active', ActiveResponse);
      return Object.keys(r.data);
    },

    async listAgents() {
      const r = await json('GET', '/api/agent', DataEnvelope(z.array(AgentInfo)));
      return r.data;
    },

    async evalPermission(input: EvalPermissionInput) {
      const r = await json('POST', `/api/session/${enc(input.sessionId)}/permission`, EvalResponse, {
        action: input.action,
        resources: input.resources,
        agent: input.agent,
      });
      if (r.data.effect === 'ask' && r.data.id) {
        // The evaluator leaves the request pending; clear it so it never surfaces as a real ask.
        await replyPermission(input.sessionId, r.data.id, 'reject').catch(() => undefined);
      }
      return r.data.effect;
    },

    async createSession(input: CreateSessionInput) {
      const body: Record<string, unknown> = { model: input.model };
      if (input.agent !== undefined) body.agent = input.agent;
      if (input.parentId !== undefined) body.parentID = input.parentId;
      if (input.title !== undefined) body.title = input.title;
      const r = await json('POST', '/api/session', DataEnvelope(SessionInfo), body);
      return r.data;
    },

    async prompt(sessionId: string, input: PromptInput) {
      const body: Record<string, unknown> = { text: input.text };
      if (input.delivery !== undefined) body.delivery = input.delivery;
      if (input.resume !== undefined) body.resume = input.resume;
      await noContent('POST', `/api/session/${enc(sessionId)}/prompt`, body);
    },

    async interrupt(sessionId: string) {
      const r = await json('POST', `/api/session/${enc(sessionId)}/interrupt`, InterruptResponse);
      return r.interrupted;
    },

    async getSession(sessionId: string) {
      const r = await json('GET', `/api/session/${enc(sessionId)}`, DataEnvelope(SessionInfo));
      return r.data;
    },

    async listSessions(input: ListSessionsInput = {}) {
      const out: SessionInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const q = new URLSearchParams();
        const remaining = input.limit === undefined ? LIST_PAGE_SIZE : input.limit - out.length;
        q.set('limit', String(Math.max(1, Math.min(LIST_PAGE_SIZE, remaining))));
        if (cursor === undefined) {
          if (input.order) q.set('order', input.order);
        } else {
          q.set('cursor', cursor);
        }
        if (input.parentId !== undefined) q.set('parentID', input.parentId);
        const r = await json('GET', `/api/session?${q.toString()}`, SessionsResponse);
        out.push(...r.data);
        cursor = r.cursor?.next ?? undefined;
        if (!cursor || r.data.length === 0) break;
        if (input.limit !== undefined && out.length >= input.limit) break;
      }
      return input.limit === undefined ? out : out.slice(0, input.limit);
    },

    async listPendingPermissions(sessionId?: string) {
      const path = sessionId === undefined ? '/api/permission/request' : `/api/session/${enc(sessionId)}/permission`;
      const r = await json('GET', path, DataEnvelope(z.array(PermissionRequest)));
      return r.data;
    },

    replyPermission,

    async shell(sessionId: string, command: string, shellOpts: ShellOptions = {}) {
      const path = `/api/session/${enc(sessionId)}/shell`;
      const waitMs = shellOpts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const ac = new AbortController();
      let connected: () => void = () => undefined;
      const isConnected = new Promise<void>((r) => (connected = r));
      let result: ShellResult | undefined;
      let settle: () => void = () => undefined;
      const ended = new Promise<void>((r) => (settle = r));
      let streamError: unknown;
      const reader = (async () => {
        try {
          for await (const ev of api.events({ signal: ac.signal })) {
            if (ev.type === 'server.connected') connected();
            if (ev.type !== 'session.shell.ended' || ev.data.sessionID !== sessionId) continue;
            const info = ev.data.shell as Record<string, unknown> | undefined;
            if (info?.command !== command) continue;
            const out = ev.data.output as Record<string, unknown> | undefined;
            result = {
              status: typeof info.status === 'string' ? info.status : 'unknown',
              exit: typeof info.exit === 'number' && Number.isFinite(info.exit) ? info.exit : undefined,
              output: typeof out?.output === 'string' ? out.output : '',
            };
            settle();
            return;
          }
        } catch (err) {
          streamError = err;
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const connectTimeout = new Promise<void>((r) => (timer = setTimeout(r, 5_000)));
        await Promise.race([isConnected, connectTimeout, reader]);
        clearTimeout(timer);
        if (streamError) throw streamError;
        await noContent('POST', path, { command });
        const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), waitMs)));
        const r = await Promise.race([ended.then(() => 'ended' as const), timeout, reader.then(() => 'closed' as const)]);
        if (result) return result;
        if (r === 'timeout') throw new RunApiError({ kind: 'stream', message: `POST ${path}: no session.shell.ended within ${waitMs} ms`, method: 'POST', path });
        if (streamError) throw streamError;
        throw new RunApiError({ kind: 'stream', message: `POST ${path}: event stream closed before session.shell.ended`, method: 'POST', path });
      } finally {
        clearTimeout(timer);
        ac.abort();
        await reader;
      }
    },

    events(eventOpts: { signal?: AbortSignal } = {}): AsyncIterable<ServerEvent> {
      const signal = eventOpts.signal;
      const path = '/api/event';
      return (async function* () {
        if (signal?.aborted) return;
        let res: Response;
        try {
          res = await doFetch(base + path, { method: 'GET', headers: { authorization: auth, accept: 'text/event-stream' }, signal });
        } catch (cause) {
          if (signal?.aborted) return;
          throw new RunApiError({ kind: 'network', message: `GET ${path} failed: ${errMessage(cause)}`, method: 'GET', path, cause });
        }
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          throw new RunApiError({
            kind: 'http',
            message: `GET ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
            method: 'GET',
            path,
            status: res.status,
            body: text.slice(0, 2000),
          });
        }
        for await (const frame of parseSseStream(res.body, signal, { method: 'GET', path })) {
          if (frame.data === undefined) {
            if (frame.comment?.startsWith('heartbeat')) yield { type: HEARTBEAT_EVENT_TYPE, data: {} };
            continue;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(frame.data);
          } catch {
            continue; // not one of ours
          }
          const parsed = ServerEvent.safeParse(raw);
          if (parsed.success) yield parsed.data;
        }
      })();
    },
  };
  return api;
}
