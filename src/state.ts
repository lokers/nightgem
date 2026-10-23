/**
 * Run state: atomic RUN.json, append-only JSONL, the single-run lock and control flags.
 * Synchronous fs on purpose: these are small files and callers (guard, CLI, orchestrator)
 * need simple, ordered semantics. `home` / paths are injectable for tests.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { CONTROL_DIR_NAME } from './brand.ts';
import { ControlFlags, isTerminalRunState, ManifestUpgradeError, parseRunManifest, RunManifest } from './contracts.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type StateErrorCode = 'missing' | 'invalid-json' | 'invalid-schema' | 'lock-held' | 'lock-error';

/** Typed error for every failure in this module. Inspect `code`. */
export class StateError extends Error {
  readonly code: StateErrorCode;
  readonly path: string;
  /** For `lock-held`: the PID that owns the lock. */
  readonly pid?: number;

  constructor(code: StateErrorCode, path: string, message: string, opts: { cause?: unknown; pid?: number } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'StateError';
    this.code = code;
    this.path = path;
    if (opts.pid !== undefined) this.pid = opts.pid;
  }
}

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}

/**
 * Write `data` to `path` atomically: tmp file in the same directory (mode 0600, O_EXCL), fsync,
 * rename over the target, fsync the directory. A crash leaves either the old file or the new
 * one, plus at most an ignored `.<name>.<rand>.tmp` leftover.
 */
export function atomicWriteFile(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    try {
      let off = 0;
      const buf = Buffer.from(data, 'utf8');
      while (off < buf.length) off += writeSync(fd, buf, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  fsyncDir(dir);
}

// ---------------------------------------------------------------------------
// RUN.json
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StateError('missing', path, `File not found: ${path}`, { cause: err });
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new StateError('invalid-json', path, `Invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
  }
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown, path: string): z.output<T> {
  const res = schema.safeParse(value);
  if (!res.success) {
    throw new StateError('invalid-schema', path, `Schema validation failed for ${path}: ${z.prettifyError(res.error)}`, {
      cause: res.error,
    });
  }
  return res.data;
}

/**
 * Read and validate RUN.json (v1 or v2; always returns v2). Throws `StateError` (`missing` | `invalid-json` | `invalid-schema`).
 */
export function readManifest(path: string): RunManifest {
  const json = readJsonFile(path);
  try {
    return parseRunManifest(json);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new StateError('invalid-schema', path, `Schema validation failed for ${path}: ${z.prettifyError(err)}`, { cause: err });
    }
    if (err instanceof ManifestUpgradeError) throw new StateError('invalid-schema', path, `${err.message} (${path})`, { cause: err });
    throw err;
  }
}

/** Validate then atomically write RUN.json (mode 0600). */
export function writeManifest(path: string, manifest: RunManifest): void {
  const valid = parseWith(RunManifest, manifest, path);
  atomicWriteFile(path, `${JSON.stringify(valid, null, 2)}\n`);
}

/**
 * Read-modify-write. `fn` may mutate and return nothing, or return a replacement manifest.
 * Stamps `updatedAt` only if the RunManifest schema defines that field (it currently does not).
 */
export function updateManifest(
  path: string,
  fn: (m: RunManifest) => RunManifest | void,
  now: () => Date = () => new Date(),
): RunManifest {
  const current = readManifest(path);
  const next: RunManifest = fn(current) ?? current;
  if ('updatedAt' in RunManifest.shape) {
    (next as Record<string, unknown>)['updatedAt'] = now().toISOString();
  }
  writeManifest(path, next);
  return next;
}

/** Restarting a run in a terminal state must do nothing. */
export function isRestartNoop(manifest: Pick<RunManifest, 'state'>): boolean {
  return isTerminalRunState(manifest.state);
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

/** Validate `obj` and append it as one line. Throws `StateError('invalid-schema')` on a bad object. */
export function appendJsonl<T extends z.ZodType>(path: string, schema: T, obj: z.input<T>): z.output<T> {
  const valid = parseWith(schema, obj, path);
  const line = `${JSON.stringify(valid)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', FILE_MODE);
  try {
    // A single write() in O_APPEND mode; no interleaving with other appenders for small lines.
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return valid;
}

export interface JsonlRead<T> {
  items: T[];
  /** Lines that were non-empty but not valid JSON or failed the schema. */
  malformed: number;
}

/** Read a JSONL file, skipping (and counting) malformed lines. A missing file reads as empty. */
export function readJsonl<T extends z.ZodType>(path: string, schema: T): JsonlRead<z.output<T>> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], malformed: 0 };
    throw err;
  }
  const items: z.output<T>[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const res = schema.safeParse(json);
    if (res.success) items.push(res.data);
    else malformed++;
  }
  return { items, malformed };
}

// ---------------------------------------------------------------------------
// Global single-run lock
// ---------------------------------------------------------------------------

/** One global lock, so only one run at a time (spec A5). */
export function defaultLockPath(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', CONTROL_DIR_NAME, 'run.lock');
}

export interface LockOptions {
  /** PID to record as owner. Defaults to `process.pid`. */
  pid?: number;
  /** Liveness probe, injectable for tests. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Run slug recorded in the lock, so a handoff (CLI -> orchestrator) can recognise its own run. */
  slug?: string;
  /** Age after which an unparseable (e.g. half-written) lock file counts as stale. */
  garbageGraceMs?: number;
}

export type ReleaseLock = () => void;

const LockContent = z.object({ pid: z.number().int().positive(), token: z.string(), ts: z.string(), slug: z.string().optional() });
type LockContent = z.infer<typeof LockContent>;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(lockPath: string): LockContent | undefined {
  try {
    const res = LockContent.safeParse(JSON.parse(readFileSync(lockPath, 'utf8')));
    return res.success ? res.data : undefined;
  } catch {
    return undefined;
  }
}

/** Who holds the lock (`undefined`: no lock or unparseable). Read-only. */
export function readLockInfo(lockPath: string): { pid: number; slug?: string; ts: string } | undefined {
  const c = readLock(lockPath);
  return c ? { pid: c.pid, ts: c.ts, ...(c.slug ? { slug: c.slug } : {}) } : undefined;
}

function removeIfSame(lockPath: string, expected: { pid?: number; token?: string } | undefined): void {
  const now = readLock(lockPath);
  if (expected === undefined ? now !== undefined : now?.token !== expected.token || now?.pid !== expected.pid) return;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Take the lock with O_EXCL. A lock whose recorded PID is dead is stale and is taken over; a
 * live one throws `StateError('lock-held')`. Returns an idempotent release function.
 */
export function acquireLock(lockPath: string, opts: LockOptions = {}): ReleaseLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? isPidAlive;
  const grace = opts.garbageGraceMs ?? 5_000;
  mkdirSync(dirname(lockPath), { recursive: true, mode: DIR_MODE });

  const content: LockContent = { pid, token: randomBytes(8).toString('hex'), ts: new Date().toISOString(), ...(opts.slug ? { slug: opts.slug } : {}) };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', FILE_MODE);
      try {
        writeSync(fd, `${JSON.stringify(content)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return makeRelease(lockPath, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new StateError('lock-error', lockPath, `Cannot create lock ${lockPath}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }

    const existing = readLock(lockPath);
    if (existing) {
      if (isAlive(existing.pid)) {
        throw new StateError('lock-held', lockPath, `Another run holds ${lockPath} (pid ${existing.pid})`, {
          pid: existing.pid,
        });
      }
      removeIfSame(lockPath, existing); // stale: owner is dead
    } else {
      // Unparseable: either being written right now, or garbage left by a crash.
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished, retry
      }
      if (ageMs < grace) {
        throw new StateError('lock-held', lockPath, `Lock ${lockPath} is being written by another process`);
      }
      removeIfSame(lockPath, undefined);
    }
  }
  throw new StateError('lock-error', lockPath, `Could not acquire lock ${lockPath} (contended)`);
}

function makeRelease(lockPath: string, mine: LockContent): ReleaseLock {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeIfSame(lockPath, mine);
  };
}

/** Release a lock by path if (and only if) it is owned by `pid`. Idempotent. */
export function releaseLock(lockPath: string, pid: number = process.pid): void {
  const now = readLock(lockPath);
  if (now?.pid === pid) removeIfSame(lockPath, now);
}

// ---------------------------------------------------------------------------
// Control flags (control dir, outside agent-writable dirs)
// ---------------------------------------------------------------------------

export const CONTROL_FLAGS_FILE = 'control.json';

export function controlFlagsPath(controlDirPath: string): string {
  return join(controlDirPath, CONTROL_FLAGS_FILE);
}

/** Read the flags; a missing file yields the defaults (no stop, heartbeat 0). Invalid content throws. */
export function readControlFlags(controlDirPath: string): ControlFlags {
  const path = controlFlagsPath(controlDirPath);
  if (!existsSync(path)) return ControlFlags.parse({});
  return parseWith(ControlFlags, readJsonFile(path), path);
}

export function writeControlFlags(controlDirPath: string, flags: Partial<ControlFlags>): ControlFlags {
  const path = controlFlagsPath(controlDirPath);
  const valid = parseWith(ControlFlags, flags, path);
  mkdirSync(controlDirPath, { recursive: true, mode: DIR_MODE });
  atomicWriteFile(path, `${JSON.stringify(valid)}\n`);
  return valid;
}

/** Merge the current flags with `patch` and write. */
export function updateControlFlags(controlDirPath: string, patch: Partial<ControlFlags>): ControlFlags {
  return writeControlFlags(controlDirPath, { ...readControlFlags(controlDirPath), ...patch });
}

/** Stamp the orchestrator heartbeat (epoch ms), preserving the stop flags. */
export function touchHeartbeat(controlDirPath: string, nowMs: number = Date.now()): ControlFlags {
  return updateControlFlags(controlDirPath, { heartbeatTs: nowMs });
}
