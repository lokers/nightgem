import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SafetyInputs } from '../src/contracts.ts';
import { EXPECTED_OPENCODE_VERSION } from '../src/doctor.ts';
import { controlDir, runDir, shimBinDir, xdgDataHome } from '../src/paths.ts';
import { isPidAlive } from '../src/state.ts';
import { agentModelOverrides } from '../src/wiring.ts';
import {
  KEEP_OPENCODE_ENV,
  NON_INTERACTIVE_ENV,
  RedactingLogWriter,
  ServerStartError,
  buildServeInvocation,
  buildServerEnv,
  DEFAULT_REPO_ROOT,
  descendantPids,
  installRunShims,
  prepareRunServer,
  resetRunTmpDir,
  redactSecrets,
  runTmpDir,
  startRunServer,
  stripPathEntry,
} from '../src/server.ts';
import { SANDBOX_EXEC } from '../src/sandbox.ts';

const HOME = '/Users/alice';
const WORKSPACE = `${HOME}/workspace`;
const PW = 'f00dfacecafebeef0123456789abcdef0123456789abcdef';
/** Neutral safety inputs for the tests: no user denies, no skill roots. */
const safetyFor = (workspaceRoot: string): SafetyInputs => ({ workspaceRoot, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } });

const SLUG = 'srv-test';

const envInput = () => ({
  baseEnv: {
    PATH: `/usr/bin:${HOME}/.local/bin:/opt/homebrew/bin:/bin`,
    HOME: '/somewhere/else',
    USER: 'tester',
    LANG: 'en_US.UTF-8',
    GH_TOKEN: 'ghp_realtoken',
    GITHUB_TOKEN: 'ghp_realtoken',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    AWS_PROFILE: 'dev',
    AWS_SECRET_ACCESS_KEY: 'secret',
    OPENCODE_SERVER_PASSWORD: 'inherited-password-value',
    OPENCODE_CONFIG_CONTENT: '{"inherited":true}',
    OPENCODE_CONFIG_DIR: '/inherited',
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: '1',
    OPENCODE_PID: '123',
    NODE_OPTIONS: '--inspect',
  } as Record<string, string>,
  slug: SLUG,
  home: HOME,
  workspaceRoot: WORKSPACE,
  safety: safetyFor(WORKSPACE),
  password: PW,
  port: 41234,
  paths: { controlDir: controlDir(SLUG, HOME), xdgDataHome: xdgDataHome(SLUG, HOME) },
  tmpDir: `${controlDir(SLUG, HOME)}/tmp`,
  configContentJson: '{"model":"anthropic/m"}',
  sshWrapper: '/repo/profile/git-ssh-fetch-only.sh',
});

describe('buildServerEnv', () => {
  const env = buildServerEnv(envInput());

  it('starts from an allowlist (nothing else leaks in)', () => {
    expect(env.USER).toBe('tester');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.AWS_PROFILE).toBe('dev');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HOME).toBe(HOME);
  });

  it('drops inherited OPENCODE_* except OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS', () => {
    expect(KEEP_OPENCODE_ENV).toEqual(['OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS']);
    expect(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe('1');
    expect(env.OPENCODE_PID).toBeUndefined();
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    // the two we set ourselves replace the inherited values
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"anthropic/m"}');
    expect(env.OPENCODE_SERVER_PASSWORD).toBe(PW);
    const unexpected = Object.keys(env).filter((k) => k.startsWith('OPENCODE_') && !['OPENCODE_CONFIG_CONTENT', 'OPENCODE_SERVER_PASSWORD', ...KEEP_OPENCODE_ENV].includes(k));
    expect(unexpected).toEqual([]);
  });

  it('has no ~/.local/bin in PATH', () => {
    expect(env.PATH).toBe(`${shimBinDir(controlDir(SLUG, HOME))}:/usr/bin:/opt/homebrew/bin:/bin`);
    expect(env.PATH?.split(':')).not.toContain(`${HOME}/.local/bin`);
    expect(stripPathEntry(`${HOME}/.local/bin:/a:${HOME}/.local/bin/`, `${HOME}/.local/bin`)).toBe('/a');
  });

  it('puts the run shim dir (<controlDir>/bin) first in PATH, ahead of everything inherited', () => {
    const dir = `${controlDir(SLUG, HOME)}/bin`;
    expect(shimBinDir(controlDir(SLUG, HOME))).toBe(dir);
    expect(env.PATH?.split(':')[0]).toBe(dir);
    // a PATH that already lists it, or any other order, still gets exactly one copy in front
    const e = buildServerEnv({ ...envInput(), baseEnv: { ...envInput().baseEnv, PATH: `/opt/homebrew/bin:/usr/bin` } });
    expect(e.PATH).toBe(`${dir}:/opt/homebrew/bin:/usr/bin`);
    // the shim dir is not writable by the sandbox: it is the control dir's child, only xdg-data is allowed
    expect(dir.startsWith(`${xdgDataHome(SLUG, HOME)}/`)).toBe(false);
  });

  it('points TMPDIR and zsh TMPPREFIX at the run tmp dir', () => {
    const tmp = `${controlDir(SLUG, HOME)}/tmp`;
    expect(env.TMPDIR).toBe(tmp);
    expect(env.TMPPREFIX).toBe(`${tmp}/zsh`);
  });

  it('sets every push-disable variable, overriding inherited credentials', () => {
    expect(env.GIT_SSH_COMMAND).toBe('/repo/profile/git-ssh-fetch-only.sh');
    expect(env.GIT_SSH_VARIANT).toBe('ssh');
    expect(env.GH_TOKEN).toBe('invalid');
    expect(env.GITHUB_TOKEN).toBe('invalid');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('/usr/bin/false');
    expect(env.SSH_AUTH_SOCK).toBe('');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(count).toBe(4);
    const pushInstead = Array.from({ length: count }, (_, k) => [env[`GIT_CONFIG_KEY_${k}`], env[`GIT_CONFIG_VALUE_${k}`]]).filter(([key]) => key === 'url.nopush://.pushInsteadOf');
    expect(pushInstead.map(([, v]) => v)).toEqual(['git@github.com:', 'ssh://git@github.com/', 'https://github.com/']);
  });

  it('adds extra no-push prefixes (local origins) and quotes an ssh wrapper path with spaces', () => {
    const e = buildServerEnv({ ...envInput(), pushInsteadOf: ['/tmp/origin.git'], sshWrapper: '/my repo/git ssh.sh' });
    expect(e.GIT_CONFIG_COUNT).toBe('5');
    expect(e.GIT_CONFIG_VALUE_4).toBe('/tmp/origin.git');
    expect(e.GIT_SSH_COMMAND).toBe(`'/my repo/git ssh.sh'`);
  });

  it('sets the non-interactive env', () => {
    for (const [k, v] of Object.entries(NON_INTERACTIVE_ENV)) expect(env[k]).toBe(v);
    expect(env).toMatchObject({ CI: '1', GIT_EDITOR: 'true', EDITOR: 'true', VISUAL: 'true', GIT_PAGER: 'cat', PAGER: 'cat', NX_DAEMON: 'false', npm_config_yes: 'true' });
  });

  it('sets per-run XDG_DATA_HOME / TMPDIR and the guard env', () => {
    expect(env.XDG_DATA_HOME).toBe(xdgDataHome(SLUG, HOME));
    expect(env.TMPDIR).toBe(`${controlDir(SLUG, HOME)}/tmp`);
    expect(env.NIGHTGEM_CONTROL_DIR).toBe(controlDir(SLUG, HOME));
    expect(env.NIGHTGEM_RUN_PORT).toBe('41234');
    expect(env.NIGHTGEM_ALLOWED_WRITE_ROOTS).toContain(`${WORKSPACE}/.specs/${SLUG}`);
  });

  it('only the env carries the password (not any other value)', () => {
    const holders = Object.entries(env).filter(([, v]) => v.includes(PW));
    expect(holders.map(([k]) => k)).toEqual(['OPENCODE_SERVER_PASSWORD']);
  });
});

describe('buildServeInvocation', () => {
  it('plain: opencode serve on 127.0.0.1:<port>', () => {
    expect(buildServeInvocation({ opencodeBin: '/opt/homebrew/bin/opencode', port: 5555, sandbox: false })).toEqual({
      file: '/opt/homebrew/bin/opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '5555'],
    });
  });

  it('sandbox: wrapped in sandbox-exec -f <profile>', () => {
    expect(buildServeInvocation({ opencodeBin: '/opt/homebrew/bin/opencode', port: 5555, sandbox: true, sandboxProfilePath: '/ctl/sandbox.sb' })).toEqual({
      file: SANDBOX_EXEC,
      args: ['-f', '/ctl/sandbox.sb', '/opt/homebrew/bin/opencode', 'serve', '--hostname', '127.0.0.1', '--port', '5555'],
    });
  });

  it('sandbox without a profile path is an error', () => {
    expect(() => buildServeInvocation({ opencodeBin: 'x', port: 1, sandbox: true })).toThrow(/profile/);
  });
});

describe('redaction', () => {
  it('redacts the password, its Basic-auth encoding and URL encoding; ignores short secrets', () => {
    const b64 = Buffer.from(`opencode:${PW}`).toString('base64');
    const text = `pw=${PW} auth=Basic ${b64} again ${PW}`;
    const out = redactSecrets(text, [PW, 'abc']);
    expect(out).not.toContain(PW);
    expect(out).not.toContain(b64);
    expect(out).toBe('pw=[REDACTED] auth=Basic [REDACTED] again [REDACTED]');
    expect(redactSecrets('abc abc', ['abc'])).toBe('abc abc');
  });

  it('RedactingLogWriter redacts across chunk boundaries and per line', () => {
    const lines: string[] = [];
    const w = new RedactingLogWriter((l) => lines.push(l), [PW]);
    const half = Math.floor(PW.length / 2);
    w.write(`start ${PW.slice(0, half)}`);
    w.write(`${PW.slice(half)} end\nsecond ${PW}`);
    w.flush();
    expect(lines).toEqual(['[serve] start [REDACTED] end\n', '[serve] second [REDACTED]\n']);
    expect(lines.join('')).not.toContain(PW);
  });
});

describe('descendantPids', () => {
  it('walks the tree below the root, not the root nor siblings', () => {
    const ps = [' 1 0', ' 100 1', ' 101 100', ' 102 100', ' 103 101', ' 200 1', ' 201 200', 'garbage'].join('\n');
    expect(descendantPids(ps, 100).sort()).toEqual([101, 102, 103]);
    expect(descendantPids(ps, 999)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// prepareRunServer / startRunServer against a fake `opencode`
// ---------------------------------------------------------------------------

let root: string;
let fakeBin: string;
let versionFile: string;
let envDump: string;
let grandchildPidFile: string;

const FAKE_OPENCODE = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const here = __dirname;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const pw = process.env.OPENCODE_SERVER_PASSWORD;
fs.writeFileSync(path.join(here, 'env.json'), JSON.stringify({ env: process.env, args, cwd: process.cwd() }));
const gc = spawn('sleep', ['120'], { stdio: 'ignore' });
fs.writeFileSync(path.join(here, 'grandchild.pid'), String(gc.pid));
console.log('serving with password ' + pw);
console.error('basic ' + Buffer.from('opencode:' + pw).toString('base64'));
const server = http.createServer((req, res) => {
  const want = 'Basic ' + Buffer.from('opencode:' + pw).toString('base64');
  if (req.headers.authorization !== want) { res.writeHead(401); return res.end('{}'); }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/info') return res.end(JSON.stringify({ version: fs.readFileSync(path.join(here, 'version.txt'), 'utf8').trim(), pid: process.pid, urls: [], paths: { tmp: '/t' } }));
  if (req.url.startsWith('/api/agent')) return res.end(JSON.stringify({ location: { directory: process.cwd() }, data: [] }));
  res.writeHead(404); res.end('{}');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

let savedTmpdir: string | undefined;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ng-server-'));
  // the run tmp dir is os.tmpdir()/nightgem-<slug>: keep it inside this test's root
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  fakeBin = join(root, 'fake-opencode');
  versionFile = join(root, 'version.txt');
  envDump = join(root, 'env.json');
  grandchildPidFile = join(root, 'grandchild.pid');
  writeFileSync(fakeBin, FAKE_OPENCODE);
  chmodSync(fakeBin, 0o755);
});

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(root, { recursive: true, force: true });
});

function freshHome(): string {
  const home = mkdtempSync(join(root, 'home-'));
  return home;
}

const baseEnv = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/ignored', OPENCODE_STALE: '1', NODE_OPTIONS: '' });

describe('prepareRunServer', () => {
  it('creates a 0700 control dir with a 0600 password file; writes config, sandbox profile and git repo', async () => {
    const home = freshHome();
    const prep = await prepareRunServer({
      slug: SLUG,
      home,
      workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')),
      model: 'anthropic/claude-opus-5-5',
      smallModel: 'anthropic/claude-haiku-5-5',
      port: 45678,
      opencodeBin: '/opt/homebrew/bin/opencode',
      sandbox: true,
      baseEnv: baseEnv(),
    });
    const ctl = controlDir(SLUG, home);
    expect(statSync(ctl).mode & 0o777).toBe(0o700);
    expect(statSync(prep.passwordFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(prep.passwordFile, 'utf8').trim()).toBe(prep.password);
    expect(prep.password).toMatch(/^[0-9a-f]{48}$/);
    expect(existsSync(join(runDir(SLUG, join(home, 'workspace')), '.git'))).toBe(true);
    expect(existsSync(join(runDir(SLUG, join(home, 'workspace')), 'opencode.json'))).toBe(true);
    expect(existsSync(join(runDir(SLUG, join(home, 'workspace')), '.opencode', 'oh-my-opencode-slim.jsonc'))).toBe(true);

    // sandbox profile in the control dir, wrapping applied, port denied
    expect(prep.sandboxProfilePath).toBe(join(ctl, 'sandbox.sb'));
    expect(statSync(prep.sandboxProfilePath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(prep.sandboxProfilePath!, 'utf8')).toContain('localhost:45678');
    expect(prep.invocation.file).toBe(SANDBOX_EXEC);
    expect(prep.invocation.args.slice(0, 2)).toEqual(['-f', prep.sandboxProfilePath]);

    // config content: explicit model, guard dir from the repo
    const cfg = JSON.parse(prep.env.OPENCODE_CONFIG_CONTENT!);
    expect(cfg.model).toBe('anthropic/claude-opus-5-5');
    expect(cfg.plugins[0].package).toMatch(/profile\/guard$/);

    // the password is in the env only: not in any file we render, not in the invocation
    expect(prep.env.OPENCODE_SERVER_PASSWORD).toBe(prep.password);
    expect(prep.env.OPENCODE_STALE).toBeUndefined();
    expect(JSON.stringify(prep.invocation)).not.toContain(prep.password);
    expect(readFileSync(prep.sandboxProfilePath!, 'utf8')).not.toContain(prep.password);
    expect(prep.env.OPENCODE_CONFIG_CONTENT).not.toContain(prep.password);
    expect(readFileSync(join(runDir(SLUG, join(home, 'workspace')), 'opencode.json'), 'utf8')).not.toContain(prep.password);
  });

  it('the run tmp dir is <os.tmpdir()>/nightgem-<slug> (0700), outside the control dir, and is $TMPDIR and the sandbox/guard tmp', async () => {
    const home = freshHome();
    const prep = await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: true, port: 45679, baseEnv: baseEnv() });
    expect(prep.tmpDir).toBe(runTmpDir(SLUG));
    expect(prep.tmpDir).toBe(join(realpathSync(root), `nightgem-${SLUG}`));
    expect(prep.tmpDir).not.toContain(' ');
    expect(prep.tmpDir.startsWith(controlDir(SLUG, home))).toBe(false);
    expect(statSync(prep.tmpDir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(controlDir(SLUG, home), 'tmp'))).toBe(false);
    expect(prep.env.TMPDIR).toBe(prep.tmpDir);
    expect(prep.env.NIGHTGEM_ALLOWED_WRITE_ROOTS).toContain(prep.tmpDir);
    expect(readFileSync(prep.sandboxProfilePath!, 'utf8')).toContain(`(subpath "${prep.tmpDir}")`); // realpath'd, so it is already the /private form the sandbox needs
    // the control dir (password, flags, sandbox profile) never sits inside the agent-writable tmp dir
    expect(prep.passwordFile.startsWith(prep.tmpDir)).toBe(false);
  });

  it('an explicit tmpDir input wins (tests, custom setups)', async () => {
    const home = freshHome();
    const tmpDir = join(root, 'custom-tmp');
    const prep = await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: false, tmpDir, baseEnv: baseEnv() });
    expect(prep.tmpDir).toBe(tmpDir);
    expect(prep.env.TMPDIR).toBe(tmpDir);
  });

  it('wipes and recreates the run tmp dir (0700) at every start, whatever an earlier server left in it', async () => {
    const home = freshHome();
    const tmpDir = join(root, 'wipe-tmp');
    mkdirSync(join(tmpDir, 'old-dir'), { recursive: true });
    writeFileSync(join(tmpDir, 'old-file'), 'x');
    writeFileSync(join(tmpDir, 'old-dir', 'nested'), 'x');
    chmodSync(tmpDir, 0o755);
    const input = { slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: false, tmpDir, baseEnv: baseEnv() };
    await prepareRunServer(input);
    expect(readdirSync(tmpDir)).toEqual([]);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    writeFileSync(join(tmpDir, 'again'), 'x');
    await prepareRunServer(input);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('installs the mktemp shim into <controlDir>/bin as a read-only, executable copy of profile/shims/mktemp, and keeps PATH pointing at it', async () => {
    const home = freshHome();
    const prep = await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: true, port: 45680, baseEnv: baseEnv() });
    const dir = join(controlDir(SLUG, home), 'bin');
    expect(prep.env.PATH?.split(':')[0]).toBe(dir);
    const shim = join(dir, 'mktemp');
    expect(statSync(shim).mode & 0o777).toBe(0o555);
    expect(readFileSync(shim, 'utf8')).toBe(readFileSync(join(DEFAULT_REPO_ROOT, 'profile', 'shims', 'mktemp'), 'utf8'));
    // the sandbox profile grants no write on the shim dir (it is the control dir's child; only xdg-data is below it)
    const sb = readFileSync(prep.sandboxProfilePath!, 'utf8');
    expect(sb).not.toContain(dir);
    // a second start replaces a stale or tampered copy
    chmodSync(shim, 0o755);
    writeFileSync(shim, '#!/bin/sh\necho pwned\n');
    await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: true, port: 45680, baseEnv: baseEnv() });
    expect(readFileSync(shim, 'utf8')).not.toContain('pwned');
    expect(statSync(shim).mode & 0o777).toBe(0o555);
  });

  it('MCP servers of the safety inputs are switched off in the rendered run config (slim disabled_mcps + tool denies), without values', async () => {
    const home = freshHome();
    const safety = { ...safetyFor(join(home, 'workspace')), mcpServerNames: ['atlassian', 'my.server'] };
    const prep = await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety, model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: false, baseEnv: baseEnv() });
    const rules = prep.env.OPENCODE_CONFIG_CONTENT!;
    expect(rules).toContain('atlassian_*');
    expect(rules).toContain('my_server_*');
    // switched off in the config itself, with an inert stand-in: nothing of the user's definition (no command, url, headers)
    expect(JSON.parse(rules).mcp).toEqual({ servers: { atlassian: { type: 'local', command: ['/usr/bin/false'], disabled: true }, 'my.server': { type: 'local', command: ['/usr/bin/false'], disabled: true } } });
    const slim = JSON.parse(readFileSync(join(runDir(SLUG, join(home, 'workspace')), '.opencode', 'oh-my-opencode-slim.jsonc'), 'utf8').replace(/^\/\/.*\n/, '')) as { disabled_mcps: string[] };
    expect(slim.disabled_mcps).toEqual(['atlassian', 'my.server']);
  });

  it('no sandbox: plain invocation and no sandbox profile', async () => {
    const home = freshHome();
    const prep = await prepareRunServer({ slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'a/b', smallModel: 'a/c', opencodeBin: '/bin/oc', sandbox: false, baseEnv: baseEnv() });
    expect(prep.sandboxProfilePath).toBeUndefined();
    expect(prep.invocation.file).toBe('/bin/oc');
    expect(prep.port).toBeGreaterThan(0);
  });

  it('end to end: NIGHTGEM_<AGENT>_MODEL env -> agentModelOverrides -> slim overrides entry {model, variant}', async () => {
    const env = { NIGHTGEM_FIXER_MODEL: 'anthropic/x#medium', NIGHTGEM_DESIGNER_MODEL: 'openai/gpt-9', NIGHTGEM_EXPLORER_MODEL: 'anthropic/claude-haiku-5-5#high' };
    const home = freshHome();
    const prep = await prepareRunServer({
      slug: SLUG, home, workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')), model: 'anthropic/claude-opus-5-5', smallModel: 'anthropic/claude-haiku-5-5', opencodeBin: '/bin/oc', sandbox: false, baseEnv: baseEnv(),
      agentModels: agentModelOverrides(env),
    });
    const slim = JSON.parse(readFileSync(join(runDir(SLUG, join(home, 'workspace')), '.opencode', 'oh-my-opencode-slim.jsonc'), 'utf8').replace(/^\/\/.*\n/, ''));
    // the override's variant wins; an override without one keeps the agent's default variant; the rest keep the defaults
    expect(slim.agents.fixer).toEqual({ model: 'anthropic/x', variant: 'medium' });
    expect(slim.agents.designer).toEqual({ model: 'openai/gpt-9', variant: 'medium' });
    expect(slim.agents.explorer).toEqual({ model: 'anthropic/claude-haiku-5-5', variant: 'high' });
    expect(slim.agents.oracle).toEqual({ model: 'anthropic/claude-opus-5-5', variant: 'xhigh' });
    expect(slim.agents.librarian).toEqual({ model: 'anthropic/claude-haiku-5-5', variant: 'low' });
    expect(JSON.stringify(slim)).not.toContain('"model":{');
    // top-level run model is untouched
    expect(JSON.parse(prep.env.OPENCODE_CONFIG_CONTENT!).model).toBe('anthropic/claude-opus-5-5');
  });

  it('rejects a malformed model ref', async () => {
    await expect(prepareRunServer({ slug: SLUG, home: freshHome(), workspaceRoot: join(freshHome(), 'workspace'), safety: safetyFor(WORKSPACE), model: 'nomodel', smallModel: 'a/c', opencodeBin: 'x', sandbox: false })).rejects.toThrow(/Invalid model/);
  });
});

describe('startRunServer (fake opencode)', () => {
  it('starts, passes the handshake, scrubs the env, redacts logs, and stop() kills the whole tree', async () => {
    writeFileSync(versionFile, `${EXPECTED_OPENCODE_VERSION}\n`);
    const home = freshHome();
    const server = await startRunServer({
      slug: SLUG,
      home,
      workspaceRoot: join(home, 'workspace'), safety: safetyFor(join(home, 'workspace')),
      model: 'anthropic/claude-opus-5-5',
      smallModel: 'anthropic/claude-haiku-5-5',
      opencodeBin: fakeBin,
      sandbox: false,
      baseEnv: { ...baseEnv(), PATH: `${home}/.local/bin:${baseEnv().PATH}` },
      startTimeoutMs: 20_000,
    });
    try {
      expect(server.version).toBe(EXPECTED_OPENCODE_VERSION);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.pid).toBeGreaterThan(0);
      expect(isPidAlive(server.pid)).toBe(true);
      expect(await server.api.listAgents()).toEqual([]);

      const dump = JSON.parse(readFileSync(envDump, 'utf8'));
      expect(dump.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(server.port)]);
      expect(dump.cwd).toContain(join('.specs', SLUG, '.run'));
      expect(dump.env.OPENCODE_STALE).toBeUndefined();
      expect(dump.env.PATH.split(':')).not.toContain(`${home}/.local/bin`);
      expect(dump.env.XDG_DATA_HOME).toBe(xdgDataHome(SLUG, home));

      const password = readFileSync(server.passwordFile, 'utf8').trim();
      expect(Object.values(server).filter((v) => typeof v === 'string' && v.includes(password))).toEqual([]);

      // server output was redacted before reaching orchestrator.log (give the pipe a moment)
      await new Promise((r) => setTimeout(r, 300));
      const log = readFileSync(server.logPath, 'utf8');
      expect(log).toContain('[serve] serving with password [REDACTED]');
      expect(log).not.toContain(password);
      expect(log).not.toContain(Buffer.from(`opencode:${password}`).toString('base64'));

      const grandchild = Number(readFileSync(grandchildPidFile, 'utf8'));
      expect(isPidAlive(grandchild)).toBe(true);

      await server.stop();
      expect(isPidAlive(server.pid)).toBe(false);
      expect(isPidAlive(grandchild)).toBe(false);
      expect(server.hasExited()).toBe(true);
      await server.stop(); // idempotent
    } finally {
      await server.stop();
    }
  }, 40_000);

  it('a version mismatch fails startup and leaves no process behind', async () => {
    writeFileSync(versionFile, '1.2.3\n');
    const ws = join(freshHome(), 'workspace');
    const err = await startRunServer({
      slug: 'srv-mismatch',
      home: freshHome(),
      workspaceRoot: ws,
      safety: safetyFor(ws),
      model: 'a/b',
      smallModel: 'a/c',
      opencodeBin: fakeBin,
      sandbox: false,
      baseEnv: baseEnv(),
      startTimeoutMs: 20_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as ServerStartError).code).toBe('version-mismatch');
    expect(isPidAlive(Number(readFileSync(grandchildPidFile, 'utf8')))).toBe(false);
  }, 40_000);

  it('a server that exits during startup fails fast with code "exited"', async () => {
    const dead = join(root, 'dead-opencode');
    writeFileSync(dead, '#!/bin/sh\necho boom >&2\nexit 3\n');
    chmodSync(dead, 0o755);
    const ws = join(freshHome(), 'workspace');
    const err = await startRunServer({
      slug: 'srv-dead',
      home: freshHome(),
      workspaceRoot: ws,
      safety: safetyFor(ws),
      model: 'a/b',
      smallModel: 'a/c',
      opencodeBin: dead,
      sandbox: false,
      baseEnv: baseEnv(),
      startTimeoutMs: 20_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartError);
    expect((err as ServerStartError).code).toBe('exited');
  }, 40_000);
});

describe('resetRunTmpDir', () => {
  it('refuses a dir that is, or contains, a protected path, or is too shallow', () => {
    const base = mkdtempSync(join(tmpdir(), 'ng-reset-'));
    try {
      const keep = join(base, 'keep');
      mkdirSync(keep);
      writeFileSync(join(keep, 'f'), 'x');
      expect(() => resetRunTmpDir(keep, [keep])).toThrow(/Refusing/);
      expect(() => resetRunTmpDir(base, [keep])).toThrow(/contains/);
      expect(() => resetRunTmpDir('/', [])).toThrow(/Refusing/);
      expect(() => resetRunTmpDir('/tmp', [])).toThrow(/Refusing/);
      expect(() => resetRunTmpDir('relative/dir', [])).toThrow(/Refusing/);
      expect(readFileSync(join(keep, 'f'), 'utf8')).toBe('x');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('unlinks a symlink at the path instead of following it', () => {
    const base = mkdtempSync(join(tmpdir(), 'ng-reset-'));
    try {
      const target = join(base, 'target');
      mkdirSync(target);
      writeFileSync(join(target, 'f'), 'x');
      const link = join(base, 'nightgem-link');
      symlinkSync(target, link);
      resetRunTmpDir(link, []);
      expect(readFileSync(join(target, 'f'), 'utf8')).toBe('x');
      expect(statSync(link).isDirectory()).toBe(true);
      expect(readdirSync(link)).toEqual([]);
      expect(realpathSync(link)).toBe(link.replace(/^\/var\//, '/private/var/'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('installRunShims', () => {
  it('copies each shim 0555 into <controlDir>/bin (0700) and is idempotent', () => {
    const base = mkdtempSync(join(tmpdir(), 'ng-shim-'));
    try {
      const dir = installRunShims(base, DEFAULT_REPO_ROOT);
      expect(dir).toBe(join(base, 'bin'));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual(['mktemp']);
      expect(statSync(join(dir, 'mktemp')).mode & 0o777).toBe(0o555);
      installRunShims(base, DEFAULT_REPO_ROOT);
      expect(statSync(join(dir, 'mktemp')).mode & 0o777).toBe(0o555);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
