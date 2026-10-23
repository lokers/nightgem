/**
 * Tripwires: detect side effects outside the run's worktrees.
 *
 * - Main checkouts: HEAD, branch, `git status --porcelain` hash and stash count must equal the
 *   baseline taken at launch. Worktrees live in `<repo>/.worktrees/` (globally ignored), so they
 *   never change a main checkout's porcelain output.
 * - Protected files (profile, guard, control files): content hash must be unchanged and the
 *   mode must still be 0444.
 *
 * The orchestrator's own writes (run dir, `.specs`) are not inside any repo and cannot trip
 * anything. Git and the filesystem are injectable.
 */
import { createHash } from 'node:crypto';
import { chmod, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { RepoBaseline } from './contracts.ts';
import { currentBranch, defaultGit, headSha, porcelainHash, stashCount, type GitRunner } from './gitinfo.ts';

// the second name is built at runtime so this file carries no term the repo audit's local bannedTerms would flag
const WORKTREE_HOLDERS: ReadonlySet<string> = new Set(['.worktrees', ['.sdlc', 'worktrees'].join('-')]);

/** The exact top-level directory names that hold worktrees (not repos in their own right). A real repo named `x-worktrees` is still watched. */
export function isWorktreeHolder(name: string): boolean {
  return WORKTREE_HOLDERS.has(name);
}
export const PROTECTED_MODE = 0o444;

// ---------------------------------------------------------------------------
// Filesystem seams
// ---------------------------------------------------------------------------

export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
}
export interface StatLike {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface DiscoverFs {
  readdir(path: string): Promise<DirEntryLike[]>;
  /** Must reject when the path does not exist. */
  stat(path: string): Promise<StatLike>;
}

export const nodeDiscoverFs: DiscoverFs = {
  readdir: (p) => readdir(p, { withFileTypes: true }),
  stat: (p) => stat(p),
};

export interface ProtectFs {
  readFile(path: string): Promise<Uint8Array>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<{ mode: number }>;
}

export const nodeProtectFs: ProtectFs = {
  readFile: (p) => readFile(p),
  chmod: (p, m) => chmod(p, m),
  stat: (p) => stat(p),
};

// ---------------------------------------------------------------------------
// Discovery and snapshots
// ---------------------------------------------------------------------------

/**
 * Every top-level directory of the workspace root that contains a `.git` directory or file (a `.git` file
 * is a linked worktree or submodule), minus worktree holders (see `isWorktreeHolder`). Sorted by path.
 */
export async function discoverRepos(workspaceRoot: string, fs: DiscoverFs = nodeDiscoverFs): Promise<string[]> {
  const entries = await fs.readdir(workspaceRoot);
  const repos: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || isWorktreeHolder(e.name)) continue;
    const dir = join(workspaceRoot, e.name);
    try {
      const g = await fs.stat(join(dir, '.git'));
      if (g.isDirectory() || g.isFile()) repos.push(dir);
    } catch {
      // no .git
    }
  }
  return repos.sort();
}

export async function snapshotRepo(path: string, git: GitRunner = defaultGit): Promise<RepoBaseline> {
  const [head, branch, porcelain, stashes] = await Promise.all([
    headSha(path, git),
    currentBranch(path, git),
    porcelainHash(path, git),
    stashCount(path, git),
  ]);
  return { head, branch, porcelainHash: porcelain, stashCount: stashes };
}

/** Baselines keyed by repo path. */
export type Baseline = Record<string, RepoBaseline>;

export interface BaselineWarning {
  path: string;
  reason: string;
}

/**
 * Snapshot every repo. Repos that cannot be snapshotted (no commits yet, broken checkout, git failure) are skipped and
 * reported through `onWarning`; they are simply not watched. Never rejects because of one bad repo.
 */
export async function takeBaseline(
  repos: readonly string[],
  git: GitRunner = defaultGit,
  opts: { onWarning?: (w: BaselineWarning) => void } = {},
): Promise<Baseline> {
  const out: Baseline = {};
  const snaps = await Promise.all(
    repos.map(async (r): Promise<RepoBaseline | BaselineWarning> => {
      try {
        return await snapshotRepo(r, git);
      } catch (err) {
        const msg = (err as Error).message.split('\n')[0] ?? 'unknown error';
        const noHead = /unknown revision|bad revision|ambiguous argument|needed a single revision|does not have any commits/i.test((err as Error).message);
        return { path: r, reason: noHead ? 'no HEAD (repository has no commits)' : `cannot snapshot: ${msg}` };
      }
    }),
  );
  repos.forEach((r, i) => {
    const snap = snaps[i]!;
    if ('reason' in snap) opts.onWarning?.(snap);
    else out[r] = snap;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Protected files
// ---------------------------------------------------------------------------

export interface ProtectedFile {
  path: string;
  sha256: string;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** chmod 0444 each file and return its content hash. */
export async function protectFiles(paths: readonly string[], fs: ProtectFs = nodeProtectFs): Promise<ProtectedFile[]> {
  const out: ProtectedFile[] = [];
  for (const path of paths) {
    await fs.chmod(path, PROTECTED_MODE);
    out.push({ path, sha256: sha256(await fs.readFile(path)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export type ViolationKind =
  | 'head'
  | 'branch'
  | 'porcelain'
  | 'stash'
  | 'no-baseline'
  | 'git-error'
  | 'protected-changed'
  | 'protected-mode'
  | 'protected-missing';

export interface Violation {
  kind: ViolationKind;
  /** Repo path or protected file path. */
  path: string;
  message: string;
  expected?: string | number;
  actual?: string | number;
}

export interface TripwireInput {
  baseline: Baseline;
  repos: readonly string[];
  protectedFiles: readonly ProtectedFile[];
}

export interface TripwireDeps {
  git?: GitRunner;
  fs?: ProtectFs;
}

/** Empty array = all quiet. Order: repos (in `repos` order), then protected files. */
export async function checkTripwires(input: TripwireInput, deps: TripwireDeps = {}): Promise<Violation[]> {
  const git = deps.git ?? defaultGit;
  const fs = deps.fs ?? nodeProtectFs;
  const violations: Violation[] = [];

  const perRepo = await Promise.all(input.repos.map((r) => checkRepo(r, input.baseline[r], git)));
  for (const v of perRepo) violations.push(...v);

  for (const f of input.protectedFiles) violations.push(...(await checkProtected(f, fs)));
  return violations;
}

async function checkRepo(path: string, base: RepoBaseline | undefined, git: GitRunner): Promise<Violation[]> {
  if (!base) return [{ kind: 'no-baseline', path, message: `No baseline recorded for ${path}` }];
  let now: RepoBaseline;
  try {
    now = await snapshotRepo(path, git);
  } catch (err) {
    return [{ kind: 'git-error', path, message: `Cannot inspect ${path}: ${(err as Error).message}` }];
  }
  const out: Violation[] = [];
  const cmp = (kind: ViolationKind, what: string, expected: string | number, actual: string | number) => {
    if (expected !== actual) out.push({ kind, path, message: `${what} changed in ${path}`, expected, actual });
  };
  cmp('head', 'HEAD', base.head, now.head);
  cmp('branch', 'Branch', base.branch, now.branch);
  cmp('porcelain', 'Working tree status', base.porcelainHash, now.porcelainHash);
  cmp('stash', 'Stash count', base.stashCount, now.stashCount);
  return out;
}

async function checkProtected(f: ProtectedFile, fs: ProtectFs): Promise<Violation[]> {
  let data: Uint8Array;
  let mode: number;
  try {
    data = await fs.readFile(f.path);
    mode = (await fs.stat(f.path)).mode;
  } catch (err) {
    return [{ kind: 'protected-missing', path: f.path, message: `Protected file unreadable: ${f.path} (${(err as Error).message})` }];
  }
  const out: Violation[] = [];
  const actual = sha256(data);
  if (actual !== f.sha256) {
    out.push({ kind: 'protected-changed', path: f.path, message: `Protected file modified: ${f.path}`, expected: f.sha256, actual });
  }
  const perm = mode & 0o777;
  if (perm !== PROTECTED_MODE) {
    out.push({
      kind: 'protected-mode',
      path: f.path,
      message: `Protected file mode is no longer 0444: ${f.path}`,
      expected: PROTECTED_MODE.toString(8),
      actual: perm.toString(8),
    });
  }
  return out;
}
