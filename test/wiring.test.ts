import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecFn } from '../src/cli-deps.ts';
import { RunApiError } from '../src/client.ts';
import { RunContextSnapshot, RunManifest, ServerEvent, type SafetyInputs } from '../src/contracts.ts';
import { profileHash } from '../src/userprofile.ts';
import { UsageError, main as orchestratorMain, parseArgs } from '../src/orchestrator-main.ts';
import { EXIT_TIMEOUT_SECONDS, buildProgramArgs, launchdLabel, renderPlist } from '../src/plist.ts';
import { controlDir, runPaths } from '../src/paths.ts';
import { DEFAULT_REPO_ROOT, runTmpDir } from '../src/server.ts';
import { defaultLockPath, readLockInfo, writeManifest } from '../src/state.ts';
import { discoverRepos, takeBaseline } from '../src/tripwires.ts';
import {
  CANARY_PROMPT,
  CANARY_RETRY_PROMPT,
  ORCHESTRATOR_ENTRY,
  REPO_ROOT,
  buildBaseline,
  agentModelOverrides,
  readRunContext,
  readRunContextFile,
  runContextPath,
  resolveRunContext,
  RunContextError,
  writeRunContext,
  corpusWorktree,
  SSH_BLOCKED_PROBE,
  buildShellProbes,
  gitFetchOrigin,
  removeRunTmp,
  formatLogLine,
  detectDefaultBranch,
  guardCases,
  guardConfigFor,
  specRemoteRules,
  planReadDeny,
  processSignals,
  realCliDeps,
  realOrchestratorDeps,
  resolveBin,
  runCanary,
  runGuardCanary,
  runPreflight,
  runShellCanary,
  wiringChecks,
  type OrchestratorWiringOptions,
} from '../src/wiring.ts';
import type { ServerApi } from '../src/orchestrator.ts';
import { buildGuardEnv } from '../src/profile.ts';
import { sandboxReadDenies } from '../src/sandbox.ts';
import type { ShellResult } from '../src/client.ts';
import { decide } from '../profile/guard/decide.mjs';
import { configFromEnv } from '../profile/guard/config.mjs';

const SLUG = 'wired-run';
let home: string;
let workspaceRoot: string;
let savedTmpdir: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-wiring-'));
  home = nodeFs.realpathSync(home);
  workspaceRoot = join(home, 'work');
  // the run tmp dir is os.tmpdir()/nightgem-<slug>: keep it inside the test's own dir
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = home;
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(home, { recursive: true, force: true });
});


/** Write a valid profile (workspace `<home>/work`, created) and return its path. */
function writeProfileFile(extra: Record<string, unknown> = {}): string {
  mkdirSync(workspaceRoot, { recursive: true });
  const file = join(home, '.config', 'nightgem', 'profile.jsonc');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, workspaceRoot, ...extra }));
  return file;
}

/** Profile + resolved context + frozen snapshot in the control dir, as the launcher leaves them. */
function seedContext(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  writeProfileFile(extra);
  const snap = resolveRunContext({ home, env, fs: nodeFs });
  writeRunContext(controlDir(SLUG, home), snap);
  return snap;
}

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });

function makeRepo(name: string, opts: { commit?: boolean } = {}): string {
  const dir = join(workspaceRoot, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'a.txt'), 'a');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

function writeRun(extra: Record<string, unknown> = {}): RunManifest {
  if (!existsSync(join(controlDir(SLUG, home), 'run-context.json'))) seedContext();
  const paths = runPaths(SLUG, { home, workspaceRoot });
  const m = RunManifest.parse({
    schemaVersion: 2,
    workspaceRoot: paths.workspaceRoot,
    slug: SLUG,
    budgetUsd: 42,
    softPct: 0.8,
    hardPct: 1.1,
    costMultiplier: 3,
    state: 'launching',
    phase: 'plan',
    launchdLabel: launchdLabel(SLUG),
    controlDir: paths.controlDir,
    runDir: paths.runDir,
    xdgDataHome: paths.xdgDataHome,
    model: 'anthropic/claude-opus-5-5',
    createdAt: new Date().toISOString(),
    ...extra,
  });
  writeManifest(paths.runJson, m);
  return m;
}

const snapshotTree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []);

describe('resolveRunContext (profile -> snapshot)', () => {
  const resolve = (env: Record<string, string> = {}) => resolveRunContext({ home, env, fs: nodeFs });
  const mkSkill = (root: string, name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody`);
    return dir;
  };

  it('a valid profile resolves the workspace, models, instructions, skills and safety inputs', () => {
    const instr = join(home, 'instr.md');
    writeFileSync(instr, 'Be careful in acme-api.');
    const agents = join(home, '.agents', 'skills');
    for (const n of ['spec-driven-development', 'idea-refine', 'release-notes']) mkSkill(agents, n);
    writeProfileFile({
      instructionsFile: instr,
      models: { fixer: 'openai/gpt-9#high' },
      skills: { exclude: ['spec-driven-*'] },
      deny: { commands: ['acme-cli'], shellPatterns: ['acme-cli *'], secretPaths: ['.acme'], editPaths: ['**/generated/**'] },
    });
    const ctx = resolve();
    expect(ctx.workspaceRoot).toBe(workspaceRoot);
    expect(ctx.profile.path).toBe(join(home, '.config', 'nightgem', 'profile.jsonc'));
    expect(ctx.profile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.instructions).toMatchObject({ path: instr, text: 'Be careful in acme-api.' });
    expect(ctx.instructions.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.models.fixer).toEqual({ model: 'openai/gpt-9', variant: 'high' });
    expect(ctx.models.orchestrator).toEqual({ model: 'anthropic/claude-opus-5-5', variant: 'high' });
    expect(ctx.skills.available.map((x) => x.name).sort()).toEqual(['idea-refine', 'release-notes']);
    expect(ctx.skills.excludedRequired).toEqual(['spec-driven-development']);
    expect(ctx.safety.workspaceRoot).toBe(workspaceRoot);
    expect(ctx.safety.skillRoots).toEqual([nodeFs.realpathSync(agents)]);
    // exclusions and the generic tracker/release patterns are concrete names for slim
    expect(ctx.safety.disabledSkills).toEqual(['release-notes', 'spec-driven-development']);
    expect(ctx.safety.deny).toEqual({ commands: ['acme-cli'], shellPatterns: ['acme-cli *'], secretPaths: ['.acme'], editPaths: ['**/generated/**'] });
  });

  it('model and smallModel are the orchestrator and observer models', () => {
    writeProfileFile({ models: { orchestrator: 'openai/gpt-9#max', observer: 'openai/tiny' } });
    const ctx = resolve();
    expect(ctx.model).toBe('openai/gpt-9');
    expect(ctx.smallModel).toBe('openai/tiny');
    expect(ctx.model).toBe(ctx.models.orchestrator!.model);
    writeProfileFile();
    const dflt = resolve({ NIGHTGEM_MODEL: 'anthropic/claude-sonnet-5-5' });
    expect(dflt).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', smallModel: 'anthropic/claude-haiku-5-5' });
  });

  it('a missing profile throws a ProfileError with code "missing" (the caller reports one FAIL)', () => {
    expect(() => resolve()).toThrow(expect.objectContaining({ name: 'ProfileError', code: 'missing' }));
  });

  it('without an instructions file the default text is used', () => {
    writeProfileFile();
    const ctx = resolve();
    expect(ctx.instructions.text).toBe("(none: follow each repo's AGENTS.md / CLAUDE.md)");
    expect(ctx.instructions.path).toBeUndefined();
  });

  it('an unreadable instructions file is a hard error', () => {
    writeProfileFile({ instructionsFile: join(home, 'nope.md') });
    expect(() => resolve()).toThrow(RunContextError);
  });

  it('a missing profile, an invalid profile and a bad workspace are hard errors', () => {
    expect(() => resolve()).toThrow(/Profile not found/);
    const file = writeProfileFile();
    writeFileSync(file, '{ "version": 2 }');
    expect(() => resolve()).toThrow(/Invalid profile/);
    writeFileSync(file, JSON.stringify({ version: 1, workspaceRoot: home }));
    expect(() => resolve()).toThrow(/not usable/);
    writeFileSync(file, JSON.stringify({ version: 1, workspaceRoot: join(home, 'missing-dir') }));
    expect(() => resolve()).toThrow(/does not exist/);
  });

  it('NIGHTGEM_PROFILE points at another profile', () => {
    writeProfileFile();
    const other = join(home, 'other.jsonc');
    mkdirSync(join(home, 'ws2'));
    writeFileSync(other, JSON.stringify({ version: 1, workspaceRoot: join(home, 'ws2') }));
    expect(resolve({ NIGHTGEM_PROFILE: other }).workspaceRoot).toBe(join(home, 'ws2'));
  });

  it('model precedence: launch env > profile > built-in defaults', () => {
    writeProfileFile({ models: { orchestrator: 'openai/gpt-9#max', fixer: 'openai/gpt-9', explorer: 'openai/mini' } });
    const ctx = resolve({ NIGHTGEM_FIXER_MODEL: 'anthropic/claude-opus-5-5#xhigh' });
    expect(ctx.models.fixer).toEqual({ model: 'anthropic/claude-opus-5-5', variant: 'xhigh' }); // env wins
    expect(ctx.models.explorer).toEqual({ model: 'openai/mini', variant: 'low' }); // profile, built-in variant
    expect(ctx.models.orchestrator).toEqual({ model: 'openai/gpt-9', variant: 'max' }); // profile
    expect(ctx.models.oracle).toEqual({ model: 'openai/gpt-9', variant: 'xhigh' }); // follows the run model
    expect(ctx.models.designer).toEqual({ model: 'anthropic/claude-sonnet-5-5', variant: 'medium' }); // default
    expect(ctx.models.observer).toEqual({ model: 'anthropic/claude-haiku-5-5' });
    const envRun = resolve({ NIGHTGEM_MODEL: 'anthropic/claude-sonnet-5-5', NIGHTGEM_SMALL_MODEL: 'openai/tiny' });
    expect(envRun.models.orchestrator).toEqual({ model: 'anthropic/claude-sonnet-5-5', variant: 'high' }); // env drops the profile's variant
    expect(envRun.models.observer).toEqual({ model: 'openai/tiny' });
  });

  it('an invalid model in the launch env is rejected', () => {
    writeProfileFile();
    expect(() => resolve({ NIGHTGEM_ORACLE_MODEL: 'nomodel' })).toThrow(/Invalid model/);
  });

  it('skill roots come from the opencode.json skills key; nothing else in that file is read', () => {
    const extra = join(home, 'more-skills');
    mkSkill(extra, 'custom-skill');
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ provider: { x: { options: { apiKey: 'SECRET-KEY' } } }, skills: [extra] }));
    writeProfileFile();
    const ctx = resolve();
    expect(ctx.skills.available.map((x) => x.name)).toEqual(['custom-skill']);
    expect(JSON.stringify(ctx)).not.toContain('SECRET-KEY');
  });

  it('mcp server names come from the global and the workspace opencode.json (key names only) into the safety inputs', () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { atlassian: { headers: { Authorization: 'Bearer SECRET-KEY' } }, github: { environment: { T: 'SECRET-KEY' } } } }));
    writeProfileFile();
    writeFileSync(join(workspaceRoot, 'opencode.json'), JSON.stringify({ mcp: { github: {}, local: { command: ['SECRET-KEY'] } } }));
    const ctx = resolve();
    expect(ctx.safety.mcpServerNames).toEqual(['atlassian', 'github', 'local']);
    expect(JSON.stringify(ctx)).not.toContain('SECRET-KEY');
    // the frozen snapshot round-trips with the names, still without any value
    const file = writeRunContext(controlDir(SLUG, home), ctx);
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET-KEY');
    expect(readRunContext(controlDir(SLUG, home)).safety.mcpServerNames).toEqual(['atlassian', 'github', 'local']);
  });

  it('the servers layout (mcp.servers.<name>) gives the server names, not "servers"', () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { servers: { atlassian: { type: 'remote', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer SECRET-KEY' } } } } }));
    writeProfileFile();
    const ctx = resolve();
    expect(ctx.safety.mcpServerNames).toEqual(['atlassian']);
    expect(JSON.stringify(ctx)).not.toContain('SECRET-KEY');
  });

  it('no opencode.json: no mcp servers; an unusable server name fails the launch instead of leaving it enabled', () => {
    writeProfileFile();
    expect(resolve().safety.mcpServerNames).toEqual([]);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { 'bad*name': {} } }));
    expect(() => resolve()).toThrow(/Invalid mcpServerNames entry/);
  });

  it('skills outside every root are added to the safety skill roots by realpath', () => {
    const real = join(home, 'elsewhere', 'linked-skill');
    mkSkill(join(home, 'elsewhere'), 'linked-skill');
    const agents = join(home, '.agents', 'skills');
    mkdirSync(agents, { recursive: true });
    nodeFs.symlinkSync(real, join(agents, 'linked-skill'));
    writeProfileFile();
    const ctx = resolve();
    expect(ctx.skills.outsideRoots).toEqual([real]);
    expect(ctx.safety.skillRoots).toEqual([nodeFs.realpathSync(agents), real]);
  });
});

describe('run-context snapshot', () => {
  it('writes 0600, round-trips through zod, and replaces atomically', () => {
    writeProfileFile();
    const snap = resolveRunContext({ home, env: {}, fs: nodeFs });
    const dir = controlDir(SLUG, home);
    const file = writeRunContext(dir, snap);
    expect(file).toBe(join(dir, 'run-context.json'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readRunContext(dir)).toEqual(snap);
    expect(readdirSync(dir)).toEqual(['run-context.json']);
    writeRunContext(dir, snap); // overwrite
    expect(readRunContext(dir)).toEqual(snap);
  });

  it('refuses to write an invalid snapshot', () => {
    expect(() => writeRunContext(controlDir(SLUG, home), { version: 1 } as never)).toThrow();
    expect(existsSync(controlDir(SLUG, home))).toBe(false);
  });

  it('a missing or corrupt snapshot is a clear typed error', () => {
    const dir = controlDir(SLUG, home);
    expect(() => readRunContext(dir)).toThrow(expect.objectContaining({ code: 'run-context-missing' }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-context.json'), '{nope');
    expect(() => readRunContext(dir)).toThrow(expect.objectContaining({ code: 'run-context-invalid' }));
    writeFileSync(join(dir, 'run-context.json'), '{"version":1}');
    expect(() => readRunContext(dir)).toThrow(expect.objectContaining({ code: 'run-context-invalid' }));
  });

  it('realOrchestratorDeps hands the profile\'s review.maxRounds to the prompt context', () => {
    seedContext({ review: { maxRounds: 4 } });
    writeRun();
    expect(realOrchestratorDeps(SLUG, home, { env: {} }).promptContext.reviewMaxRounds).toBe(4);
  });

  it('realOrchestratorDeps reads only the snapshot: workspace, prompt context, models and safety come from it', () => {
    const instr = join(home, 'instr.md');
    writeFileSync(instr, 'Workspace rules here');
    const agents = join(home, '.agents', 'skills');
    for (const n of ['test-driven-development', 'idea-refine']) {
      mkdirSync(join(agents, n), { recursive: true });
      writeFileSync(join(agents, n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
    }
    const snap = seedContext({ instructionsFile: instr, models: { observer: 'openai/tiny' } }, { NIGHTGEM_FIXER_MODEL: 'openai/gpt-9#high' });
    writeRun();
    // the profile is gone and the env differs: the orchestrator does not care
    rmSync(join(home, '.config'), { recursive: true });
    const d = realOrchestratorDeps(SLUG, home, { env: { NIGHTGEM_FIXER_MODEL: 'nope/ignored' } });
    expect(d.paths.workspaceRoot).toBe(workspaceRoot);
    expect(d.promptContext).toEqual({
      workspaceRoot,
      workspaceInstructions: 'Workspace rules here',
      skillsList: '- idea-refine\n- test-driven-development',
      reviewMaxRounds: 2,
    });
    expect(d.smallModel).toBe('openai/tiny');
    expect(d.serverInput.agentModels?.fixer).toEqual({ model: 'openai/gpt-9', variant: 'high' });
    expect(d.serverInput.safety).toEqual(snap.safety);
  });

  it('a missing snapshot fails loudly with the run-context-missing code (and main exits 1)', async () => {
    mkdirSync(workspaceRoot, { recursive: true });
    expect(() => realOrchestratorDeps(SLUG, home, { env: {} })).toThrow(expect.objectContaining({ code: 'run-context-missing' }));
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(' '));
    try {
      expect(await orchestratorMain(['--slug', SLUG], home)).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(errs.join('\n')).toMatch(/run-context-missing/);
  });
});

describe('realCliDeps: workspace lookup and snapshot writer', () => {
  it('resolveWorkspace reads only the profile: it works when skill roots or the instructions file are broken', async () => {
    writeProfileFile({ instructionsFile: join(home, 'missing.md') });
    const d = realCliDeps(home, { env: {} });
    await expect(d.resolveWorkspace()).resolves.toBe(workspaceRoot);
    await expect(d.resolveRunContext()).rejects.toThrow(RunContextError);
  });

  it('a missing profile fails resolveWorkspace with a clear error', async () => {
    await expect(realCliDeps(home, { env: {} }).resolveWorkspace()).rejects.toThrow(/Profile not found/);
  });

  it('readManifest / writeManifest / writeReport locate the run through the profile workspace', async () => {
    const m = writeRun();
    const d = realCliDeps(home, { env: {} });
    expect((await d.readManifest(SLUG))?.slug).toBe(SLUG);
    expect(await d.readManifest('other')).toBeUndefined();
    const reportPath = await d.writeReport(SLUG);
    expect(reportPath).toBe(runPaths(SLUG, { home, workspaceRoot }).reportMd);
    await d.writeManifest(SLUG, { ...m, nudges: 3 });
    expect((await d.readManifest(SLUG))?.nudges).toBe(3);
  });

  it('finds a launched run through its HOME-keyed snapshot first, even if the profile now points elsewhere or is gone', async () => {
    const m = writeRun();
    const d = realCliDeps(home, { env: {} });
    rmSync(join(home, '.config'), { recursive: true });
    expect(runContextPath(SLUG, home)).toBe(runPaths(SLUG, { home, workspaceRoot }).runContextJson);
    expect((await d.readManifest(SLUG))?.slug).toBe(SLUG);
    expect(await d.writeReport(SLUG)).toBe(runPaths(SLUG, { home, workspaceRoot }).reportMd);
    expect(m.workspaceRoot).toBe(workspaceRoot);
    // a run without a snapshot falls back to the profile workspace (then fails without one)
    await expect(d.readManifest('not-launched')).rejects.toThrow(/Profile not found/);
  });

  it('writeManifest writes where the manifest says its workspace is', async () => {
    const m = writeRun();
    const other = join(home, 'other-ws');
    mkdirSync(other, { recursive: true });
    const d = realCliDeps(home, { env: {} });
    await d.writeManifest('moved-run', { ...m, slug: 'moved-run', workspaceRoot: other, runDir: runPaths('moved-run', { home, workspaceRoot: other }).runDir });
    expect(existsSync(runPaths('moved-run', { home, workspaceRoot: other }).runJson)).toBe(true);
    expect(existsSync(runPaths('moved-run', { home, workspaceRoot }).runJson)).toBe(false);
  });

  it('writeRunContext is the snapshot writer: mode 0600 at <controlDir>/run-context.json', async () => {
    writeProfileFile();
    const d = realCliDeps(home, { env: {} });
    const snap = await d.resolveRunContext();
    const dir = controlDir(SLUG, home);
    d.writeRunContext(dir, snap);
    expect(statSync(join(dir, 'run-context.json')).mode & 0o777).toBe(0o600);
    expect(readRunContext(dir)).toEqual(snap);
    expect(runPaths(SLUG, { home, workspaceRoot }).controlDir).toBe(dir);
  });
});

describe('guard canary gets the run safety inputs', () => {
  it('guardConfigFor with safety equals the config the plugin builds from the same buildGuardEnv input', () => {
    writeProfileFile({ deny: { editPaths: ['**/generated/**'], secretPaths: ['.acme'] } });
    const { safety } = resolveRunContext({ home, env: {}, fs: nodeFs });
    const paths = runPaths(SLUG, { home, workspaceRoot });
    const input = { home, workspaceRoot, slug: SLUG, controlDir: paths.controlDir, tmpDir: runTmpDir(SLUG), runDir: paths.runDir, xdgDataHome: paths.xdgDataHome, now: 1 };
    const withSafety = guardConfigFor({ ...input, safety });
    const expected = { ...configFromEnv(buildGuardEnv({ slug: SLUG, workspaceRoot, controlDir: paths.controlDir, tmpDir: runTmpDir(SLUG), safety })) };
    expect(withSafety).toMatchObject(expected);
  });

  it('runGuardCanary evaluates every case with the config built from the safety inputs', () => {
    writeProfileFile();
    const { safety } = resolveRunContext({ home, env: {}, fs: nodeFs });
    const seen: unknown[] = [];
    const spy: typeof decide = (event, cfg) => {
      seen.push(cfg);
      return decide(event, cfg);
    };
    const paths = runPaths(SLUG, { home, workspaceRoot });
    const expectedCfg = guardConfigFor({ home, workspaceRoot, slug: SLUG, controlDir: paths.controlDir, tmpDir: runTmpDir(SLUG), runDir: paths.runDir, xdgDataHome: paths.xdgDataHome, safety });
    const res = runGuardCanary({ home, workspaceRoot, slug: SLUG, controlDir: paths.controlDir, tmpDir: runTmpDir(SLUG), runDir: paths.runDir, xdgDataHome: paths.xdgDataHome, safety }, spy);
    expect(res.checked).toBeGreaterThan(0);
    expect(seen.length).toBe(res.checked);
    expect((seen[0] as { workspaceRoot?: unknown }).workspaceRoot).toEqual((expectedCfg as { workspaceRoot?: unknown }).workspaceRoot);
  });
});

describe('corpusWorktree', () => {
  it('uses the first spec repo with a real default branch, else a neutral placeholder', () => {
    const repos = [
      { path: '/w/acme-web', defaultBranch: '-' },
      { path: '/w/acme-api', defaultBranch: 'main' },
    ];
    expect(corpusWorktree('/w', 'run-1', repos)).toBe('/w/acme-api/.worktrees/run-1/x');
    expect(corpusWorktree('/w', 'run-1', [repos[0]!])).toBe('/w/repo/.worktrees/run-1/x');
    expect(corpusWorktree('/w', 'run-1', [])).toBe('/w/repo/.worktrees/run-1/x');
  });

});

describe('deps construct without side effects', () => {
  it('realCliDeps: nothing is created, spawned or locked by constructing or by read-only calls', async () => {
    writeProfileFile();
    const before = snapshotTree(home);
    const d = realCliDeps(home, { env: {} });
    expect(snapshotTree(home)).toEqual(before);
    expect(d.home).toBe(home);
    expect(d.orchestratorEntry).toBe(ORCHESTRATOR_ENTRY);
    expect(d.orchestratorEntry).toBe(join(REPO_ROOT, 'bin', 'nightgem-orchestrator.mjs'));
    expect(existsSync(d.orchestratorEntry)).toBe(true);
    expect(d.model).toBe('anthropic/claude-opus-5-5');
    expect(await d.readManifest(SLUG)).toBeUndefined();
    expect(await d.readControlFlags(join(home, 'Library', 'Application Support', 'other-tool', SLUG))).toBeUndefined();
    expect(await d.lockIsFree()).toBe(true);
    expect(snapshotTree(home)).toEqual(before);
  });

  it('NIGHTGEM_MODEL overrides the model; the profile model applies without it; a broken profile falls back to the env', () => {
    writeProfileFile({ models: { orchestrator: 'openai/gpt-9' } });
    expect(realCliDeps(home, { env: {} }).model).toBe('openai/gpt-9');
    expect(realCliDeps(home, { env: { NIGHTGEM_MODEL: 'anthropic/claude-sonnet-5-5' } }).model).toBe('anthropic/claude-sonnet-5-5');
    rmSync(join(home, '.config'), { recursive: true });
    expect(realCliDeps(home, { env: {} }).model).toBe('anthropic/claude-opus-5-5');
    expect(realCliDeps(home, { env: { NIGHTGEM_MODEL: 'anthropic/claude-sonnet-5-5' } }).model).toBe('anthropic/claude-sonnet-5-5');
  });

  it('realOrchestratorDeps: reads RUN.json only; ledger and flags come from the manifest, nothing is written', () => {
    writeRun();
    const before = snapshotTree(home);
    const d = realOrchestratorDeps(SLUG, home, { env: { PATH: '/usr/bin', NIGHTGEM_OPENCODE_BIN: '/x/opencode', NIGHTGEM_SANDBOX: '0', NIGHTGEM_SMALL_MODEL: 'anthropic/claude-haiku-5-5' } });
    expect(snapshotTree(home)).toEqual(before);
    expect(d.slug).toBe(SLUG);
    expect(d.pid).toBe(process.pid);
    expect(d.lockPath).toBe(defaultLockPath(home));
    expect(d.opencodeBin).toBe('/x/opencode');
    expect(d.sandbox).toBe(false);
    // home, workspaceRoot + the run tmp dir, plus the snapshot's resolved models and safety inputs
    expect(d.serverInput).toMatchObject({ home, workspaceRoot, tmpDir: runTmpDir(SLUG), safety: { workspaceRoot } });
    expect(d.serverInput.agentModels?.fixer).toEqual({ model: 'anthropic/claude-sonnet-5-5', variant: 'high' });
    expect(d.tmpDir).toBe(runTmpDir(SLUG));
    expect(d.ledger.budgetUsd).toBe(42);
    expect(d.ledger.softPct).toBe(0.8);
    expect(d.ledger.hardPct).toBe(1.1);
    expect(d.ledger.costMultiplier).toBe(3);
    expect(d.secrets).toEqual([]);
    for (const k of ['startServer', 'waitForAgents', 'preflight', 'createPump', 'checkTripwires', 'protectFiles', 'headSha', 'writeReport', 'cleanupLaunchd', 'renderPrompt'] as const) {
      expect(d[k], k).toBeTypeOf('function');
    }
  });

  describe('ledger re-hydration from cost.jsonl and the attempts', () => {
    const costLine = (sessionId: string, costUsd: number, phase = 'build') =>
      JSON.stringify({ ts: '2026-10-20T10:00:00.000Z', sessionId, parentId: null, phase, costUsd, estimated: false, source: 'session-info', totalUsd: costUsd });
    const writeCost = (lines: string[]) => {
      const paths = runPaths(SLUG, { home, workspaceRoot });
      mkdirSync(paths.runDir, { recursive: true });
      writeFileSync(paths.costJsonl, `${lines.join('\n')}\n`);
    };
    const info = (id: string, cost: number) => ({ id, cost, time: { created: 1, updated: 2 }, location: { directory: '/tmp/run' } }) as never;

    it('two attempts: baselines from the latest cost.jsonl lines (a malformed line is skipped), costAtStartUsd from the last attempt', () => {
      const attempts = [
        { n: 1, startedAt: '2026-10-20T09:00:00.000Z', endedAt: '2026-10-20T10:00:00.000Z', state: 'aborted-budget', stopReason: 'budget-hard', budgetUsd: 5, costAtStartUsd: 0, costUsd: 4 },
        { n: 2, startedAt: '2026-10-21T09:00:00.000Z', budgetUsd: 42, costAtStartUsd: 12 },
      ];
      writeRun({ attempts });
      writeCost([costLine('p1', 1, 'plan'), 'not json {', costLine('b1', 1.5), costLine('b1', 3)]);
      const before = snapshotTree(home);
      const d = realOrchestratorDeps(SLUG, home, { env: {} });
      expect(snapshotTree(home)).toEqual(before);
      expect(d.ledger.baselineUsd).toBeCloseTo(4 * 3); // (1 + 3) raw, times the manifest multiplier 3
      expect(d.ledger.costAtStartUsd).toBe(12); // the last attempt's, not the first's 0
      expect(d.ledger.budgetUsd).toBe(42);
      d.ledger.ingestSession(info('p1', 1));
      d.ledger.ingestSession(info('b1', 3));
      expect(d.ledger.cumulativeUsd).toBeCloseTo(12);
      expect(d.ledger.attemptSpendUsd).toBe(0);
      // old sessions keep the phase from cost.jsonl
      expect(d.ledger.perPhase(() => 'report').plan.costUsd).toBe(1);
      expect(d.ledger.toCostLines(() => 'report')).toEqual([]);
    });

    it('a v1 manifest has one implicit attempt with costAtStartUsd 0', () => {
      writeRun({ costUsd: 6 });
      writeCost([costLine('a', 2)]);
      const d = realOrchestratorDeps(SLUG, home, { env: {} });
      expect(d.ledger.costAtStartUsd).toBe(0);
      expect(d.ledger.baselineUsd).toBeCloseTo(6);
      d.ledger.ingestSession(info('a', 2.5));
      // the implicit attempt started at 0, so the floor makes attempt spend the whole cumulative cost (2.5 raw, times 3)
      expect(d.ledger.attemptSpendUsd).toBeCloseTo(7.5);
      expect(d.ledger.attemptSpendUsd).toBeCloseTo(d.ledger.cumulativeUsd);
    });

    it('a missing cost.jsonl is a fresh run: zero baselines, attempt spend equals cumulative', () => {
      writeRun();
      expect(existsSync(runPaths(SLUG, { home, workspaceRoot }).costJsonl)).toBe(false);
      const d = realOrchestratorDeps(SLUG, home, { env: {} });
      expect(d.ledger.baselineUsd).toBe(0);
      expect(d.ledger.costAtStartUsd).toBe(0);
      d.ledger.ingestSession(info('a', 2));
      expect(d.ledger.attemptSpendUsd).toBe(d.ledger.cumulativeUsd);
    });
  });

  it('sandbox is on by default', () => {
    writeRun();
    expect(realOrchestratorDeps(SLUG, home, { env: {} }).sandbox).toBe(true);
  });

  it('a missing run is a clear error, not a crash', () => {
    seedContext();
    writeRunContext(controlDir('nope', home), resolveRunContext({ home, env: {}, fs: nodeFs }));
    expect(() => realOrchestratorDeps('nope', home, { env: {} })).toThrow(/No run "nope".*RUN\.json does not exist/);
  });

  it('a log field called "event" cannot overwrite the log event name', () => {
    writeRun();
    const d = realOrchestratorDeps(SLUG, home, { env: {} });
    mkdirSync(d.paths.runDir, { recursive: true });
    d.logger('ledger.event', { event: 'soft', ts: 'x' });
    const line = JSON.parse(readFileSync(d.paths.orchestratorLog, 'utf8').trim());
    expect(line).toEqual({ event: 'ledger.event', fieldEvent: 'soft', ts: 'x' });
  });

  it('the run tmp dir is removed by removeTmp, and only ever a nightgem-* dir', () => {
    writeRun();
    const d = realOrchestratorDeps(SLUG, home, { env: {} });
    mkdirSync(d.tmpDir!, { recursive: true });
    writeFileSync(join(d.tmpDir!, 'x'), 'y');
    d.removeTmp!();
    expect(existsSync(d.tmpDir!)).toBe(false);
    expect(() => removeRunTmp(home)).toThrow(/Refusing/);
    expect(existsSync(home)).toBe(true);
  });

  it('the launch-time NIGHTGEM_<AGENT>_MODEL overrides reach the server input through the snapshot', () => {
    seedContext({}, { NIGHTGEM_FIXER_MODEL: 'anthropic/claude-opus-5-5', NIGHTGEM_DESIGNER_MODEL: 'openai/gpt-9#high' });
    writeRun();
    const d = realOrchestratorDeps(SLUG, home, { env: {} });
    expect(d.serverInput.agentModels).toMatchObject({ fixer: { model: 'anthropic/claude-opus-5-5', variant: 'high' }, designer: { model: 'openai/gpt-9', variant: 'high' } });
    expect(agentModelOverrides({})).toBeUndefined();
    expect(() => agentModelOverrides({ NIGHTGEM_ORACLE_MODEL: 'nomodel' })).toThrow(/Invalid model/);
  });

  it('the logger appends JSON lines to orchestrator.log', () => {
    writeRun();
    const d = realOrchestratorDeps(SLUG, home, { env: {} });
    mkdirSync(d.paths.runDir, { recursive: true });
    d.logger('phase.start', { phase: 'plan' });
    d.logger('final', { state: 'completed' });
    const lines = readFileSync(d.paths.orchestratorLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { event: 'phase.start', phase: 'plan' },
      { event: 'final', state: 'completed' },
    ]);
  });

  it('cleanupLaunchd deletes the plist and detaches a delayed bootout of this job (it never waits for itself)', async () => {
    const m = writeRun();
    const detached: Array<[string, string[]]> = [];
    const opts: OrchestratorWiringOptions = { env: {}, detach: (c, a) => void detached.push([c, a]) };
    const d = realOrchestratorDeps(SLUG, home, opts);
    mkdirSync(d.paths.controlDir, { recursive: true });
    const plist = join(d.paths.controlDir, `${m.launchdLabel}.plist`);
    writeFileSync(plist, '<plist/>');
    await d.cleanupLaunchd();
    expect(existsSync(plist)).toBe(false);
    expect(detached).toHaveLength(1);
    expect(detached[0]![0]).toBe('/bin/sh');
    // the label is a positional argument of `sh -c`, never part of the script text
    expect(detached[0]![1]).toEqual(['-c', expect.stringContaining('launchctl bootout "gui/'), 'sh', m.launchdLabel, plist]);
    expect(detached[0]![1][1]).not.toContain(m.launchdLabel);
    expect(detached[0]![1][1]).not.toContain(plist);
    expect(detached[0]![1][1]).toContain(`gui/${process.getuid?.() ?? 501}/$1`);
    // a job bootstrapped again meanwhile (resume writes its plist first) is not ours to boot out
    expect(detached[0]![1][1]).toMatch(/^sleep 2; \[ -e "\$2" \] \|\| \/bin\/launchctl bootout /);
    await d.cleanupLaunchd(); // already gone: still fine

    // run the real script with the sleep and launchctl swapped for harmless stand-ins: the guard decides
    const script = detached[0]![1][1]!.replace('sleep 2', 'true').replace('/bin/launchctl', 'echo').replace(' >/dev/null 2>&1', '');
    const run = (plistPath: string) => execFileSync('/bin/sh', ['-c', script, 'sh', m.launchdLabel, plistPath], { encoding: 'utf8' });
    // our own finalize deleted the plist, nothing replaced it: the job is ours to boot out
    expect(run(plist)).toContain(`bootout gui/${process.getuid?.() ?? 501}/${m.launchdLabel}`);
    writeFileSync(plist, '<plist/>'); // a resume wrote its plist before bootstrapping
    expect(run(plist)).toBe('');
  });

  it('cleanupLaunchd accepts a legacy-style label', async () => {
    const m = writeRun({ launchdLabel: `com.example.something.${SLUG}` });
    const detached: Array<[string, string[]]> = [];
    const d = realOrchestratorDeps(SLUG, home, { env: {}, detach: (c, a) => void detached.push([c, a]) });
    await d.cleanupLaunchd();
    expect(detached[0]![1].slice(-2)).toEqual([m.launchdLabel, join(d.paths.controlDir, `${m.launchdLabel}.plist`)]);
  });

  it.each([
    ['dot-dot slash', `../victim.${SLUG}`],
    ['slash', `a/b.${SLUG}`],
    ['space', `a b.${SLUG}`],
    ['semicolon', `a;touch pwned.${SLUG}`],
    ['command substitution', `$(id).${SLUG}`],
    ['backtick', `\`id\`.${SLUG}`],
  ])('cleanupLaunchd refuses a %s label: nothing is unlinked or signalled', async (_n, label) => {
    writeRun({ launchdLabel: label });
    const detached: Array<[string, string[]]> = [];
    const d = realOrchestratorDeps(SLUG, home, { env: {}, detach: (c, a) => void detached.push([c, a]) });
    // a file the escaping label would have pointed at
    const victim = join(d.paths.controlDir, '..', 'victim.' + SLUG + '.plist');
    mkdirSync(d.paths.controlDir, { recursive: true });
    writeFileSync(victim, 'keep');
    await expect(d.cleanupLaunchd()).rejects.toThrow(/launchd label/);
    expect(existsSync(victim)).toBe(true);
    expect(detached).toHaveLength(0);
  });

  it('cleanupLaunchd refuses a manifest whose slug is not the run\'s', async () => {
    writeRun({ slug: 'other-run' });
    const detached: Array<[string, string[]]> = [];
    const d = realOrchestratorDeps(SLUG, home, { env: {}, detach: (c, a) => void detached.push([c, a]) });
    await expect(d.cleanupLaunchd()).rejects.toThrow(/records the slug "other-run"/);
    expect(detached).toHaveLength(0);
  });

  it('writeReport / headSha / protectFiles are the real implementations', async () => {
    writeRun();
    const d = realOrchestratorDeps(SLUG, home, { env: {} });
    const repo = makeRepo('r1');
    expect(await d.headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
    mkdirSync(d.paths.specsDir, { recursive: true });
    writeFileSync(d.paths.specMd, '# spec');
    const protectedFiles = await d.protectFiles([d.paths.specMd]);
    expect(protectedFiles[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await d.writeReport(d.paths);
    expect(existsSync(d.paths.reportMd)).toBe(true);
  });
});

describe('lock handoff: what the CLI leaves behind for the orchestrator', () => {
  it('the CLI lock records the run slug and pid; lockIsFree and lockHolder reflect the holder; a live holder is never force-released', async () => {
    const d = realCliDeps(home, { env: {} });
    expect(await d.lockHolder()).toBeUndefined();
    const lock = await d.acquireLock(SLUG);
    const info = readLockInfo(defaultLockPath(home));
    expect(info).toMatchObject({ pid: process.pid, slug: SLUG });
    expect(await d.lockHolder()).toEqual({ pid: process.pid, slug: SLUG, alive: true });
    expect(await d.lockIsFree()).toBe(false); // the holder (this process) is alive
    await d.releaseLock('some-other-run'); // not ours: untouched
    await d.releaseLock(SLUG); // ours by slug, but its holder is alive: a live process keeps what it holds
    expect(existsSync(defaultLockPath(home))).toBe(true);
    await lock.release(); // the holder lets go itself
    expect(existsSync(defaultLockPath(home))).toBe(false);
    await lock.release(); // idempotent
    expect(await d.lockIsFree()).toBe(true);
    expect(await d.lockHolder()).toBeUndefined();
  });

  it('releaseLock(slug) frees a lock whose holder is dead, and only that run\'s', async () => {
    mkdirSync(dirname(defaultLockPath(home)), { recursive: true });
    const d = realCliDeps(home, { env: {} });
    const write = (slug?: string) =>
      writeFileSync(defaultLockPath(home), `${JSON.stringify({ pid: 999_999, token: 't', ts: new Date().toISOString(), ...(slug ? { slug } : {}) })}\n`);
    write(SLUG);
    expect(await d.lockHolder()).toEqual({ pid: 999_999, slug: SLUG, alive: false });
    await d.releaseLock('some-other-run');
    expect(existsSync(defaultLockPath(home))).toBe(true);
    await d.releaseLock(SLUG);
    expect(existsSync(defaultLockPath(home))).toBe(false);
    write(); // an old-format lock with no slug
    await d.releaseLock(SLUG);
    expect(existsSync(defaultLockPath(home))).toBe(false);
  });

  it('lockHolder reports an unparsable lock file as no holder', async () => {
    mkdirSync(dirname(defaultLockPath(home)), { recursive: true });
    writeFileSync(defaultLockPath(home), 'garbage');
    expect(await realCliDeps(home, { env: {} }).lockHolder()).toBeUndefined();
  });

  it('a lock whose holder died (the exited CLI) counts as free', async () => {
    mkdirSync(dirname(defaultLockPath(home)), { recursive: true });
    writeFileSync(defaultLockPath(home), `${JSON.stringify({ pid: 999_999, token: 't', ts: new Date().toISOString(), slug: SLUG })}\n`);
    expect(await realCliDeps(home, { env: {} }).lockIsFree()).toBe(true);
  });
});

describe('baseline tolerance (AD2.7: every repo under the workspace root)', () => {
  it('takeBaseline skips a repo with no commits and warns, instead of rejecting', async () => {
    const good = makeRepo('good');
    const empty = makeRepo('empty', { commit: false });
    const warnings: Array<{ path: string; reason: string }> = [];
    const baseline = await takeBaseline([good, empty], undefined, { onWarning: (w) => warnings.push(w) });
    expect(Object.keys(baseline)).toEqual([good]);
    expect(warnings).toEqual([{ path: empty, reason: 'no HEAD (repository has no commits)' }]);
  });

  it('buildBaseline: spec repos with their default branch, every other repo with "-", unborn repos skipped with a warning', async () => {
    const spec = makeRepo('spec-repo');
    const other = makeRepo('other-repo');
    const empty = makeRepo('empty-repo', { commit: false });
    mkdirSync(join(workspaceRoot, 'not-a-repo'), { recursive: true });
    const warnings: string[] = [];
    const entries = await buildBaseline(workspaceRoot, [spec], { onWarning: (w) => warnings.push(`${w.path}: ${w.reason}`) });

    expect(entries.map((e) => [e.name, e.defaultBranch]).sort()).toEqual([
      ['other-repo', '-'],
      ['spec-repo', 'main'],
    ]);
    expect(entries.find((e) => e.path === spec)?.baseline.head).toMatch(/^[0-9a-f]{40}$/);
    expect(entries.find((e) => e.path === other)?.baseline.branch).toBe('main');
    expect(warnings).toEqual([`${empty}: no HEAD (repository has no commits)`]);
    // the result is valid RUN.json material
    expect(() => RunManifest.parse({ schemaVersion: 2, workspaceRoot: '/w', slug: SLUG, budgetUsd: 1, state: 'launching', phase: 'plan', launchdLabel: 'l', controlDir: '/c', runDir: '/r', xdgDataHome: '/x', model: 'a/b', createdAt: 'now', repos: entries })).not.toThrow();
  });

  it('a spec repo that cannot be baselined is skipped too (warning, no throw)', async () => {
    const empty = makeRepo('only-empty', { commit: false });
    const warnings: string[] = [];
    expect(await buildBaseline(workspaceRoot, [empty], { onWarning: (w) => warnings.push(w.reason) })).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('discovery failures are a warning as well', async () => {
    const warnings: string[] = [];
    const entries = await buildBaseline(workspaceRoot, [], {
      discover: async () => {
        throw new Error('EACCES');
      },
      onWarning: (w) => warnings.push(w.reason),
    });
    expect(entries).toEqual([]);
    expect(warnings[0]).toMatch(/cannot scan for repos: EACCES/);
  });

  it('discoverRepos sees the same repos buildBaseline covers', async () => {
    const a = makeRepo('a');
    expect(await discoverRepos(workspaceRoot)).toEqual([a]);
  });

  it('detectDefaultBranch: main/master, current branch, "-" when unborn', async () => {
    const r = makeRepo('db');
    expect(await detectDefaultBranch(r)).toBe('main');
    sh(r, 'branch', '-m', 'main', 'trunk');
    expect(await detectDefaultBranch(r)).toBe('trunk');
    expect(await detectDefaultBranch(makeRepo('unborn', { commit: false }))).toBe('-');
  });

  it('specRemoteRules: local bare origins (path and file://) and remote hosts are all covered by pushInsteadOf', async () => {
    const bare = join(home, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const withLocal = makeRepo('with-local');
    sh(withLocal, 'remote', 'add', 'origin', bare);
    const withRemote = makeRepo('with-remote');
    sh(withRemote, 'remote', 'add', 'origin', 'git@github.com:acme/x.git');
    const without = makeRepo('without');
    const rules = await specRemoteRules([withLocal, withRemote, without]);
    expect(rules.pushInsteadOf).toEqual([bare, `file://${bare}`, 'git@github.com:', 'git@github.com:acme/x.git'].sort());
    expect(rules.insteadOf).toEqual([]);
  });
});

describe('plist', () => {
  it('ExitTimeOut is 120 s so the graceful stop (interrupt rounds, final reconcile) can finish', () => {
    expect(EXIT_TIMEOUT_SECONDS).toBe(120);
    const xml = renderPlist({
      label: launchdLabel(SLUG),
      programArgs: buildProgramArgs({ nodePath: '/n/node', orchestratorEntry: ORCHESTRATOR_ENTRY, slug: SLUG }),
      env: { PATH: '/a' },
      stdout: '/o',
      stderr: '/e',
      workingDir: '/w',
    });
    expect(xml).toContain('<key>ExitTimeOut</key>\n  <integer>120</integer>');
    expect(xml).toContain('<key>KeepAlive</key>\n  <false/>');
  });

  it('ProgramArguments invoke the orchestrator entry as `node <entry> --slug <slug>` and that file exists', () => {
    const args = buildProgramArgs({ nodePath: process.execPath, orchestratorEntry: realCliDeps(home, { env: {} }).orchestratorEntry, slug: SLUG });
    expect(args).toEqual(['/usr/bin/caffeinate', '-ims', process.execPath, ORCHESTRATOR_ENTRY, '--slug', SLUG]);
    expect(existsSync(args[3]!)).toBe(true);
    expect(parseArgs(args.slice(4))).toEqual({ slug: SLUG });
  });
});

describe('entry', () => {
  it('parseArgs accepts --slug <v> and --slug=<v>', () => {
    expect(parseArgs(['--slug', 'abc'])).toEqual({ slug: 'abc' });
    expect(parseArgs(['--slug=abc-1'])).toEqual({ slug: 'abc-1' });
  });

  it.each([[[]], [['--slug']], [['--slug', 'Bad_Slug']], [['--slug', 'a', '--extra']], [['abc']]] as Array<[string[]]>)('parseArgs rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it('main returns 1 with a clear message for a missing run, a bad slug, or no args', async () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(' '));
    try {
      seedContext();
      writeRunContext(controlDir('does-not-exist', home), resolveRunContext({ home, env: {}, fs: nodeFs }));
      expect(await orchestratorMain(['--slug', 'does-not-exist'], home)).toBe(1);
      expect(await orchestratorMain(['--slug', 'Bad_Slug'], home)).toBe(1);
      expect(await orchestratorMain([], home)).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(errs.join('\n')).toMatch(/No run "does-not-exist"/);
    expect(errs.join('\n')).toMatch(/Invalid slug/);
    expect(errs.join('\n')).toMatch(/missing --slug/);
  });

  it('bin/nightgem-orchestrator.mjs: exits 1 with a message for an unknown run, quickly (no hang), from any cwd', () => {
    seedContext();
    writeRunContext(controlDir('does-not-exist', home), resolveRunContext({ home, env: {}, fs: nodeFs }));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [ORCHESTRATOR_ENTRY, '--slug', 'does-not-exist'], { cwd: tmpdir(), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/orchestrator: No run "does-not-exist"/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe('signals', () => {
  it('subscribes, unsubscribes, and leaves a no-op handler so a late SIGTERM cannot kill the finalizing process', () => {
    const proc = new EventEmitter();
    const sig = processSignals(proc as unknown as NodeJS.Process);
    let calls = 0;
    const off = sig.on('SIGTERM', () => calls++);
    proc.emit('SIGTERM');
    expect(calls).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    off();
    expect(proc.listenerCount('SIGTERM')).toBe(1); // the no-op
    proc.emit('SIGTERM');
    expect(calls).toBe(1);
    sig.on('SIGTERM', () => calls++)();
    expect(proc.listenerCount('SIGTERM')).toBe(1); // still exactly one no-op
  });
});

describe('doctor checks and bin resolution', () => {
  const exec = (models: string, code = 0): ExecFn => async () => ({ stdout: models, stderr: '', exitCode: code });
  const ALL = 'anthropic/claude-opus-5-5\nanthropic/claude-haiku-5-5\nanthropic/claude-sonnet-5-5\n';

  /** A machine that satisfies every environment check: slim 3.x configured and cached, the 5 core skills installed. */
  function healthyHome(extraProfile: Record<string, unknown> = {}): void {
    writeProfileFile(extraProfile);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['oh-my-opencode-slim@3.0.4'] }));
    const pkg = join(home, '.cache', 'opencode', 'npm', 'oh-my-opencode-slim@3.0.4', '1', 'node_modules', 'oh-my-opencode-slim');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '3.0.4' }));
    for (const n of ['spec-driven-development', 'planning-and-task-breakdown', 'test-driven-development', 'incremental-implementation', 'code-review-and-quality']) {
      mkdirSync(join(home, '.agents', 'skills', n), { recursive: true });
      writeFileSync(join(home, '.agents', 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n`);
    }
  }
  const run = (models: string, env: Record<string, string> = {}) => wiringChecks(home, { exec: exec(models), env, fs: nodeFs });

  it('passes on a clean tree and lists the models', async () => {
    healthyHome();
    const checks = await run(ALL);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.name === 'models available')!.detail).toContain('anthropic/claude-sonnet-5-5');
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(['orchestrator entry', 'guard plugin', 'ssh fetch-only wrapper', 'profile', 'oh-my-opencode-slim', 'required skills', 'probe corpus', 'no ancestor opencode config', 'models available']));
  });

  it('the orchestrator entry must load, not just exist (a stale or missing dist/ is a hard FAIL)', async () => {
    healthyHome();
    const failingCheck: ExecFn = async (cmd, args) =>
      args?.includes('--check')
        ? { stdout: '', stderr: 'failed to start: no compiled output, run `npm run build`', exitCode: 1 }
        : { stdout: ALL, stderr: '', exitCode: 0 };
    const checks = await wiringChecks(home, { exec: failingCheck, env: {}, fs: nodeFs });
    const entry = checks.find((c) => c.name === 'orchestrator entry')!;
    expect(entry).toMatchObject({ ok: false, hard: true });
    expect(entry.detail).toContain('npm run build');
  });

  it('a missing profile is one FAIL with the install hint and the dependent checks are skipped', async () => {
    const checks = await run(ALL);
    const profile = checks.filter((c) => c.name === 'profile');
    expect(profile).toHaveLength(1);
    expect(profile[0]).toMatchObject({ ok: false, hard: true });
    expect(profile[0]!.detail).toMatch(/nightgem\.mjs install --workspace <dir>/);
    expect(checks.some((c) => c.name === 'probe corpus' || c.name === 'required skills')).toBe(false);
  });

  it('flags an ancestor opencode config (slim walks every ancestor) as a hard failure', async () => {
    healthyHome();
    mkdirSync(join(workspaceRoot, '.opencode'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.opencode', 'opencode.json'), '{}');
    const c = (await run(ALL)).find((x) => x.name === 'no ancestor opencode config')!;
    expect(c).toMatchObject({ ok: false, hard: true });
  });

  it('resolveBin finds an executable on PATH and nothing for a missing one', () => {
    expect(resolveBin('sh', '/nonexistent:/bin')).toBe('/bin/sh');
    expect(resolveBin('definitely-not-a-binary', '/bin:/usr/bin')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canary / preflight against a scripted fake server API
// ---------------------------------------------------------------------------

const SECRET = 'SECRET-OUTPUT-must-never-be-logged';

/** Neutral safety inputs for the preflight tests: no user denies, no skill roots. */
const safetyFor = (root: string): SafetyInputs => ({ workspaceRoot: root, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } });

/** `runPreflight` with the test's home (the default would be the real one) and neutral safety inputs unless given. */
const preflightIn = (ctx: Parameters<typeof runPreflight>[0], env: Parameters<typeof runPreflight>[1], opts: Partial<Parameters<typeof runPreflight>[2]> = {}) =>
  runPreflight(ctx, env, { home, safety: safetyFor(ctx.paths.workspaceRoot), ...opts });

interface CanaryScript {
  /** LLM canary: one entry per attempt (new session each), command -> outcome */
  attempts?: Array<Array<{ command: string; outcome: 'failed' | 'exit0' | 'exit1' }>>;
  asks?: number;
  cost?: number;
  silent?: boolean;
  /** /shell: substrings of commands that "succeed" (exit 0); everything else exits 1 */
  shellRuns?: string[];
  /** /shell: replace the whole result */
  shellOverride?: (command: string) => ShellResult | Error | undefined;
  noShell?: boolean;
  /** /shell: substrings of must-succeed (temp file and diagnostic) commands that exit 1 instead of 0 */
  shellFails?: string[];
}

/** Commands of the must-succeed `/shell` probes (temp files, diagnostics): the fake lets them pass unless a script says otherwise. */
const MUST_SUCCEED_MARKERS = ['heredoc-probe', 'mktemp', 'ZSH_VERSION', '"$TMPDIR" =', 'TMPPREFIX'];

interface FakeCanary {
  api: ServerApi;
  eventsCalled: () => number;
  sessionsCreated: () => string[];
  prompts: string[];
  replies: string[];
  shellCommands: string[];
}

function fakeCanaryApi(script: CanaryScript): FakeCanary {
  let push: (ev: ServerEvent) => void = () => undefined;
  let eventsCalled = 0;
  const replies: string[] = [];
  const prompts: string[] = [];
  const created: string[] = [];
  const shellCommands: string[] = [];
  let sid = '';
  let attempt = -1;
  const session = (id: string, cost: number) => ({ id, cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, location: { directory: '/r' } });
  const base: Record<string, unknown> = {
    async listAgents() {
      return ['orchestrator', 'fixer', 'oracle', 'designer', 'explorer', 'librarian'].map((id) => ({ id, permissions: [{ action: '*', resource: '*', effect: 'allow' }] }));
    },
    async evalPermission() {
      return 'deny' as const;
    },
    async createSession(input: { title?: string }) {
      sid = `ses_${created.length}`;
      created.push(input.title ?? '');
      return session(sid, 0);
    },
    async prompt(_id: string, input: { text: string }) {
      prompts.push(input.text);
      expect([CANARY_PROMPT, CANARY_RETRY_PROMPT]).toContain(input.text);
      attempt++;
      if (script.silent) return;
      const calls = script.attempts?.[Math.min(attempt, script.attempts.length - 1)] ?? [];
      const mine = sid;
      setTimeout(() => {
        const ev = (type: string, data: Record<string, unknown>) => push(ServerEvent.parse({ type, data: { sessionID: mine, ...data } }));
        ev('session.execution.started', {});
        calls.forEach((c, i) => {
          ev('session.tool.called', { id: `t${i}`, input: { command: c.command } });
          if (c.outcome === 'failed') ev('session.tool.failed', { id: `t${i}`, error: { type: 'permission.rejected', message: 'denied' } });
          else ev('session.tool.success', { id: `t${i}`, content: [{ type: 'text', text: SECRET }], metadata: { exit: c.outcome === 'exit0' ? 0 : 1 } });
        });
        for (let i = 0; i < (script.asks ?? 0); i++) push(ServerEvent.parse({ type: 'permission.asked', data: { id: `per_${i}`, sessionID: mine, action: 'shell', resources: ['x'] } }));
        ev('session.execution.succeeded', {});
      }, 5);
    },
    async interrupt() {
      return true;
    },
    async getSession(id: string) {
      return session(id, script.cost ?? 0.004);
    },
    async replyPermission(_s: string, requestId: string, reply: string) {
      replies.push(`${requestId}:${reply}`);
    },
    events(opts: { signal?: AbortSignal } = {}): AsyncIterable<ServerEvent> {
      eventsCalled++;
      const queue: ServerEvent[] = [];
      let wake: (() => void) | undefined;
      push = (ev) => {
        queue.push(ev);
        wake?.();
      };
      opts.signal?.addEventListener('abort', () => wake?.());
      push(ServerEvent.parse({ type: 'server.connected', data: {} }));
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<ServerEvent>> => {
            for (;;) {
              if (opts.signal?.aborted) return { done: true, value: undefined };
              const e = queue.shift();
              if (e) return { done: false, value: e };
              await new Promise<void>((r) => (wake = r));
            }
          },
          return: async () => ({ done: true, value: undefined }),
        }),
      };
    },
  };
  if (!script.noShell) {
    base.shell = async (_sid: string, command: string): Promise<ShellResult> => {
      shellCommands.push(command);
      const o = script.shellOverride?.(command);
      if (o instanceof Error) throw o;
      if (o) return o;
      if (script.shellRuns?.some((x) => command.includes(x))) return { status: 'exited', exit: 0, output: SECRET };
      if (MUST_SUCCEED_MARKERS.some((m) => command.includes(m))) return { status: 'exited', exit: script.shellFails?.some((x) => command.includes(x)) ? 1 : 0, output: '' };
      if (command.includes('remote get-url --push')) return { status: 'exited', exit: 0, output: 'nopush://github.com/example/nightgem-canary.git\n' };
      return { status: 'exited', exit: 1, output: SECRET };
    };
  }
  return { api: base as unknown as ServerApi, eventsCalled: () => eventsCalled, sessionsCreated: () => created, prompts, replies, shellCommands };
}

const ALL_BLOCKED: NonNullable<CanaryScript['attempts']>[number] = [
  { command: 'git push origin HEAD', outcome: 'failed' },
  { command: 'gh pr list', outcome: 'failed' },
  { command: 'echo canary > /tmp/x', outcome: 'exit1' },
  { command: 'cat ~/.config/opencode/opencode.json | head -1', outcome: 'failed' },
];
const NONE_TRIED: NonNullable<CanaryScript['attempts']>[number] = [{ command: 'ls', outcome: 'exit0' }];

describe('runCanary (the optional LLM layer)', () => {
  it('passes when every attempt is denied or blocked, with no asks and a low cost', async () => {
    const f = fakeCanaryApi({ attempts: [ALL_BLOCKED] });
    expect(await runCanary(f.api)).toEqual({ ok: true, failures: [], warnings: [], attempts: 4, sessionIds: ['ses_0'] });
    expect(f.prompts).toEqual([CANARY_PROMPT]);
  });

  it('the prompt is an explicit operator-authorized self-test that asks the model to attempt the probes', () => {
    expect(CANARY_PROMPT).toMatch(/OPERATOR-AUTHORIZED SELF-TEST/);
    expect(CANARY_PROMPT).toMatch(/REQUIRED to attempt/);
    for (const cmd of ['git push origin HEAD', 'gh pr list', 'echo canary > /tmp/x', 'cat ~/.config/opencode/opencode.json | head -1']) {
      expect(CANARY_PROMPT).toContain(cmd);
      expect(CANARY_RETRY_PROMPT).toContain(cmd);
    }
  });

  it('a probe that actually ran (exit 0) is FATAL, naming the probe but never the output, and is not retried', async () => {
    const f = fakeCanaryApi({ attempts: [[...ALL_BLOCKED.slice(0, 3), { command: 'cat ~/.config/opencode/opencode.json | head -1', outcome: 'exit0' }]] });
    const r = await runCanary(f.api);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['canary: "read opencode.json" ran successfully (expected denied/blocked)']);
    expect(r.warnings).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(f.sessionsCreated()).toHaveLength(1);
  });

  it('any permission.asked fails the canary, and the ask is rejected so nothing hangs', async () => {
    const f = fakeCanaryApi({ attempts: [ALL_BLOCKED], asks: 1 });
    const r = await runCanary(f.api);
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/1 permission\.asked/);
    expect(f.replies).toEqual(['per_0:reject']);
  });

  it('a canary costing $0.05 or more fails', async () => {
    const r = await runCanary(fakeCanaryApi({ attempts: [ALL_BLOCKED], cost: 0.05 }).api);
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/cost \$0\.0500 is not under \$0\.05/);
  });

  it('a model that attempts nothing is retried once with the reinforced prompt in a fresh session; if it still does, that is a warning, not a failure', async () => {
    const f = fakeCanaryApi({ attempts: [NONE_TRIED] });
    const r = await runCanary(f.api);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual(['canary inconclusive after 2 tries: the model attempted none of the probes']);
    expect(f.prompts).toEqual([CANARY_PROMPT, CANARY_RETRY_PROMPT]);
    expect(f.sessionsCreated()).toHaveLength(2);
    expect(r.sessionIds).toEqual(['ses_0', 'ses_1']);
  });

  it('the retry can succeed: no warning when the second attempt tries the probes and all are blocked', async () => {
    const f = fakeCanaryApi({ attempts: [NONE_TRIED, ALL_BLOCKED] });
    const r = await runCanary(f.api);
    expect(r).toMatchObject({ ok: true, failures: [], warnings: [], attempts: 4 });
  });

  it('a probe that runs on the retry is still fatal', async () => {
    const f = fakeCanaryApi({ attempts: [NONE_TRIED, [{ command: 'git push origin HEAD', outcome: 'exit0' }]] });
    const r = await runCanary(f.api);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['canary: "git push" ran successfully (expected denied/blocked)']);
  });

  it('a timeout interrupts and is inconclusive (warning), not a failure', async () => {
    const r = await runCanary(fakeCanaryApi({ silent: true }).api, { timeoutMs: 50 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['canary inconclusive after 2 tries: the LLM canary timed out']);
  });

  it('an API error becomes a warning, never a throw', async () => {
    const f = fakeCanaryApi({ attempts: [ALL_BLOCKED] });
    f.api.createSession = async () => {
      throw new RunApiError({ kind: 'http', message: 'x', method: 'POST', path: '/api/session', status: 503 });
    };
    const r = await runCanary(f.api);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['canary inconclusive after 2 tries: the LLM canary errored: HTTP 503']);
  });
});

// ---------------------------------------------------------------------------
// layer (i): sandbox + env through /shell
// ---------------------------------------------------------------------------

const probeInput = {
  repoDir: '/c/tmp/canary-repo',
  port: 4242,
  sandbox: true,
  specRemotes: [] as Array<{ repo: string; remotes: string[] }>,
  readDenyFile: '/h/.aws/config',
  nonce: 'abcd1234',
  tmpDir: '/c/tmp/nightgem-run',
};

const TMP_PROBE_NAMES = [
  'heredoc into a file in the run tmp dir',
  'heredoc through /bin/bash -c',
  'heredoc through /bin/sh -c',
  'mktemp (no template, through the PATH shim) and a write to it',
  'mktemp with a $TMPDIR template and a write to it',
  'diagnostic: the shell is zsh ($ZSH_VERSION is set)',
  'diagnostic: $TMPDIR is the run tmp dir',
  'diagnostic: $TMPPREFIX (zsh) is under the run tmp dir',
];

describe('buildShellProbes', () => {
  it('covers push (github-form origin + rewrite), gh, /tmp write, run-port connect and a sandbox read-deny path', () => {
    const { probes, skipped } = buildShellProbes(probeInput);
    expect(skipped).toEqual([]);
    expect(probes.map((p) => p.name)).toEqual([
      'git push (github-form origin)',
      'git push url rewritten to nopush://',
      'gh pr list',
      'gh auth status',
      ...TMP_PROBE_NAMES,
      'write /tmp',
      'write /private/var/tmp',
      'ssh to github.com (port 22)',
      'connect to the run port',
      'read a sandbox-denied credential path',
    ]);
    const byName = Object.fromEntries(probes.map((p) => [p.name, p.command]));
    expect(byName['git push (github-form origin)']).toBe("git -C '/c/tmp/canary-repo' push origin HEAD");
    expect(byName['write /tmp']).toBe('echo canary > /tmp/nightgem-canary-abcd1234');
    expect(byName['write /private/var/tmp']).toBe('echo canary > /private/var/tmp/nightgem-canary-abcd1234');
    expect(byName['ssh to github.com (port 22)']).toContain('ssh -o BatchMode=yes -o ConnectTimeout=5 -T git@github.com');
    expect(byName['connect to the run port']).toContain('http://127.0.0.1:4242/');
    expect(byName['read a sandbox-denied credential path']).toBe("cat '/h/.aws/config'");
  });

  it('adds heredoc and mktemp probes that must succeed, plus silent shell/TMPDIR diagnostics, none printing anything', () => {
    const { probes } = buildShellProbes(probeInput);
    const byName = Object.fromEntries(probes.map((p) => [p.name, p]));
    const heredoc = byName['heredoc into a file in the run tmp dir']!;
    expect(heredoc.command).toBe(
      ["f='/c/tmp/nightgem-run'/nightgem-heredoc-probe-abcd1234", `cat <<'EOF' > "$f"`, 'canary', 'EOF', '[ "$(cat "$f" 2>/dev/null)" = canary ]; rc=$?', 'rm -f "$f"', 'exit $rc'].join('\n'),
    );
    expect(byName['heredoc through /bin/bash -c']!.command).toBe(
      ['cd "$TMPDIR" || exit 1', `f='/c/tmp/nightgem-run'/nightgem-heredoc-probe-bash-abcd1234`, `/bin/bash -c 'cat <<EOF > "$1"`, 'canary', `EOF' _ "$f"`, '[ "$(cat "$f" 2>/dev/null)" = canary ]; rc=$?', 'rm -f "$f"', 'exit $rc'].join('\n'),
    );
    expect(byName['heredoc through /bin/sh -c']!.command).toContain(`/bin/sh -c 'cat <<EOF > "$1"`);
    expect(byName['heredoc through /bin/sh -c']!.command).toContain('nightgem-heredoc-probe-sh-abcd1234');
    // a bare mktemp (the PATH shim) whose result must be inside the run tmp dir
    expect(byName['mktemp (no template, through the PATH shim) and a write to it']!.command).toBe(
      ['f=$(mktemp) || exit 1', `case "$f" in '/c/tmp/nightgem-run'/*) ;; *) rm -f "$f"; exit 1;; esac`, 'echo canary > "$f"; rc=$?', 'rm -f "$f"', 'exit $rc'].join('\n'),
    );
    expect(byName['mktemp with a $TMPDIR template and a write to it']!.command).toContain('mktemp "$TMPDIR/nightgem-mktemp-probe-abcd1234.XXXXXX"');
    expect(byName['diagnostic: the shell is zsh ($ZSH_VERSION is set)']!.command).toBe('[ -n "$ZSH_VERSION" ]');
    expect(byName['diagnostic: $TMPDIR is the run tmp dir']!.command).toBe(`[ "$TMPDIR" = '/c/tmp/nightgem-run' ]`);
    expect(byName['diagnostic: $TMPPREFIX (zsh) is under the run tmp dir']!.command).toContain(`'/c/tmp/nightgem-run'/*`);
    for (const n of TMP_PROBE_NAMES) expect(byName[n]!.expect, n).toBe('succeed');
    // the temp-file probes gate the launch (no temporary flag any more); only the diagnostics never gate
    expect(Object.keys(byName['heredoc into a file in the run tmp dir']!)).not.toContain('expectedFailUntilT2');
    expect(probes.filter((p) => p.diagnostic).map((p) => p.name)).toEqual(TMP_PROBE_NAMES.slice(5));
    // the must-succeed probe for /tmp stays: writing /tmp must fail
    expect(byName['write /tmp']!.expect).toBe('fail');
    expect(byName['write /private/var/tmp']!.expect).toBe('fail');
    // no probe echoes or prints variables or paths
    for (const n of TMP_PROBE_NAMES) expect(byName[n]!.command, n).not.toMatch(/\b(echo|printf|env|printenv)\s+["$]?[A-Z]|\bset\b|\benv\b/);
  });

  it('quotes an awkward run tmp dir', () => {
    const { probes } = buildShellProbes({ ...probeInput, tmpDir: "/c/t m'p" });
    expect(probes.find((p) => p.name.startsWith('diagnostic: $TMPDIR'))?.command).toBe(`[ "$TMPDIR" = '/c/t m'\\''p' ]`);
  });

  it('skips the temp-file probes (without failing) when the run tmp dir is unknown', () => {
    const { tmpDir: _unused, ...noTmp } = probeInput;
    const { probes, skipped } = buildShellProbes(noTmp);
    expect(probes.map((p) => p.name).filter((n) => TMP_PROBE_NAMES.includes(n))).toEqual([]);
    expect(skipped.map((x) => `${x.name}: ${x.skipped}`)).toEqual(['temp files in the run tmp dir: no run tmp dir known']);
  });

  // the commands themselves are shell code: run them for real (no sandbox) with a zsh like the agent's
  it.skipIf(!existsSync('/bin/zsh'))('the temp-file probes pass in a real /bin/zsh when TMPDIR and TMPPREFIX point at a writable run tmp dir', () => {
    const run = join(home, 'run-tmp');
    mkdirSync(run, { recursive: true });
    const { probes } = buildShellProbes({ ...probeInput, tmpDir: run });
    for (const p of probes.filter((x) => TMP_PROBE_NAMES.includes(x.name))) {
      const r = spawnSync('/bin/zsh', ['-c', p.command], { env: { PATH: `${join(DEFAULT_REPO_ROOT, 'profile', 'shims')}:/usr/bin:/bin`, HOME: home, TMPDIR: run, TMPPREFIX: join(run, 'zsh') }, encoding: 'utf8', timeout: 20_000 });
      expect({ name: p.name, status: r.status, out: r.stdout + r.stderr }).toEqual({ name: p.name, status: 0, out: '' });
    }
    expect(readdirSync(run)).toEqual([]);
  });

  it.skipIf(!existsSync('/bin/zsh'))('the TMPDIR and TMPPREFIX diagnostics report false for a shell that points elsewhere, and print nothing', () => {
    const run = join(home, 'run-tmp');
    mkdirSync(run, { recursive: true });
    const { probes } = buildShellProbes({ ...probeInput, tmpDir: run });
    const status = (name: string, env: Record<string, string>): number | null =>
      spawnSync('/bin/zsh', ['-c', probes.find((p) => p.name === name)!.command], { env: { PATH: '/usr/bin:/bin', HOME: home, ...env }, encoding: 'utf8' }).status;
    expect(status(TMP_PROBE_NAMES[6]!, { TMPDIR: '/var/folders/xx/T' })).toBe(1);
    expect(status(TMP_PROBE_NAMES[7]!, { TMPDIR: run, TMPPREFIX: '/tmp/zsh' })).toBe(1);
    expect(status(TMP_PROBE_NAMES[7]!, { TMPDIR: run })).toBe(1);
  });

  it('checks every push URL of every remote of every spec repo is nopush://, shell-quoting awkward paths', () => {
    const { probes } = buildShellProbes({ ...probeInput, specRemotes: [{ repo: "/h/my repo's/x", remotes: ['origin', 'up stream'] }] });
    const ps = probes.filter((x) => x.name.startsWith('push urls of'));
    expect(ps.map((p) => p.name)).toEqual(['push urls of x remote origin are all nopush://', 'push urls of x remote up stream are all nopush://']);
    expect(ps[0]?.command).toBe(`git -C '/h/my repo'\\''s/x' remote get-url --push --all 'origin'`);
    expect(ps[1]?.command).toContain(`--all 'up stream'`);
    expect(ps[0]?.expect).toEqual({ everyLineStartsWith: 'nopush://' });
  });

  it('without a sandbox only the env-level probes are built, and the rest are reported as skipped', () => {
    const { probes, skipped } = buildShellProbes({ ...probeInput, sandbox: false });
    expect(probes.map((p) => p.name)).not.toContain('write /tmp');
    expect(probes.map((p) => p.name)).toContain('git push (github-form origin)');
    expect(skipped.map((s) => s.name)).toEqual(['write /tmp', 'write /private/var/tmp', 'ssh to github.com (port 22)', 'connect to the run port', 'read a sandbox-denied credential path']);
  });

  it('skips the port and credential probes (without failing) when there is nothing to probe', () => {
    const { probes, skipped } = buildShellProbes({ ...probeInput, port: undefined, readDenyFile: undefined });
    expect(probes.map((p) => p.name)).not.toContain('connect to the run port');
    expect(skipped.map((s) => `${s.name}: ${s.skipped}`)).toEqual(['connect to the run port: no port known', 'read a sandbox-denied credential path: no credential path present']);
  });
});

describe('ssh canary probe', () => {
  const run = (sshOutput: string): number | null => {
    const bin = join(home, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "${sshOutput}" >&2\nexit 255\n`, { mode: 0o755 });
    return spawnSync('/bin/sh', ['-c', SSH_BLOCKED_PROBE], { env: { PATH: `${bin}:/usr/bin:/bin` } }).status;
  };

  it('exits non-zero (blocked) when the connection is refused locally', () => {
    expect(run('ssh: connect to host github.com port 22: Operation not permitted')).toBe(7);
    expect(run('ssh: Could not resolve hostname github.com')).toBe(7);
  });

  it('exits 0 (open) when GitHub was reached, even if the key was refused', () => {
    expect(run('git@github.com: Permission denied (publickey).')).toBe(0);
    expect(run("Hi someone! You've successfully authenticated, but GitHub does not provide shell access.")).toBe(0);
  });
});

describe('gitFetchOrigin (spec repo pre-fetch)', () => {
  it('fetches from the origin and returns exit 0', async () => {
    const bare = join(home, 'origin.git');
    sh(home, 'init', '-q', '--bare', bare);
    const repo = makeRepo('p1');
    sh(repo, 'remote', 'add', 'origin', bare);
    sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const r = await gitFetchOrigin(repo, 30_000, process.env);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(sh(repo, 'rev-parse', 'refs/remotes/origin/main').trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a missing origin is a non-zero exit, not a throw', async () => {
    const repo = makeRepo('p2');
    const r = await gitFetchOrigin(repo, 30_000, process.env);
    expect(r.exitCode).not.toBe(0);
  });

  it('runs no program planted in the repo config (uploadpack, fsmonitor) and still fetches', async () => {
    const bare = join(home, 'origin-hostile.git');
    sh(home, 'init', '-q', '--bare', bare);
    const repo = makeRepo('p3');
    sh(repo, 'remote', 'add', 'origin', bare);
    sh(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const marker = join(home, 'planted-ran');
    const evil = join(home, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\nexec git-upload-pack "$@"\n`);
    chmodSync(evil, 0o755);
    sh(repo, 'config', 'remote.origin.uploadpack', evil);
    sh(repo, 'config', 'core.fsmonitor', evil);
    const r = await gitFetchOrigin(repo, 30_000, process.env);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('runShellCanary', () => {
  const probes = buildShellProbes(probeInput).probes;

  it('passes when every probe is blocked, recording exit codes only', async () => {
    const f = fakeCanaryApi({});
    const r = await runShellCanary(f.api, 'ses_x', probes);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.results).toHaveLength(probes.length);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(f.shellCommands).toEqual(probes.map((p) => p.command));
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a probe that succeeds fails the canary, naming the probe and exit code but never the output', async () => {
    const f = fakeCanaryApi({ shellRuns: ['echo canary > /tmp/nightgem-canary'] });
    const r = await runShellCanary(f.api, 'ses_x', probes);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['canary: "write /tmp" ran successfully (exit 0, expected it to be blocked)']);
    expect(r.results.find((x) => x.name === 'write /tmp')).toMatchObject({ ok: false, exit: 0 });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a write that succeeds in /private/var/tmp (a widened sandbox) fails the canary', async () => {
    const r = await runShellCanary(fakeCanaryApi({ shellRuns: ['echo canary > /private/var/tmp/nightgem-canary'] }).api, 's', probes);
    expect(r.failures).toEqual(['canary: "write /private/var/tmp" ran successfully (exit 0, expected it to be blocked)']);
  });

  it('every kind of probe is individually fatal when it runs', async () => {
    for (const p of probes.filter((x) => x.expect === 'fail')) {
      const r = await runShellCanary(fakeCanaryApi({ shellRuns: [p.command] }).api, 's', probes);
      expect(r.failures, p.name).toHaveLength(1);
      expect(r.failures[0]).toContain(`"${p.name}"`);
    }
  });

  it('the rewrite probe needs exit 0 and a nopush:// url', async () => {
    const rewrite = 'git push url rewritten to nopush://';
    const bad = await runShellCanary(fakeCanaryApi({ shellOverride: (c) => (c.includes('get-url') ? { status: 'exited', exit: 0, output: 'git@github.com:x/y.git\n' } : undefined) }).api, 's', probes);
    expect(bad.failures).toEqual([`canary: "${rewrite}" did not give the expected result (exit 0)`]);
    const failed = await runShellCanary(fakeCanaryApi({ shellOverride: (c) => (c.includes('get-url') ? { status: 'exited', exit: 128, output: '' } : undefined) }).api, 's', probes);
    expect(failed.failures).toEqual([`canary: "${rewrite}" did not give the expected result (exit 128)`]);
  });

  it('the all-remotes push-url probe: every line must be nopush://; mixed output and empty output fail, multi-line nopush:// passes', async () => {
    const withRemotes = buildShellProbes({ ...probeInput, specRemotes: [{ repo: '/w/acme-web', remotes: ['origin'] }] }).probes;
    const name = 'push urls of acme-web remote origin are all nopush://';
    const run = async (output: string, exit = 0) =>
      runShellCanary(fakeCanaryApi({ shellOverride: (c) => (c.includes('remote get-url --push --all') ? { status: 'exited', exit, output } : undefined) }).api, 's', withRemotes);
    expect((await run('nopush://\nnopush://\n')).failures).toEqual([]);
    expect((await run('nopush://\nhttps://bitbucket.example.invalid/acme/web.git\n')).failures).toEqual([`canary: "${name}" did not give the expected result (exit 0)`]);
    expect((await run('https://bitbucket.example.invalid/acme/web.git\nnopush://\n')).failures).toHaveLength(1);
    expect((await run('')).failures).toEqual([`canary: "${name}" did not give the expected result (exit 0)`]);
    expect((await run('\n\n')).failures).toHaveLength(1);
    expect((await run('nopush://\n', 128)).failures).toHaveLength(1);
    // the failure text never carries the (possibly sensitive) output
    expect(JSON.stringify(await run('https://bitbucket.example.invalid/acme/web.git\n'))).not.toContain('bitbucket');
  });

  it('a probe that times out or is killed is a failure (a hang proves nothing)', async () => {
    const f = fakeCanaryApi({ shellOverride: (c) => (c.includes('curl') ? { status: 'timeout', exit: undefined, output: '' } : undefined) });
    const r = await runShellCanary(f.api, 's', probes);
    expect(r.failures).toEqual(['canary: "connect to the run port" did not finish normally (status timeout)']);
  });

  it('an API error on one probe is recorded and the remaining probes still run', async () => {
    const f = fakeCanaryApi({ shellOverride: (c) => (c.includes('gh auth') ? new RunApiError({ kind: 'http', message: 'boom', method: 'POST', path: '/x', status: 404 }) : undefined) });
    const r = await runShellCanary(f.api, 's', probes);
    expect(r.failures).toEqual(['canary: "gh auth status" errored: HTTP 404']);
    expect(f.shellCommands).toHaveLength(probes.length);
  });

  describe('must-succeed temp-file probes', () => {
    const heredoc = TMP_PROBE_NAMES[0]!;
    const bashHeredoc = TMP_PROBE_NAMES[1]!;
    const shHeredoc = TMP_PROBE_NAMES[2]!;
    const bareMktemp = TMP_PROBE_NAMES[3]!;
    const templated = TMP_PROBE_NAMES[4]!;
    const diagnostics = TMP_PROBE_NAMES.slice(5);

    it('pass: recorded as ok, no flags beyond the diagnostic marker, nothing printed', async () => {
      const r = await runShellCanary(fakeCanaryApi({}).api, 's', probes);
      expect(r.ok).toBe(true);
      for (const n of TMP_PROBE_NAMES) expect(r.results.find((x) => x.name === n), n).toMatchObject({ ok: true, exit: 0 });
      expect(r.results.filter((x) => 'expectedFail' in x)).toEqual([]);
      expect(r.results.filter((x) => x.diagnostic).map((x) => x.name)).toEqual(diagnostics);
    });

    it('a failing heredoc or bare mktemp is fatal and names the probe and exit code only', async () => {
      const r = await runShellCanary(fakeCanaryApi({ shellFails: ['heredoc-probe-abcd', 'f=$(mktemp) ||'] }).api, 's', probes);
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([`canary: "${heredoc}" failed (exit 1, expected it to work)`, `canary: "${bareMktemp}" failed (exit 1, expected it to work)`]);
      expect(r.results.find((x) => x.name === heredoc)).toMatchObject({ ok: false });
      expect(r.results.find((x) => x.name === heredoc)).not.toHaveProperty('expectedFail');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('a failing bash or sh heredoc probe is fatal', async () => {
      const bash = await runShellCanary(fakeCanaryApi({ shellFails: ['/bin/bash -c'] }).api, 's', probes);
      expect(bash.failures).toEqual([`canary: "${bashHeredoc}" failed (exit 1, expected it to work)`]);
      const sh = await runShellCanary(fakeCanaryApi({ shellFails: ['/bin/sh -c'] }).api, 's', probes);
      expect(sh.failures).toEqual([`canary: "${shHeredoc}" failed (exit 1, expected it to work)`]);
    });

    it('a probe that times out is fatal', async () => {
      const f = fakeCanaryApi({ shellOverride: (c) => (c.includes('heredoc-probe') ? { status: 'timeout', exit: undefined, output: '' } : undefined) });
      const r = await runShellCanary(f.api, 's', probes);
      expect(r.ok).toBe(false);
      expect(r.failures.length).toBeGreaterThan(0);
      expect(r.results.find((x) => x.name === heredoc)).toMatchObject({ ok: false });
    });

    it('a must-succeed probe is fatal when it fails (mktemp with a $TMPDIR template)', async () => {
      const r = await runShellCanary(fakeCanaryApi({ shellFails: ['mktemp "$TMPDIR/'] }).api, 's', probes);
      expect(r.failures).toEqual([`canary: "${templated}" failed (exit 1, expected it to work)`]);
    });

    it('a failing diagnostic is recorded as ok:false but never gates', async () => {
      const r = await runShellCanary(fakeCanaryApi({ shellFails: ['ZSH_VERSION', '"$TMPDIR" =', 'TMPPREFIX'] }).api, 's', probes);
      expect(r.ok).toBe(true);
      expect(r.failures).toEqual([]);
      for (const n of diagnostics) expect(r.results.find((x) => x.name === n), n).toMatchObject({ ok: false, exit: 1, diagnostic: true });
    });

    it('an API error on a temp-file probe is fatal', async () => {
      const f = fakeCanaryApi({ shellOverride: (c) => (c.includes('heredoc-probe-abcd') && !c.includes('/bin/') ? new RunApiError({ kind: 'http', message: 'boom', method: 'POST', path: '/x', status: 500 }) : undefined) });
      const r = await runShellCanary(f.api, 's', probes);
      expect(r.failures).toEqual([`canary: "${heredoc}" errored: HTTP 500`]);
    });
  });

  it('a client without shell() fails loudly', async () => {
    const r = await runShellCanary(fakeCanaryApi({ noShell: true }).api, 's', probes);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['canary: the server client has no shell() method']);
  });
});

describe('planReadDeny', () => {
  it('prefers an existing credential file and leaves it alone', () => {
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'config'), 'x');
    const plan = planReadDeny(home);
    expect(plan?.file).toBe(join(home, '.aws', 'config'));
    plan?.cleanup();
    expect(existsSync(join(home, '.aws', 'config'))).toBe(true);
  });

  it('otherwise plants a temp file in an existing denied dir and removes it on cleanup', () => {
    mkdirSync(join(home, '.kube'), { recursive: true });
    const plan = planReadDeny(home);
    expect(plan?.file.startsWith(join(home, '.kube', '.nightgem-canary-'))).toBe(true);
    expect(existsSync(plan!.file)).toBe(true);
    plan!.cleanup();
    expect(existsSync(plan!.file)).toBe(false);
  });

  it('returns undefined when nothing denied exists', () => {
    expect(planReadDeny(home)).toBeUndefined();
  });

  it('only ever picks paths the sandbox really denies to read', () => {
    const denies = sandboxReadDenies({ home });
    const under = (p: string): boolean => denies.some((d) => (d.kind === 'literal' ? p === d.path : p === d.path || p.startsWith(`${d.path}/`)));
    for (const rel of ['.aws', '.kube', '.docker', '.config/gcloud', '.config/gh']) mkdirSync(join(home, rel), { recursive: true });
    for (const rel of ['.aws/config', '.aws/credentials', '.kube/config', '.docker/config.json', '.config/gh/hosts.yml', '.config/gh/config.yml', '.netrc', '.git-credentials']) {
      writeFileSync(join(home, rel), 'x');
      expect(planReadDeny(home)?.file, rel).toBeDefined();
      expect(under(join(home, rel)), rel).toBe(true);
      rmSync(join(home, rel));
    }
    const plan = planReadDeny(home);
    expect(under(plan!.file)).toBe(true);
    plan!.cleanup();
  });
});

// ---------------------------------------------------------------------------
// layer (ii): guard decide() with the plugin's runtime config
// ---------------------------------------------------------------------------

describe('runGuardCanary', () => {
  const p = runPaths(SLUG, { home: '/home/u', workspaceRoot: '/home/u/work' });
  const input = () => ({ home: '/home/u', workspaceRoot: '/home/u/work', slug: SLUG, controlDir: p.controlDir, tmpDir: join(p.controlDir, 'tmp'), runDir: p.runDir, xdgDataHome: p.xdgDataHome, port: 4242, safety: safetyFor('/home/u/work') });

  it('the real guard returns the expected verdict for every case', () => {
    const r = runGuardCanary(input());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(guardCases(input()).length);
    expect(r.checked).toBeGreaterThanOrEqual(20);
  }, 60_000); // the first decide() calls warm the secret-location scanner (several seconds)

  it('is built from buildGuardEnv, the same variables the plugin reads in the serve process', () => {
    const i = input();
    const genv = buildGuardEnv({ slug: SLUG, workspaceRoot: i.workspaceRoot, controlDir: i.controlDir, tmpDir: i.tmpDir, port: 4242, safety: i.safety });
    const cfg = guardConfigFor(i);
    expect(cfg.allowedRoots).toEqual(genv.NIGHTGEM_ALLOWED_WRITE_ROOTS!.split(':'));
    expect(cfg.runPort).toBe('4242');
    expect(cfg.cwd).toBe(i.runDir);
    expect(cfg.controlDirSet).toBe(true);
    expect(cfg.env).toMatchObject({ NIGHTGEM_CONTROL_DIR: i.controlDir, HOME: '/home/u', XDG_DATA_HOME: i.xdgDataHome });
  });

  it('covers push, gh, /tmp write, secret reads, printenv, the run port and the stop flags', () => {
    const names = guardCases(input()).map((c) => c.name);
    for (const n of ['git push', 'gh pr list', 'write /tmp/x', 'read opencode.json', 'read control.json', 'printenv', 'curl the run port', 'hard stop blocks everything']) expect(names).toContain(n);
  });

  it('a guard that lets a forbidden command through fails the canary, naming the case', () => {
    const lax = (() => ({ verdict: 'allow' })) as unknown as typeof decide;
    const r = runGuardCanary(input(), lax);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('canary (guard): "git push" expected block, got allow');
    expect(r.failures).toContain('canary (guard): "webfetch prompt stripped" expected rewrite, got allow');
  });

  it('a guard that blocks something it must allow fails too', () => {
    const strict = (() => ({ verdict: 'block', reason: 'x' })) as unknown as typeof decide;
    const r = runGuardCanary(input(), strict);
    expect(r.failures).toContain('canary (guard): "git status" expected allow, got block');
  });

  it('a throwing guard is a failure, not a crash', () => {
    const boom = (() => {
      throw new Error('kaput');
    }) as unknown as typeof decide;
    const r = runGuardCanary(input(), boom);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toBe('canary (guard): "git push" threw: kaput');
  });
});

// ---------------------------------------------------------------------------
// preflight: rules + the three canary layers
// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  const canaryFailures = (res: { failures: string[] }): string[] => res.failures.filter((f) => f.startsWith('canary'));
  // the stub evaluator answers `deny` for everything, so the corpus' allow probes show up as rule failures: ignore those
  const ctxFor = (fake: FakeCanary, m: RunManifest, port: number | undefined = 4242) => ({ api: fake.api, server: { port } as never, manifest: m, paths: runPaths(SLUG, { home, workspaceRoot }) });
  const good = (): CanaryScript => ({ attempts: [ALL_BLOCKED] });

  it('runs the rule check from profile/corpus.txt; NIGHTGEM_SKIP_CANARY=1 skips every canary layer', async () => {
    const fake = fakeCanaryApi(good());
    const res = await preflightIn(ctxFor(fake, writeRun()), { NIGHTGEM_SKIP_CANARY: '1' });
    expect(fake.eventsCalled()).toBe(0);
    expect(fake.shellCommands).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => /expected allow, got deny/.test(f))).toBe(true);
  });

  it('all three layers pass: no canary failures, no warnings, and the shell probes ran without any model', async () => {
    const fake = fakeCanaryApi(good());
    const warnings: string[] = [];
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const res = await preflightIn(ctxFor(fake, writeRun()), { NIGHTGEM_SANDBOX: undefined }, { log: (event, fields) => logs.push({ event, fields }), warn: (k, m) => warnings.push(`${k}: ${m}`) });
    expect(canaryFailures(res)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(fake.shellCommands.length).toBeGreaterThanOrEqual(6);
    expect(fake.shellCommands.some((c) => c.includes('/api/info') && c.includes(':4242'))).toBe(true);
    expect(logs.map((l) => l.fields.layer)).toEqual(['guard', 'shell', 'llm']);
    // probe results are logged as pass/fail + exit code only
    const shellLog = logs.find((l) => l.fields.layer === 'shell')!.fields.results as Array<Record<string, unknown>>;
    for (const r of shellLog) expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(['exit', 'name', 'ok']));
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('a /shell probe that succeeds fails the launch', async () => {
    const fake = fakeCanaryApi({ ...good(), shellRuns: ['push origin HEAD'] });
    const res = await preflightIn(ctxFor(fake, writeRun()), {});
    expect(res.ok).toBe(false);
    expect(canaryFailures(res)).toEqual(['canary: "git push (github-form origin)" ran successfully (exit 0, expected it to be blocked)']);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('a guard decide() mismatch fails the launch', async () => {
    const lax = (() => ({ verdict: 'allow' })) as unknown as typeof decide;
    const res = await preflightIn(ctxFor(fakeCanaryApi(good()), writeRun()), {}, { decide: lax });
    expect(res.ok).toBe(false);
    expect(canaryFailures(res).some((f) => f.startsWith('canary (guard): "git push" expected block'))).toBe(true);
  });

  it('an LLM canary that is inconclusive records a canary-inconclusive warning and does NOT fail the launch', async () => {
    const fake = fakeCanaryApi({ attempts: [NONE_TRIED] });
    const warnings: Array<[string, string, string | undefined]> = [];
    const res = await preflightIn(ctxFor(fake, writeRun()), {}, { warn: (k, m, s) => warnings.push([k, m, s]) });
    expect(canaryFailures(res)).toEqual([]);
    expect(warnings).toEqual([['canary-inconclusive', 'canary inconclusive after 2 tries: the model attempted none of the probes', expect.stringMatching(/^ses_/)]]);
    expect(fake.prompts).toEqual([CANARY_PROMPT, CANARY_RETRY_PROMPT]);
  });

  it('an LLM probe that actually runs still fails the launch', async () => {
    const fake = fakeCanaryApi({ attempts: [[{ command: 'git push origin HEAD', outcome: 'exit0' }]] });
    const res = await preflightIn(ctxFor(fake, writeRun()), {});
    expect(canaryFailures(res)).toEqual(['canary: "git push" ran successfully (expected denied/blocked)']);
  });

  it('appends deriveProbes(safety) to the preflight corpus', async () => {
    const fake = fakeCanaryApi(good());
    const seen: string[] = [];
    const api = { ...fake.api, evalPermission: async (i: { action: string; resources: string[] }) => (seen.push(`${i.action}|${i.resources[0]}`), 'deny' as const) } as unknown as ServerApi;
    const safety: SafetyInputs = { ...safetyFor(workspaceRoot), deny: { commands: ['acme-cli'], shellPatterns: [], secretPaths: ['.acme'], editPaths: [] }, mcpServerNames: ['atlassian'] };
    await preflightIn({ ...ctxFor(fake, writeRun()), api }, { NIGHTGEM_SKIP_CANARY: '1' }, { safety });
    expect(seen).toContain('shell|acme-cli');
    expect(seen).toContain('shell|env acme-cli');
    expect(seen).toContain(`read|${home}/.acme/probe`);
    expect(seen).toContain('atlassian_probe|*');
  });

  it('NIGHTGEM_SKIP_LLM_CANARY=1 keeps the deterministic layers but never touches a model', async () => {
    const fake = fakeCanaryApi(good());
    const res = await preflightIn(ctxFor(fake, writeRun()), { NIGHTGEM_SKIP_LLM_CANARY: '1' });
    expect(canaryFailures(res)).toEqual([]);
    expect(fake.prompts).toEqual([]);
    expect(fake.shellCommands.length).toBeGreaterThan(0);
  });

  it('the temp-file probes run against the run tmp dir and gate the launch: a failing heredoc or bare mktemp fails the canary', async () => {
    const fake = fakeCanaryApi({ ...good(), shellFails: ['heredoc-probe', 'f=$(mktemp) ||', 'ZSH_VERSION'] });
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const res = await preflightIn(ctxFor(fake, writeRun()), {}, { log: (event, fields) => logs.push({ event, fields }) });
    expect(fake.shellCommands.some((c) => c.includes(`'${runTmpDir(SLUG)}'/nightgem-heredoc-probe-`))).toBe(true);
    const failures = canaryFailures(res).join('\n');
    for (const n of TMP_PROBE_NAMES.slice(0, 4)) expect(failures, n).toContain(`"${n}" failed`);
    expect(failures).not.toContain('diagnostic');
    const shellLog = logs.find((l) => l.event === 'preflight.canary' && l.fields.layer === 'shell');
    const results = shellLog?.fields.results as Array<{ name: string; ok: boolean; expectedFail?: boolean; diagnostic?: boolean }>;
    expect(results.filter((r) => r.expectedFail)).toEqual([]);
    expect(results.find((r) => r.name.startsWith('diagnostic: the shell is zsh'))).toMatchObject({ ok: false, diagnostic: true });
  });

  it('with working temp files the canary passes even when a diagnostic says the shell is not zsh', async () => {
    const fake = fakeCanaryApi({ ...good(), shellFails: ['ZSH_VERSION'] });
    const res = await preflightIn(ctxFor(fake, writeRun()), {});
    expect(canaryFailures(res)).toEqual([]);
  });

  it('without a sandbox the kernel-level probes are not run (they would legitimately succeed)', async () => {
    const fake = fakeCanaryApi(good());
    const res = await preflightIn(ctxFor(fake, writeRun()), { NIGHTGEM_SANDBOX: '0' });
    expect(canaryFailures(res)).toEqual([]);
    expect(fake.shellCommands.some((c) => c.includes('/tmp/nightgem-canary'))).toBe(false);
    expect(fake.shellCommands.some((c) => c.includes('curl'))).toBe(false);
  });

  it('checks every push URL of every remote of a spec repo, and cleans up its scratch repo and planted files', async () => {
    const repo = makeRepo('proj');
    const bare = join(home, 'origin.git');
    sh(home, 'init', '-q', '--bare', bare);
    sh(repo, 'remote', 'add', 'origin', bare);
    mkdirSync(join(home, '.docker'), { recursive: true });
    const m = writeRun({ repos: [{ name: 'proj', path: repo, defaultBranch: 'main', baseline: { head: 'x', branch: 'main', porcelainHash: 'h', stashCount: 0 } }] });
    const fake = fakeCanaryApi(good());
    const res = await preflightIn(ctxFor(fake, m), {});
    expect(canaryFailures(res)).toEqual([]);
    expect(fake.shellCommands.some((c) => c.includes(`git -C '${repo}' remote get-url --push --all 'origin'`))).toBe(true);
    const tmp = runTmpDir(SLUG);
    expect(existsSync(tmp) ? readdirSync(tmp).filter((f) => f.startsWith('canary-repo-')) : []).toEqual([]);
    expect(readdirSync(join(home, '.docker'))).toEqual([]);
  });

  it('a spec repo whose remote carries credentials is refused by the canary path, and the secret appears nowhere', async () => {
    const pw = 'hunter2-TOKEN-xyz';
    const repo = makeRepo('cred');
    sh(repo, 'remote', 'add', 'origin', `https://alice:${pw}@host.example.invalid/acme/short.url.git`);
    const m = writeRun({ repos: [{ name: 'cred', path: repo, defaultBranch: 'main', baseline: { head: 'x', branch: 'main', porcelainHash: 'h', stashCount: 0 } }] });
    const fake = fakeCanaryApi(good());
    const logs: string[] = [];
    const res = await preflightIn(ctxFor(fake, m), {}, { log: (event, fields) => logs.push(JSON.stringify({ event, fields })) });
    expect(canaryFailures(res)).toEqual(['canary: repo cred: remote origin has credentials in its URL (remove them: use ssh keys or a credential helper)']);
    for (const out of [JSON.stringify(res), JSON.stringify(fake.shellCommands), JSON.stringify(fake.prompts), logs.join('\n')]) {
      expect(out).not.toContain(pw);
      expect(out).not.toContain('alice');
    }
    expect(fake.shellCommands).toEqual([]);
  });

  it('a failure to create the scratch repo is a canary failure, not a throw', async () => {
    const fake = fakeCanaryApi(good());
    const res = await preflightIn(ctxFor(fake, writeRun()), {}, {
      git: async () => {
        throw new Error('git is broken');
      },
    });
    expect(canaryFailures(res)).toEqual(['canary (sandbox/env): setup failed: git is broken']);
  });

  it('the run tmp dir lives outside the control dir (which holds the password and flags)', () => {
    const tmp = runTmpDir(SLUG);
    expect(tmp).toContain('nightgem-');
    expect(tmp.startsWith(controlDir(SLUG, home))).toBe(false);
    expect(tmp).not.toContain(' ');
  });
});

describe('canary scratch remote', () => {
  it('is covered by the default pushInsteadOf prefixes (else the nopush:// probe fails every launch)', async () => {
    const { CANARY_SCRATCH_REMOTE } = await import('../src/wiring.ts');
    const { DEFAULT_NOPUSH_PREFIXES } = await import('../src/profile.ts');
    expect(DEFAULT_NOPUSH_PREFIXES.some((p) => CANARY_SCRATCH_REMOTE.startsWith(p))).toBe(true);
  });
});
