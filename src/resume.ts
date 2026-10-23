/**
 * Pure helpers for `resume` (and the crashed-run branch of `stop`): the eligibility rules, the single manifest transition,
 * its rollback, the attempt closing and the worktree check. No I/O except through the injected probes.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  attemptsOf,
  isNeverStartedFailure,
  isTerminalRunState,
  type RepoEntry,
  type RunAttempt,
  type RunManifest,
  type RunState,
  type TaskEvent,
} from './contracts.ts';
import { integrationWorktree, recordedControlDir, recordedLaunchdLabel, worktreeRoot } from './paths.ts';

/** The terminal states a run can be resumed from. `completed` is deliberately absent. */
export const RESUMABLE_STATES = ['stopped', 'aborted-budget', 'failed', 'stalled'] as const satisfies readonly RunState[];

export function isResumableState(state: RunState): boolean {
  return (RESUMABLE_STATES as readonly string[]).includes(state);
}

/** The stop reason `stop` records for a run whose orchestrator died without closing its attempt. */
export const STOPPED_AFTER_CRASH = 'stopped-after-crash';
/** The stop reason of a resume attempt that could not be started (the CLI rolled the manifest back). */
export const RESUME_FAILED = 'resume-failed';

/** The budget flag, validated: a finite number above 0. */
export function parseResumeBudget(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid budget "${String(value)}" (expected a positive USD amount, e.g. --budget 5)`);
  return n;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type ResumeEligibility =
  | { ok: true; manifest: RunManifest; attempts: RunAttempt[]; last: RunAttempt; controlDir: string; label: string }
  | { ok: false; message: string };

/**
 * Decide whether `manifest` (the parsed RUN.json of `slug`, or `undefined` when there is none) may be resumed. `cli` is the
 * command prefix for the hints ("node /path/bin/nightgem.mjs"). The recorded control dir and launchd label must pass the
 * same checks as `stop` and `status`; they are what the CLI then acts on.
 */
export function checkResumeEligibility(input: { slug: string; manifest: RunManifest | undefined; cli: string }): ResumeEligibility {
  const { slug, manifest, cli } = input;
  const refuse = (message: string): ResumeEligibility => ({ ok: false, message });
  if (!manifest) return refuse(`No run found for "${slug}". Nothing to resume; launch it with "${cli} launch ${slug} --budget <usd>".`);

  let controlDir: string;
  let label: string;
  try {
    controlDir = recordedControlDir(manifest, slug);
    label = recordedLaunchdLabel(manifest, slug);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }

  if (manifest.state === 'completed') {
    return refuse(`Run "${slug}" is completed; there is nothing to resume. To do more work, launch a new slug.`);
  }
  if (!isTerminalRunState(manifest.state)) {
    return refuse(
      `Run "${slug}" is still active (state: ${manifest.state}). Check it with "${cli} status ${slug}" or stop it with "${cli} stop ${slug}"; ` +
        'if its orchestrator crashed, stop closes the attempt and the run can then be resumed.',
    );
  }
  if (!isResumableState(manifest.state)) {
    return refuse(`Run "${slug}" is ${manifest.state}, which cannot be resumed (resumable: ${RESUMABLE_STATES.join(', ')}).`);
  }
  if (isNeverStartedFailure(manifest)) {
    return refuse(`Run "${slug}" failed before it ever started, so there is nothing to continue. Launch it again with "${cli} launch ${slug} --budget <usd>".`);
  }

  const attempts = attemptsOf(manifest);
  const last = attempts.at(-1);
  if (!last) return refuse(`Run "${slug}" has an empty attempts list in RUN.json; it cannot be resumed.`);
  if (last.endedAt === undefined) {
    return refuse(
      `The last attempt (${last.n}) of run "${slug}" is still open; the orchestrator probably crashed before it could close it. ` +
        `Run "${cli} stop ${slug}" first to close it, then resume.`,
    );
  }
  return { ok: true, manifest, attempts, last, controlDir, label };
}

// ---------------------------------------------------------------------------
// Manifest transitions
// ---------------------------------------------------------------------------

export interface ResumeTransitionInput {
  manifest: RunManifest;
  /** `attemptsOf(manifest)`, all closed. */
  attempts: RunAttempt[];
  budgetUsd: number;
  now: string;
  /** The CLI's pid: the orchestrator recognises the lock holder as this run during the handoff. */
  pid: number;
  /** The rebuilt tripwire baseline. */
  repos: RepoEntry[];
}

/**
 * The one manifest write of a resume (AD6): the earlier attempts stay as they are (the implicit first attempt of a manifest
 * without `attempts` is written out), a new open attempt is appended, the state is `launching` with the CLI's pid and the new
 * budget, and the end markers of the earlier attempt are cleared. `costAtStartUsd` is the cumulative `costUsd` (already
 * multiplied). The stale server url and port go too: the attempt starts a fresh server.
 */
export function buildResumeManifest(i: ResumeTransitionInput): RunManifest {
  const last = i.attempts.at(-1);
  const attempt: RunAttempt = { n: (last?.n ?? 0) + 1, startedAt: i.now, budgetUsd: i.budgetUsd, costAtStartUsd: i.manifest.costUsd };
  const next: RunManifest = {
    ...i.manifest,
    state: 'launching',
    pid: i.pid,
    budgetUsd: i.budgetUsd,
    repos: i.repos,
    attempts: [...i.attempts.map((a) => ({ ...a })), attempt],
  };
  delete next.endedAt;
  delete next.stopReason;
  delete next.serverUrl;
  delete next.port;
  return next;
}

/**
 * The manifest to restore when the resume fails after {@link buildResumeManifest} was written: the previous manifest
 * (terminal state, end markers, budget, baseline) with the new attempt kept as a closed, failed one. No attempt is left open.
 */
export function buildRollbackManifest(i: { previous: RunManifest; attempts: RunAttempt[]; started: RunAttempt; now: string }): RunManifest {
  const failed: RunAttempt = { ...i.started, endedAt: i.now, state: 'failed', stopReason: RESUME_FAILED, costUsd: i.started.costUsd ?? 0 };
  return { ...i.previous, attempts: [...i.attempts.map((a) => ({ ...a })), failed] };
}

/**
 * The attempts of `m` with the last one closed (the implicit one is written out when `attempts` is absent), unless it is
 * already closed. `costUsd` stays as recorded and is never lowered; when nothing was recorded it is what the run spent since
 * the attempt began.
 */
export function closeLastAttempt(m: RunManifest, close: { endedAt: string; state: RunAttempt['state']; stopReason?: string | undefined }): RunAttempt[] {
  const attempts = attemptsOf(m).map((a) => ({ ...a }));
  const last = attempts.at(-1);
  if (!last || last.endedAt !== undefined) return attempts;
  last.endedAt = close.endedAt;
  if (close.state !== undefined) last.state = close.state;
  if (close.stopReason !== undefined) last.stopReason = close.stopReason;
  last.costUsd = last.costUsd ?? Math.max(0, m.costUsd - last.costAtStartUsd);
  return attempts;
}

/** True when the last attempt of `m` (implicit or recorded) has no `endedAt`. */
export function hasOpenAttempt(m: RunManifest): boolean {
  return attemptsOf(m).at(-1)?.endedAt === undefined;
}

// ---------------------------------------------------------------------------
// Worktree check
// ---------------------------------------------------------------------------

export interface WorktreeInspection {
  exists: boolean;
  /** The branch checked out there; `undefined` when detached or unreadable. */
  branch?: string | undefined;
}

const PSEUDO = /^(phase|wind-down):/;

/**
 * The worktrees a resumed build relies on: the latest event of every task that was started (not `todo`, not a `phase:` or
 * `wind-down:` pseudo-task), and the `_integration` worktree of every repo that has a started `integration:<repo>` event. A
 * `skipped` task was never started, whatever the reason (a wind-down's, or a dependent of a blocked task), so it has no
 * worktree to lose; `blocked` tasks were started and are checked.
 */
export function startedWorktreeTargets(events: readonly TaskEvent[]): { tasks: TaskEvent[]; integrations: TaskEvent[] } {
  const latest = new Map<string, TaskEvent>();
  for (const e of events) latest.set(e.id, e);
  const tasks: TaskEvent[] = [];
  const integrations: TaskEvent[] = [];
  for (const e of latest.values()) {
    if (e.state === 'todo') continue;
    if (e.id.startsWith('integration:')) integrations.push(e);
    else if (PSEUDO.test(e.id) || e.repo === '_run') continue;
    else if (e.state === 'skipped') continue; // never started, whatever the reason (a blocked task's dependents are skipped too)
    else tasks.push(e);
  }
  return { tasks, integrations };
}

function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface WorktreeProblem {
  taskId: string;
  path: string;
  /** Why it blocks the resume. */
  problem: string;
}

/**
 * Check, before anything is written, that every started task still has its worktree and branch. A path must be absolute and
 * lie inside the run's worktree root of its repo (`<repo>/.worktrees/<slug>`; the integration worktree must be exactly
 * `<root>/_integration`), must exist, and must have the task's branch checked out. Returns every problem found.
 */
export async function checkWorktrees(input: {
  slug: string;
  repos: readonly Pick<RepoEntry, 'name' | 'path'>[];
  events: readonly TaskEvent[];
  inspect: (path: string) => Promise<WorktreeInspection> | WorktreeInspection;
}): Promise<WorktreeProblem[]> {
  const { slug, repos, events } = input;
  const { tasks, integrations } = startedWorktreeTargets(events);
  const problems: WorktreeProblem[] = [];

  const check = async (e: TaskEvent, repoName: string, kind: 'task' | 'integration'): Promise<void> => {
    const add = (problem: string): void => void problems.push({ taskId: e.id, path: e.worktree, problem });
    const repo = repos.find((r) => r.name === repoName);
    if (!repo) return add(`repo "${repoName}" is not one of the run's repos`);
    if (!isAbsolute(e.worktree)) return add('the recorded worktree path is not absolute');
    const root = resolve(worktreeRoot(repo.path, slug));
    const path = resolve(e.worktree);
    if (kind === 'integration') {
      if (path !== resolve(integrationWorktree(repo.path, slug))) return add(`not the integration worktree of the run (expected ${integrationWorktree(repo.path, slug)})`);
    } else if (!isStrictlyInside(root, path)) {
      return add(`outside the run's worktree root ${root}`);
    }
    const found = await input.inspect(path);
    if (!found.exists) return add('the worktree is missing');
    if (found.branch !== e.branch) {
      return add(`branch ${e.branch} is not checked out there${found.branch === undefined ? ' (detached or unreadable HEAD)' : ` (found ${found.branch})`}`);
    }
  };

  for (const e of tasks) await check(e, e.repo, 'task');
  for (const e of integrations) await check(e, e.id.slice('integration:'.length), 'integration');
  return problems;
}

/** The refusal message for {@link checkWorktrees} problems: one line per problem. */
export function formatWorktreeProblems(slug: string, problems: readonly WorktreeProblem[]): string {
  const n = problems.length;
  return [
    `Cannot resume "${slug}": ${n} worktree${n === 1 ? '' : 's'} of started tasks ${n === 1 ? 'is' : 'are'} missing or not usable.`,
    ...problems.map((p) => `  - ${p.taskId}: ${p.path}: ${p.problem}`),
    'A resume never rebuilds a worktree silently. Restore them (for example with "git worktree add <path> <branch>"), or launch a new slug.',
  ].join('\n');
}

/**
 * Inspect a worktree through plain file reads (no git process, so no hook or config of an agent-written repo runs): the
 * `.git` file (or dir) at `path`, then its `HEAD`. The `fs` is injected.
 */
export function inspectWorktreeFs(path: string, fs: { exists(p: string): boolean; readText(p: string): string | undefined }): WorktreeInspection {
  const dotGit = `${path}${sep}.git`;
  if (!fs.exists(path) || !fs.exists(dotGit)) return { exists: false };
  let headFile = `${dotGit}${sep}HEAD`;
  const pointer = fs.readText(dotGit); // a linked worktree has a `.git` FILE ("gitdir: <dir>"); a directory reads as undefined
  if (pointer !== undefined) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
    if (!m?.[1]) return { exists: true };
    headFile = `${isAbsolute(m[1]) ? m[1] : resolve(path, m[1])}${sep}HEAD`;
  }
  const head = fs.readText(headFile);
  const ref = head === undefined ? null : /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return ref?.[1] ? { exists: true, branch: ref[1] } : { exists: true };
}
