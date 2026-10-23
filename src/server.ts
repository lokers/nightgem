/**
 * Run-server lifecycle prepare the isolated per-run `opencode serve`, spawn it (optionally under
 * `sandbox-exec`), wait until healthy, run the version handshake, and stop it again.
 *
 * - Own port + password, run dir as cwd (own `git init`), own `XDG_DATA_HOME`, inherited `OPENCODE_*` scrubbed.
 * - No push capability in the env (ssh wrapper, pushInsteadOf, no credentials).
 * - The password lives in `<controlDir>/server.pw` (0600, dir 0700). It is NEVER returned, logged or put in
 *   an error message; server output is redacted before it reaches `orchestrator.log`.
 * - Serve runs non-detached in the orchestrator's process group (launchd's `AbandonProcessGroup=false`
 *   then takes it down if the orchestrator is `kill -9`ed). Because it shares our pgid, `stop()` cannot signal the
 *   group; it walks the process tree under the server pid instead.
 */
import { execa } from 'execa';
import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { TMP_PREFIX } from './brand.ts';
import { RunApiError, createRunApi, type RunClient } from './client.ts';
import { parseModelRef, type SafetyInputs } from './contracts.ts';
import { EXPECTED_OPENCODE_VERSION } from './doctor.ts';
import { runPaths, type RunPaths } from './paths.ts';
import {
  DEFAULT_NOPUSH_PREFIXES,
  buildGuardEnv,
  buildSafetyEnv,
  renderRunConfig,
  writeRunDirFiles,
  type RenderedRunConfig,
  type AgentModelOverride,
} from './profile.ts';
import { SANDBOX_EXEC, renderSandboxProfile, sandboxArgs } from './sandbox.ts';
import { isPidAlive } from './state.ts';

export const SERVER_HOST = '127.0.0.1';
export const STOP_GRACE_MS = 5_000;
export const DEFAULT_START_TIMEOUT_MS = 90_000;
/** Environment variables inherited from the caller. Everything else is dropped. */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', '__CF_USER_TEXT_ENCODING'];
/** Passed through when set (config, not credentials). Extend with `passEnv`. */
export const DEFAULT_PASS_ENV = ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
/** The only inherited `OPENCODE_*` variable that survives (slim needs it for background subagents). */
export const KEEP_OPENCODE_ENV = ['OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'];
/** Env that keeps tools non-interactive */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  CI: '1',
  GIT_EDITOR: 'true',
  EDITOR: 'true',
  VISUAL: 'true',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  NX_DAEMON: 'false',
  npm_config_yes: 'true',
};

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Replace every secret (and its Basic-auth encoding) in `text`. Empty/short secrets are ignored. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const needles = new Set<string>();
  for (const s of secrets) {
    if (s.length < 8) continue;
    needles.add(s);
    needles.add(Buffer.from(`opencode:${s}`).toString('base64'));
    needles.add(encodeURIComponent(s));
  }
  for (const n of [...needles].sort((a, b) => b.length - a.length)) out = out.split(n).join(REDACTED);
  return out;
}

/** Drop `dir` (exact match) from a PATH string. */
export function stripPathEntry(pathValue: string, dir: string): string {
  return pathValue
    .split(':')
    .filter((p) => p !== '' && p !== dir && p !== `${dir}/`)
    .join(':');
}

export interface BuildServerEnvInput {
  /** The caller's environment (defaults to `process.env`). Only the allowlist survives. */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  slug: string;
  home: string;
  workspaceRoot: string;
  /** The run's safety inputs (the snapshot's); passed to the guard env. */
  safety: SafetyInputs;
  password: string;
  port: number;
  paths: Pick<RunPaths, 'controlDir' | 'xdgDataHome'>;
  tmpDir: string;
  configContentJson: string;
  /** Absolute path of `profile/git-ssh-fetch-only.sh`. */
  sshWrapper: string;
  /** Added to `DEFAULT_NOPUSH_PREFIXES` as `url.nopush://.pushInsteadOf` (the spec repos' remote URLs and host prefixes). */
  pushInsteadOf?: string[];
  /** `url.nopush://.insteadOf` (the spec repos' explicit pushurls). */
  insteadOf?: string[];
  passEnv?: string[];
}

function shellQuoteIfNeeded(p: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

/** The complete, minimal environment of the serve process. Pure. */
export function buildServerEnv(i: BuildServerEnvInput): Record<string, string> {
  const base = i.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of [...ENV_ALLOWLIST, ...(i.passEnv ?? DEFAULT_PASS_ENV), ...KEEP_OPENCODE_ENV]) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = i.home;
  // PATH without ~/.local/bin (that is where user-installed wrappers such as gh helpers live)
  env.PATH = stripPathEntry(env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', `${i.home}/.local/bin`);

  Object.assign(env, NON_INTERACTIVE_ENV);
  Object.assign(
    env,
    buildSafetyEnv({
      sshWrapper: shellQuoteIfNeeded(i.sshWrapper),
      pushInsteadOf: [...DEFAULT_NOPUSH_PREFIXES, ...(i.pushInsteadOf ?? [])],
      insteadOf: i.insteadOf ?? [],
      sshLog: join(i.paths.xdgDataHome, 'ssh-wrapper.log'),
    }),
  );
  Object.assign(
    env,
    buildGuardEnv({ slug: i.slug, workspaceRoot: i.workspaceRoot, controlDir: i.paths.controlDir, tmpDir: i.tmpDir, port: i.port, safety: i.safety }),
  );

  env.OPENCODE_CONFIG_CONTENT = i.configContentJson;
  env.OPENCODE_SERVER_PASSWORD = i.password;
  env.XDG_DATA_HOME = i.paths.xdgDataHome;
  env.TMPDIR = i.tmpDir;
  return env;
}

export interface ServeInvocation {
  file: string;
  args: string[];
}

/** `opencode serve ...`, wrapped in `sandbox-exec -f <profile>` when `sandbox` is true. Pure. */
export function buildServeInvocation(i: { opencodeBin: string; port: number; sandbox: boolean; sandboxProfilePath?: string }): ServeInvocation {
  const serve = [i.opencodeBin, 'serve', '--hostname', SERVER_HOST, '--port', String(i.port)];
  if (!i.sandbox) return { file: serve[0]!, args: serve.slice(1) };
  if (!i.sandboxProfilePath) throw new Error('sandbox requested but no sandbox profile path given');
  return { file: SANDBOX_EXEC, args: sandboxArgs(i.sandboxProfilePath, serve) };
}

/** Pids below `rootPid` (excluding it) from `ps -axo pid=,ppid=` output. */
export function descendantPids(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** Line-buffered redacting writer for the server's stdout/stderr. */
export class RedactingLogWriter {
  private buf = '';
  constructor(
    private readonly sink: (line: string) => void,
    private readonly secrets: readonly string[],
    private readonly prefix = '[serve] ',
  ) {}

  write(chunk: string | Buffer): void {
    this.buf += chunk.toString();
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.emit(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    // never hold an unbounded partial line (a secret split by the cut would otherwise leak)
    if (this.buf.length > 64 * 1024) {
      this.emit(this.buf);
      this.buf = '';
    }
  }

  flush(): void {
    if (this.buf !== '') this.emit(this.buf);
    this.buf = '';
  }

  private emit(line: string): void {
    this.sink(`${this.prefix}${redactSecrets(line, this.secrets)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Prepare (all filesystem work, no process)
// ---------------------------------------------------------------------------

export interface StartRunServerInput {
  slug: string;
  home: string;
  /** Directory holding the repos and `.specs` (sandbox write subpath, permission globs, guard roots). */
  workspaceRoot: string;
  /** The run's safety inputs (the snapshot's), threaded to the config, sandbox and guard renderers. */
  safety: SafetyInputs;
  /** `providerID/modelID` for the orchestrator, oracle, fixer and designer. */
  model: string;
  /** `providerID/modelID` for `small_model` and the light agents. */
  smallModel: string;
  /** Free port when omitted. */
  port?: number;
  /** Absolute path of the opencode binary. */
  opencodeBin: string;
  /** Wrap the server in `sandbox-exec` (the write boundary). */
  sandbox: boolean;
  extraWriteSubpaths?: string[];
  /** Directory of already RENDERED `*_append.md` files to install into the run dir (the orchestrator renders `prompts/`). */
  appendsDir?: string;
  /** Per-agent overrides only (`{ model, variant? }`); the defaults per agent come from `renderRunConfig`. */
  agentModels?: Partial<Record<string, AgentModelOverride>>;
  runDirWritable?: string[];
  /** Extra `pushInsteadOf` prefixes (rewrite pushes to `nopush://`), computed from the spec repos' remotes (`src/remotes.ts`). */
  pushInsteadOf?: string[];
  /** Extra `insteadOf` values: the spec repos' explicit pushurls. */
  insteadOf?: string[];
  passEnv?: string[];
  /** Repo root holding `profile/`. Defaults to this package. */
  repoRoot?: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** The run's `$TMPDIR` (created 0700). Defaults to `runTmpDir(slug)`. */
  tmpDir?: string;
  /** Defaults to the pinned `EXPECTED_OPENCODE_VERSION`. */
  expectedVersion?: string;
  startTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PreparedRunServer {
  paths: RunPaths;
  port: number;
  password: string;
  tmpDir: string;
  passwordFile: string;
  sandboxProfilePath: string | undefined;
  rendered: RenderedRunConfig;
  env: Record<string, string>;
  invocation: ServeInvocation;
}

export const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The run's `$TMPDIR`: `<os.tmpdir()>/nightgem-<slug>`, deliberately OUTSIDE the control dir (the control dir holds
 * the password, flags and sandbox profile, and the agent is allowed to write to its tmp dir). `os.tmpdir()` has no
 * spaces on macOS. The base is resolved through symlinks (`/tmp` -> `/private/tmp`) so the sandbox, the guard roots and
 * `$TMPDIR` all name the same real path. `slug` is validated by the caller (`assertSlug`).
 */
export function runTmpDir(slug: string, base: string = tmpdir()): string {
  let real = base;
  try {
    real = realpathSync(base);
  } catch {
    /* a base that does not exist yet is used as given */
  }
  return join(real, `${TMP_PREFIX}${slug}`);
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, SERVER_HOST, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('Could not determine a free port'))));
    });
  });
}

export function generatePassword(): string {
  return randomBytes(24).toString('hex');
}

function writeSecretFile(file: string, content: string): void {
  if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Create dirs/files, render config and sandbox profile, build env and command. No process is started. */
export async function prepareRunServer(input: StartRunServerInput): Promise<PreparedRunServer> {
  parseModelRef(input.model);
  parseModelRef(input.smallModel);
  const repoRoot = input.repoRoot ?? DEFAULT_REPO_ROOT;
  const paths = runPaths(input.slug, { home: input.home, workspaceRoot: input.workspaceRoot });
  const tmpDir = input.tmpDir ?? runTmpDir(input.slug);

  // control dir 0700 (secrets, flags) and per-run data; the tmp dir lives outside it (see runTmpDir)
  mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.controlDir, 0o700);
  mkdirSync(paths.xdgDataHome, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  chmodSync(tmpDir, 0o700);
  mkdirSync(paths.runDir, { recursive: true });

  if (!existsSync(join(paths.runDir, '.git'))) {
    await execa('git', ['init', '-q'], { cwd: paths.runDir, stdin: 'ignore' });
  }

  const port = input.port ?? (await findFreePort());
  const password = generatePassword();
  const passwordFile = join(paths.controlDir, 'server.pw');
  writeSecretFile(passwordFile, `${password}\n`);

  const rendered = renderRunConfig({
    slug: input.slug,
    home: input.home,
    workspaceRoot: input.workspaceRoot,
    runDir: paths.runDir,
    controlDir: paths.controlDir,
    tmpDir,
    model: input.model,
    smallModel: input.smallModel,
    guardDir: join(repoRoot, 'profile', 'guard'),
    ...(input.agentModels ? { agentModels: input.agentModels } : {}),
    ...(input.runDirWritable ? { runDirWritable: input.runDirWritable } : {}),
    safety: input.safety,
    mcpServerNames: input.safety.mcpServerNames ?? [],
  });
  writeRunDirFiles(paths.runDir, rendered, input.appendsDir);

  let sandboxProfilePath: string | undefined;
  if (input.sandbox) {
    sandboxProfilePath = join(paths.controlDir, 'sandbox.sb');
    writeSecretFile(
      sandboxProfilePath,
      renderSandboxProfile({
        home: input.home,
        workspaceRoot: input.workspaceRoot,
        tmpDir,
        xdgDataHome: paths.xdgDataHome,
        port,
        ...(input.extraWriteSubpaths ? { extraWriteSubpaths: input.extraWriteSubpaths } : {}),
        safety: input.safety,
      }),
    );
  }

  const env = buildServerEnv({
    ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
    slug: input.slug,
    home: input.home,
    workspaceRoot: input.workspaceRoot,
    safety: input.safety,
    password,
    port,
    paths,
    tmpDir,
    configContentJson: rendered.configContentJson,
    sshWrapper: join(repoRoot, 'profile', 'git-ssh-fetch-only.sh'),
    ...(input.pushInsteadOf ? { pushInsteadOf: input.pushInsteadOf } : {}),
    ...(input.insteadOf ? { insteadOf: input.insteadOf } : {}),
    ...(input.passEnv ? { passEnv: input.passEnv } : {}),
  });

  const invocation = buildServeInvocation({
    opencodeBin: input.opencodeBin,
    port,
    sandbox: input.sandbox,
    ...(sandboxProfilePath ? { sandboxProfilePath } : {}),
  });

  return { paths, port, password, tmpDir, passwordFile, sandboxProfilePath, rendered, env, invocation };
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

export interface ServerExit {
  exitCode: number | undefined;
  signal: string | undefined;
}

export interface RunServer {
  api: RunClient;
  url: string;
  port: number;
  pid: number;
  /** opencode version reported by the handshake. */
  version: string;
  controlDir: string;
  /** Path of the 0600 password file (the password itself is never exposed). */
  passwordFile: string;
  logPath: string;
  /** Resolves when the server process ends (crash, or after `stop()`). */
  exited: Promise<ServerExit>;
  hasExited(): boolean;
  /** TERM the server process tree, then KILL after `STOP_GRACE_MS`. Idempotent. */
  stop(): Promise<void>;
}

export class ServerStartError extends Error {
  readonly code: 'exited' | 'timeout' | 'version-mismatch' | 'handshake-failed';
  constructor(code: ServerStartError['code'], message: string) {
    super(message);
    this.name = 'ServerStartError';
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function listDescendants(rootPid: number): Promise<number[]> {
  try {
    const r = await execa('ps', ['-axo', 'pid=,ppid='], { stdin: 'ignore', reject: false });
    return descendantPids(String(r.stdout ?? ''), rootPid);
  } catch {
    return [];
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** Kill `rootPid` and everything below it: TERM first, KILL for stragglers after `graceMs`. */
export async function killProcessTree(rootPid: number, graceMs: number = STOP_GRACE_MS): Promise<void> {
  const known = new Set<number>([rootPid, ...(await listDescendants(rootPid))]);
  for (const pid of known) signal(pid, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    for (const pid of await listDescendants(rootPid)) known.add(pid);
    if (![...known].some((p) => isPidAlive(p))) return;
    await sleep(100);
  }
  for (const pid of await listDescendants(rootPid)) known.add(pid);
  for (const pid of known) if (isPidAlive(pid)) signal(pid, 'SIGKILL');
  // reap
  const reapDeadline = Date.now() + 2_000;
  while (Date.now() < reapDeadline && [...known].some((p) => isPidAlive(p))) await sleep(50);
}

/** Poll `/api/agent` until every id in `required` is registered (slim registers 5-15 s after start). */
export async function waitForAgents(api: Pick<RunClient, 'listAgents'>, required: readonly string[], timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let ids: string[] = [];
  for (;;) {
    try {
      ids = (await api.listAgents()).map((a) => a.id);
      if (required.every((r) => ids.includes(r))) return ids;
    } catch {
      /* not ready */
    }
    if (Date.now() >= deadline) {
      throw new ServerStartError('timeout', `agents not registered after ${timeoutMs} ms (have: ${ids.join(', ') || 'none'}; need: ${required.join(', ')})`);
    }
    await sleep(500);
  }
}

export async function startRunServer(input: StartRunServerInput): Promise<RunServer> {
  const prep = await prepareRunServer(input);
  const { paths, port, password } = prep;
  const url = `http://${SERVER_HOST}:${port}`;
  const logPath = paths.orchestratorLog;
  const expectedVersion = input.expectedVersion ?? EXPECTED_OPENCODE_VERSION;

  const secrets = [password];
  const writer = new RedactingLogWriter((line) => appendFileSync(logPath, line, { mode: 0o644 }), secrets);
  appendFileSync(logPath, redactSecrets(`[serve] starting: ${prep.invocation.file} ${prep.invocation.args.join(' ')}\n`, secrets));

  const child = execa(prep.invocation.file, prep.invocation.args, {
    cwd: paths.runDir,
    env: prep.env,
    extendEnv: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    detached: false,
  });
  child.stdout?.on('data', (c: Buffer) => writer.write(c));
  child.stderr?.on('data', (c: Buffer) => writer.write(c));

  let exitedFlag = false;
  const exited: Promise<ServerExit> = Promise.resolve(child).then(
    (r) => {
      exitedFlag = true;
      writer.flush();
      const result = r as { exitCode?: number; signal?: string };
      appendFileSync(logPath, `[serve] exited code=${result.exitCode ?? 'none'} signal=${result.signal ?? 'none'}\n`);
      return { exitCode: result.exitCode, signal: result.signal };
    },
    (err: unknown) => {
      exitedFlag = true;
      writer.flush();
      appendFileSync(logPath, redactSecrets(`[serve] failed: ${err instanceof Error ? err.message : String(err)}\n`, secrets));
      return { exitCode: undefined, signal: undefined };
    },
  );

  const pid = child.pid;
  if (pid === undefined) {
    await exited;
    throw new ServerStartError('exited', `failed to spawn ${input.opencodeBin}`);
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (!exitedFlag) await killProcessTree(pid, STOP_GRACE_MS);
      await Promise.race([exited, sleep(2_000)]);
    })();
    return stopping;
  };

  const api = createRunApi({ baseUrl: url, password, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });

  try {
    const deadline = Date.now() + (input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let version: string | undefined;
    while (version === undefined) {
      if (exitedFlag) {
        const r = await exited;
        throw new ServerStartError('exited', `opencode serve exited during startup (code ${r.exitCode ?? 'none'}, signal ${r.signal ?? 'none'}); see ${logPath}`);
      }
      try {
        version = (await api.getInfo()).version;
      } catch (err) {
        if (err instanceof RunApiError && err.isUnauthorized) {
          throw new ServerStartError('handshake-failed', 'server rejected the generated credentials (401)');
        }
        if (Date.now() >= deadline) {
          throw new ServerStartError('timeout', `opencode serve not healthy after ${input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS} ms; see ${logPath}`);
        }
        await sleep(250);
      }
    }
    if (version !== expectedVersion) {
      throw new ServerStartError('version-mismatch', `opencode version ${version} != expected ${expectedVersion}`);
    }
    try {
      await api.listAgents();
    } catch (err) {
      throw new ServerStartError('handshake-failed', `GET /api/agent failed: ${redactSecrets(err instanceof Error ? err.message : String(err), secrets)}`);
    }

    return {
      api,
      url,
      port,
      pid,
      version,
      controlDir: paths.controlDir,
      passwordFile: prep.passwordFile,
      logPath,
      exited,
      hasExited: () => exitedFlag,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
