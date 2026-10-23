/**
 * Launcher: `launch`, `stop`, `status`, `report`.
 *
 * `launch` detaches the orchestrator through a generated launchd plist. All state-module, baseline
 * and report functionality is injected via `CliDeps`; subprocesses via `ExecFn`.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cliInvocation, type CliDeps, type ExecFn } from './cli-deps.ts';
import { isNeverStartedFailure, isTerminalRunState, RUN_MANIFEST_VERSION, RunContextSnapshot, RunManifest, type RepoEntry } from './contracts.ts';
import { doctor, formatDoctor, formatWarning, hardFailures, type DoctorFs, type DoctorOptions } from './doctor.ts';
import { assertSlug, isValidSlug, recordedControlDir, recordedLaunchdLabel, runPaths, type RunPaths } from './paths.ts';
import { buildJobEnv, buildProgramArgs, launchdLabel, renderPlist } from './plist.ts';
import { loadSpec, type SpecMeta } from './specmeta.ts';

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

/** `launchctl print` succeeds when the job is loaded; `running` when it has a live pid. */
async function jobState(exec: ExecFn, uid: number, label: string): Promise<{ loaded: boolean; running: boolean }> {
  const r = await exec('launchctl', ['print', `${domain(uid)}/${label}`]);
  if (r.exitCode !== 0) return { loaded: false, running: false };
  return { loaded: true, running: /state = running/.test(r.stdout) };
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

  if ((await jobState(exec, deps.uid, label)).loaded) {
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
// stop
// ---------------------------------------------------------------------------

export interface StopInput {
  slug: string;
  deps: CliDeps;
  exec: ExecFn;
  io?: LauncherIo;
}

export async function stop(input: StopInput): Promise<'signalled' | 'stopped' | 'already-terminal'> {
  const { deps, exec } = input;
  const io = input.io ?? defaultIo;
  const slug = assertSlug(input.slug);
  const manifest = await deps.readManifest(slug);
  if (!manifest) throw new Error(`No run found for "${slug}"`);
  if (isTerminalRunState(manifest.state)) {
    io.out(`Run ${slug} is already ${manifest.state}.`);
    return 'already-terminal';
  }
  recordedControlDir(manifest, slug); // refuse a manifest whose recorded paths are not ours before touching launchd
  const label = recordedLaunchdLabel(manifest, slug);
  const job = await jobState(exec, deps.uid, label);
  if (job.running) {
    const r = await exec('launchctl', ['kill', 'SIGTERM', `${domain(deps.uid)}/${label}`]);
    if (r.exitCode !== 0) throw new Error(`launchctl kill failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
    io.out(`SIGTERM sent to ${label}. The orchestrator aborts all sessions and writes REPORT.md.`);
    return 'signalled';
  }
  // Job not running: nobody will write the report, so do it here.
  const reportPath = await deps.writeReport(slug);
  await deps.writeManifest(slug, {
    ...manifest,
    state: 'stopped',
    endedAt: deps.now().toISOString(),
    stopReason: 'stopped by user (launchd job was not running)',
  });
  await deps.releaseLock(slug);
  io.out(`Job ${label} was not running. Marked ${slug} as stopped. Report: ${reportPath}`);
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
  const pct = m.budgetUsd > 0 ? (m.costUsd / m.budgetUsd) * 100 : 0;
  let heartbeat = 'never';
  if (flags && flags.heartbeatTs > 0) {
    const age = deps.now().getTime() - flags.heartbeatTs;
    heartbeat = `${formatAge(age)} ago${!isTerminalRunState(m.state) && age > HEARTBEAT_STALE_MS ? ' (STALE)' : ''}`;
  }
  io.out(`Run:        ${slug}`);
  io.out(`State:      ${m.state}`);
  io.out(`Phase:      ${m.phase}`);
  io.out(`Cost:       $${m.costUsd.toFixed(2)} / $${m.budgetUsd.toFixed(2)} (${pct.toFixed(1)}%)`);
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
    const pct = m.budgetUsd > 0 ? (m.costUsd / m.budgetUsd) * 100 : 0;
    io.out(`${name}  ${m.state}  ${m.phase}  $${m.costUsd.toFixed(2)}/$${m.budgetUsd.toFixed(2)} (${pct.toFixed(0)}%)`);
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
