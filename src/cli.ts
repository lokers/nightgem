/**
 * nightgem CLI: `launch | status | stop | report | doctor [--audit-repo] | profile path|show|validate | render | install | uninstall`.
 *
 * `main` runs against the real dependencies from `src/wiring.ts` (`realCliDeps`). Use `buildProgram(deps)` to inject
 * deps (tests).
 */
import * as nodeFs from 'node:fs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { APP, COMMANDS, CONFIG_DIR_NAME, ENV_PREFIX, TMP_PREFIX } from './brand.ts';
import { auditRepo } from './audit.ts';
import { cliInvocation, realExec, realProfileAccess, type CliDeps, type ExecFn, type ProfileAccess } from './cli-deps.ts';
import type { RepoEntry } from './contracts.ts';
import { doctor, formatDoctor, hasHardFailure, type DoctorFs, type DoctorOptions } from './doctor.ts';
import { InstallError, installCommands, uninstallCommands } from './install.ts';
import { buildLaunchManifest, launch, report, resolveJobPath, settleRunContext, status, stop, type LauncherIo } from './launcher.ts';
import { launchdLabel } from './plist.ts';
import { assertSlug, runPaths } from './paths.ts';
import { assertSafeOutDir, realRenderers, renderRunArtifacts, writeRenderedFiles } from './render.ts';
import { parseSpec } from './specmeta.ts';
import { ProfileError } from './userprofile.ts';
import { realCliDeps } from './wiring.ts';

export { DEFAULT_MODEL } from './wiring.ts';

export interface ProgramOptions {
  deps: CliDeps;
  exec?: ExecFn;
  /** Filesystem probe for doctor (tests inject a fake). */
  fs?: DoctorFs;
  io?: LauncherIo;
  /** Environment for the profile location (`NIGHTGEM_PROFILE`). Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Profile access (tests inject a fake). Default: the real profile at `NIGHTGEM_PROFILE` or the default location. */
  profile?: ProfileAccess;
  /** Where `install` writes the commands (default `<home>/.config/opencode/commands`); tests and `--commands-dir` override it. */
  commandsDir?: string;
  /** Receives a non-zero exit code. Default: `process.exitCode`. */
  onExit?: (code: number) => void;
}

/** The repo that contains this CLI (this file is `src/cli.ts`). */
const CLI_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Fixed stand-ins so `render` output is reproducible. */
const RENDER_PORT = 54321;
const RENDER_PASSWORD = 'render-preview-password';

function parseNumber(label: string): (v: string) => number {
  return (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number, got "${v}"`);
    return n;
  };
}

/** `--soft-pct`: the wind-down threshold as a fraction of the budget. A narrow range keeps a typo from disabling the wind-down. */
function parseSoftPct(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.1 || n > 0.95) throw new Error(`--soft-pct must be a number between 0.1 and 0.95, got "${v}"`);
  return n;
}

export function buildProgram(opts: ProgramOptions): Command {
  const { deps } = opts;
  const exec = opts.exec ?? realExec;
  const io = opts.io;
  const out = (line: string): void => (io?.out ?? console.log)(line);
  const err = (line: string): void => (io?.err ?? console.error)(line);
  const fail = (code = 1): void => (opts.onExit ?? ((c: number) => void (process.exitCode = c)))(code);
  const profile = opts.profile ?? realProfileAccess(deps.home, opts.env ?? process.env);
  const fs: DoctorFs = opts.fs ?? {
    exists: (p) => existsSync(p),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return undefined;
      }
    },
  };
  const program = new Command(APP).description(`Launch and manage autonomous ${APP} runs`);
  program.exitOverride();

  program
    .command('launch <slug>')
    .description('Validate the spec, run doctor, and start a detached run via launchd')
    .requiredOption('--budget <usd>', 'budget in USD', parseNumber('--budget'))
    .option('--repos <a,b>', 'override the repos from SPEC.md (names under the workspace root or absolute paths)')
    .option('--cost-multiplier <n>', 'multiply observed cost (smoke tests only)', parseNumber('--cost-multiplier'))
    .option('--soft-pct <fraction>', 'TESTING ONLY: wind down at this fraction of the budget (0.1-0.95, default 0.85)', parseSoftPct)
    .action(async (slug: string, o: { budget: number; repos?: string; costMultiplier?: number; softPct?: number }) => {
      await launch({
        slug,
        budgetUsd: o.budget,
        repos: o.repos?.split(',').map((s) => s.trim()).filter(Boolean),
        costMultiplier: o.costMultiplier,
        softPct: o.softPct,
        deps,
        exec,
        fs,
        io,
      });
    });

  program
    .command('status [slug]')
    .description('Show run state, cost and attach instructions (all runs when no slug)')
    .action(async (slug?: string) => {
      await status({ slug, deps, io });
    });

  program
    .command('stop <slug>')
    .description('Stop a run (SIGTERM via launchctl); the orchestrator writes the report')
    .action(async (slug: string) => {
      await stop({ slug, deps, exec, io });
    });

  program
    .command('report <slug>')
    .description('Regenerate REPORT.md')
    .action(async (slug: string) => {
      await report({ slug, deps, io });
    });

  program
    .command('doctor')
    .description('Check the environment for an unattended run (--audit-repo: scan this checkout for user-specific facts)')
    .option('--audit-repo', 'scan the tracked files of a repo for home paths, emails, ticket keys and the profile bannedTerms')
    .option('--dir <repo>', 'repo to audit with --audit-repo (default: the checkout containing this CLI)')
    .option('--verbose', 'print the full detail of every check (the default output is one line of at most 200 characters per check)')
    .action(async (o: { auditRepo?: boolean; dir?: string; verbose?: boolean }) => {
      if (o.auditRepo) {
        const dir = resolve(o.dir ?? CLI_REPO_ROOT);
        let bannedTerms: string[] = [];
        try {
          bannedTerms = [...profile.load().profile.audit.bannedTerms];
        } catch (e) {
          if (!(e instanceof ProfileError && e.code === 'missing')) throw e;
          err('note: no profile found; running the generic checks only');
        }
        const gitRun = async (args: string[], cwd: string): Promise<string> => {
          const r = await exec('git', args, { cwd });
          if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${r.stderr.trim()}`);
          return r.stdout;
        };
        const res = await auditRepo({ dir, bannedTerms, git: gitRun, generic: true });
        for (const h of res.hits) out(`${h.file}:${h.line}:${h.col} ${h.kind} ${h.match}`);
        out(`audit: ${res.hits.length} hit(s) in ${res.scanned} file(s)${bannedTerms.length > 0 ? ' (with profile bannedTerms)' : ' (generic checks only)'}`);
        if (res.hits.length > 0) fail(1);
        return;
      }
      const result = await runDoctor();
      out(formatDoctor(result, { verbose: o.verbose === true }));
      if (hasHardFailure(result)) fail(1);
    });

  /** With a profile: check the toolchains of the repos it lists (`repos.<name>.tools` plus the generic defaults) on the job PATH. */
  async function profileToolchainOptions(settled: Awaited<ReturnType<typeof settleRunContext>>): Promise<Partial<DoctorOptions>> {
    if (!('runContext' in settled)) return {};
    const { workspaceRoot, profile: p } = settled.runContext;
    const specRepos = Object.keys(p.data.repos).map((name) => ({ name, path: join(workspaceRoot, name) }));
    if (specRepos.length === 0) return {};
    return { specRepos, jobPath: await resolveJobPath(exec, deps), repoTools: p.data.repos };
  }

  /** Doctor never crashes on a missing or broken profile: the context (or why there is none) is passed in as a finding. */
  async function runDoctor(): ReturnType<typeof doctor> {
    const settled = await settleRunContext(deps);
    const options: DoctorOptions = {
      exec,
      fs,
      nodePath: deps.nodePath,
      env: opts.env ?? process.env,
      ...settled,
      ...(await profileToolchainOptions(settled)),
      lockIsFree: () => deps.lockIsFree(),
      preflight: deps.preflight ? () => deps.preflight!() : undefined,
    };
    return doctor(options);
  }

  const profileCmd = program.command('profile').description(`Inspect the user profile (location: ${ENV_PREFIX}PROFILE or ~/.config/${CONFIG_DIR_NAME}/profile.jsonc)`);
  profileCmd
    .command('path')
    .description('Print the profile path in effect')
    .action(() => out(profile.path()));
  profileCmd
    .command('show')
    .description('Print the resolved profile (~ expanded). audit.bannedTerms is only printed with --json')
    .option('--json', 'machine-readable: the resolved profile object, including audit.bannedTerms')
    .action((o: { json?: boolean }) => {
      try {
        const loaded = profile.load();
        if (o.json) {
          out(JSON.stringify(loaded.profile, null, 2));
          return;
        }
        const shown = { ...loaded.profile, audit: { bannedTerms: `<${loaded.profile.audit.bannedTerms.length} term(s) hidden; use --json>` } };
        out(`path:   ${loaded.path}`);
        out(`sha256: ${loaded.sha256}`);
        out(JSON.stringify(shown, null, 2));
      } catch (e) {
        reportProfileError(e);
      }
    });
  profileCmd
    .command('validate')
    .description('Validate the profile (schema and workspace checks); exit 1 with the reasons when invalid')
    .action(() => {
      try {
        const loaded = profile.load();
        out(`Profile OK: ${loaded.path} (workspaceRoot ${loaded.profile.workspaceRoot})`);
      } catch (e) {
        reportProfileError(e);
      }
    });

  function reportProfileError(e: unknown): void {
    if (!(e instanceof ProfileError)) throw e;
    err(`error: ${e.message}`);
    for (const issue of e.issues ?? []) err(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    for (const reason of e.reasons ?? []) err(`  - ${reason}`);
    fail(1);
  }

  program
    .command('install')
    .description(`Install the /${COMMANDS.main} commands into the OpenCode commands dir and create a starter profile if none exists`)
    .option('--workspace <dir>', 'the directory that holds your repos (required when no profile exists)')
    .option('--force', `replace commands that are not managed by ${APP} (a .bak copy is made first)`)
    .option('--commands-dir <dir>', 'commands dir (default: ~/.config/opencode/commands)')
    .action(async (o: { workspace?: string; force?: boolean; commandsDir?: string }) => {
      let result: ReturnType<typeof installCommands>;
      try {
        result = installCommands({
          home: deps.home,
          env: opts.env ?? process.env,
          fs: nodeFs,
          nodePath: deps.nodePath,
          binPath: join(CLI_REPO_ROOT, 'bin', `${APP}.mjs`),
          templatesDir: join(CLI_REPO_ROOT, 'commands'),
          starterPath: join(CLI_REPO_ROOT, 'templates', 'profile.starter.jsonc'),
          commandsDir: o.commandsDir ? resolve(o.commandsDir) : opts.commandsDir,
          workspace: o.workspace === undefined ? undefined : o.workspace.startsWith('~') ? o.workspace : resolve(o.workspace),
          force: o.force === true,
          now: () => deps.now(),
        });
      } catch (e) {
        if (!(e instanceof InstallError)) throw e;
        err(`error: ${e.message}`);
        fail(1);
        return;
      }
      for (const c of result.commands) out(`${c.action.padEnd(10)} ${c.path}${c.backup ? ` (previous file saved as ${c.backup})` : ''}`);
      out(result.profile.action === 'created' ? `created    ${result.profile.path} (workspaceRoot ${result.profile.workspaceRoot})` : `profile    ${result.profile.path} (already exists, left alone)`);
      out('');
      out('Next steps:');
      out(`  1. Review the profile: ${result.profile.path}  (tracker, skills, deny lists are optional)`);
      out(`  2. Check it: ${cliInvocation(deps.nodePath)} profile validate`);
      out(`  3. Restart OpenCode, then use /${COMMANDS.main} <task or ticket> to write a spec and launch a run`);
      out('');
      out('Environment check (doctor):');
      try {
        const result2 = await runDoctor();
        out(formatDoctor(result2));
        if (hasHardFailure(result2)) out('doctor reported hard failures; fix them before launching a run (install itself succeeded).');
      } catch (e) {
        out(`doctor skipped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    });

  program
    .command('uninstall')
    .description(`Remove the /${COMMANDS.main} commands that install wrote and that were not edited. The profile is never touched`)
    .option('--commands-dir <dir>', 'commands dir (default: ~/.config/opencode/commands)')
    .action((o: { commandsDir?: string }) => {
      const res = uninstallCommands({ home: deps.home, fs: nodeFs, commandsDir: o.commandsDir ? resolve(o.commandsDir) : opts.commandsDir });
      for (const c of res.commands) {
        if (c.action === 'removed') out(`removed    ${c.path}`);
        else if (c.action === 'missing') out(`missing    ${c.path}`);
        else if (c.action === 'skipped-edited') err(`warning: ${c.path} was edited since install; leaving it in place`);
        else err(`warning: ${c.path} is not managed by ${APP}; leaving it in place`);
      }
      out(`To remove the PATH link too (if you ran npm link): npm unlink -g ${APP}`);
    });

  program
    .command('render <slug>')
    .description('Render the run config, sandbox profile, guard env, prompts and RUN.json preview into --out. Never launches; never writes .specs')
    .requiredOption('--out <dir>', 'output directory')
    .option('--spec <path>', 'SPEC.md to read the repos from (default: the slug\'s SPEC.md)')
    .option('--budget <usd>', 'budget shown in manifest-preview.json (default 10)', parseNumber('--budget'))
    .action(async (slug: string, o: { out: string; spec?: string; budget?: number }) => {
      assertSlug(slug);
      const context = await deps.resolveRunContext();
      const { workspaceRoot } = context;
      const outDir = assertSafeOutDir(o.out, { home: deps.home, workspaceRoot });
      const paths = runPaths(slug, { home: deps.home, workspaceRoot });
      const specPath = resolve(o.spec ?? paths.specMd);
      if (!existsSync(specPath)) throw new Error(`SPEC.md not found: ${specPath}`);
      // the repos are only shown in the preview: a draft spec or missing repo renders with none
      let repos: RepoEntry[] = [];
      try {
        repos = parseSpec(readFileSync(specPath, 'utf8'), { home: deps.home, workspaceRoot }).repos.map((r) => ({
          name: r.name,
          path: r.path,
          defaultBranch: '<default-branch>',
          baseline: { head: '<head>', branch: '<branch>', porcelainHash: '<porcelain-hash>', stashCount: 0 },
        }));
      } catch (e) {
        err(`note: no repos in the preview (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
      }
      const manifestPreview = buildLaunchManifest({
        slug,
        budgetUsd: o.budget ?? 10,
        costMultiplier: 1,
        context,
        label: launchdLabel(slug),
        paths,
        model: context.model,
        repos,
        pid: 1,
        createdAt: '1970-01-01T00:00:00.000Z',
      });
      const files = renderRunArtifacts(
        {
          slug,
          home: deps.home,
          context,
          manifestPreview,
          guardDir: join(CLI_REPO_ROOT, 'profile', 'guard'),
          sshWrapper: join(CLI_REPO_ROOT, 'profile', 'git-ssh-fetch-only.sh'),
          tmpDir: `/private/tmp/${TMP_PREFIX}${slug}`,
          port: RENDER_PORT,
          password: RENDER_PASSWORD,
        },
        deps.renderers,
      );
      for (const f of writeRenderedFiles(outDir, files)) out(join(outDir, f));
    });

  return program;
}

export async function main(argv: string[], deps: CliDeps = realCliDeps()): Promise<number> {
  const program = buildProgram({ deps });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') return 0;
    if (typeof code === 'string' && code.startsWith('commander.')) return 2;
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Run when executed directly (via bin/nightgem.mjs or `tsx src/cli.ts`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
