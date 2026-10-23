/**
 * Pure path helpers for runs, control dirs and worktrees. `home` is injectable for tests.
 * Only `assertWithin` touches the filesystem (to resolve symlinks).
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CONTROL_DIR_NAME } from './brand.ts';

export const SLUG_MAX = 60;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * Hyphen-separated tokens the push guard and the launcher reject in branch names, so slugs and task
 * ids (which become branch names and worktree paths) must not contain them. `pushover` is fine, `jira-1-push-notif` is not.
 * `stash` is reserved because the permission profile glob `*git*stash*` would otherwise deny `git -C <run path> ...`.
 */
export const RESERVED_TOKENS = ['push', 'gh', 'ssh', 'stash'] as const;

/** The first reserved token (`push`, `gh`, `ssh`, `stash`) found as a whole `-`-separated token, case-insensitive. */
export function reservedToken(name: string): string | undefined {
  return name
    .toLowerCase()
    .split('-')
    .find((t) => (RESERVED_TOKENS as readonly string[]).includes(t));
}

function reservedMessage(kind: string, name: string, token: string): string {
  return `Invalid ${kind} "${name}": it contains the standalone word "${token}", which the push/stash guard rejects in branch names and paths (use a synonym such as "notif" or "publish-ui")`;
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX && KEBAB_RE.test(slug) && reservedToken(slug) === undefined;
}

export function assertSlug(slug: string): string {
  if (!isValidSlug(slug)) {
    const token = slug.length > 0 && slug.length <= SLUG_MAX && KEBAB_RE.test(slug) ? reservedToken(slug) : undefined;
    if (token) throw new Error(reservedMessage('slug', slug, token));
    throw new Error(`Invalid slug "${slug}" (expected kebab-case [a-z0-9-], at most ${SLUG_MAX} chars)`);
  }
  return slug;
}

/** Task ids become directory names: kebab-case (case-insensitive), no separators, never `_integration`. */
export function assertTaskId(task: string): string {
  if (task.length === 0 || task.length > SLUG_MAX || !TASK_RE.test(task)) {
    throw new Error(`Invalid task id "${task}" (expected kebab-case [A-Za-z0-9-], at most ${SLUG_MAX} chars)`);
  }
  const token = reservedToken(task);
  if (token) throw new Error(reservedMessage('task id', task, token));
  return task;
}

// --- Run / control directories ------------------------------------------------

/** `<workspaceRoot>/.specs/<slug>` */
export function specsDir(slug: string, workspaceRoot: string): string {
  return join(workspaceRoot, '.specs', assertSlug(slug));
}

/** `<specs>/.run` (the opencode serve cwd). */
export function runDir(slug: string, workspaceRoot: string): string {
  return join(specsDir(slug, workspaceRoot), '.run');
}

/** `~/Library/Application Support/nightgem/<slug>` (secrets, flags, plist; agent-unwritable). */
export function controlDir(slug: string, home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', CONTROL_DIR_NAME, assertSlug(slug));
}

/**
 * The control dir an EXISTING run recorded in its RUN.json. Looking a run up by path rebuilt from the slug would
 * break when the control root is named differently than at launch time (a manifest written by another version or tool).
 * The recorded path must be absolute (no `..` segments) and end in `/<slug>`; anything else is refused. New launches use
 * {@link controlDir}.
 */
export function recordedControlDir(manifest: { slug: string; controlDir: string }, slug: string): string {
  if (manifest.slug !== slug) {
    throw new Error(`Refusing run "${slug}": its RUN.json records the slug "${manifest.slug}"`);
  }
  const dir = manifest.controlDir;
  if (!isAbsolute(dir) || dir.split(sep).includes('..')) {
    throw new Error(`Refusing run "${slug}": its recorded controlDir "${dir}" is not an absolute path`);
  }
  const norm = resolve(dir);
  if (basename(norm) !== slug) {
    throw new Error(`Refusing run "${slug}": its recorded controlDir "${dir}" does not end in /${slug}`);
  }
  return norm;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * The launchd label an EXISTING run recorded in its RUN.json. It is used as a `launchctl` argument and in a plist file
 * name, so it must be a plain dotted identifier that ends in `.<slug>` (legacy `com.example.x.<slug>` labels and
 * `dev.nightgem.<slug>` both qualify). `slug` is the caller's {@link assertSlug}'d value.
 */
export function recordedLaunchdLabel(manifest: { slug: string; launchdLabel: string }, slug: string): string {
  if (manifest.slug !== slug) {
    throw new Error(`Refusing run "${slug}": its RUN.json records the slug "${manifest.slug}"`);
  }
  const label = manifest.launchdLabel;
  if (!LABEL_RE.test(label) || label.includes('..') || !label.endsWith(`.${slug}`)) {
    throw new Error(`Refusing run "${slug}": its recorded launchd label "${label}" is not a plain label ending in .${slug}`);
  }
  return label;
}

/** Per-run isolated `XDG_DATA_HOME` (own opencode DB). */
export function xdgDataHome(slug: string, home: string = homedir()): string {
  return join(controlDir(slug, home), 'xdg-data');
}

// --- Artifact files -----------------------------------------------------------

export interface RunPaths {
  workspaceRoot: string;
  specsDir: string;
  runDir: string;
  controlDir: string;
  xdgDataHome: string;
  /** The frozen run context (in the control dir, agent-unwritable). */
  runContextJson: string;
  /** In the run dir (orchestrator-owned). */
  runJson: string;
  costJsonl: string;
  tasksJsonl: string;
  decisionsJsonl: string;
  eventsJsonl: string;
  orchestratorLog: string;
  /** In the specs dir. */
  reportMd: string;
  statusMd: string;
  decisionsMd: string;
  planMd: string;
  specMd: string;
}

export function runPaths(slug: string, ctx: { home: string; workspaceRoot: string }): RunPaths {
  const { home, workspaceRoot } = ctx;
  const specs = specsDir(slug, workspaceRoot);
  const run = runDir(slug, workspaceRoot);
  return {
    workspaceRoot,
    specsDir: specs,
    runDir: run,
    controlDir: controlDir(slug, home),
    xdgDataHome: xdgDataHome(slug, home),
    runContextJson: join(controlDir(slug, home), 'run-context.json'),
    runJson: join(run, 'RUN.json'),
    costJsonl: join(run, 'cost.jsonl'),
    tasksJsonl: join(run, 'tasks.jsonl'),
    decisionsJsonl: join(run, 'decisions.jsonl'),
    eventsJsonl: join(run, 'events.jsonl'),
    orchestratorLog: join(run, 'orchestrator.log'),
    reportMd: join(specs, 'REPORT.md'),
    statusMd: join(specs, 'STATUS.md'),
    decisionsMd: join(specs, 'DECISIONS.md'),
    planMd: join(specs, 'PLAN.md'),
    specMd: join(specs, 'SPEC.md'),
  };
}

// --- Worktrees ----------------------------------------------------------------

/** `<repo>/.worktrees/<slug>` */
export function worktreeRoot(repoPath: string, slug: string): string {
  return join(repoPath, '.worktrees', assertSlug(slug));
}

/** `<repo>/.worktrees/<slug>/<task>` */
export function taskWorktree(repoPath: string, slug: string, task: string): string {
  return join(worktreeRoot(repoPath, slug), assertTaskId(task));
}

/** `<repo>/.worktrees/<slug>/_integration` */
export function integrationWorktree(repoPath: string, slug: string): string {
  return join(worktreeRoot(repoPath, slug), '_integration');
}

// --- Containment --------------------------------------------------------------

/**
 * Resolve symlinks for as much of `p` as exists. Missing tail segments are re-appended, and
 * dangling symlinks are followed manually, so a not-yet-created file below a symlinked
 * directory (or behind a dangling link) cannot escape.
 */
function realpathLoose(p: string, depth = 0): string {
  if (depth > 40) throw new Error(`Too many symlink levels resolving "${p}"`);
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      // Dangling symlink: realpath failed, but the link itself exists.
      return realpathLoose(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLoose(parent, depth + 1), basename(abs));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Throw unless `path` is (after resolving `..` and symlinks) inside one of `roots`.
 * Roots are resolved the same way. Returns the resolved path.
 */
export function assertWithin(path: string, roots: readonly string[]): string {
  if (roots.length === 0) throw new Error('assertWithin requires at least one allowed root');
  const target = realpathLoose(path);
  for (const root of roots) {
    if (isInside(realpathLoose(root), target)) return target;
  }
  throw new Error(`Path "${path}" (resolved: ${target}) is outside the allowed roots: ${roots.join(', ')}`);
}
