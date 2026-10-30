/**
 * The user profile: the only source of user-specific facts (workspace, tracker, skills, denies, models, review rounds, audit terms).
 *
 * Pure and explicit: `loadProfile` takes `home`, `env` and `fs` and has no defaults, so tests (and the
 * launcher) control exactly what is read. This module imports nothing from the rest of the app.
 *
 * Location: `<home>/.config/nightgem/profile.jsonc`, or `NIGHTGEM_PROFILE`.
 */
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';

import { APP, CONFIG_DIR_NAME, CONTROL_DIR_NAME, ENV_PREFIX } from './brand.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PROFILE_VERSION = 1 as const;

const nonEmpty = z.string().min(1);

/** `provider/model` or `provider/model#variant`. */
export const MODEL_SPEC_RE = /^[^/\s#]+\/[^\s#]+(?:#\S+)?$/;

/** Split `provider/model#variant` into `{ model: 'provider/model', variant? }`. */
export function splitModelSpec(spec: string): { model: string; variant?: string } {
  const hash = spec.indexOf('#');
  if (hash === -1) return { model: spec };
  return { model: spec.slice(0, hash), variant: spec.slice(hash + 1) };
}

const RegexString = nonEmpty.refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid regular expression' },
);

/** HOME-relative path. A leading `~/` is accepted and stripped; absolute paths are rejected. */
const HomeRelativePath = nonEmpty
  .transform((s) => (s.startsWith('~/') ? s.slice(2) : s))
  .refine((s) => !isAbsolute(s) && !s.startsWith('~'), { message: 'must be relative to $HOME (e.g. ".config/foo")' });

const AutoClaim = z
  .strictObject({
    enabled: z.boolean().default(false),
    when: z
      .strictObject({
        status: nonEmpty.optional(),
        unassigned: z.boolean().default(false),
      })
      .prefault({}),
    /** Contains `{KEY}`. */
    command: nonEmpty.optional(),
    /** Contains `{KEY}`. */
    verifyCommand: nonEmpty.optional(),
  })
  .refine((c) => !c.enabled || (c.command !== undefined && c.verifyCommand !== undefined), {
    message: 'autoClaim.enabled requires both "command" and "verifyCommand"',
  });

const Tracker = z.strictObject({
  keyPattern: RegexString.optional(),
  /** Contains `{KEY}`. */
  fetchCommand: nonEmpty.optional(),
  /** Contains `{KEYS}`. */
  linkedFetchCommand: nonEmpty.optional(),
  autoClaim: AutoClaim.prefault({}),
  notes: z.string().optional(),
});

export const UserProfile = z.strictObject({
  version: z.literal(PROFILE_VERSION),
  /** Where `.specs/<slug>` and the repos live. Required. `~` is expanded by `loadProfile`. */
  workspaceRoot: nonEmpty,
  /** Workspace-specific agent instructions, injected into the orchestrator/fixer/oracle appends. */
  instructionsFile: nonEmpty.optional(),
  repos: z.record(nonEmpty, z.strictObject({ tools: z.array(nonEmpty).default([]) })).default({}),
  tracker: Tracker.prefault({}),
  skills: z
    .strictObject({
      required: z.array(nonEmpty).default([]),
      /** Names or globs. Excluded skills are disabled for runs. */
      exclude: z.array(nonEmpty).default([]),
      extraRoots: z.array(nonEmpty).default([]),
    })
    .prefault({}),
  deny: z
    .strictObject({
      commands: z.array(nonEmpty).default([]),
      shellPatterns: z.array(nonEmpty).default([]),
      secretPaths: z.array(HomeRelativePath).default([]),
      editPaths: z.array(nonEmpty).default([]),
    })
    .prefault({}),
  /** agent name -> `provider/model[#variant]` */
  models: z.record(nonEmpty, nonEmpty.regex(MODEL_SPEC_RE, { message: 'expected "provider/model" or "provider/model#variant"' })).default({}),
  /** The full review phase: review -> fix -> re-review rounds (the soft-stop lite review never fixes). */
  review: z
    .strictObject({
      maxRounds: z.number().int().min(1).max(5).default(2),
    })
    .prefault({}),
  audit: z.strictObject({ bannedTerms: z.array(nonEmpty).default([]) }).prefault({}),
});
export type UserProfile = z.output<typeof UserProfile>;
export type UserProfileInput = z.input<typeof UserProfile>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProfileErrorCode = 'missing' | 'invalid-json' | 'invalid-schema' | 'invalid-workspace';

/** Typed error for every profile failure. Inspect `code`. */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly path: string;
  /** For `invalid-schema`: the zod issues. */
  readonly issues?: z.core.$ZodIssue[];
  /** For `invalid-workspace`: why the workspace was rejected. */
  readonly reasons?: string[];

  constructor(
    code: ProfileErrorCode,
    path: string,
    message: string,
    opts: { cause?: unknown; issues?: z.core.$ZodIssue[]; reasons?: string[] } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProfileError';
    this.code = code;
    this.path = path;
    if (opts.issues !== undefined) this.issues = opts.issues;
    if (opts.reasons !== undefined) this.reasons = opts.reasons;
  }
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The slice of `node:fs` this module uses. `import * as fs from 'node:fs'` satisfies it. */
export interface ProfileFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
  realpathSync(path: string): string;
}

export type ProfileEnv = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~` and `~/x` expand to `home`. `~user`, absolute and relative paths are returned unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** `NIGHTGEM_PROFILE` when set (and non-empty), else `<home>/.config/nightgem/profile.jsonc`. */
export function resolveProfilePath(input: { home: string; env: ProfileEnv }): string {
  const fromEnv = input.env[`${ENV_PREFIX}PROFILE`];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(expandHome(fromEnv.trim(), input.home));
  return join(input.home, '.config', CONFIG_DIR_NAME, 'profile.jsonc');
}

/** sha256 (hex) of the raw profile text. */
export function profileHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The agent-unwritable control root: `<home>/Library/Application Support/nightgem`. */
export function controlRootFor(home: string): string {
  return join(home, 'Library', 'Application Support', CONTROL_DIR_NAME);
}

// --- containment (case-insensitive: the default macOS filesystem is) -------------------------

const norm = (p: string): string => {
  const r = resolve(p);
  return (r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r).toLowerCase();
};

/** True when `outer` equals `inner` or is an ancestor of it. */
function covers(outer: string, inner: string): boolean {
  const a = norm(outer);
  const b = norm(inner);
  if (a === b) return true;
  return b.startsWith(a === sep ? sep : a + sep);
}

function tryRealpath(fs: Pick<ProfileFs, 'realpathSync'> | undefined, p: string): string {
  if (!fs) return p;
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** Reasons why `candidate` (absolute) overlaps a location agents or tooling must never write into. */
function denyOverlapReasons(candidate: string, realCandidate: string, home: string, realHome: string, controlRoot: string): string[] {
  const reasons: string[] = [];
  const cands = unique([candidate, realCandidate]);
  const homes = unique([home, realHome]);

  if (cands.some((c) => norm(c) === sep)) reasons.push('is the filesystem root "/"');
  if (cands.some((c) => homes.some((h) => covers(c, h)))) reasons.push('is your home directory or one of its ancestors');

  const denied: { label: string; paths: string[] }[] = [
    { label: '~/Library', paths: homes.map((h) => join(h, 'Library')) },
    { label: '~/.config', paths: homes.map((h) => join(h, '.config')) },
    { label: '~/.ssh', paths: homes.map((h) => join(h, '.ssh')) },
    { label: `the ${APP} control directory`, paths: unique([controlRoot, join(realHome, 'Library', 'Application Support', CONTROL_DIR_NAME)]) },
  ];
  for (const d of denied) {
    if (cands.some((c) => d.paths.some((dp) => covers(c, dp) || covers(dp, c)))) reasons.push(`overlaps ${d.label}`);
  }
  return reasons;
}

/** Reasons for a path under `$HOME` whose first segment is a dotfile directory (`~/.aws`, `~/.gnupg`, `~/.docker`, ...). */
function dotDirReasons(candidates: string[], homes: string[]): string[] {
  for (const c of candidates) {
    for (const h of homes) {
      if (c !== h && covers(h, c)) {
        const first = relative(resolve(h), resolve(c)).split(sep)[0];
        if (first?.startsWith('.') && first !== '..') return [`is inside a hidden directory of your home (~/${first})`];
      }
    }
  }
  return [];
}

export interface WorkspaceCheckOptions {
  home: string;
  fs: ProfileFs;
  /** Defaults to `<home>/Library/Application Support/nightgem`. */
  controlRoot?: string;
}

/**
 * Why `path` cannot be a workspace root. Empty list: acceptable.
 * Rejects `/`, `$HOME` and its ancestors, anything overlapping `~/Library`, `~/.config`, `~/.ssh` or the control root,
 * non-directories, and any path inside a git work tree (`.specs/` would land in a repo).
 */
export function validateWorkspaceRoot(path: string, opts: WorkspaceCheckOptions): string[] {
  const { home, fs } = opts;
  const controlRoot = opts.controlRoot ?? controlRootFor(home);
  if (!isAbsolute(path)) return [`"${path}" is not an absolute path`];
  const p = resolve(path);

  let isDir = false;
  let exists = true;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    exists = false;
  }
  const reasons: string[] = [];
  if (!exists) reasons.push('does not exist');
  else if (!isDir) reasons.push('is not a directory');

  const real = exists ? tryRealpath(fs, p) : p;
  const realHome = tryRealpath(fs, home);
  reasons.push(...denyOverlapReasons(p, real, home, realHome, controlRoot));
  reasons.push(...dotDirReasons(unique([p, real]), unique([home, realHome])));

  // Inside a git work tree: any ancestor (or the path itself) holding `.git` (a dir, or a file for worktrees).
  for (const start of unique([p, real])) {
    let dir = start;
    for (;;) {
      if (fs.existsSync(join(dir, '.git'))) {
        reasons.push(`is inside a git work tree (${dir}); .specs/ must not land in a repository`);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return unique(reasons);
}

export interface SkillRootCheckOptions {
  home: string;
  /** Defaults to `<home>/Library/Application Support/nightgem`. */
  controlRoot?: string;
  /** When given, the path is realpath'd before checking. */
  fs?: Pick<ProfileFs, 'realpathSync'>;
}

/**
 * Why `path` cannot be a skill root: the deny-overlap rules of `validateWorkspaceRoot` without the git check.
 * `~/.config/opencode/skills` (and anything inside it) is the one allowed place under `~/.config`.
 */
export function validateSkillRoot(path: string, opts: SkillRootCheckOptions): string[] {
  const { home } = opts;
  const controlRoot = opts.controlRoot ?? controlRootFor(home);
  if (!isAbsolute(path)) return [`"${path}" is not an absolute path`];
  const p = resolve(path);
  const real = tryRealpath(opts.fs, p);
  const realHome = tryRealpath(opts.fs, home);

  const carve = unique([join(home, '.config', 'opencode', 'skills'), join(realHome, '.config', 'opencode', 'skills')]);
  if (unique([p, real]).every((c) => carve.some((k) => covers(k, c)))) return [];
  return unique(denyOverlapReasons(p, real, home, realHome, controlRoot));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadProfileInput {
  path: string;
  home: string;
  /** Reserved for future `${VAR}` expansion; not read yet. */
  env: ProfileEnv;
  fs: ProfileFs;
}

export interface LoadedProfile {
  /** Validated, with `workspaceRoot`, `instructionsFile` and `skills.extraRoots` made absolute. */
  profile: UserProfile;
  path: string;
  sha256: string;
  raw: string;
}

/** Relative paths in the profile resolve against the profile's own directory. */
function absolutize(p: string, home: string, base: string): string {
  const expanded = expandHome(p, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/**
 * Read, parse (JSONC), validate and normalise the profile at `input.path`.
 * @throws ProfileError `missing` | `invalid-json` | `invalid-schema` | `invalid-workspace`
 */
export function loadProfile(input: LoadProfileInput): LoadedProfile {
  const { path, home, fs } = input;

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProfileError(
        'missing',
        path,
        `Profile not found at ${path}. Create it (see the README "Profile" section) or point ${ENV_PREFIX}PROFILE at one.`,
        { cause: err },
      );
    }
    throw err;
  }

  const errors: ParseError[] = [];
  const json: unknown = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    const before = raw.slice(0, first.offset);
    const line = before.split('\n').length;
    const col = first.offset - (before.lastIndexOf('\n') + 1) + 1;
    throw new ProfileError('invalid-json', path, `Invalid JSON in ${path} at line ${line}, column ${col}: ${printParseErrorCode(first.error)}`);
  }

  const res = UserProfile.safeParse(json);
  if (!res.success) {
    throw new ProfileError('invalid-schema', path, `Invalid profile ${path}:\n${z.prettifyError(res.error)}`, {
      cause: res.error,
      issues: res.error.issues,
    });
  }

  const base = dirname(path);
  const data = res.data;
  const profile: UserProfile = {
    ...data,
    workspaceRoot: absolutize(data.workspaceRoot, home, base),
    ...(data.instructionsFile === undefined ? {} : { instructionsFile: absolutize(data.instructionsFile, home, base) }),
    skills: { ...data.skills, extraRoots: data.skills.extraRoots.map((r) => absolutize(r, home, base)) },
  };

  const reasons = validateWorkspaceRoot(profile.workspaceRoot, { home, fs });
  if (reasons.length > 0) {
    throw new ProfileError(
      'invalid-workspace',
      path,
      `workspaceRoot "${profile.workspaceRoot}" is not usable:\n${reasons.map((r) => `  - ${r}`).join('\n')}`,
      { reasons },
    );
  }

  return { profile, path, sha256: profileHash(raw), raw };
}
