/**
 * sandbox-exec write boundary for the run server (see docs/opencode-notes.md).
 * `(allow default)(deny file-write*)` plus an allowlist of writable subpaths, a `file-read*` deny for credential
 * locations the run never reads (including `~/.ssh` and the CLI login dirs under `~/.config`), a deny for outbound connections to the run
 * server's own port (so shells spawned by the agent cannot call the run API) and a deny for outbound port 22 (ssh push).
 * The orchestrator runs OUTSIDE the sandbox.
 */
import { join } from 'node:path';

import { APP, CONTROL_DIR_NAME } from './brand.ts';
import type { SafetyInputs } from './contracts.ts';
import { assertSameWorkspace, normalizeSecretPath } from './profile.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export interface SandboxProfileInput {
  home: string;
  workspaceRoot: string;
  /** The run's `$TMPDIR`. */
  tmpDir: string;
  /** The run's `XDG_DATA_HOME` (isolated opencode DB). */
  xdgDataHome: string;
  /** The run server port. */
  port: number;
  /** Widen one subpath at a time, and only when a build step needs it. */
  extraWriteSubpaths?: string[];
  /**
   * Consumed for the read boundary: `deny.secretPaths` are added to the `file-read*` denies (except the paths the server
   * tree itself needs, see `SANDBOX_READ_EXEMPT`). `safety.workspaceRoot` must equal `workspaceRoot`, the one write subpath.
   */
  safety: SafetyInputs;
}

/** macOS reports /tmp, /var and /etc under /private; the sandbox matches the real path. */
export function canonicalMacPath(p: string): string {
  return /^\/(tmp|var|etc)(\/|$)/.test(p) ? `/private${p}` : p;
}

function sbString(s: string): string {
  if (/[\0\n\r]/.test(s)) throw new Error('Invalid character in sandbox path');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Subpaths the run server may write to (before `extraWriteSubpaths`). */
export function sandboxWriteSubpaths(i: SandboxProfileInput): string[] {
  return [
    i.workspaceRoot,
    i.tmpDir,
    i.xdgDataHome,
    join(i.home, '.cache'),
    join(i.home, '.npm'),
    join(i.home, 'Library', 'Caches'),
    join(i.home, 'go', 'pkg', 'mod'),
    join(i.home, 'Library', 'Logs'),
    ...(i.extraWriteSubpaths ?? []),
  ].map(canonicalMacPath);
}

/**
 * HOME-relative paths the serve process tree itself reads or writes, so `deny.secretPaths` must not turn them into a kernel
 * read deny (the guard and the permission profile still cover them): its own config dir, the control dir (the run's XDG data
 * home lives below it) and `.npmrc` (npm reads it in every build). A path that contains one of these (`.config`, `Library`)
 * is skipped as well.
 */
export const SANDBOX_READ_EXEMPT = ['.config/opencode', `Library/Application Support/${CONTROL_DIR_NAME}`, '.npmrc'] as const;

function isSandboxReadExempt(rel: string): boolean {
  return SANDBOX_READ_EXEMPT.some((e) => rel === e || rel.startsWith(`${e}/`) || e.startsWith(`${rel}/`));
}

/**
 * Paths the serve process tree never reads, so the kernel refuses `file-read*` on them (subpath = dir + below,
 * literal = one file). `~/.ssh` is denied: network git is disabled during runs (the launcher pre-fetches origin before
 * the server starts), so nothing in the tree needs the keys. NOT denied on purpose: `~/.config/opencode` (the server
 * reads its own config at runtime; the guard blocks agent shell reads of it). The skill roots need no allow here: no read deny
 * covers them (`~/.config/opencode/skills` sits below the config dir, which is not denied; the guard and the profile carve it out).
 */
export function sandboxReadDenies(i: Pick<SandboxProfileInput, 'home'> & Partial<Pick<SandboxProfileInput, 'safety'>>): Array<{ kind: 'subpath' | 'literal'; path: string }> {
  const extra = [...new Set((i.safety?.deny.secretPaths ?? []).map(normalizeSecretPath))].filter((rel) => !isSandboxReadExempt(rel));
  return [
    // `.docker` also hides the Docker CLI config/contexts and ~/.docker/run sockets; fine, `docker` is denied by the profile
    // `.local/share/opencode` is the user's global auth/db: the run uses its own XDG_DATA_HOME (live-checked)
    // common third-party CLI logins (gh, glab, linear) and cloud credentials
    ...['.aws', '.config/gcloud', '.kube', '.docker', '.config/gh', '.config/glab-cli', '.config/linear', '.ssh', 'Library/Keychains', '.local/share/opencode', ...extra].map((rel) => ({ kind: 'subpath' as const, path: join(i.home, rel) })),
    ...['.netrc', '.git-credentials'].map((rel) => ({ kind: 'literal' as const, path: join(i.home, rel) })),
  ];
}

/**
 * Host-control binaries a run must never execute: `launchctl submit|load|bootstrap` starts a job OUTSIDE this sandbox,
 * `osascript` drives other apps (and runs `do shell script`), `crontab` installs a scheduled job. The opencode server
 * itself does not need them (only the unsandboxed orchestrator calls launchctl; the server's one osascript use is the
 * desktop "open in app" helper, which a headless `serve` never reaches). The profile and the guard deny the same names.
 */
export const SANDBOX_EXEC_DENIES = ['/bin/launchctl', '/usr/bin/osascript', '/usr/bin/crontab'] as const;

export function renderSandboxProfile(i: SandboxProfileInput): string {
  assertSameWorkspace(i.workspaceRoot, i.safety);
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) throw new Error(`Invalid port ${i.port}`);
  const subpaths = [...new Set(sandboxWriteSubpaths(i))];
  return [
    `;; ${APP} write boundary: everything readable/executable, writes only under the allowlist,`,
    ';; and no outbound connections to the run server (agents must not call the run API).',
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...subpaths.map((p) => `  (subpath ${sbString(p)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/(tty|ttys[0-9]+|fd/[0-9]+)$"))',
    ';; credentials the run never needs to read (the guard covers the ones the server itself needs)',
    '(deny file-read*',
    ...sandboxReadDenies(i).map((d) => `  (${d.kind} ${sbString(d.path)})`),
    ')',
    ';; host-control binaries (a job started by launchctl or cron would run outside this sandbox)',
    `(deny process-exec ${SANDBOX_EXEC_DENIES.map((p) => `(literal ${sbString(p)})`).join(' ')})`,
    // SBPL only accepts `*` or `localhost` as host; "localhost" covers 127.0.0.1 and ::1 (verified live).
    `(deny network-outbound (remote ip "localhost:${i.port}"))`,
    // ssh transport: no key (see file-read* above) and no port 22, so `git push` over ssh cannot work even if every other layer failed.
    // "*:22" covers every host including localhost (SBPL host must be `*` or `localhost`).
    '(deny network-outbound (remote ip "*:22"))',
    '',
  ].join('\n');
}

/** Arguments for `/usr/bin/sandbox-exec`: `sandbox-exec -f <profile> <cmd...>`. */
export function sandboxArgs(profilePath: string, cmd: string[]): string[] {
  if (cmd.length === 0) throw new Error('sandboxArgs requires a command');
  return ['-f', profilePath, ...cmd];
}
