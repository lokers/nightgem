import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli.ts';
import type { CliDeps } from '../src/cli-deps.ts';
import { buildLaunchManifest } from '../src/launcher.ts';
import { runPaths } from '../src/paths.ts';
import { PROMPT_NAMES } from '../src/prompts.ts';
import { assertSafeOutDir, redactEnv, realRenderers, renderRunArtifacts, writeRenderedFiles, type RenderRenderers } from '../src/render.ts';
import { makeRunContext } from './fixtures/run-context.ts';

const SLUG = 'demo-run';
const PASSWORD = 'FAKE-PASSWORD-9f8e7d6c5b4a';

let home: string;
let workspaceRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-render-'));
  workspaceRoot = join(home, 'workspace');
  mkdirSync(join(workspaceRoot, 'acme-api', '.git'), { recursive: true });
  const specs = runPaths(SLUG, { home, workspaceRoot }).specsDir;
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, 'SPEC.md'), '# Spec: demo\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-api` | x |\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakeRenderers(): RenderRenderers {
  return {
    renderRunConfig: (i) => ({
      configContent: { model: i.model, small_model: i.smallModel, warming: false, plugins: [], permissions: [] },
      configContentJson: JSON.stringify({ model: i.model }),
      slimOverrides: {
        agents: {},
        backgroundJobs: { maxSessionsPerAgent: 1, wallClockTimeoutMs: 1, concurrency: { defaultConcurrency: 1 } },
        interview: { autoOpenBrowser: false },
        acpAgents: {},
        disabled_tools: [],
        disabled_skills: [],
        disabled_mcps: [],
      },
      readableCopy: { model: i.model, small_model: i.smallModel, warming: false, permissions: [] },
    }),
    renderSandboxProfile: (i) => `(version 1) ;; ${i.workspaceRoot} port ${i.port}`,
    buildServerEnv: (i) => ({
      HOME: i.home,
      OPENCODE_SERVER_PASSWORD: i.password,
      OPENCODE_CONFIG_CONTENT: i.configContentJson,
      GH_TOKEN: 'invalid',
      SOME_API_KEY: 'k-123',
      EMBEDDED: `x:${i.password}:y`,
    }),
    renderPrompt: (name, vars) => `${name}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(';')}`,
    promptNames: ['orchestrator_append', 'phase-plan', 'nudge'],
    promptVars: (name) => (name === 'nudge' ? ['reason'] : []),
  };
}

function baseInput() {
  const context = makeRunContext(workspaceRoot);
  const paths = runPaths(SLUG, { home, workspaceRoot });
  return {
    slug: SLUG,
    home,
    context,
    manifestPreview: buildLaunchManifest({
      slug: SLUG,
      budgetUsd: 10,
      costMultiplier: 1,
      context,
      label: `dev.nightgem.${SLUG}`,
      paths,
      model: 'anthropic/claude-opus-5-5',
      repos: [],
      pid: 1,
      createdAt: '1970-01-01T00:00:00.000Z',
    }),
    guardDir: '/repo/profile/guard',
    sshWrapper: '/repo/profile/git-ssh-fetch-only.sh',
    tmpDir: '/private/tmp/x',
    port: 54321,
    password: PASSWORD,
  };
}

describe('renderRunArtifacts (pure, injected renderers)', () => {
  it('returns the documented file set, splitting appends from the phase prompts', () => {
    const files = renderRunArtifacts(baseInput(), fakeRenderers());
    expect(files.map((f) => f.path)).toEqual([
      'opencode.config.json',
      'oh-my-opencode-slim.jsonc',
      'sandbox.sb',
      'guard-env.json',
      'appends/orchestrator_append.md',
      'prompts/phase-plan.md',
      'prompts/nudge.md',
      'run-context.json',
      'manifest-preview.json',
    ]);
  });

  it('never lets the password or other secrets into any rendered file', () => {
    const files = renderRunArtifacts(baseInput(), fakeRenderers());
    for (const f of files) expect(f.content, f.path).not.toContain(PASSWORD);
    const env = JSON.parse(files.find((f) => f.path === 'guard-env.json')!.content) as Record<string, string>;
    expect(env['OPENCODE_SERVER_PASSWORD']).toBe('<redacted>');
    expect(env['SOME_API_KEY']).toBe('<redacted>');
    expect(env['EMBEDDED']).toBe('<redacted>');
    expect(env['GH_TOKEN']).toBe('invalid'); // the safety placeholder is not a secret
    expect(env['OPENCODE_CONFIG_CONTENT']).toBe('<see opencode.config.json>');
  });

  it('fills the vars a prompt needs: known ones from the run, unknown ones as <name>', () => {
    const files = renderRunArtifacts(baseInput(), fakeRenderers());
    const nudge = files.find((f) => f.path === 'prompts/nudge.md')!.content;
    expect(nudge).toContain('reason=<reason>');
    expect(nudge).toContain(`slug=${SLUG}`);
    expect(nudge).toContain('workspaceInstructions=Follow each repo AGENTS.md.');
    expect(nudge).toContain('skillsList=(none detected)');
  });

  it('is deterministic', () => {
    expect(renderRunArtifacts(baseInput(), fakeRenderers())).toEqual(renderRunArtifacts(baseInput(), fakeRenderers()));
  });

  it('redactEnv sorts keys', () => {
    expect(Object.keys(redactEnv({ B: '1', A: '2' }, PASSWORD))).toEqual(['A', 'B']);
  });
});

describe('output location', () => {
  it('refuses --out inside .specs or the control root, and any path that escapes the out dir', () => {
    const ctx = { home, workspaceRoot };
    expect(() => assertSafeOutDir(join(workspaceRoot, '.specs', SLUG, 'out'), ctx)).toThrow(/Refusing/);
    expect(() => assertSafeOutDir(join(workspaceRoot, '.specs'), ctx)).toThrow(/Refusing/);
    expect(() => assertSafeOutDir(join(home, 'Library', 'Application Support', 'nightgem', 'x'), ctx)).toThrow(/Refusing/);
    expect(assertSafeOutDir(join(home, 'out'), ctx)).toBe(join(home, 'out'));
    expect(() => writeRenderedFiles(join(home, 'out'), [{ path: '../evil', content: 'x' }])).toThrow(/outside/);
  });
});

describe('nightgem render (CLI, real renderers)', () => {
  function deps(): CliDeps {
    const never = async (): Promise<never> => {
      throw new Error('render must not touch this');
    };
    return {
      home,
      nodePath: '/n/bin/node',
      orchestratorEntry: '/o/nightgem-orchestrator.mjs',
      model: 'anthropic/claude-opus-5-5',
      uid: 501,
      now: () => new Date('2026-10-21T22:00:00Z'),
      resolveRunContext: async () => makeRunContext(workspaceRoot),
      resolveWorkspace: async () => workspaceRoot,
      writeRunContext: never,
      renderers: realRenderers,
      readManifest: never,
      writeManifest: never,
      readControlFlags: never,
      acquireLock: never,
      releaseLock: never,
      lockIsFree: never,
      buildBaseline: never,
      writeReport: never,
    };
  }

  function walk(dir: string, prefix = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  }

  it('writes the file set into --out, with no password anywhere, and leaves .specs and the control dir untouched', async () => {
    const out = join(home, 'rendered');
    const lines: string[] = [];
    const before = walk(workspaceRoot).sort();
    const program = buildProgram({ deps: deps(), io: { out: (l) => void lines.push(l), err: () => undefined } });
    await program.parseAsync(['render', SLUG, '--out', out], { from: 'user' });
    const files = walk(out).sort();
    expect(files).toEqual(
      [
        'opencode.config.json',
        'oh-my-opencode-slim.jsonc',
        'sandbox.sb',
        'guard-env.json',
        ...PROMPT_NAMES.map((n) => (n.endsWith('_append') ? `appends/${n}.md` : `prompts/${n}.md`)),
        'run-context.json',
        'manifest-preview.json',
      ].sort(),
    );
    expect(lines).toHaveLength(files.length);
    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf8');
      expect(text, f).not.toContain('render-preview-password');
    }
    const preview = JSON.parse(readFileSync(join(out, 'manifest-preview.json'), 'utf8')) as { schemaVersion: number; state: string; repos: Array<{ name: string }>; launchdLabel: string };
    expect(preview).toMatchObject({ schemaVersion: 2, state: 'launching', launchdLabel: `dev.nightgem.${SLUG}` });
    expect(preview.repos.map((r) => r.name)).toEqual(['acme-api']);
    expect(walk(workspaceRoot).sort()).toEqual(before); // nothing written next to the specs
    expect(() => readdirSync(join(home, 'Library'))).toThrow(); // no control dir created
  });

  it('--spec renders against any spec file and never needs the slug\'s SPEC.md', async () => {
    const other = join(home, 'elsewhere.md');
    writeFileSync(other, '# Spec: other\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-api` | x |\n');
    rmSync(runPaths(SLUG, { home, workspaceRoot }).specMd);
    const program = buildProgram({ deps: deps(), io: { out: () => undefined, err: () => undefined } });
    await program.parseAsync(['render', SLUG, '--out', join(home, 'r2'), '--spec', other], { from: 'user' });
    expect(walk(join(home, 'r2'))).toContain('manifest-preview.json');
  });

  it('refuses an --out inside .specs', async () => {
    const program = buildProgram({ deps: deps(), io: { out: () => undefined, err: () => undefined } });
    await expect(program.parseAsync(['render', SLUG, '--out', join(workspaceRoot, '.specs', SLUG, 'r')], { from: 'user' })).rejects.toThrow(/Refusing/);
  });

  it('has no --legacy flag', () => {
    const program = buildProgram({ deps: deps() });
    const cmd = program.commands.find((c) => c.name() === 'render')!;
    expect(cmd.options.map((o) => o.long)).not.toContain('--legacy');
  });
});
