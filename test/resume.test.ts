import { describe, expect, it } from 'vitest';

import { attemptsOf, RunManifest, TaskEvent } from '../src/contracts.ts';
import {
  buildResumeManifest,
  buildRollbackManifest,
  checkResumeEligibility,
  checkWorktrees,
  closeLastAttempt,
  formatWorktreeProblems,
  hasOpenAttempt,
  inspectWorktreeFs,
  parseResumeBudget,
  startedWorktreeTargets,
  type WorktreeInspection,
} from '../src/resume.ts';

const SLUG = 'demo-run';
const CLI = 'node /x/bin/nightgem.mjs';
const REPO = '/Users/alice/work/acme-api';
const ROOT = `${REPO}/.worktrees/${SLUG}`;

function manifest(over: Record<string, unknown> = {}): RunManifest {
  return RunManifest.parse({
    schemaVersion: 2,
    workspaceRoot: '/Users/alice/work',
    slug: SLUG,
    budgetUsd: 40,
    state: 'stopped',
    phase: 'build',
    launchdLabel: `dev.nightgem.${SLUG}`,
    controlDir: `/Users/alice/Library/Application Support/nightgem/${SLUG}`,
    runDir: `/Users/alice/work/.specs/${SLUG}/.run`,
    xdgDataHome: `/Users/alice/Library/Application Support/nightgem/${SLUG}/xdg-data`,
    model: 'anthropic/claude-opus-5-5',
    createdAt: '2026-10-21T21:00:00.000Z',
    startedAt: '2026-10-21T21:00:10.000Z',
    endedAt: '2026-10-21T21:50:00.000Z',
    stopReason: 'signal:SIGTERM',
    costUsd: 12.5,
    serverUrl: 'http://127.0.0.1:1',
    port: 1,
    repos: [{ name: 'acme-api', path: REPO, defaultBranch: 'main', baseline: { head: 'a', branch: 'main', porcelainHash: 'h', stashCount: 0 } }],
    ...over,
  });
}

function task(id: string, state: string, over: Record<string, unknown> = {}): TaskEvent {
  return TaskEvent.parse({ ts: '2026-10-21T21:10:00.000Z', id, repo: 'acme-api', branch: `feat/${id}`, worktree: `${ROOT}/${id}`, state, phase: 'build', ...over });
}

describe('parseResumeBudget', () => {
  it.each([['5', 5], [5, 5], ['0.25', 0.25], [' 3 ', 3]])('accepts %s', (v, n) => expect(parseResumeBudget(v)).toBe(n));
  it.each([['0'], [0], ['-1'], [-0.01], ['abc'], [''], ['  '], [Number.NaN], [Number.POSITIVE_INFINITY], [undefined], [null], ['1e999']])('rejects %s', (v) => {
    expect(() => parseResumeBudget(v)).toThrow(/Invalid budget/);
  });
});

describe('checkResumeEligibility', () => {
  const check = (m: RunManifest | undefined) => checkResumeEligibility({ slug: SLUG, manifest: m, cli: CLI });

  it.each(['stopped', 'aborted-budget', 'failed', 'stalled'] as const)('accepts a %s run whose attempt is closed', (state) => {
    const r = check(manifest({ state }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toHaveLength(1);
      expect(r.last.endedAt).toBeDefined();
      expect(r.label).toBe(`dev.nightgem.${SLUG}`);
      expect(r.controlDir).toBe(`/Users/alice/Library/Application Support/nightgem/${SLUG}`);
    }
  });

  const refusal = (m: RunManifest | undefined): string => {
    const r = check(m);
    if (r.ok) throw new Error('expected a refusal');
    return r.message;
  };

  it('refuses an unknown slug', () => expect(refusal(undefined)).toMatch(/No run found for "demo-run".*launch demo-run --budget/));
  it('refuses a completed run: launch a new slug', () => expect(refusal(manifest({ state: 'completed' }))).toMatch(/completed.*launch a new slug/));
  it.each(['launching', 'running', 'winding-down', 'stopping'])('refuses an active %s run: check status or stop', (state) => {
    const m = refusal(manifest({ state, endedAt: undefined }));
    expect(m).toContain(`still active (state: ${state})`);
    expect(m).toContain(`${CLI} status ${SLUG}`);
    expect(m).toContain(`${CLI} stop ${SLUG}`);
  });
  it('refuses an open explicit last attempt: run stop first', () => {
    const m = refusal(manifest({ attempts: [{ n: 1, startedAt: 'x', budgetUsd: 40, costAtStartUsd: 0 }] }));
    expect(m).toMatch(/last attempt \(1\).*still open/);
    expect(m).toContain(`${CLI} stop ${SLUG}" first to close it`);
  });
  it('counts the implicit attempt of a manifest without endedAt as open', () => {
    expect(refusal(manifest({ endedAt: undefined }))).toMatch(/still open/);
  });
  it('refuses when an earlier attempt is closed but the last one is open', () => {
    const m = refusal(manifest({ attempts: [{ n: 1, startedAt: 'x', endedAt: 'y', state: 'stopped', budgetUsd: 40, costAtStartUsd: 0 }, { n: 2, startedAt: 'z', budgetUsd: 5, costAtStartUsd: 10 }] }));
    expect(m).toMatch(/last attempt \(2\)/);
  });
  it('refuses a launch that failed before it ever started', () => {
    expect(refusal(manifest({ state: 'failed', startedAt: undefined }))).toMatch(/before it ever started/);
  });
  it('accepts a failed run that did start', () => expect(check(manifest({ state: 'failed' })).ok).toBe(true));
  it('runs the recorded controlDir and label checks first', () => {
    expect(refusal(manifest({ controlDir: '/Users/alice/other' }))).toMatch(/does not end in/);
    expect(refusal(manifest({ launchdLabel: 'bad label' }))).toMatch(/launchd label/);
    expect(refusal({ ...manifest(), slug: 'other-run' })).toMatch(/records the slug "other-run"/);
    // also for a completed run: the path checks come first
    expect(refusal(manifest({ state: 'completed', controlDir: 'rel/demo-run' }))).toMatch(/not an absolute path/);
  });
});

describe('buildResumeManifest', () => {
  const now = '2026-10-21T22:00:00.000Z';

  it('appends one open attempt, writes out the implicit one and clears the end markers and server', () => {
    const m = manifest();
    const next = buildResumeManifest({ manifest: m, attempts: attemptsOf(m), budgetUsd: 7, now, pid: 4242, repos: [] });
    expect(next).toMatchObject({ state: 'launching', pid: 4242, budgetUsd: 7, costUsd: 12.5, startedAt: m.startedAt });
    expect('endedAt' in next).toBe(false);
    expect('stopReason' in next).toBe(false);
    expect('serverUrl' in next).toBe(false);
    expect('port' in next).toBe(false);
    expect(next.attempts).toEqual([
      { n: 1, startedAt: '2026-10-21T21:00:10.000Z', endedAt: '2026-10-21T21:50:00.000Z', state: 'stopped', stopReason: 'signal:SIGTERM', budgetUsd: 40, costAtStartUsd: 0, costUsd: 12.5 },
      { n: 2, startedAt: now, budgetUsd: 7, costAtStartUsd: 12.5 },
    ]);
    expect(RunManifest.safeParse(next).success).toBe(true);
  });

  it('does not mutate its input', () => {
    const m = manifest({ attempts: [{ n: 1, startedAt: 'x', endedAt: 'y', state: 'stopped', budgetUsd: 40, costAtStartUsd: 0, costUsd: 1 }] });
    const snapshot = JSON.stringify(m);
    buildResumeManifest({ manifest: m, attempts: attemptsOf(m), budgetUsd: 7, now, pid: 1, repos: [] });
    expect(JSON.stringify(m)).toBe(snapshot);
  });
});

describe('buildRollbackManifest', () => {
  it('restores the previous manifest and keeps the new attempt closed as resume-failed', () => {
    const m = manifest();
    const attempts = attemptsOf(m);
    const next = buildResumeManifest({ manifest: m, attempts, budgetUsd: 7, now: '2026-10-21T22:00:00.000Z', pid: 1, repos: [] });
    const back = buildRollbackManifest({ previous: m, attempts, started: next.attempts!.at(-1)!, now: '2026-10-21T22:00:05.000Z' });
    expect(back).toMatchObject({ state: 'stopped', budgetUsd: 40, endedAt: m.endedAt, stopReason: 'signal:SIGTERM', serverUrl: 'http://127.0.0.1:1' });
    expect(back.attempts!.at(-1)).toEqual({ n: 2, startedAt: '2026-10-21T22:00:00.000Z', endedAt: '2026-10-21T22:00:05.000Z', state: 'failed', stopReason: 'resume-failed', budgetUsd: 7, costAtStartUsd: 12.5, costUsd: 0 });
    expect(hasOpenAttempt(back)).toBe(false);
  });
});

describe('closeLastAttempt', () => {
  const close = { endedAt: '2026-10-21T23:00:00.000Z', state: 'stopped' as const, stopReason: 'stopped-after-crash' };

  it('closes an open explicit attempt and keeps its recorded cost', () => {
    const m = manifest({ state: 'running', endedAt: undefined, costUsd: 9, attempts: [{ n: 1, startedAt: 'x', budgetUsd: 40, costAtStartUsd: 0, costUsd: 3 }] });
    expect(closeLastAttempt(m, close)).toEqual([{ n: 1, startedAt: 'x', budgetUsd: 40, costAtStartUsd: 0, costUsd: 3, ...close }]);
  });
  it('fills an unrecorded cost from the cumulative spend since the start, never negative', () => {
    const m = manifest({ state: 'running', endedAt: undefined, costUsd: 9, attempts: [{ n: 2, startedAt: 'x', budgetUsd: 5, costAtStartUsd: 4 }] });
    expect(closeLastAttempt(m, close)[0]!.costUsd).toBe(5);
    const low = manifest({ state: 'running', endedAt: undefined, costUsd: 1, attempts: [{ n: 2, startedAt: 'x', budgetUsd: 5, costAtStartUsd: 4 }] });
    expect(closeLastAttempt(low, close)[0]!.costUsd).toBe(0);
  });
  it('writes out and closes the implicit attempt of a manifest without attempts', () => {
    const m = manifest({ state: 'running', endedAt: undefined, stopReason: undefined });
    expect(closeLastAttempt(m, close)).toEqual([{ n: 1, startedAt: '2026-10-21T21:00:10.000Z', budgetUsd: 40, costAtStartUsd: 0, costUsd: 12.5, ...close }]);
  });
  it('leaves an already closed attempt alone', () => {
    const m = manifest({ attempts: [{ n: 1, startedAt: 'x', endedAt: 'y', state: 'failed', budgetUsd: 40, costAtStartUsd: 0, costUsd: 1 }] });
    expect(closeLastAttempt(m, close)[0]).toMatchObject({ endedAt: 'y', state: 'failed' });
  });
});

describe('startedWorktreeTargets', () => {
  it('takes the latest event of started tasks and of started integrations, and skips the rest', () => {
    const { tasks, integrations } = startedWorktreeTargets([
      task('a', 'running'),
      task('a', 'done'),
      task('b', 'todo'),
      task('c', 'running'),
      task('c', 'todo'),
      task('d', 'blocked', { blockedReason: 'wind-down: unfinished' }),
      task('e', 'skipped', { blockedReason: 'wind-down: never started' }),
      task('f', 'skipped', { blockedReason: 'dependency d is blocked' }),
      task('g', 'blocked', { blockedReason: 'verify keeps failing' }),
      task('phase:build', 'running', { repo: '_run' }),
      task('wind-down:x', 'done'),
      task('integration:acme-api', 'running'),
      task('integration:acme-web', 'todo'),
    ]);
    expect(tasks.map((t) => t.id).sort()).toEqual(['a', 'd', 'g']); // skipped (any reason) was never started; blocked was
    expect(integrations.map((t) => t.id)).toEqual(['integration:acme-api']);
  });
});

describe('checkWorktrees', () => {
  const repos = [{ name: 'acme-api', path: REPO }];
  const present = (branches: Record<string, string>) => (path: string): WorktreeInspection => (path in branches ? { exists: true, branch: branches[path] } : { exists: false });
  const run = (events: TaskEvent[], inspect: (p: string) => WorktreeInspection) => checkWorktrees({ slug: SLUG, repos, events, inspect });

  it('is clean when everything started exists on its branch (including a task still marked running)', async () => {
    const problems = await run(
      [task('a', 'done'), task('b', 'running'), task('c', 'todo')],
      present({ [`${ROOT}/a`]: 'feat/a', [`${ROOT}/b`]: 'feat/b' }),
    );
    expect(problems).toEqual([]);
  });

  it('lists every missing worktree', async () => {
    const problems = await run([task('a', 'done'), task('b', 'running')], present({}));
    expect(problems.map((p) => [p.taskId, p.problem])).toEqual([['a', 'the worktree is missing'], ['b', 'the worktree is missing']]);
    const msg = formatWorktreeProblems(SLUG, problems);
    expect(msg).toMatch(/2 worktrees of started tasks are missing/);
    expect(msg).toContain(`- a: ${ROOT}/a: the worktree is missing`);
  });

  it('uses the singular for one', () => {
    expect(formatWorktreeProblems(SLUG, [{ taskId: 'a', path: '/p', problem: 'x' }])).toMatch(/1 worktree of started tasks is missing/);
  });

  it('flags a wrong or detached branch', async () => {
    const wrong = await run([task('a', 'done')], present({ [`${ROOT}/a`]: 'feat/zzz' }));
    expect(wrong[0]!.problem).toMatch(/branch feat\/a is not checked out there \(found feat\/zzz\)/);
    const detached = await run([task('a', 'done')], () => ({ exists: true }));
    expect(detached[0]!.problem).toMatch(/detached or unreadable/);
  });

  it.each([
    ['another repo\'s root', `${REPO}/.worktrees/other-run/a`],
    ['the repo itself', REPO],
    ['the worktree root itself', ROOT],
    ['a sibling outside', '/Users/alice/work/elsewhere/a'],
    ['a ..-escape', `${ROOT}/../../../../elsewhere/a`],
    ['a relative path', '.worktrees/demo-run/a'],
  ])('refuses a path that is %s, without even inspecting it', async (_n, worktree) => {
    const seen: string[] = [];
    const problems = await run([task('a', 'running', { worktree })], (p) => {
      seen.push(p);
      return { exists: true, branch: 'feat/a' };
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/outside the run's worktree root|not absolute/);
    expect(seen).toEqual([]);
  });

  it('does not require a worktree for a skipped dependent of a blocked task, but still checks the blocked one', async () => {
    const events = [task('a', 'blocked', { blockedReason: 'verify keeps failing' }), task('b', 'skipped', { blockedReason: 'depends on a' })];
    const problems = await run(events, present({ [`${ROOT}/a`]: 'feat/a' }));
    expect(problems).toEqual([]);
    expect((await run(events, present({}))).map((p) => p.taskId)).toEqual(['a']);
  });

  it('refuses a task of a repo the run does not have', async () => {
    const problems = await run([task('a', 'running', { repo: 'acme-web' })], present({}));
    expect(problems[0]!.problem).toMatch(/not one of the run's repos/);
  });

  it('checks the _integration worktree of each repo with a started integration event, and nothing else for a todo one', async () => {
    const events = [task('integration:acme-api', 'running', { branch: 'integration/demo', worktree: `${ROOT}/_integration` })];
    expect((await run(events, present({}))).map((p) => p.taskId)).toEqual(['integration:acme-api']);
    expect(await run(events, present({ [`${ROOT}/_integration`]: 'integration/demo' }))).toEqual([]);
    expect(await run([task('integration:acme-api', 'todo', { worktree: `${ROOT}/_integration` })], present({}))).toEqual([]);
  });

  it('requires the integration worktree to be exactly <root>/_integration', async () => {
    const events = [task('integration:acme-api', 'running', { branch: 'b', worktree: `${ROOT}/somewhere-else` })];
    const problems = await run(events, present({ [`${ROOT}/somewhere-else`]: 'b' }));
    expect(problems[0]!.problem).toMatch(/not the integration worktree of the run/);
  });
});

describe('inspectWorktreeFs', () => {
  const files = (map: Record<string, string>) => ({
    exists: (p: string) => Object.keys(map).some((k) => k === p || k.startsWith(`${p}/`)),
    readText: (p: string) => map[p],
  });

  it('reads the branch of a linked worktree through its .git file', () => {
    const fs = files({ '/w/t1/.git': 'gitdir: /r/.git/worktrees/t1\n', '/r/.git/worktrees/t1/HEAD': 'ref: refs/heads/feat/t1\n' });
    expect(inspectWorktreeFs('/w/t1', fs)).toEqual({ exists: true, branch: 'feat/t1' });
  });
  it('resolves a relative gitdir against the worktree', () => {
    const fs = files({ '/w/t1/.git': 'gitdir: ../gd\n', '/w/gd/HEAD': 'ref: refs/heads/b\n' });
    expect(inspectWorktreeFs('/w/t1', fs).branch).toBe('b');
  });
  it('reads HEAD of a plain checkout (.git is a directory)', () => {
    const fs = files({ '/w/t1/.git/HEAD': 'ref: refs/heads/main\n' });
    expect(inspectWorktreeFs('/w/t1', fs)).toEqual({ exists: true, branch: 'main' });
  });
  it('has no branch for a detached HEAD or an unreadable pointer, and does not exist without .git', () => {
    expect(inspectWorktreeFs('/w/t1', files({ '/w/t1/.git': 'gitdir: /g\n', '/g/HEAD': 'a1b2c3\n' }))).toEqual({ exists: true });
    expect(inspectWorktreeFs('/w/t1', files({ '/w/t1/.git': 'garbage' }))).toEqual({ exists: true });
    expect(inspectWorktreeFs('/w/t1', files({ '/w/t1/file': 'x' }))).toEqual({ exists: false });
    expect(inspectWorktreeFs('/w/t1', files({}))).toEqual({ exists: false });
  });
});
