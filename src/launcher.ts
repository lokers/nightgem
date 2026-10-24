/**
 * Launcher: `launch`, `stop`, `status`, `report`.
 *
 * `launch` detaches the orchestrator through a generated launchd plist. All state-module, baseline
 * and report functionality is injected via `CliDeps`; subprocesses via `ExecFn`.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cliInvocation, type CliDeps, type ExecFn, type ExecResult, type LockHandle } from './cli-deps.ts';
import { attemptsOf, isNeverStartedFailure, isTerminalRunState, RUN_MANIFEST_VERSION, RunContextSnapshot, RunManifest, TaskEvent, type RepoEntry } from './contracts.ts';
import { doctor, formatDoctor, formatWarning, hardFailures, type DoctorFs, type DoctorOptions } from './doctor.ts';
import { assertSlug, isValidSlug, recordedControlDir, recordedLaunchdLabel, runPaths, type RunPaths } from './paths.ts';
import { buildJobEnv, buildProgramArgs, launchdLabel, renderPlist } from './plist.ts';
import {
  buildResumeManifest,
  buildRollbackManifest,
  checkResumeEligibility,
  checkWorktrees,
  closeLastAttempt,
  formatWorktreeProblems,
  hasOpenAttempt,
  inspectWorktreeFs,
  isResumableState,
  parseResumeBudget,
  RESUME_FAILED,
  STOPPED_AFTER_CRASH,
  type ResumeEligibility,
} from './resume.ts';
import { loadSpec, type SpecMeta } from './specmeta.ts';
import { readJsonl, StateError } from './state.ts';

/** The frozen run context in the (agent-unwritable) control dir. */

/**
 * Resolve the run context without throwing, so the doctor can report a missing or broken profile as a finding instead of
 * crashing: `{ runContext }` or `{ runContextError }` (always an `Error`).
 */
export async function settleRunContext(deps: Pick<CliDeps, 'resolveRunContext'>): Promise<{ runContext: RunContextSnapshot } | { runContextError: Error }> {
  return deps.resolveRunContext().then(
    (runContext) => ({ runContext }),
    (e: unknown) => ({ runContextError: e instanceof Error ? e : new Error(String(e)) }),
  );
}

export interface LauncherIo {
  out: (line: string) => void;
  /** Diagnostics (default: stderr). */
  err?: (line: string) => void;
}

const defaultIo: LauncherIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

export interface BuildLaunchManifestInput {
  slug: string;
  budgetUsd: number;
  costMultiplier: number;
  softPct?: number | undefined;
  context: RunContextSnapshot;
  label: string;
  paths: Pick<RunPaths, 'controlDir' | 'runDir' | 'xdgDataHome'>;
  model: string;
  repos: RepoEntry[];
  pid: number;
  createdAt: string;
}

/**
 * The v2 RUN.json `launch` writes: state `launching`, plus the summary of the context snapshot (profile path + hash, skills,
 * instructions hash). Pure; `render` builds its `manifest-preview.json` with it, so the two cannot drift.
 */
export function buildLaunchManifest(i: BuildLaunchManifestInput): RunManifest {
  const { context } = i;
  return RunManifest.parse({
    schemaVersion: RUN_MANIFEST_VERSION,
    workspaceRoot: context.workspaceRoot,
    profile: { path: context.profile.path, sha256: context.profile.sha256 },
    skills: { available: context.skills.available, excluded: context.skills.excluded, required: context.profile.data.skills.required },
    instructions: { ...(context.instructions.path ? { path: context.instructions.path } : {}), sha256: context.instructions.sha256 },
    slug: i.slug,
    budgetUsd: i.budgetUsd,
    costMultiplier: i.costMultiplier,
    ...(i.softPct === undefined ? {} : { softPct: i.softPct }),
    state: 'launching',
    phase: 'plan',
    // the CLI's pid: the orchestrator recognises the lock holder as this run during the launchd handoff
    pid: i.pid,
    launchdLabel: i.label,
    controlDir: i.paths.controlDir,
    runDir: i.paths.runDir,
    xdgDataHome: i.paths.xdgDataHome,
    model: i.model,
    repos: i.repos,
    createdAt: i.createdAt,
  });
}

const realFs: DoctorFs = {
  exists: (p) => existsSync(p),
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

export interface LaunchInput {
  slug: string;
  budgetUsd: number;
  repos?: string[];
  costMultiplier?: number;
  /** Testing only: fraction of the budget that starts the wind-down (0.1-0.95). Default: the contract default (0.85). */
  softPct?: number;
  deps: CliDeps;
  exec: ExecFn;
  fs?: DoctorFs;
  io?: LauncherIo;
  /** Parent environment to filter the job env from. Default `process.env`. */
  parentEnv?: Record<string, string | undefined>;
}

export interface LaunchResult {
  label: string;
  plistPath: string;
  manifest: RunManifest;
}

async function resolveBin(exec: ExecFn, name: string): Promise<string> {
  const r = await exec('/bin/sh', ['-c', `command -v ${name}`]);
  const path = r.stdout.trim().split('\n')[0] ?? '';
  if (r.exitCode !== 0 || !path.startsWith('/')) throw new Error(`Cannot resolve an absolute path for "${name}"`);
  return path;
}

/** The PATH a launched job would get, for the standalone `doctor` toolchain check (same fallbacks as `launch`). */
export async function resolveJobPath(exec: ExecFn, deps: Pick<CliDeps, 'home' | 'nodePath'>): Promise<string> {
  const opencodePath = await resolveBin(exec, 'opencode').catch(() => '/opt/homebrew/bin/opencode');
  const gitPath = await resolveBin(exec, 'git').catch(() => '/usr/bin/git');
  return buildJobEnv({ parentEnv: {}, home: deps.home, nodePath: deps.nodePath, opencodePath, gitPath }).PATH ?? '';
}

function domain(uid: number): string {
  return `gui/${uid}`;
}

/**
 * `launchctl print` succeeds when the job is loaded; `running` when it has a live pid. A failure only means "not loaded" when
 * launchctl says it cannot find the service (exit 113, or that wording); any other failure (no launchctl, a permission or
 * domain error) is `unknown`, and callers that act on the answer must refuse rather than guess.
 */
async function jobState(exec: ExecFn, uid: number, label: string): Promise<{ loaded: boolean; running: boolean; unknown: boolean; detail: string }> {
  const r = await exec('launchctl', ['print', `${domain(uid)}/${label}`]);
  if (r.exitCode === 0) return { loaded: true, running: /state = running/.test(r.stdout), unknown: false, detail: '' };
  const text = (r.stderr || r.stdout).trim();
  const notFound = r.exitCode === 113 || /could not find|not found|no such (service|process)/i.test(text);
  return { loaded: false, running: false, unknown: !notFound, detail: `launchctl print exit ${r.exitCode}${text ? `: ${text.split('\n')[0]}` : ''}` };
}

export interface LaunchGatesInput {
  slug: string;
  /** `--repos` override for the spec's repo list. */
  repos?: string[] | undefined;
  deps: CliDeps;
  exec: ExecFn;
  fs?: DoctorFs | undefined;
  io?: LauncherIo | undefined;
  /** Parent environment to filter the job env from. Default `process.env`. */
  parentEnv?: Record<string, string | undefined> | undefined;
  /** Reuse an already frozen run context (resume) instead of resolving a fresh one. It is still schema-validated. */
  runContext?: RunContextSnapshot | undefined;
  /**
   * Runs right after the run context and spec are loaded and before the doctor, for a caller-specific check that must keep
   * its place in the order (`launch` refuses an existing slug here; `resume` needs the opposite check).
   */
  afterLoad?: ((loaded: { runContext: RunContextSnapshot; spec: SpecMeta; paths: RunPaths }) => Promise<void> | void) | undefined;
}

export interface LaunchGates {
  runContext: RunContextSnapshot;
  spec: SpecMeta;
  label: string;
  paths: RunPaths;
  opencodePath: string;
  gitPath: string;
  /** The doctor's non-fatal findings, formatted. Already printed through `io.out`. */
  warnings: string[];
}

/**
 * Everything that must hold before a job may start, shared by `launch` and `resume`: the run context and spec, the doctor
 * (binaries on the job PATH, AC power, free lock, remote credentials, preflight, ...), the resolved `opencode` / `git` paths
 * and "launchd job not already loaded". Throws on the first failure. Creates nothing: no baseline, no dirs, no lock, no
 * manifest, no bootstrap; those stay with the caller.
 */
export async function runLaunchGates(input: LaunchGatesInput): Promise<LaunchGates> {
  const { deps, exec } = input;
  const io = input.io ?? defaultIo;
  const fs = input.fs ?? realFs;
  const slug = assertSlug(input.slug);

  // 1. Run context (workspace root, profile, models, safety inputs) and spec.
  // validated before anything is created: a context the orchestrator could not read back must not launch
  const runContext = RunContextSnapshot.parse(input.runContext ?? (await deps.resolveRunContext()));
  const { workspaceRoot } = runContext;
  const keyPattern = runContext.profile.data.tracker.keyPattern;
  const spec = loadSpec(slug, { home: deps.home, workspaceRoot, repoOverride: input.repos, ...(keyPattern === undefined ? {} : { keyPattern: new RegExp(keyPattern) }) });
  const paths = runPaths(slug, { home: deps.home, workspaceRoot });

  await input.afterLoad?.({ runContext, spec, paths });

  // 2. Doctor: any hard failure aborts. The verify tools are looked up on the PATH the JOB will get, not ours.
  const opencodeResolved = await resolveBin(exec, 'opencode').then((p) => ({ path: p }), (error: unknown) => ({ error }));
  const gitResolved = await resolveBin(exec, 'git').then((p) => ({ path: p }), (error: unknown) => ({ error }));
  const jobEnv = buildJobEnv({
    parentEnv: input.parentEnv ?? process.env,
    home: deps.home,
    nodePath: deps.nodePath,
    opencodePath: 'path' in opencodeResolved ? opencodeResolved.path : '/opt/homebrew/bin/opencode',
    gitPath: 'path' in gitResolved ? gitResolved.path : '/usr/bin/git',
  });
  const doctorOptions: DoctorOptions = {
    exec,
    fs,
    nodePath: deps.nodePath,
    workspaceRoot,
    runContext,
    lockIsFree: () => deps.lockIsFree(),
    specRepos: spec.repos,
    jobPath: jobEnv.PATH ?? '',
    repoTools: runContext.profile.data.repos,
    preflight: deps.preflight ? () => deps.preflight!() : undefined,
  };
  const report = await doctor(doctorOptions);
  const hard = hardFailures(report);
  if (hard.length > 0) {
    throw new Error(`doctor reported hard failures, not launching:\n${formatDoctor({ checks: hard })}`);
  }
  const warnings: string[] = [];
  for (const c of report.checks) {
    if (c.ok) continue;
    const line = formatWarning(c);
    warnings.push(line);
    io.out(line);
  }

  if ('error' in opencodeResolved) throw opencodeResolved.error;
  if ('error' in gitResolved) throw gitResolved.error;
  const label = launchdLabel(slug);

  const existing = await jobState(exec, deps.uid, label);
  if (existing.unknown) throw new Error(`Cannot tell whether the launchd job ${label} is already loaded (${existing.detail}); not launching.`);
  if (existing.loaded) {
    throw new Error(`launchd job ${label} is already loaded. Run "${cliInvocation(deps.nodePath)} stop ${slug}" first.`);
  }
  return { runContext, spec, label, paths, opencodePath: opencodeResolved.path, gitPath: gitResolved.path, warnings };
}

export async function launch(input: LaunchInput): Promise<LaunchResult> {
  const { deps, exec } = input;
  const io = input.io ?? defaultIo;
  // first thing: a slug that is not kebab-case (or looks like a push/gh/ssh command, see paths.ts) is a clear error
  const slug = assertSlug(input.slug);
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) {
    throw new Error(`Invalid budget "${input.budgetUsd}" (expected a positive USD amount)`);
  }
  const costMultiplier = input.costMultiplier ?? 1;
  if (!Number.isFinite(costMultiplier) || costMultiplier <= 0) {
    throw new Error(`Invalid cost multiplier "${costMultiplier}" (expected a positive number)`);
  }
  if (input.softPct !== undefined && !(Number.isFinite(input.softPct) && input.softPct >= 0.1 && input.softPct <= 0.95)) {
    throw new Error(`Invalid soft threshold "${input.softPct}" (expected a fraction between 0.1 and 0.95)`);
  }

  const { runContext, spec, label, paths, opencodePath, gitPath } = await runLaunchGates({
    slug,
    repos: input.repos,
    deps,
    exec,
    fs: input.fs,
    io,
    parentEnv: input.parentEnv,
    // 1b. A slug that already has a run is never relaunched: that would overwrite its RUN.json (and its history).
    afterLoad: async ({ paths: existing }) => {
      let existingManifest: RunManifest | undefined;
      try {
        existingManifest = await deps.readManifest(slug);
      } catch {
        // unreadable or invalid: still a run that is on disk, refused below
      }
      // the one exception: a launch that failed before the run ever started holds no history, so the slug can be retried
      const retryable = existingManifest !== undefined && isNeverStartedFailure(existingManifest);
      if (!retryable && (existingManifest !== undefined || existsSync(existing.runJson) || existsSync(join(existing.specsDir, 'RUN.json')))) {
        const cli = cliInvocation(deps.nodePath);
        const state = existingManifest?.state;
        const resumable = state === 'stopped' || state === 'aborted-budget' || state === 'failed' || state === 'stalled';
        const next = resumable
          ? `To continue it, run "${cli} resume ${slug} --budget <usd>", or launch under a new slug.`
          : state === undefined || state === 'completed'
            ? `Launch under a new slug${state === undefined ? ' (or inspect it with "status")' : ''}.`
            : `It is still active: check it with "${cli} status ${slug}" or stop it with "${cli} stop ${slug}", or launch under a new slug.`;
        throw new Error(`Run "${slug}" already exists${state === undefined ? '' : ` (state: ${state})`}; launch will not overwrite its RUN.json. ${next}`);
      }
    },
  });

  // 3. Git baseline per repo.
  const repos = await deps.buildBaseline(spec.repos.map((r) => r.path));

  // 4. Control dir (0700) and run dir (launchd WorkingDirectory).
  mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.controlDir, 0o700);
  mkdirSync(paths.runDir, { recursive: true });
  // 5. Lock. From here on every failure releases it.
  const lock = await deps.acquireLock(slug);
  let manifest: RunManifest | undefined;
  try {
    // 6. The frozen run context, then RUN.json (v2) in state `launching`. The orchestrator never re-resolves the profile:
    // it reads only this snapshot, which the agent cannot write (control dir). One writer per launch.
    await deps.writeRunContext(paths.controlDir, runContext);
    // A control dir left by an earlier run of the same slug (a launch that failed before it started) may still carry its stop
    // flags, and the orchestrator fails the attempt on a stale one: clear them, and nothing else. Its stale `xdg-data` stays,
    // so the ledger can over-count the cost of the new run, which is the safe direction.
    await deps.resetStopFlags(paths.controlDir);
    manifest = buildLaunchManifest({
      slug,
      budgetUsd: input.budgetUsd,
      costMultiplier,
      softPct: input.softPct,
      context: runContext,
      label,
      paths,
      model: runContext.model,
      repos,
      pid: process.pid,
      createdAt: deps.now().toISOString(),
    });
    await deps.writeManifest(slug, manifest);

    // 7. Plist in the control dir.
    const plistPath = join(paths.controlDir, `${label}.plist`);
    const plist = renderPlist({
      label,
      programArgs: buildProgramArgs({ nodePath: deps.nodePath, orchestratorEntry: deps.orchestratorEntry, slug }),
      env: buildJobEnv({
        parentEnv: input.parentEnv ?? process.env,
        home: deps.home,
        nodePath: deps.nodePath,
        opencodePath,
        gitPath,
      }),
      stdout: join(paths.controlDir, 'launchd.out.log'),
      stderr: join(paths.controlDir, 'launchd.err.log'),
      workingDir: paths.runDir,
    });
    writeFileSync(plistPath, plist, { mode: 0o600 });
    chmodSync(plistPath, 0o600);

    // 8. Bootstrap.
    const boot = await exec('launchctl', ['bootstrap', domain(deps.uid), plistPath]);
    if (boot.exitCode !== 0) {
      throw new Error(`launchctl bootstrap failed (exit ${boot.exitCode}): ${(boot.stderr || boot.stdout).trim()}`);
    }

    // 9. Tell the user.
    io.out(`Launched ${slug} (${label})`);
    io.out(`  log:    ${paths.orchestratorLog}`);
    io.out(`  status: ${cliInvocation(deps.nodePath)} status ${slug}`);
    io.out(`  report: ${paths.reportMd}`);
    return { label, plistPath, manifest };
  } catch (err) {
    if (manifest) {
      try {
        await deps.writeManifest(slug, {
          ...manifest,
          state: 'failed',
          endedAt: deps.now().toISOString(),
          stopReason: `launch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // best effort; the original error matters more
      }
    }
    await lock.release();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

export interface ResumeInput {
  slug: string;
  /** The extra budget of the new attempt, in USD. Required: there is no default. */
  budgetUsd: number;
  deps: CliDeps;
  exec: ExecFn;
  fs?: DoctorFs;
  io?: LauncherIo;
  /** Parent environment to filter the job env from. Default `process.env`. */
  parentEnv?: Record<string, string | undefined>;
  /** Pid recorded in the manifest and the lock. Default `process.pid`. */
  pid?: number;
  /** Testing: wait between the polls after a `launchctl bootout`. Default: real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a booted-out job to disappear. Default 10 s. */
  bootoutWaitMs?: number;
  /** Testing: a millisecond clock for the settle wait after the lock. Default `Date.now`. */
  clock?: () => number;
}

/**
 * The previous orchestrator detaches `sleep 2; launchctl bootout <label>` after it releases the lock. When the job was loaded,
 * or the run ended only moments ago, a new job must not be bootstrapped before that has fired: wait until this long after we
 * took the lock, then look again.
 */
export const RESUME_SETTLE_MS = 5_000;
/** A run that ended less recently than this has no delayed bootout left in flight. */
export const RECENT_END_MS = 30_000;

export interface ResumeResult extends LaunchResult {
  attempt: number;
}

const nodeFs = {
  exists: (p: string): boolean => existsSync(p),
  readText: (p: string): string | undefined => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** Turn a lock failure into a refusal that says what to do about it. */
function lockRefusal(err: unknown, slug: string, cli: string): Error {
  if (err instanceof StateError && err.code === 'lock-held') {
    if (err.pid !== undefined) {
      return new Error(
        `Another process (pid ${err.pid}) holds the run lock, so "${slug}" is not resumed. If it is a run, check it with "${cli} status" ` +
          `and wait for it or stop it ("${cli} stop <slug>"); if it is a stuck process, end it and try again.`,
      );
    }
    return new Error('The run lock file is being written by another process, or is unreadable and younger than 5 s. Try again in a few seconds; an unreadable lock older than that is taken over.');
  }
  return new Error(`Cannot take the run lock: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * `resume`: continue a stopped, over-budget, failed or stalled run as a new attempt with `--budget` extra to spend.
 *
 * Order, so that nothing is written before every check has passed and no attempt is ever left open:
 *  1. eligibility from RUN.json (no side effects), the frozen run context, the worktree check;
 *  2. the run lock (a dead holder is taken over, a live one refused), then eligibility again (a racing resume may have won);
 *  3. a running launchd job is refused, a loaded one that is not running is booted out and checked again;
 *  4. the shared gates (doctor, remotes, preflight, ...) on the FROZEN run context, and the tripwire baseline;
 *  5. one manifest write (state `launching`, a new open attempt), the stop flags reset, the plist, the bootstrap;
 *  6. any failure after the manifest write restores the previous manifest and closes the new attempt as `failed`.
 * The lock stays with the CLI pid on success; the orchestrator takes it over (same handoff as `launch`).
 */
export async function resume(input: ResumeInput): Promise<ResumeResult> {
  const { deps, exec } = input;
  const io = input.io ?? defaultIo;
  const slug = assertSlug(input.slug);
  const budgetUsd = parseResumeBudget(input.budgetUsd);
  const cli = cliInvocation(deps.nodePath);
  const pid = input.pid ?? process.pid;

  const readEligible = async (): Promise<Extract<ResumeEligibility, { ok: true }>> => {
    let manifest: RunManifest | undefined;
    try {
      manifest = await deps.readManifest(slug);
    } catch (e) {
      throw new Error(`Run "${slug}" has a RUN.json that cannot be read, so it cannot be resumed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
    const eligible = checkResumeEligibility({ slug, manifest, cli });
    if (!eligible.ok) throw new Error(eligible.message);
    return eligible;
  };

  // 1. nothing is written or touched yet
  let eligible = await readEligible();
  const { readRunContext, resetStopFlags } = deps;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const clock = input.clock ?? Date.now;
  const waitMs = input.bootoutWaitMs ?? 10_000;
  const manifest0 = eligible.manifest;
  let runContext: RunContextSnapshot;
  try {
    runContext = RunContextSnapshot.parse(await readRunContext.call(deps, eligible.controlDir));
  } catch (e) {
    throw new Error(`Cannot resume "${slug}": its frozen run context cannot be read (${e instanceof Error ? e.message.split('\n')[0] : String(e)}).`);
  }
  if (runContext.workspaceRoot !== manifest0.workspaceRoot) {
    throw new Error(`Cannot resume "${slug}": its frozen run context is for the workspace ${runContext.workspaceRoot}, but RUN.json records ${manifest0.workspaceRoot}.`);
  }
  const paths = runPaths(slug, { home: deps.home, workspaceRoot: manifest0.workspaceRoot });
  const events = readJsonl(paths.tasksJsonl, TaskEvent).items;
  const problems = await checkWorktrees({ slug, repos: manifest0.repos, events, inspect: (p) => inspectWorktreeFs(p, nodeFs) });
  if (problems.length > 0) throw new Error(formatWorktreeProblems(slug, problems));

  // 2. the lock
  let lock: LockHandle;
  try {
    lock = await deps.acquireLock(slug);
  } catch (e) {
    throw lockRefusal(e, slug, cli);
  }
  const lockedAt = clock();
  const label = eligible.label;

  const readJob = async (): Promise<{ loaded: boolean; running: boolean }> => {
    const j = await jobState(exec, deps.uid, label);
    if (j.unknown) throw new Error(`Cannot tell whether the launchd job ${label} is loaded (${j.detail}); not resuming.`);
    return j;
  };
  /** Boot the job out and poll until launchd has forgotten it (it goes a few seconds after the call). */
  const bootoutAndWait = async (): Promise<{ loaded: boolean; running: boolean; exitCode: number; detail: string }> => {
    const r = await bootout(exec, deps.uid, label);
    let waited = 0;
    let after = await readJob();
    while (after.loaded && !after.running && waited < waitMs) {
      await sleep(500);
      waited += 500;
      after = await readJob();
    }
    return { ...after, exitCode: r.exitCode, detail: (r.stderr || r.stdout).trim() };
  };

  const attemptResume = async (): Promise<{ plistPath: string; next: RunManifest; attempt: number; run: RunManifest }> => {
    eligible = await readEligible(); // a resume that raced us may have written already (the state is then `launching`)

    // 3. the job: a running one is never touched; a stale one must be gone before the new one is bootstrapped
    const job = await readJob();
    if (job.running) {
      throw new Error(
        `The launchd job ${label} is running although RUN.json says the run is ${eligible.manifest.state}. Check it with "${cli} status ${slug}" and stop it with "${cli} stop ${slug}" first. ` +
          'If the run just finished, wait a few seconds and retry.',
      );
    }
    const wasLoaded = job.loaded;
    if (job.loaded) {
      const after = await bootoutAndWait();
      if (after.running) throw new Error(`The launchd job ${label} started running again; not resuming. Check it with "${cli} status ${slug}".`);
      if (after.loaded) {
        throw new Error(`The stale launchd job ${label} is still loaded after bootout${after.exitCode === 0 ? '' : ` (exit ${after.exitCode}: ${after.detail})`}. Run "launchctl bootout gui/${deps.uid}/${label}" and try again.`);
      }
      io.out(`Booted out the stale launchd job ${label}.`);
    }

    // 4. the shared gates, on the frozen context. We hold the lock ourselves, so the doctor's "lock is free" check is moot.
    const run = eligible.manifest;
    // RUN.json also records every other checkout in the workspace (for the tripwires) with defaultBranch '-'.
    // Only the run's spec repos are passed on, or every workspace repo would become a spec repo on resume.
    const specRepos = run.repos.filter((r) => r.defaultBranch !== '-');
    const gates = await runLaunchGates({
      slug,
      repos: specRepos.length > 0 ? specRepos.map((r) => r.path) : undefined,
      deps: { ...deps, lockIsFree: async () => true },
      exec,
      fs: input.fs,
      io,
      parentEnv: input.parentEnv,
      runContext,
    });
    const repos = await deps.buildBaseline(gates.spec.repos.map((r) => r.path));

    // The old orchestrator's delayed bootout (see RESUME_SETTLE_MS) must have fired before we bootstrap, or it boots us out.
    const endedMs = run.endedAt === undefined ? Number.NaN : Date.parse(run.endedAt);
    const justEnded = Number.isFinite(endedMs) && deps.now().getTime() - endedMs < RECENT_END_MS;
    if (wasLoaded || justEnded) {
      const remaining = RESUME_SETTLE_MS - (clock() - lockedAt);
      if (remaining > 0) await sleep(remaining);
      const again = await readJob();
      if (again.running || again.loaded) {
        throw new Error(`The launchd job ${label} is ${again.running ? 'running' : 'loaded'} again after the previous run ended; not resuming. Check it with "${cli} status ${slug}" and try again in a few seconds.`);
      }
    }

    // 5. the one manifest write. Anything from here on may have landed, so any failure rolls back.
    const next = buildResumeManifest({ manifest: run, attempts: eligible.attempts, budgetUsd, now: deps.now().toISOString(), pid, repos });
    let bootstrapped = false;
    try {
      await deps.writeManifest(slug, next);
      await resetStopFlags.call(deps, eligible.controlDir);
      const plistPath = join(eligible.controlDir, `${label}.plist`);
      const plist = renderPlist({
        label,
        programArgs: buildProgramArgs({ nodePath: deps.nodePath, orchestratorEntry: deps.orchestratorEntry, slug }),
        env: buildJobEnv({
          parentEnv: input.parentEnv ?? process.env,
          home: deps.home,
          nodePath: deps.nodePath,
          opencodePath: gates.opencodePath,
          gitPath: gates.gitPath,
        }),
        stdout: join(eligible.controlDir, 'launchd.out.log'),
        stderr: join(eligible.controlDir, 'launchd.err.log'),
        workingDir: paths.runDir,
      });
      // the plist exists before the bootstrap: the old orchestrator's delayed bootout skips a job whose plist is there
      writeFileSync(plistPath, plist, { mode: 0o600 });
      chmodSync(plistPath, 0o600);
      bootstrapped = true; // from here a half-loaded job is possible
      const boot = await exec('launchctl', ['bootstrap', domain(deps.uid), plistPath]);
      if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed (exit ${boot.exitCode}): ${(boot.stderr || boot.stdout).trim()}`);
      return { plistPath, next, attempt: next.attempts?.at(-1)?.n ?? 0, run };
    } catch (err) {
      // The manifest says `launching` with an open attempt, and no orchestrator will ever close it: put the previous terminal
      // state back and keep the new attempt as a failed one. No attempt may stay open.
      const notes: string[] = [];
      if (bootstrapped) {
        try {
          // we verified nothing was loaded under the lock, so anything loaded now is ours. Wait until it is gone before the
          // manifest says "terminal" and the lock is released: a job that is still starting would find a finished run.
          await bootout(exec, deps.uid, label);
          let waited = 0;
          let after = await readJob();
          while (after.loaded && waited < waitMs) {
            await sleep(500);
            waited += 500;
            after = await readJob();
          }
          if (after.loaded) notes.push('the launchd job is still loaded');
        } catch (e) {
          notes.push(`the launchd job may still be loaded (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      try {
        await deps.writeManifest(
          slug,
          buildRollbackManifest({ previous: run, attempts: eligible.attempts, started: next.attempts!.at(-1)!, now: deps.now().toISOString() }),
        );
      } catch (rollbackErr) {
        notes.push(`RUN.json could not be restored (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}); run "${cli} stop ${slug}" to close the attempt`);
      }
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(notes.length > 0 ? `${base} (resume rolled back; ${notes.join('; ')})` : `${base} (resume rolled back: ${slug} is ${run.state} again)`, { cause: err });
    }
  };

  let started: Awaited<ReturnType<typeof attemptResume>>;
  try {
    started = await attemptResume();
  } catch (err) {
    await lock.release();
    throw err;
  }
  // after the try: a failing write to the terminal must not look like a failed resume of a healthy job
  io.out(`Resumed ${slug} as attempt ${started.attempt} (${label}), budget $${budgetUsd.toFixed(2)} on top of $${started.run.costUsd.toFixed(2)} spent`);
  io.out(`  log:    ${paths.orchestratorLog}`);
  io.out(`  status: ${cli} status ${slug}`);
  io.out(`  report: ${paths.reportMd}`);
  return { label, plistPath: started.plistPath, manifest: started.next, attempt: started.attempt };
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export interface StopInput {
  slug: string;
  deps: CliDeps;
  exec: ExecFn;
  io?: LauncherIo;
}

async function bootout(exec: ExecFn, uid: number, label: string): Promise<ExecResult> {
  return exec('launchctl', ['bootout', `${domain(uid)}/${label}`]);
}

export async function stop(input: StopInput): Promise<'signalled' | 'stopped' | 'already-terminal'> {
  const { deps, exec } = input;
  const io = input.io ?? defaultIo;
  const slug = assertSlug(input.slug);
  const manifest = await deps.readManifest(slug);
  if (!manifest) throw new Error(`No run found for "${slug}"`);
  const cli = cliInvocation(deps.nodePath);

  /**
   * A `launch` or `resume` of this very run keeps the lock (under the CLI's pid, or the orchestrator's) while it works. Marking
   * the run stopped under it would be overwritten, or would hide a run that is about to start: refuse and let the user retry.
   */
  const refuseWhileStarting = async (): Promise<void> => {
    const holder = await deps.lockHolder();
    if (holder?.alive && (holder.slug === slug || (manifest.pid !== undefined && holder.pid === manifest.pid))) {
      throw new Error(
        `A launch or resume of "${slug}" is in progress (process ${holder.pid} holds the run lock), so it is not marked stopped now. ` +
          `Wait a few seconds and run "${cli} stop ${slug}" again.`,
      );
    }
  };

  if (isTerminalRunState(manifest.state)) {
    // A resumable run whose last attempt never got closed (a crash, or an older version's stop) would make `resume` refuse
    // with no way out: close that attempt here, as the manifest says it ended. A launch that never started has none to close.
    if (isResumableState(manifest.state) && !isNeverStartedFailure(manifest) && hasOpenAttempt(manifest)) {
      recordedControlDir(manifest, slug);
      await refuseWhileStarting();
      const endedAt = manifest.endedAt ?? deps.now().toISOString();
      const attempts = closeLastAttempt(manifest, { endedAt, state: manifest.state, stopReason: manifest.stopReason });
      await deps.writeManifest(slug, { ...manifest, endedAt, attempts });
      io.out(`Run ${slug} is already ${manifest.state}; closed its open attempt ${attempts.at(-1)?.n ?? 1}. It can be resumed.`);
      return 'stopped';
    }
    io.out(`Run ${slug} is already ${manifest.state}.`);
    return 'already-terminal';
  }
  recordedControlDir(manifest, slug); // refuse a manifest whose recorded paths are not ours before touching launchd
  const label = recordedLaunchdLabel(manifest, slug);
  const job = await jobState(exec, deps.uid, label);
  if (job.unknown) {
    // "not loaded" is a claim about launchd; without a clear answer, marking a possibly live run stopped would be a guess
    throw new Error(`Cannot tell whether the launchd job ${label} is running (${job.detail}), so ${slug} is not marked stopped. Check launchctl and try again.`);
  }
  if (job.running) {
    const r = await exec('launchctl', ['kill', 'SIGTERM', `${domain(deps.uid)}/${label}`]);
    if (r.exitCode !== 0) throw new Error(`launchctl kill failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
    io.out(`SIGTERM sent to ${label}. The orchestrator aborts all sessions and writes REPORT.md.`);
    return 'signalled';
  }
  // Job not running: the orchestrator is gone (it crashed, or never started), so nobody will close the attempt or write the
  // report. Do it here: `crash -> stop -> resume` is the documented path, and resume refuses an open attempt.
  await refuseWhileStarting();
  const endedAt = deps.now().toISOString();
  const attempts = closeLastAttempt(manifest, { endedAt, state: 'stopped', stopReason: STOPPED_AFTER_CRASH });
  await deps.writeManifest(slug, { ...manifest, state: 'stopped', endedAt, stopReason: STOPPED_AFTER_CRASH, attempts });
  const warnings: string[] = [];
  if (job.loaded) {
    const r = await bootout(exec, deps.uid, label);
    if (r.exitCode !== 0) warnings.push(`warning: launchctl bootout of ${label} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
  }
  // releases the lock only when its holder is dead (or it is this run's stale one); a live process keeps what it holds
  await deps.releaseLock(slug);
  let reportNote = '';
  try {
    reportNote = ` Report: ${await deps.writeReport(slug)}`;
  } catch (e) {
    warnings.push(`warning: could not write the report: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const w of warnings) (io.err ?? console.error)(w);
  io.out(`Job ${label} was not running. Marked ${slug} as stopped (${STOPPED_AFTER_CRASH}) and closed its attempt.${reportNote}`);
  return 'stopped';
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export interface StatusInput {
  slug?: string;
  deps: CliDeps;
  io?: LauncherIo;
}

/**
 * What `status` shows as spend. A single-attempt run: the cumulative cost over the budget, as always. After a resume: the
 * open or last attempt's spend over that attempt's budget (the thresholds work the same way), and `attempt` says which one.
 */
function costSummary(m: RunManifest): { spendUsd: number; budgetUsd: number; pct: number; attempt?: { n: number; budgetUsd: number; failedStarts: number } } {
  const attempts = attemptsOf(m);
  // a resume that was rolled back never ran: the attempt before it is still the current one (its budget is the run's again)
  const real = attempts.filter((a) => a.stopReason !== RESUME_FAILED);
  const last = real.at(-1);
  if (attempts.length <= 1 || !last) {
    return { spendUsd: m.costUsd, budgetUsd: m.budgetUsd, pct: m.budgetUsd > 0 ? (m.costUsd / m.budgetUsd) * 100 : 0 };
  }
  // the live attempt spend is recorded on the attempt; before the first write of an attempt it is what the run spent since it began
  const spendUsd = last.costUsd ?? Math.max(0, m.costUsd - last.costAtStartUsd);
  return {
    spendUsd,
    budgetUsd: last.budgetUsd,
    pct: last.budgetUsd > 0 ? (spendUsd / last.budgetUsd) * 100 : 0,
    attempt: { n: last.n, budgetUsd: last.budgetUsd, failedStarts: attempts.length - real.length },
  };
}

export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

async function printRunStatus(slug: string, deps: CliDeps, io: LauncherIo): Promise<void> {
  const m = await deps.readManifest(slug);
  if (!m) {
    io.out(`${slug}: no RUN.json found`);
    return;
  }
  const paths = runPaths(slug, { home: deps.home, workspaceRoot: m.workspaceRoot });
  const checkedControlDir = recordedControlDir(m, slug);
  const flags = await deps.readControlFlags(checkedControlDir);
  const cost = costSummary(m);
  let heartbeat = 'never';
  if (flags && flags.heartbeatTs > 0) {
    const age = deps.now().getTime() - flags.heartbeatTs;
    heartbeat = `${formatAge(age)} ago${!isTerminalRunState(m.state) && age > HEARTBEAT_STALE_MS ? ' (STALE)' : ''}`;
  }
  io.out(`Run:        ${slug}`);
  io.out(`State:      ${m.state}`);
  io.out(`Phase:      ${m.phase}`);
  if (cost.attempt) io.out(`Attempt:    ${cost.attempt.n} (budget $${cost.attempt.budgetUsd.toFixed(2)}${cost.attempt.failedStarts > 0 ? `; ${cost.attempt.failedStarts} later attempt${cost.attempt.failedStarts === 1 ? '' : 's'} failed to start` : ''})`);
  io.out(`Cost:       $${cost.spendUsd.toFixed(2)} / $${cost.budgetUsd.toFixed(2)} (${cost.pct.toFixed(1)}%)${cost.attempt ? `  run total $${m.costUsd.toFixed(2)}` : ''}`);
  io.out(`Sessions:   ${m.knownSessionIds.length}`);
  io.out(`Heartbeat:  ${heartbeat}`);
  io.out(`Server:     ${m.serverUrl ?? 'not started'}`);
  io.out(`Log:        ${paths.orchestratorLog}`);
  io.out(`Report:     ${paths.reportMd}`);
  if (m.serverUrl) {
    const pw = join(checkedControlDir, 'server.pw');
    io.out('');
    io.out('Attach to the run server (best effort, not verified end to end):');
    io.out(`  OPENCODE_SERVER_PASSWORD=$(cat ${pw}) opencode --server ${m.serverUrl}`);
    io.out('  Desktop app / browser: a single-use pairing link comes from `POST /api/pair` on the server');
    io.out('  (needs the same Basic auth, user "opencode"). Desktop-app attach is unverified.');
  }
}

export async function status(input: StatusInput): Promise<void> {
  const { deps } = input;
  const io = input.io ?? defaultIo;
  if (input.slug) {
    await printRunStatus(assertSlug(input.slug), deps, io);
    return;
  }
  const workspaceRoot = await deps.resolveWorkspace();
  const specsRoot = join(workspaceRoot, '.specs');
  let names: string[] = [];
  try {
    names = readdirSync(specsRoot, { withFileTypes: true })
      // Other tools keep folders such as `.obsidian` in `.specs`; only slug-named dirs can be runs.
      .filter((d) => d.isDirectory() && isValidSlug(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    // no .specs dir
  }
  let shown = 0;
  for (const name of names) {
    const p = runPaths(name, { home: deps.home, workspaceRoot });
    if (!existsSync(p.runJson) && !existsSync(join(p.specsDir, 'RUN.json'))) continue;
    let m: RunManifest | undefined;
    try {
      m = await deps.readManifest(name);
    } catch (e) {
      (io.err ?? console.error)(`warning: skipping ${name}: cannot read its RUN.json (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
      continue;
    }
    if (!m) continue;
    const cost = costSummary(m);
    io.out(
      `${name}  ${m.state}  ${m.phase}  $${cost.spendUsd.toFixed(2)}/$${cost.budgetUsd.toFixed(2)} (${cost.pct.toFixed(0)}%)` +
        (cost.attempt ? `  attempt ${cost.attempt.n}, run total $${m.costUsd.toFixed(2)}` : ''),
    );
    shown++;
  }
  if (shown === 0) io.out('No runs found.');
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export async function report(input: { slug: string; deps: CliDeps; io?: LauncherIo }): Promise<string> {
  const io = input.io ?? defaultIo;
  const path = await input.deps.writeReport(assertSlug(input.slug));
  io.out(`Report written: ${path}`);
  return path;
}
