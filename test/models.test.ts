import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecFn } from '../src/cli-deps.ts';
import { wiringChecks } from '../src/wiring.ts';

const ALL = ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'];
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ng-models-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeProfile(extra: Record<string, unknown> = {}): void {
  const workspaceRoot = join(home, 'work');
  mkdirSync(workspaceRoot, { recursive: true });
  const file = join(home, '.config', 'nightgem', 'profile.jsonc');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, workspaceRoot, ...extra }));
}

interface Call {
  args: string[];
  env?: Record<string, string>;
  xdgExistedDuringCall: boolean;
}

/** A fake exec: `opencode models` lists `listed`; everything else (the entry `--check`) succeeds. */
function fakeExec(listed: readonly string[], result: { exitCode?: number; stderr?: string } = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    if (cmd !== 'opencode') return { stdout: 'ok', stderr: '', exitCode: 0 };
    const xdg = opts?.env?.XDG_DATA_HOME;
    calls.push({ args, ...(opts?.env ? { env: opts.env } : {}), xdgExistedDuringCall: xdg !== undefined && existsSync(xdg) });
    return { stdout: result.exitCode ? '' : listed.join('\n') + '\n', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  };
  return { exec, calls };
}

const check = async (listed: readonly string[], env: Record<string, string> = {}, result = {}) => {
  const { exec, calls } = fakeExec(listed, result);
  const checks = await wiringChecks(home, { exec, env, fs: nodeFs });
  return { c: checks.find((x) => x.name === 'models available')!, calls };
};

describe('models available (doctor)', () => {
  it('passes when every model the run would use is listed', async () => {
    const { c } = await check(ALL);
    expect(c).toMatchObject({ ok: true, hard: true });
    expect(c.detail).toContain('anthropic/claude-sonnet-5-5');
  });

  it('a missing default is a hard FAIL naming the agents, the profile key and the env var', async () => {
    const { c } = await check(['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5']);
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(c.detail).toContain('anthropic/claude-sonnet-5-5');
    expect(c.detail).toContain('fixer');
    expect(c.detail).toContain('models.fixer');
    expect(c.detail).toContain('NIGHTGEM_FIXER_MODEL');
    expect(c.detail).toContain('designer');
    expect(c.detail).toContain('docs/profile.md');
  });

  it('names the orchestrator and observer env vars', async () => {
    const { c } = await check([]);
    expect(c.detail).toContain('NIGHTGEM_MODEL');
    expect(c.detail).toContain('NIGHTGEM_SMALL_MODEL');
  });

  it('a profile override to an unavailable model is a FAIL', async () => {
    writeProfile({ models: { explorer: 'openai/mini' } });
    const { c } = await check(ALL);
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(c.detail).toContain('openai/mini');
    expect(c.detail).toContain('explorer');
    expect(c.detail).toContain('models.explorer');
  });

  it('an available env override passes even when the default is missing', async () => {
    const { c } = await check(['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5', 'openai/gpt-9'], {
      NIGHTGEM_FIXER_MODEL: 'openai/gpt-9',
      NIGHTGEM_DESIGNER_MODEL: 'openai/gpt-9',
    });
    expect(c.ok).toBe(true);
  });

  it('an env override beats a profile override', async () => {
    writeProfile({ models: { fixer: 'openai/unlisted' } });
    const { c } = await check([...ALL, 'openai/gpt-9'], { NIGHTGEM_FIXER_MODEL: 'openai/gpt-9' });
    expect(c.ok).toBe(true);
  });

  it('a malformed env override is a FAIL naming the variable', async () => {
    const { c } = await check(ALL, { NIGHTGEM_FIXER_MODEL: 'not-a-model-ref' });
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(c.detail).toContain('NIGHTGEM_FIXER_MODEL');
    expect(c.detail).toContain('provider/model');
  });

  it('a #variant is ignored for availability', async () => {
    writeProfile({ models: { fixer: 'openai/gpt-9#high' } });
    const { c } = await check([...ALL, 'openai/gpt-9']);
    expect(c.ok).toBe(true);
    const env = await check([...ALL, 'openai/gpt-9'], { NIGHTGEM_ORACLE_MODEL: 'openai/gpt-9#xhigh' });
    expect(env.c.ok).toBe(true);
  });

  it('lists models with an empty temp XDG_DATA_HOME that is not the real one, removed afterwards', async () => {
    const real = join(home, 'real-data');
    const { calls } = await check(ALL, { XDG_DATA_HOME: real, PATH: '/usr/bin', KEEP_ME: '1' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(['models']);
    const xdg = call.env!.XDG_DATA_HOME!;
    expect(xdg).not.toBe(real);
    expect(xdg).not.toContain(join(home, '.local'));
    expect(call.xdgExistedDuringCall).toBe(true);
    expect(existsSync(xdg)).toBe(false);
    // the rest of the env is passed through
    expect(call.env!.PATH).toBe('/usr/bin');
    expect(call.env!.KEEP_ME).toBe('1');
  });

  it('`opencode models` failing is a hard FAIL with its stderr', async () => {
    const { c } = await check(ALL, {}, { exitCode: 1, stderr: 'boom: no providers' });
    expect(c).toMatchObject({ ok: false, hard: true });
    expect(c.detail).toContain('boom: no providers');
  });

  it('keeps only the first line of a failing `opencode models` (no stack trace in doctor)', async () => {
    const { c } = await check(ALL, {}, { exitCode: 1, stderr: '\nError: service port in use\n    at start (x.js:1:1)\n    at main (y.js:2:2)\n' });
    expect(c.detail).toContain('Error: service port in use');
    expect(c.detail).not.toContain('at start');
  });
});
