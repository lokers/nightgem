import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CliDeps, ExecFn, ExecResult } from '../src/cli-deps.ts';
import type { RunContextSnapshot } from '../src/contracts.ts';
import { runLaunchGates } from '../src/launcher.ts';
import { runPaths } from '../src/paths.ts';
import { realRenderers } from '../src/render.ts';
import { makeRunContext } from './fixtures/run-context.ts';

const SLUG = 'demo-run';
const NOW = new Date('2026-10-21T22:00:00Z');

let home: string;
let workspaceRoot: string;
let calls: string[];
let lines: string[];

function makeExec(env: { power?: string; jobState?: 'loaded' | 'absent' } = {}): ExecFn {
  return async (cmd, args): Promise<ExecResult> => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
    if (key === 'opencode --version') return ok('opencode v2.0.29\n');
    if (key === 'pmset -g batt') return ok(`Now drawing from '${env.power ?? 'AC Power'}'\n`);
    if (cmd === 'df') return ok('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/x 1 1 99999999 1% 1 1 0% /\n');
    if (cmd === '/bin/sh') return ok(`/opt/homebrew/bin/${args[1]?.replace('command -v ', '')}\n`);
    if (cmd === 'launchctl' && args[0] === 'print') {
      return env.jobState === 'loaded' ? ok('state = not running\n') : { stdout: '', stderr: 'not found', exitCode: 113 };
    }
    return { stdout: '', stderr: `unexpected: ${key}`, exitCode: 1 };
  };
}

function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  const forbidden = (name: string) => async (): Promise<never> => {
    throw new Error(`the gates must not call ${name}`);
  };
  return {
    home,
    nodePath: '/n/bin/node',
    orchestratorEntry: '/o/nightgem-orchestrator.mjs',
    model: 'anthropic/claude-opus-5-5',
    uid: 501,
    now: () => NOW,
    resolveRunContext: async () => makeRunContext(workspaceRoot),
    resolveWorkspace: async () => workspaceRoot,
    renderers: realRenderers,
    readManifest: async () => undefined,
    writeManifest: forbidden('writeManifest'),
    writeRunContext: forbidden('writeRunContext'),
    readControlFlags: async () => ({ softStop: false, hardStop: false, heartbeatTs: 0 }),
    acquireLock: forbidden('acquireLock'),
    releaseLock: forbidden('releaseLock'),
    lockIsFree: async () => true,
    buildBaseline: forbidden('buildBaseline'),
    writeReport: forbidden('writeReport'),
    ...over,
  };
}

const io = () => ({ out: (l: string) => void lines.push(l) });
const fs = { exists: () => true };

function gates(over: Partial<Parameters<typeof runLaunchGates>[0]> = {}) {
  return runLaunchGates({ slug: SLUG, deps: makeDeps(), exec: makeExec(), fs, io: io(), parentEnv: {}, ...over });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-gates-'));
  workspaceRoot = join(home, 'workspace');
  calls = [];
  lines = [];
  mkdirSync(join(workspaceRoot, 'acme-api', '.git'), { recursive: true });
  const specs = runPaths(SLUG, { home, workspaceRoot }).specsDir;
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, 'SPEC.md'), '# Spec: demo JIRA-9\n\nStatus: APPROVED\n\n## Affected repos\n\n| Location | Change |\n|---|---|\n| `acme-api` | x |\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('runLaunchGates', () => {
  it('returns the context, spec, label, paths and resolved binaries, and creates nothing', async () => {
    const g = await gates();
    expect(g.runContext).toEqual(makeRunContext(workspaceRoot));
    expect(g.spec.repos.map((r) => r.name)).toEqual(['acme-api']);
    expect(g.label).toBe(`dev.nightgem.${SLUG}`);
    expect(g.paths).toEqual(runPaths(SLUG, { home, workspaceRoot }));
    expect(g.opencodePath).toBe('/opt/homebrew/bin/opencode');
    expect(g.gitPath).toBe('/opt/homebrew/bin/git');
    expect(g.warnings).toEqual([]);
    // no control dir, run dir, baseline, lock or manifest (the forbidden deps would have thrown)
    expect(calls.filter((c) => c.startsWith('launchctl') && !c.startsWith('launchctl print'))).toEqual([]);
  });

  it('honours the repos override', async () => {
    mkdirSync(join(workspaceRoot, 'other', '.git'), { recursive: true });
    const g = await gates({ repos: ['other'] });
    expect(g.spec.repos.map((r) => r.name)).toEqual(['other']);
  });

  it('reuses a given run context instead of resolving one', async () => {
    const ctx = makeRunContext(workspaceRoot);
    const g = await gates({
      deps: makeDeps({
        resolveRunContext: async () => {
          throw new Error('must not resolve');
        },
      }),
      runContext: ctx,
    });
    expect(g.runContext).toEqual(ctx);
  });

  it('prints the doctor warnings and returns them', async () => {
    const only = { exists: (p: string) => !p.endsWith('/npm'), readText: (p: string) => (p.endsWith('/package.json') ? '{"scripts":{"test":"x"}}' : undefined) };
    const g = await gates({ fs: only });
    expect(g.warnings.some((l) => /^warning: toolchain acme-api: .*npm/.test(l))).toBe(true);
    expect(lines).toEqual(g.warnings);
  });

  it('rejects an invalid slug before any exec', async () => {
    await expect(gates({ slug: 'Bad Slug' })).rejects.toThrow(/Invalid slug "Bad Slug" \(expected kebab-case/);
    expect(calls).toEqual([]);
  });

  it('rejects a run context that is not a valid snapshot', async () => {
    const base = makeRunContext(workspaceRoot);
    const stub: RunContextSnapshot = { ...base, profile: { path: '', sha256: '', data: base.profile.data } };
    await expect(gates({ deps: makeDeps({ resolveRunContext: async () => stub }) })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects an unapproved spec', async () => {
    writeFileSync(runPaths(SLUG, { home, workspaceRoot }).specMd, '# t\n\nStatus: DRAFT\n');
    await expect(gates()).rejects.toThrow(/not approved/);
    expect(calls).toEqual([]);
  });

  it('runs afterLoad after the spec loads and before the doctor, and its error wins', async () => {
    const seen: string[] = [];
    await expect(
      gates({
        afterLoad: ({ spec, paths }) => {
          seen.push(`${spec.repos.length}:${paths.runJson}`, `exec calls so far: ${calls.length}`);
          throw new Error('caller refusal');
        },
      }),
    ).rejects.toThrow('caller refusal');
    expect(seen).toEqual([`1:${runPaths(SLUG, { home, workspaceRoot }).runJson}`, 'exec calls so far: 0']);
    // an afterLoad refusal also beats a doctor failure
    await expect(
      gates({
        exec: makeExec({ power: 'Battery Power' }),
        afterLoad: () => {
          throw new Error('caller refusal');
        },
      }),
    ).rejects.toThrow('caller refusal');
  });

  it('aborts on a doctor hard failure (AC power)', async () => {
    await expect(gates({ exec: makeExec({ power: 'Battery Power' }) })).rejects.toThrow(/doctor reported hard failures, not launching:[\s\S]*AC power/);
  });

  it('aborts when the lock is held', async () => {
    await expect(gates({ deps: makeDeps({ lockIsFree: async () => false }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*lock[\s\S]*another run holds the lock/);
  });

  it('aborts on a hard preflight finding such as a credentialed remote URL', async () => {
    const preflight = async () => [{ name: 'remote urls', ok: false, hard: true, detail: 'acme-api: origin embeds credentials' }];
    await expect(gates({ deps: makeDeps({ preflight }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*remote urls[\s\S]*embeds credentials/);
  });

  it('aborts when the preflight itself throws', async () => {
    const preflight = async () => {
      throw new Error('rule check exploded');
    };
    await expect(gates({ deps: makeDeps({ preflight }) })).rejects.toThrow(/doctor reported hard failures[\s\S]*preflight[\s\S]*rule check exploded/);
  });

  it('aborts when the launchd job is already loaded', async () => {
    await expect(gates({ exec: makeExec({ jobState: 'loaded' }) })).rejects.toThrow(/launchd job dev\.nightgem\.demo-run is already loaded\. Run ".* stop demo-run" first\./);
  });
});
