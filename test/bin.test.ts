import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_BIN_PATH } from '../src/cli-deps.ts';
import { COMMAND_NAMES, installCommands } from '../src/install.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'nightgem.mjs');
const ORCH_BIN = join(REPO, 'bin', 'nightgem-orchestrator.mjs');
const NODE = process.execPath;

let tmp: string;
let home: string;
let workspace: string;
let emptyPathDir: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ng-bin-')));
  home = join(tmp, 'home');
  workspace = join(tmp, 'work');
  emptyPathDir = join(tmp, 'empty-path');
  mkdirSync(home);
  mkdirSync(workspace);
  mkdirSync(emptyPathDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway environment: no inherited NIGHTGEM_*, OPENCODE_* or XDG_* variables, the given HOME, and the given PATH. */
const cleanEnv = (path: string): Record<string, string> => ({ HOME: home, PATH: path, NPM_CONFIG_UPDATE_NOTIFIER: 'false' });

/** What `npm link` does for a bin (into the global prefix; set `npm_config_prefix` to choose it): `<prefix>/bin/<name>` is a symlink to the package's bin file. */
function linkInto(prefix: string, name: string, target: string): string {
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const link = join(prefix, 'bin', name);
  symlinkSync(target, link);
  return link;
}

describe('bin through an npm-style symlink', () => {
  it('runs --help through <prefix>/bin/nightgem', async () => {
    const link = linkInto(join(tmp, 'prefix'), 'nightgem', BIN);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const r = await execa(NODE, [link, '--help'], { env: cleanEnv(emptyPathDir), extendEnv: false, reject: false, timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage: nightgem');
    for (const c of ['launch', 'status', 'stop', 'report', 'doctor', 'profile', 'render', 'install', 'uninstall']) expect(r.stdout).toContain(c);
  });

  it('runs as an executable (shebang) when only the symlink dir is on PATH', async () => {
    const prefix = join(tmp, 'prefix');
    linkInto(prefix, 'nightgem', BIN);
    const path = [join(prefix, 'bin'), dirname(NODE), '/usr/bin', '/bin'].join(delimiter);
    const r = await execa('nightgem', ['--help'], { env: cleanEnv(path), extendEnv: false, reject: false, timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Usage: nightgem');
  });

  it('resolves src/ from the real path through a chain of links', async () => {
    const first = linkInto(join(tmp, 'a'), 'nightgem', BIN);
    const second = join(tmp, 'b-link');
    symlinkSync(first, second);
    const r = await execa(NODE, [second, '--check'], { env: cleanEnv(emptyPathDir), extendEnv: false, reject: false, timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/entry ok: (src \(tsx\)|dist)/);
  });

  it('the orchestrator bin also resolves through a symlink', async () => {
    const link = linkInto(join(tmp, 'prefix'), 'nightgem-orchestrator', ORCH_BIN);
    const r = await execa(NODE, [link, '--check'], { env: cleanEnv(emptyPathDir), extendEnv: false, reject: false, timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/orchestrator entry ok: (src \(tsx\)|dist)/);
  });

  it('uninstall prints the npm unlink hint', async () => {
    const link = linkInto(join(tmp, 'prefix'), 'nightgem', BIN);
    const r = await execa(NODE, [link, 'uninstall', '--commands-dir', join(tmp, 'cmds')], {
      env: cleanEnv(emptyPathDir),
      extendEnv: false,
      reject: false,
      timeout: 60_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('npm unlink -g nightgem');
  });
});

describe('rendered slash commands keep absolute paths', () => {
  const nodePath = '/opt/node/bin/node';
  const binPath = '/opt/nightgem/bin/nightgem.mjs';

  function render(commandsDir: string, node: string, bin: string): Record<string, string> {
    installCommands({
      home,
      env: {},
      fs,
      nodePath: node,
      binPath: bin,
      templatesDir: join(REPO, 'commands'),
      starterPath: join(REPO, 'templates', 'profile.starter.jsonc'),
      commandsDir,
      workspace,
      force: false,
      now: () => new Date('2026-10-23T10:00:00Z'),
    });
    return Object.fromEntries(COMMAND_NAMES.map((n) => [n, readFileSync(join(commandsDir, `${n}.md`), 'utf8')]));
  }

  it('every command renders the absolute node and bin, never a bare `nightgem` command', () => {
    const rendered = render(join(tmp, 'cmds'), nodePath, binPath);
    expect(isAbsolute(nodePath) && isAbsolute(binPath)).toBe(true);
    for (const [name, text] of Object.entries(rendered)) {
      const calls = text.match(new RegExp(`${nodePath} ${binPath} [a-z-]+`, 'g')) ?? [];
      expect(calls.length, `${name} has no rendered invocation`).toBeGreaterThan(0);
      expect(text, name).not.toMatch(/`nightgem (launch|status|stop|report|doctor|profile|install)\b/);
      expect(text, name).not.toMatch(/\{\{/);
    }
  });

  it('a rendered invocation runs with a PATH that has no `nightgem`', async () => {
    // The real node and the real bin, so the rendered line can actually execute.
    const rendered = render(join(tmp, 'cmds'), NODE, CLI_BIN_PATH);
    const m = /`(\S+ \S+) profile show --json`/.exec(rendered['nightgem']!);
    expect(m, 'nightgem.md has a `profile show --json` invocation').not.toBeNull();
    const invocation = `${m![1]} profile show --json`;
    expect(invocation.startsWith(NODE)).toBe(true);
    expect(invocation).toContain(CLI_BIN_PATH);

    const r = await execa('/bin/sh', ['-c', invocation], { env: cleanEnv(emptyPathDir), extendEnv: false, reject: false, timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { workspaceRoot?: string }).workspaceRoot).toBe(workspace);

    const which = await execa('/bin/sh', ['-c', 'command -v nightgem'], { env: cleanEnv(emptyPathDir), extendEnv: false, reject: false });
    expect(which.exitCode).not.toBe(0);
  });
});
