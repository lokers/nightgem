/**
 * Small read-only git helpers used by the report generator (and reusable for baselines).
 *
 * Every helper takes an injectable `GitRunner` (default: `runGitSafe`, the hardened runner of `gitsafe.ts`) so tests
 * never need a real repository. A runner resolves with stdout and rejects on a non-zero exit.
 * Only `remoteHasBranch` / `checkRemoteBranch` swallow errors (by contract, yielding `unknown`); the others throw, and callers decide
 * how to render "unknown".
 */
import { createHash } from 'node:crypto';

import { runGitSafe } from './gitsafe.ts';

export type GitRunner = (args: readonly string[], opts: { cwd: string; timeoutMs?: number }) => Promise<string>;

export const defaultGit: GitRunner = async (args, opts) => {
  // Hardened (see gitsafe.ts): a program planted in the repo's config or attributes never runs.
  const result = await runGitSafe(args, {
    cwd: opts.cwd,
    env: process.env,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return result.stdout;
};

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/** `git log --oneline <base>..HEAD` as one string per commit (newest first). */
export async function commitsBetween(worktree: string, base: string, git: GitRunner = defaultGit): Promise<string[]> {
  return lines(await git(['log', '--oneline', `${base}..HEAD`], { cwd: worktree }));
}

/**
 * The patch of `<base>...HEAD` with no context lines (`-U0`), as the suppression scan reads it. Renames are detected
 * explicitly so a moved test file is not read as a deleted one. Throws on a git failure.
 */
export async function diffBetween(worktree: string, base: string, git: GitRunner = defaultGit): Promise<string> {
  return git(['diff', '-U0', '-M', '--no-color', `${base}...HEAD`], { cwd: worktree });
}

/** Current branch name (`HEAD` when detached). */
export async function currentBranch(repo: string, git: GitRunner = defaultGit): Promise<string> {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).trim();
}

export async function headSha(repo: string, git: GitRunner = defaultGit): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();
}

/** sha256 (hex) of the raw `git status --porcelain` output. Empty status hashes the empty string. */
export async function porcelainHash(repo: string, git: GitRunner = defaultGit): Promise<string> {
  const out = await git(['status', '--porcelain'], { cwd: repo });
  return createHash('sha256').update(out).digest('hex');
}

export async function stashCount(repo: string, git: GitRunner = defaultGit): Promise<number> {
  return lines(await git(['stash', 'list'], { cwd: repo })).length;
}

/** Answer of a remote branch check: `unknown` = no origin, an `ls-remote` error or a timeout. */
export type RemoteBranchState = 'yes' | 'no' | 'unknown';

export interface RemoteBranchCheck {
  state: RemoteBranchState;
  /** Why the state is `unknown` (first line of the git error). */
  reason?: string;
}

/** Network calls must not hang the report. */
export const LS_REMOTE_TIMEOUT_MS = 30_000;

/**
 * Check whether `origin` advertises `refs/heads/<branch>`. Never throws: no origin, an `ls-remote`
 * error or a timeout yields `unknown` with a reason, so callers can tell "not pushed" from "could not check".
 */
export async function checkRemoteBranch(repo: string, branch: string, git: GitRunner = defaultGit): Promise<RemoteBranchCheck> {
  try {
    const out = await git(['ls-remote', '--heads', 'origin', branch], { cwd: repo, timeoutMs: LS_REMOTE_TIMEOUT_MS });
    // ls-remote patterns match as a suffix (`feat/x` also matches `refs/heads/a/feat/x`), so compare exactly.
    return { state: lines(out).some((l) => l.split(/\s+/)[1] === `refs/heads/${branch}`) ? 'yes' : 'no' };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { state: 'unknown', reason: m.split('\n')[0] ?? m };
  }
}

/** Tri-state: `yes` (pushed), `no`, or `unknown` (no origin, `ls-remote` failed or timed out). Never throws. */
export async function remoteHasBranch(repo: string, branch: string, git: GitRunner = defaultGit): Promise<RemoteBranchState> {
  return (await checkRemoteBranch(repo, branch, git)).state;
}
