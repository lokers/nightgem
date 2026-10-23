/**
 * `install` / `uninstall`: the slash commands are repo templates (`commands/*.md`) rendered into the user's OpenCode
 * commands dir, plus a starter profile when none exists.
 *
 * A managed file carries `<!-- nightgem:managed sha256=<hash> -->` right after its frontmatter (first line when there is
 * none); `<hash>` is the sha256 of the rendered body, i.e. the file WITHOUT that marker line. There is no separate manifest:
 * `uninstall` (and `install` when it updates) trust a file only when the marker is present and the hash still matches.
 *
 * Every function takes explicit `home`/`env`/`fs`; nothing here reads the real HOME or `process.env`.
 */
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { APP, COMMANDS, MARKER } from './brand.ts';
import {
  expandHome,
  resolveProfilePath,
  UserProfile,
  validateWorkspaceRoot,
  type ProfileEnv,
  type ProfileFs,
} from './userprofile.ts';

export const COMMAND_NAMES = [COMMANDS.main, COMMANDS.status, COMMANDS.stop] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const MARKER_PREFIX = `<!-- ${MARKER} sha256=`;
const MARKER_SUFFIX = ' -->';
const MARKER_RE = new RegExp(`^<!-- ${MARKER} sha256=([0-9a-f]{64}) -->\n`);

/** The slice of `node:fs` used here. `import * as fs from 'node:fs'` satisfies it. */
export interface InstallFs extends ProfileFs {
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  copyFileSync(src: string, dest: string): void;
  rmSync(path: string, options?: { force?: boolean }): void;
}

export type InstallErrorCode = 'workspace-required' | 'invalid-workspace' | 'conflict' | 'template' | 'starter-invalid';

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  /** For `invalid-workspace`: the reasons. For `conflict`: the conflicting files. */
  readonly details: string[];
  constructor(code: InstallErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.details = details;
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const markerLine = (hash: string): string => `${MARKER_PREFIX}${hash}${MARKER_SUFFIX}\n`;

/** Length of the leading `---\n...\n---\n` block, or 0 when the text has no frontmatter. */
function frontmatterEnd(text: string): number {
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? m[0].length : 0;
}

/** Put the marker for `body` after the frontmatter (or first when there is none). The frontmatter stays at the top. */
export function addMarker(body: string): string {
  const at = frontmatterEnd(body);
  return `${body.slice(0, at)}${markerLine(sha256(body))}${body.slice(at)}`;
}

export type ManagedState =
  | { kind: 'unmanaged' }
  /** The marker is there and the body still hashes to it. */
  | { kind: 'intact'; hash: string; body: string }
  /** The marker is there but the body was edited (or the marker moved). */
  | { kind: 'edited'; hash: string };

/** Classify an installed file. */
export function inspectManaged(text: string): ManagedState {
  const at = frontmatterEnd(text);
  const m = MARKER_RE.exec(text.slice(at));
  if (!m) return { kind: 'unmanaged' };
  const hash = m[1] as string;
  const body = text.slice(0, at) + text.slice(at + m[0].length);
  return sha256(body) === hash ? { kind: 'intact', hash, body } : { kind: 'edited', hash };
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shellQuote = (p: string): string => (SAFE_ARG.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export interface TemplateVars {
  /** Absolute node binary. */
  NODE: string;
  /** Absolute `bin/nightgem.mjs`. */
  BIN: string;
}

/** Fill `{{NODE}}` and `{{BIN}}` (shell-quoted when they need it). Any other placeholder is an error. */
export function renderCommandTemplate(template: string, vars: TemplateVars): string {
  const out = template.replace(/\{\{NODE\}\}/g, () => shellQuote(vars.NODE)).replace(/\{\{BIN\}\}/g, () => shellQuote(vars.BIN));
  const left = /\{\{\s*[A-Za-z_]+\s*\}\}/.exec(out);
  if (left) throw new InstallError('template', `Command template has an unknown placeholder ${left[0]}`);
  return out;
}

export interface InstallInput {
  home: string;
  env: ProfileEnv;
  fs: InstallFs;
  /** Absolute node binary (`{{NODE}}`). */
  nodePath: string;
  /** Absolute `bin/nightgem.mjs` of this checkout (`{{BIN}}`). */
  binPath: string;
  /** Directory with `<name>.md` templates. */
  templatesDir: string;
  /** The starter profile template (`{{WORKSPACE}}`). */
  starterPath: string;
  /** Default `<home>/.config/opencode/commands`. */
  commandsDir?: string;
  /** Absolute workspace directory. Required when no profile exists. */
  workspace?: string;
  force: boolean;
  now: () => Date;
}

export type CommandAction = 'created' | 'updated' | 'unchanged' | 'overwritten';

export interface CommandResult {
  name: CommandName;
  path: string;
  action: CommandAction;
  /** Set when `--force` replaced an unmanaged or edited file. */
  backup?: string;
}

export interface InstallResult {
  commandsDir: string;
  commands: CommandResult[];
  profile: { path: string; action: 'created' | 'exists'; workspaceRoot?: string };
}

export const defaultCommandsDir = (home: string): string => join(home, '.config', 'opencode', 'commands');

/** `<file>.bak`, or `<file>.bak.<timestamp>` when that exists. */
function backupPath(fs: InstallFs, file: string, now: Date): string {
  const first = `${file}.bak`;
  if (!fs.existsSync(first)) return first;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let candidate = `${file}.bak.${stamp}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${file}.bak.${stamp}-${i}`;
  return candidate;
}

function readIfExists(fs: InstallFs, path: string): string | undefined {
  if (!fs.existsSync(path)) return undefined;
  return fs.readFileSync(path, 'utf8');
}

/** Write the starter profile text for `workspaceRoot` after validating it against the schema (nothing is written here). */
function renderStarter(starter: string, workspaceRoot: string): string {
  const text = starter.replace(/\{\{WORKSPACE\}\}/g, () => JSON.stringify(workspaceRoot).slice(1, -1));
  const parsed = UserProfile.safeParse(parseJsonc(text, [], { allowTrailingComma: true }));
  if (!parsed.success) throw new InstallError('starter-invalid', `The starter profile does not validate: ${parsed.error.message}`);
  return text;
}

/**
 * Install the three commands (and the starter profile if none exists).
 *
 * Nothing is written until every check passed: a conflict (an unmanaged or hand-edited file at a command's name, without
 * `force`), a missing or invalid `workspace`, or a bad template aborts the whole install.
 */
export function installCommands(input: InstallInput): InstallResult {
  const { home, env, fs, force } = input;
  const commandsDir = input.commandsDir ?? defaultCommandsDir(home);
  const profilePath = resolveProfilePath({ home, env });

  // 1. Profile: only created when absent.
  let profileText: string | undefined;
  let workspaceRoot: string | undefined;
  if (!fs.existsSync(profilePath)) {
    if (!input.workspace) {
      throw new InstallError('workspace-required', `No profile at ${profilePath}. Pass --workspace <dir> (the directory that holds your repos) to create one.`);
    }
    workspaceRoot = resolve(expandHome(input.workspace, home));
    const reasons = validateWorkspaceRoot(workspaceRoot, { home, fs });
    if (reasons.length > 0) {
      throw new InstallError('invalid-workspace', `--workspace "${workspaceRoot}" is not usable:\n${reasons.map((r) => `  - ${r}`).join('\n')}`, reasons);
    }
    profileText = renderStarter(fs.readFileSync(input.starterPath, 'utf8'), workspaceRoot);
  }

  // 2. Render the commands and classify what is there.
  const plan = COMMAND_NAMES.map((name) => {
    const template = fs.readFileSync(join(input.templatesDir, `${name}.md`), 'utf8');
    const content = addMarker(renderCommandTemplate(template, { NODE: input.nodePath, BIN: input.binPath }));
    const path = join(commandsDir, `${name}.md`);
    const existing = readIfExists(fs, path);
    const state: ManagedState | undefined = existing === undefined ? undefined : inspectManaged(existing);
    return { name, path, content, existing, state };
  });
  const conflicts = plan.filter((p) => p.state !== undefined && p.state.kind !== 'intact');
  if (conflicts.length > 0 && !force) {
    throw new InstallError(
      'conflict',
      `Refusing to overwrite files that ${APP} does not manage (or that were edited):\n${conflicts
        .map((c) => `  - ${c.path} (${c.state?.kind === 'edited' ? 'edited since install' : `not installed by ${APP}`})`)
        .join('\n')}\nRe-run with --force to back them up (<name>.md.bak) and replace them.`,
      conflicts.map((c) => c.path),
    );
  }

  // 3. Write.
  fs.mkdirSync(commandsDir, { recursive: true });
  const commands: CommandResult[] = [];
  for (const p of plan) {
    if (p.existing === p.content) {
      commands.push({ name: p.name, path: p.path, action: 'unchanged' });
      continue;
    }
    if (p.state === undefined) {
      fs.writeFileSync(p.path, p.content, { mode: 0o644 });
      commands.push({ name: p.name, path: p.path, action: 'created' });
    } else if (p.state.kind === 'intact') {
      fs.writeFileSync(p.path, p.content, { mode: 0o644 });
      commands.push({ name: p.name, path: p.path, action: 'updated' });
    } else {
      const backup = backupPath(fs, p.path, input.now());
      fs.copyFileSync(p.path, backup);
      fs.writeFileSync(p.path, p.content, { mode: 0o644 });
      commands.push({ name: p.name, path: p.path, action: 'overwritten', backup });
    }
  }
  if (profileText !== undefined) {
    fs.mkdirSync(dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, profileText, { mode: 0o644 });
    return { commandsDir, commands, profile: { path: profilePath, action: 'created', ...(workspaceRoot ? { workspaceRoot } : {}) } };
  }
  return { commandsDir, commands, profile: { path: profilePath, action: 'exists' } };
}

export type UninstallAction = 'removed' | 'missing' | 'skipped-edited' | 'skipped-unmanaged';

export interface UninstallResult {
  commandsDir: string;
  commands: Array<{ name: CommandName; path: string; action: UninstallAction }>;
}

/**
 * Remove the installed commands that carry the marker AND whose body hash still matches. Edited and unmanaged files are
 * left alone. The profile is never touched.
 */
export function uninstallCommands(input: { home: string; fs: InstallFs; commandsDir?: string }): UninstallResult {
  const commandsDir = input.commandsDir ?? defaultCommandsDir(input.home);
  const commands = COMMAND_NAMES.map((name) => {
    const path = join(commandsDir, `${name}.md`);
    const text = readIfExists(input.fs, path);
    if (text === undefined) return { name, path, action: 'missing' as const };
    const state = inspectManaged(text);
    if (state.kind === 'intact') {
      input.fs.rmSync(path, { force: true });
      return { name, path, action: 'removed' as const };
    }
    return { name, path, action: state.kind === 'edited' ? ('skipped-edited' as const) : ('skipped-unmanaged' as const) };
  });
  return { commandsDir, commands };
}
