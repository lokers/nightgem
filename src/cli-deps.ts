/**
 * Dependency-injection seam for the launcher CLI.
 *
 * The state module, baseline/report/preflight and the orchestrator are separate modules. The CLI therefore
 * depends on this interface only. `src/wiring.ts` supplies the real implementations; tests use fakes.
 */
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { APP } from './brand.ts';
import type { ControlFlags, RepoEntry, RunContextSnapshot, RunManifest } from './contracts.ts';
import type { RenderRenderers } from './render.ts';
import { loadProfile, resolveProfilePath, type LoadedProfile, type ProfileEnv } from './userprofile.ts';

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shellQuote = (p: string): string => (SAFE_ARG.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** Absolute `bin/nightgem.mjs` of the checkout that contains this file (`src/cli-deps.ts`). */
export const CLI_BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', `${APP}.mjs`);

/**
 * How to run this CLI from a shell, for user-facing hints: `<node> <abs bin/nightgem.mjs>`, shell-quoted like the
 * `{{NODE}} {{BIN}}` the install renders. Absolute on purpose: `nightgem` is on the PATH only after `npm link`, and launchd
 * has no PATH, so the hints must work with or without the link.
 */
export function cliInvocation(nodePath: string = process.execPath): string {
  return `${shellQuote(nodePath)} ${shellQuote(CLI_BIN_PATH)}`;
}

/** Result of a subprocess. A non-zero exit never throws; a missing binary yields exitCode 127. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Real subprocess runner built on execa. */
export const realExec: ExecFn = async (cmd, args, opts = {}) => {
  try {
    const r = await execa(cmd, args, { reject: false, cwd: opts.cwd, env: opts.env, extendEnv: opts.env === undefined });
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 127 };
  }
};

/** One doctor/preflight finding. `hard` failures block `launch`; soft ones only warn. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  hard: boolean;
  detail: string;
}

export interface LockHandle {
  /** Release the lock. Must work from another process too: the lock outlives the CLI after a successful launch. */
  release(): Promise<void>;
}

export interface CliDeps {
  /** Home directory (tests point this at a temp dir). */
  home: string;
  /** Absolute path of the node binary launchd runs. */
  nodePath: string;
  /** Absolute path of the script launchd runs (`caffeinate -ims node <entry> --slug <slug>`). */
  orchestratorEntry: string;
  /** `providerID/modelID` recorded in RUN.json. */
  model: string;
  /** Numeric uid for `gui/$UID`. */
  uid: number;
  now(): Date;

  /**
   * Resolve the run context (workspace root, profile, skills, instructions, models, safety inputs). `launch` freezes it into
   * `controlDir/run-context.json`. The real wiring resolves it from the user profile and fails clearly when there is none.
   */
  resolveRunContext(): Promise<RunContextSnapshot>;
  /**
   * Lighter than `resolveRunContext`: only the workspace root (from the profile). `status` without a slug uses it to
   * list `<workspaceRoot>/.specs/*`, so it works even when skills or the instructions file are broken.
   */
  resolveWorkspace(): Promise<string>;
  /**
   * Freeze the snapshot into `<controlDir>/run-context.json` (mode 0600). `launch` calls it once, after the lock is taken and
   * before RUN.json is written. Exactly one writer per launch.
   */
  writeRunContext(controlDir: string, snap: RunContextSnapshot): Promise<void> | void;
  /**
   * Read the frozen run context back from `<controlDir>/run-context.json` (validated). `resume` reuses it, so a continued run
   * keeps the rules it was planned with. Rejects when the file is missing or invalid.
   * Optional only so that test fakes which never resume need not define it; `realCliDeps` always does, and `resume` refuses without it.
   */
  readRunContext?(controlDir: string): Promise<RunContextSnapshot>;
  /** The renderers `nightgem render` composes (tests fake them). The real ones: `realRenderers` from `src/render.ts`. */
  renderers: RenderRenderers;

  /** RUN.json reader. `undefined` when the run has no manifest. */
  readManifest(slug: string): Promise<RunManifest | undefined>;
  writeManifest(slug: string, manifest: RunManifest): Promise<void>;
  /** Control flags (heartbeat) from the control dir a run recorded in its manifest (never rebuilt from the slug). */
  readControlFlags(controlDir: string): Promise<ControlFlags | undefined>;

  /**
   * Clear `softStop` and `hardStop` in `<controlDir>/control.json`, leaving the heartbeat alone (a missing or unreadable file
   * becomes the defaults). `launch` of a reused slug and `resume` call it before the job starts: the orchestrator fails the
   * attempt when a stop flag of an earlier process is still set. Optional like `readRunContext`: `resume` refuses without it.
   */
  resetStopFlags?(controlDir: string): Promise<void> | void;

  /** Take the single-run lock (A5). Throws if held. */
  acquireLock(slug: string): Promise<LockHandle>;
  /** Force-release the lock held for `slug` (stale lock after `stop`). */
  releaseLock(slug: string): Promise<void>;
  lockIsFree(): Promise<boolean>;

  /** Git baseline (head, branch, porcelain hash, stash count) for each repo path. */
  buildBaseline(repoPaths: string[]): Promise<RepoEntry[]>;
  /** Deterministic REPORT.md generator. Resolves to the report path. */
  writeReport(slug: string): Promise<string>;
  /** Optional rule check (profile preflight) run as part of `doctor`. */
  preflight?(): Promise<DoctorCheck[]>;
}

/** How the CLI reaches the user profile. `realProfileAccess` is the default; the profile commands never go through the run context. */
export interface ProfileAccess {
  /** The profile path in effect (`NIGHTGEM_PROFILE` or the default location). Exists or not. */
  path(): string;
  /** @throws ProfileError `missing` | `invalid-json` | `invalid-schema` | `invalid-workspace` */
  load(): LoadedProfile;
}

export function realProfileAccess(home: string, env: ProfileEnv): ProfileAccess {
  const path = () => resolveProfilePath({ home, env });
  return { path, load: () => loadProfile({ path: path(), home, env, fs: nodeFs }) };
}
