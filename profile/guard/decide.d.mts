export const GUARD_PREFIX: string;
export const CONTROL_FLAGS_FILE: string;
export const HEARTBEAT_MAX_AGE_MS: number;
export const DEFAULT_RUN_WRITABLE: string[];
export const SOFT_STOP_BLOCKED_TOOLS: Set<string>;

export interface GuardFlags {
  softStop?: boolean;
  hardStop?: boolean;
  heartbeatTs?: number;
}

export interface GuardConfig {
  /** false when NIGHTGEM_CONTROL_DIR is unset (every tool blocked). */
  controlDirSet?: boolean;
  /** Parsed control.json, or null when unreadable (every tool blocked). */
  flags: GuardFlags | null;
  allowedRoots: string[];
  now: number;
  cwd?: string;
  runPort?: string | number;
  env?: Record<string, string | undefined>;
  workdir?: string;
  /** File names directly under .specs/<slug>/.run/ that may be written (default tasks.jsonl, decisions.jsonl, run-complete.json). */
  runWritable?: string[];
  /** `NIGHTGEM_SAFETY` was malformed or missing: every tool is blocked. */
  safetyInvalid?: boolean;
  /** Profile-derived safety inputs (the guard-relevant part of `SafetyInputs` in src/contracts.ts). Unset (hand-built configs only) = the generic defaults. */
  safety?: GuardSafety;
}

export interface GuardSafety {
  /** Realpath'd skill roots; `~/.config/opencode/skills` among them enables the read carve-out. */
  skillRoots: string[];
  deny: {
    /** Plain command names, denied wherever they appear as a command word. */
    commands: string[];
    /** Substrings or opencode wildcard globs (`*`, `?`) matched against the command text. */
    shellPatterns: string[];
    /** HOME-relative secret locations. */
    secretPaths: string[];
    /** Globs matched against the resolved write target (`*` crosses `/`; a trailing `/**` also matches the directory). */
    editPaths: string[];
  };
}

export interface GuardEvent {
  tool: string;
  input?: Record<string, unknown>;
  agent?: string;
  sessionID?: string;
}

export type GuardDecision =
  | { verdict: 'allow' }
  | { verdict: 'block'; reason: string }
  | { verdict: 'rewrite'; input: Record<string, unknown>; reason?: string };

export function decide(event: GuardEvent, cfg: GuardConfig): GuardDecision;
export function checkShellCommand(cmd: string, cfg: GuardConfig, depth?: number): string | null;
export function checkWritePath(target: string, base: string | undefined, cfg: GuardConfig): string | null;
/** `protectedRes`: extra protected-path patterns (compiled `deny.editPaths`). */
export function isAllowedWritePath(resolved: string, allowedRoots: string[], runWritable?: string[], protectedRes?: RegExp[]): boolean;
/** opencode wildcard -> anchored RegExp (`*`/`**` cross `/`, `?` one char, a trailing ` *` is optional). */
export function wildcardToRegExp(glob: string): RegExp;
export function realpathLoose(p: string, depth?: number): string;
export function rootToRegExp(root: string): RegExp;
export function tokenize(cmd: string): Array<{ t: string; v: string; dyn?: boolean }>;
export function innerStrings(cmd: string): string[];
export function commandHead(words: Array<{ v: string; dyn?: boolean }>): { name: string; args: Array<{ v: string; dyn?: boolean }>; raw?: string };
export const NETWORK_GIT_MESSAGE: string;
/** Command names denied wherever they appear as a command word (the generic defaults; `deny.commands` come on top). */
export const DENIED_COMMANDS: string[];
/** Command names denied only in command position. */
export const DENIED_HEADS: Set<string>;
export const SOFT_STOP_ALLOWED_AGENT: string;
/** True when a dispatch input (task/subagent/background_*) targets the `oracle` agent only. */
export function dispatchTargetsOracle(input: Record<string, unknown>): boolean;
/** `{ sub, rest }` of a git invocation (args after the `git` word), skipping the global options. */
export function gitInvocation(args: string[]): { sub: string; rest: string[] };
/** Removes the bodies of heredocs that only feed data commands; `bodies` keep their quoting. */
export function splitHeredocs(cmd: string): { text: string; bodies: Array<{ body: string; quoted: boolean }>; scanned: string[] };
