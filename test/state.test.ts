import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CostLine, RunManifest, TaskEvent } from '../src/contracts.ts';
import {
  acquireLock,
  appendJsonl,
  atomicWriteFile,
  controlFlagsPath,
  defaultLockPath,
  isRestartNoop,
  readControlFlags,
  readJsonl,
  readManifest,
  releaseLock,
  StateError,
  touchHeartbeat,
  updateControlFlags,
  updateManifest,
  writeControlFlags,
  writeManifest,
} from '../src/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ng-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return RunManifest.parse({
    schemaVersion: 2,
    workspaceRoot: join(dir, 'ws'),
    slug: 'demo',
    budgetUsd: 10,
    state: 'running',
    phase: 'build',
    launchdLabel: 'dev.nightgem.demo',
    controlDir: join(dir, 'control'),
    runDir: join(dir, 'run'),
    xdgDataHome: join(dir, 'xdg'),
    model: 'anthropic/claude-sonnet-5-5',
    createdAt: '2026-10-21T00:00:00.000Z',
    ...over,
  });
}

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('manifest', () => {
  it('round-trips and writes with mode 0600', () => {
    const p = join(dir, 'run', 'RUN.json');
    const m = manifest();
    writeManifest(p, m);
    expect(readManifest(p)).toEqual(m);
    expect(mode(p)).toBe(0o600);
  });

  it('throws typed errors for missing, bad JSON and bad schema', () => {
    const p = join(dir, 'RUN.json');
    expect(() => readManifest(p)).toThrowError(StateError);
    expect(() => readManifest(p)).toThrow(expect.objectContaining({ code: 'missing', path: p }));

    writeFileSync(p, '{not json');
    expect(() => readManifest(p)).toThrow(expect.objectContaining({ code: 'invalid-json' }));

    writeFileSync(p, JSON.stringify({ schemaVersion: 1, slug: 'x' }));
    expect(() => readManifest(p)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
  });

  it('refuses to write an invalid manifest and leaves the old file intact', () => {
    const p = join(dir, 'RUN.json');
    writeManifest(p, manifest());
    const before = readFileSync(p, 'utf8');
    expect(() => writeManifest(p, { ...manifest(), budgetUsd: -1 })).toThrow(
      expect.objectContaining({ code: 'invalid-schema' }),
    );
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('is atomic: a crash-leftover tmp file never corrupts or shadows the real file', () => {
    const p = join(dir, 'RUN.json');
    const m = manifest();
    writeManifest(p, m);
    // Simulated crash mid-write: a half-written tmp file is left behind in the same dir.
    writeFileSync(join(dir, '.RUN.json.99999.deadbeef.tmp'), '{"schemaVersion": 1, "slu');
    expect(readManifest(p)).toEqual(m);
    // A subsequent write succeeds and the real file is still complete and valid.
    writeManifest(p, manifest({ state: 'completed' }));
    expect(readManifest(p).state).toBe('completed');
  });

  it('leaves no tmp file behind when the rename fails', () => {
    // Target is a non-empty directory, so rename(file -> dir) fails.
    const target = join(dir, 'RUN.json');
    atomicWriteFile(join(target, 'child'), 'x');
    expect(() => atomicWriteFile(target, 'data')).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('updateManifest does read-modify-write (mutate or replace) and adds no updatedAt field', () => {
    const p = join(dir, 'RUN.json');
    writeManifest(p, manifest());
    const r1 = updateManifest(p, (m) => {
      m.nudges += 1;
    });
    expect(r1.nudges).toBe(1);
    const r2 = updateManifest(p, (m) => ({ ...m, state: 'stopping' }));
    expect(r2.state).toBe('stopping');
    const onDisk = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect(onDisk['nudges']).toBe(1);
    expect(onDisk['state']).toBe('stopping');
    expect('updatedAt' in onDisk).toBe(false);
  });

  it('updateManifest propagates a read error for a missing file', () => {
    expect(() => updateManifest(join(dir, 'nope.json'), () => undefined)).toThrow(
      expect.objectContaining({ code: 'missing' }),
    );
  });
});

describe('isRestartNoop', () => {
  it.each(['completed', 'failed', 'stalled', 'aborted-budget', 'stopped'] as const)('true for %s', (state) => {
    expect(isRestartNoop(manifest({ state }))).toBe(true);
  });
  it.each(['launching', 'running', 'winding-down', 'stopping'] as const)('false for %s', (state) => {
    expect(isRestartNoop(manifest({ state }))).toBe(false);
  });
});

describe('jsonl', () => {
  const task = (id: string): z.input<typeof TaskEvent> => ({
    ts: '2026-10-21T00:00:00.000Z',
    id,
    repo: 'r',
    branch: 'b',
    worktree: '/w',
    state: 'running',
    phase: 'build',
  });

  it('appends validated lines and reads them back with defaults applied', () => {
    const p = join(dir, 'run', 'tasks.jsonl');
    appendJsonl(p, TaskEvent, task('t1'));
    appendJsonl(p, TaskEvent, task('t2'));
    expect(readFileSync(p, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(mode(p)).toBe(0o600);
    const { items, malformed } = readJsonl(p, TaskEvent);
    expect(malformed).toBe(0);
    expect(items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(items[0]?.attempt).toBe(0);
  });

  it('rejects an invalid object without writing anything', () => {
    const p = join(dir, 'tasks.jsonl');
    expect(() => appendJsonl(p, TaskEvent, { ...task('t1'), state: 'bogus' as never })).toThrow(
      expect.objectContaining({ code: 'invalid-schema' }),
    );
    expect(existsSync(p)).toBe(false);
  });

  it('skips and counts malformed lines (bad JSON, bad schema, truncated tail), ignoring blanks', () => {
    const p = join(dir, 'cost.jsonl');
    const good = {
      ts: 't',
      sessionId: 's',
      phase: 'plan',
      costUsd: 1,
      source: 'session-info',
      totalUsd: 1,
    };
    writeFileSync(
      p,
      [
        JSON.stringify(good),
        '{broken',
        '',
        JSON.stringify({ ...good, costUsd: -5 }),
        JSON.stringify({ ...good, totalUsd: 2 }),
        '{"ts":"t","sessionId":"s","ph', // crash-truncated last line (no newline)
      ].join('\n'),
    );
    const { items, malformed } = readJsonl(p, CostLine);
    expect(items.map((i) => i.totalUsd)).toEqual([1, 2]);
    expect(malformed).toBe(3);
  });

  it('reads a missing file as empty', () => {
    expect(readJsonl(join(dir, 'none.jsonl'), CostLine)).toEqual({ items: [], malformed: 0 });
  });
});

describe('lock', () => {
  const lockPath = (): string => join(dir, 'sub', 'run.lock');

  it('defaults to the single global path under Application Support', () => {
    expect(defaultLockPath('/home/u')).toBe('/home/u/Library/Application Support/nightgem/run.lock');
  });

  it('acquires, writes owner pid with mode 0600, and releases idempotently', () => {
    const release = acquireLock(lockPath(), { pid: process.pid });
    expect(mode(lockPath())).toBe(0o600);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(lockPath())).toBe(false);
    release(); // idempotent
    // After release the lock can be taken again.
    const again = acquireLock(lockPath());
    // A stale release() must not remove someone else's lock.
    release();
    expect(existsSync(lockPath())).toBe(true);
    again();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('rejects when a live process holds the lock', () => {
    const release = acquireLock(lockPath());
    // The real liveness probe: our own pid is alive.
    let err: unknown;
    try {
      acquireLock(lockPath(), { pid: process.pid + 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StateError);
    expect(err).toMatchObject({ code: 'lock-held', pid: process.pid });
    // Original lock untouched.
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('takes over a stale lock whose pid is dead (default liveness probe)', () => {
    // Find a pid that is surely dead: spawn-less approach, probe from a high number.
    let dead = 4_000_000;
    while (true) {
      try {
        process.kill(dead, 0);
        dead++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') break;
        dead++;
      }
    }
    writeFileSync(
      (() => {
        acquireLock(lockPath())(); // ensure the dir exists
        return lockPath();
      })(),
      JSON.stringify({ pid: dead, token: 'old', ts: '2020-01-01T00:00:00.000Z' }),
    );
    const release = acquireLock(lockPath(), { pid: process.pid });
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('takes over a stale lock using an injected liveness probe', () => {
    acquireLock(lockPath(), { pid: 111 });
    const seen: number[] = [];
    const release = acquireLock(lockPath(), {
      pid: 222,
      isAlive: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen).toEqual([111]);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(222);
    release();
  });

  it('treats a fresh unparseable lock as held, and an old one as stale garbage', () => {
    acquireLock(lockPath())();
    writeFileSync(lockPath(), '');
    expect(() => acquireLock(lockPath())).toThrow(expect.objectContaining({ code: 'lock-held' }));
    const release = acquireLock(lockPath(), { garbageGraceMs: -1 });
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('releaseLock(path, pid) only removes a lock owned by that pid, and is idempotent', () => {
    acquireLock(lockPath(), { pid: 111 });
    releaseLock(lockPath(), 222);
    expect(existsSync(lockPath())).toBe(true);
    releaseLock(lockPath(), 111);
    expect(existsSync(lockPath())).toBe(false);
    releaseLock(lockPath(), 111);
  });
});

describe('control flags', () => {
  const cdir = (): string => join(dir, 'control');

  it('defaults when the file is missing', () => {
    expect(readControlFlags(cdir())).toEqual({ softStop: false, hardStop: false, heartbeatTs: 0 });
  });

  it('writes with mode 0600 and round-trips', () => {
    const w = writeControlFlags(cdir(), { softStop: true });
    expect(w).toEqual({ softStop: true, hardStop: false, heartbeatTs: 0 });
    expect(mode(controlFlagsPath(cdir()))).toBe(0o600);
    expect(readControlFlags(cdir())).toEqual(w);
  });

  it('touchHeartbeat stamps the time and preserves stop flags', () => {
    writeControlFlags(cdir(), { hardStop: true });
    const f = touchHeartbeat(cdir(), 1_700_000_000_000);
    expect(f).toEqual({ softStop: false, hardStop: true, heartbeatTs: 1_700_000_000_000 });
    expect(readControlFlags(cdir())).toEqual(f);
    expect(mode(controlFlagsPath(cdir()))).toBe(0o600);
  });

  it('touchHeartbeat works with no prior file and defaults to now', () => {
    const before = Date.now();
    const f = touchHeartbeat(cdir());
    expect(f.heartbeatTs).toBeGreaterThanOrEqual(before);
  });

  it('updateControlFlags merges a patch', () => {
    touchHeartbeat(cdir(), 5);
    expect(updateControlFlags(cdir(), { softStop: true })).toEqual({ softStop: true, hardStop: false, heartbeatTs: 5 });
  });

  it('throws a typed error on corrupt flags', () => {
    writeControlFlags(cdir(), {});
    writeFileSync(controlFlagsPath(cdir()), '{"softStop": "yes"}');
    expect(() => readControlFlags(cdir())).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
  });
});
