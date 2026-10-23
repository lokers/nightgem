/**
 * Shared run contracts for nightgem.
 *
 * - zod v4 schemas at every I/O boundary (RUN.json, *.jsonl, control flags, server payloads);
 * - the `RunApi` interface: the seam implemented by the opencode client and consumed
 *   by the guard/profile, events/ledger, orchestrator and CLI.
 *
 * Server shapes (Session.Info, events, permissions) are modelled on the real opencode 2.0.29
 * fixtures in test/fixtures/opencode-2.0.29/recorded/ and are deliberately loose (`looseObject`) so unknown
 * fields never break parsing.
 */
import { basename, dirname, isAbsolute } from 'node:path';

import { z } from 'zod';

import { UserProfile } from './userprofile.ts';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'launching',
  'running',
  'winding-down',
  'stopping',
  'completed',
  'failed',
  'stalled',
  'aborted-budget',
  'stopped',
] as const;
export const RunState = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunState>;

/** States after which the orchestrator must never act again (restart is a no-op). */
export const TERMINAL_RUN_STATES = ['completed', 'failed', 'stalled', 'aborted-budget', 'stopped'] as const;
export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export const PHASES = ['plan', 'build', 'review', 'report'] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

export const TASK_STATES = ['todo', 'running', 'verifying', 'fixing', 'done', 'blocked', 'skipped'] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;

export const DECISION_KINDS = ['plan', 'dependency', 'migration', 'api-contract', 'escalation', 'other'] as const;
export const DecisionKind = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const COST_SOURCES = ['session-info', 'estimate'] as const;
export const CostSource = z.enum(COST_SOURCES);
export type CostSource = z.infer<typeof CostSource>;

// ---------------------------------------------------------------------------
// RunManifest (RUN.json)
// ---------------------------------------------------------------------------

export const RepoBaseline = z.object({
  head: z.string(),
  branch: z.string(),
  porcelainHash: z.string(),
  stashCount: z.number().int().nonnegative(),
});
export type RepoBaseline = z.infer<typeof RepoBaseline>;

export const RepoEntry = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().min(1),
  baseline: RepoBaseline,
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export const WorktreeEntry = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  /** Task id, or undefined for the integration worktree. */
  task: z.string().optional(),
  kind: z.enum(['task', 'integration']).default('task'),
});
export type WorktreeEntry = z.infer<typeof WorktreeEntry>;

export const RootSession = z.object({
  phase: Phase,
  sessionId: z.string().min(1),
  costUsd: z.number().nonnegative().default(0),
});
export type RootSession = z.infer<typeof RootSession>;

export const Defect = z.object({
  ts: z.string(),
  kind: z.string().min(1),
  message: z.string(),
  sessionId: z.string().optional(),
});
export type Defect = z.infer<typeof Defect>;

/** Current RUN.json schema version. v1 (no `workspaceRoot`) is still readable through `parseRunManifest`. */
export const RUN_MANIFEST_VERSION = 2 as const;
export const RUN_MANIFEST_V1_VERSION = 1 as const;

// --- Skills, safety inputs and the resolved run context -------------------------------------

/** One skill found on disk: `<root>/<name>/SKILL.md`, where `path` is the realpath'd skill directory. */
export const SkillEntry = z.object({
  name: z.string().min(1),
  /** The (realpath'd) skill root it was found in. */
  root: z.string().min(1),
  /** The (realpath'd) skill directory. */
  path: z.string().min(1),
});
export type SkillEntry = z.infer<typeof SkillEntry>;

export const ExcludedSkill = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  reason: z.string(),
});
export type ExcludedSkill = z.infer<typeof ExcludedSkill>;

/** Result of skill detection. `collisions` lists names found at more than one distinct realpath (first root wins). */
export const SkillDetection = z.object({
  available: z.array(SkillEntry).default([]),
  excluded: z.array(ExcludedSkill).default([]),
  missingRequired: z.array(z.string()).default([]),
  collisions: z.array(z.object({ name: z.string().min(1), paths: z.array(z.string()) })).default([]),
  roots: z.array(z.string()).default([]),
  /** Required skills that the profile also excludes (a contradiction detection reports instead of resolving). */
  excludedRequired: z.array(z.string()).default([]),
  /** Skill roots that were configured but rejected, with the reasons. */
  rootRejected: z.array(z.object({ root: z.string(), reasons: z.array(z.string()) })).default([]),
  /** Skills found at a realpath outside every accepted skill root. */
  outsideRoots: z.array(z.string()).default([]),
});
export type SkillDetection = z.infer<typeof SkillDetection>;

/** Everything the safety layers (permission profile, sandbox, guard) need from the user. */
export const SafetyInputs = z.object({
  /** Sandbox write subpath + external_directory allow. */
  workspaceRoot: z.string().min(1),
  /** Realpath'd; read-allow. */
  skillRoots: z.array(z.string()),
  /** Concrete names (slim takes exact names); patterns are expanded by detection. */
  disabledSkills: z.array(z.string()),
  deny: z.object({
    commands: z.array(z.string()),
    shellPatterns: z.array(z.string()),
    /** HOME-relative. */
    secretPaths: z.array(z.string()),
    /** Globs. */
    editPaths: z.array(z.string()),
  }),
  /**
   * Names (the keys of the `mcp` object only, never values) of the MCP servers in the user's opencode config files. Every one
   * is switched off for the run. Absent means none.
   */
  mcpServerNames: z.array(z.string()).optional(),
});
export type SafetyInputs = z.infer<typeof SafetyInputs>;

/**
 * The resolved run context, frozen at launch into `controlDir/run-context.json` (mode 0600, agent-unwritable).
 * The orchestrator reads only this; it never re-resolves the profile.
 */
export const RunContextSnapshot = z.object({
  version: z.literal(1),
  workspaceRoot: z.string().min(1),
  /** `providerID/modelID` of the run (the same value passed to the server). */
  model: z.string().min(1),
  /** `providerID/modelID` of the small model. */
  smallModel: z.string().min(1),
  profile: z.object({
    path: z.string().min(1),
    sha256: z.string().min(1),
    data: UserProfile,
  }),
  skills: SkillDetection,
  instructions: z.object({
    path: z.string().optional(),
    text: z.string(),
    sha256: z.string().min(1),
  }),
  /** agent -> resolved model (precedence: env at launch > profile > built-in defaults). */
  models: z.record(z.string(), z.object({ model: z.string().min(1), variant: z.string().optional() })),
  safety: SafetyInputs,
});
export type RunContextSnapshot = z.infer<typeof RunContextSnapshot>;

// --- RunManifest (RUN.json) ------------------------------------------------------------------

/**
 * One attempt of a run: the first launch, then each `resume`. Spend is measured per attempt against that attempt's
 * `budgetUsd`; `costAtStartUsd` is the run's cumulative cost when the attempt began.
 */
export const RunAttempt = z.object({
  n: z.number().int().min(1),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1).optional(),
  /** The terminal state the attempt ended in. Absent while it is open. */
  state: RunState.refine(isTerminalRunState, { message: 'an attempt state must be terminal' }).optional(),
  stopReason: z.string().optional(),
  budgetUsd: z.number().positive(),
  costAtStartUsd: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type RunAttempt = z.infer<typeof RunAttempt>;

/** Fields shared by v1 and v2. */
const RunManifestBase = z.object({
  slug: z.string().min(1),
  budgetUsd: z.number().positive(),
  /** Fraction of budget that triggers wind-down. */
  softPct: z.number().positive().max(1).default(0.85),
  /** Fraction of budget that triggers the hard stop. */
  hardPct: z.number().positive().max(2).default(1.0),
  /** Multiplies every observed cost. Smoke tests only. */
  costMultiplier: z.number().positive().default(1),
  state: RunState,
  phase: Phase,
  pid: z.number().int().positive().optional(),
  launchdLabel: z.string().min(1),
  serverUrl: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  controlDir: z.string().min(1),
  runDir: z.string().min(1),
  xdgDataHome: z.string().min(1),
  /** `providerID/modelID`, always passed explicitly to the server (see `parseModelRef`). */
  model: z.string().min(1),
  opencodeVersion: z.string().optional(),
  slimVersion: z.string().optional(),
  rootSessions: z.array(RootSession).default([]),
  knownSessionIds: z.array(z.string()).default([]),
  costUsd: z.number().nonnegative().default(0),
  costEstimatedUsd: z.number().nonnegative().default(0),
  repos: z.array(RepoEntry).default([]),
  worktrees: z.array(WorktreeEntry).default([]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  stopReason: z.string().optional(),
  nudges: z.number().int().nonnegative().default(0),
  defects: z.array(Defect).default([]),
  /**
   * Additive and optional, so v1 and v2 manifests still parse and the schema version is unchanged. Absent means a
   * single implicit attempt (see `attemptsOf`). Caveat: `z.object` strips unknown keys, so an older checkout that
   * reads and rewrites a RUN.json silently drops `attempts`; `attemptsOf` then falls back to the implicit attempt.
   */
  attempts: z.array(RunAttempt).optional(),
});

/** v1: written by earlier versions. Read-only; upgraded by `parseRunManifest`. */
export const RunManifestV1 = RunManifestBase.extend({
  schemaVersion: z.literal(RUN_MANIFEST_V1_VERSION),
});
export type RunManifestV1 = z.infer<typeof RunManifestV1>;

/** v2: always what is written. */
export const RunManifest = RunManifestBase.extend({
  schemaVersion: z.literal(RUN_MANIFEST_VERSION),
  /** Absolute workspace root (`<workspaceRoot>/.specs/<slug>/.run` is `runDir`). */
  workspaceRoot: z.string().min(1),
  /** The profile the run was launched with (summary of the context snapshot). */
  profile: z.object({ path: z.string().min(1), sha256: z.string().min(1) }).optional(),
  skills: z
    .object({
      available: z.array(SkillEntry),
      excluded: z.array(ExcludedSkill),
      required: z.array(z.string()),
    })
    .optional(),
  instructions: z.object({ path: z.string().optional(), sha256: z.string().min(1) }).optional(),
});
export type RunManifest = z.infer<typeof RunManifest>;

/**
 * The attempts of a run. With `attempts` recorded, returns them. Otherwise the run is a single attempt, built from the
 * top-level fields (`state` only when terminal; `costAtStartUsd` is 0).
 */
export function attemptsOf(
  m: Pick<RunManifest, 'attempts' | 'startedAt' | 'createdAt' | 'endedAt' | 'state' | 'stopReason' | 'budgetUsd' | 'costUsd'>,
): RunAttempt[] {
  if (m.attempts !== undefined) return m.attempts;
  return [
    {
      n: 1,
      startedAt: m.startedAt ?? m.createdAt,
      ...(m.endedAt === undefined ? {} : { endedAt: m.endedAt }),
      ...(isTerminalRunState(m.state) ? { state: m.state } : {}),
      ...(m.stopReason === undefined ? {} : { stopReason: m.stopReason }),
      budgetUsd: m.budgetUsd,
      costAtStartUsd: 0,
      costUsd: m.costUsd,
    },
  ];
}

/** Thrown when a v1 RUN.json cannot be upgraded because `runDir` is not `<ws>/.specs/<slug>/.run`. */
export class ManifestUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestUpgradeError';
  }
}

/**
 * Upgrade a v1 manifest. `workspaceRoot` is `dirname³(runDir)` after asserting that the parent of `runDir`
 * is `<x>/.specs/<slug>`. `launchdLabel` is kept as is; `profile`, `skills` and `instructions` stay empty.
 */
export function upgradeRunManifestV1(v1: RunManifestV1): RunManifest {
  const specs = dirname(v1.runDir);
  if (
    !isAbsolute(v1.runDir) ||
    basename(v1.runDir) !== '.run' ||
    basename(specs) !== v1.slug ||
    basename(dirname(specs)) !== '.specs'
  ) {
    throw new ManifestUpgradeError(
      `Cannot upgrade a v1 RUN.json: runDir "${v1.runDir}" is not an absolute <workspace>/.specs/${v1.slug}/.run`,
    );
  }
  const { schemaVersion: _v, ...rest } = v1;
  return RunManifest.parse({ ...rest, schemaVersion: RUN_MANIFEST_VERSION, workspaceRoot: dirname(dirname(specs)) });
}

/**
 * The single reader for RUN.json: accepts v1 or v2 and returns v2.
 * @throws ZodError for invalid content, `ManifestUpgradeError` when a v1 `runDir` has an unexpected shape.
 */
export function parseRunManifest(raw: unknown): RunManifest {
  if (typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === RUN_MANIFEST_V1_VERSION) {
    return upgradeRunManifestV1(RunManifestV1.parse(raw));
  }
  return RunManifest.parse(raw);
}

// ---------------------------------------------------------------------------
// JSONL line schemas
// ---------------------------------------------------------------------------

/** One line of cost.jsonl. */
export const CostLine = z.object({
  ts: z.string(),
  sessionId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  phase: Phase,
  /** Cost attributed to this session at this point (absolute `Session.Info.cost`, or estimate). */
  costUsd: z.number().nonnegative(),
  estimated: z.boolean().default(false),
  source: CostSource,
  /** Run total after applying this line. */
  totalUsd: z.number().nonnegative(),
});
export type CostLine = z.infer<typeof CostLine>;

export const VerifyResult = z.object({
  cmd: z.string(),
  exit: z.number().int(),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/** One line of tasks.jsonl (append-only; the latest line per id wins). */
export const TaskEvent = z.object({
  ts: z.string(),
  id: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  state: TaskState,
  attempt: z.number().int().nonnegative().default(0),
  verify: z.array(VerifyResult).default([]),
  oracleVerdict: z.string().optional(),
  blockedReason: z.string().optional(),
  phase: Phase,
  agent: z.string().optional(),
  sessionId: z.string().optional(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/** One line of decisions.jsonl (mirrored into DECISIONS.md). */
export const Decision = z.object({
  ts: z.string(),
  id: z.string().min(1),
  kind: DecisionKind,
  summary: z.string().min(1),
  rationale: z.string(),
  oracleApproved: z.boolean().optional(),
  needsHumanAttention: z.boolean().default(false),
});
export type Decision = z.infer<typeof Decision>;

/** Control flags, read by the orchestrator and by the guard plugin (per tool call). */
export const ControlFlags = z.object({
  softStop: z.boolean().default(false),
  hardStop: z.boolean().default(false),
  /** Orchestrator heartbeat, epoch milliseconds (0 = never). Guard blocks when older than 2 min. */
  heartbeatTs: z.number().nonnegative().default(0),
});
export type ControlFlags = z.infer<typeof ControlFlags>;

/** Emitted by the agent to declare the run finished. */
export const RunComplete = z.object({
  type: z.literal('run.complete').default('run.complete'),
  ts: z.string(),
  summary: z.string(),
  finalReviewPath: z.string().min(1),
});
export type RunComplete = z.infer<typeof RunComplete>;

// ---------------------------------------------------------------------------
// Server shapes (opencode 2.0.29, /api/*). Loose on purpose.
// ---------------------------------------------------------------------------

export const ModelRef = z.looseObject({
  id: z.string().min(1),
  providerID: z.string().min(1),
  variant: z.string().optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** Split `providerID/modelID` (the first `/` separates provider from model id). */
export function parseModelRef(model: string): ModelRef {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) throw new Error(`Invalid model "${model}" (expected providerID/modelID)`);
  return { providerID: model.slice(0, i), id: model.slice(i + 1) };
}

export const TokenUsage = z.looseObject({
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache: z.looseObject({ read: z.number().default(0), write: z.number().default(0) }).default({ read: 0, write: 0 }),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** Subset of `Session.Info`. The directory lives at `location.directory`. */
export const SessionInfo = z.looseObject({
  id: z.string().min(1),
  parentID: z.string().optional(),
  projectID: z.string().optional(),
  agent: z.string().optional(),
  model: ModelRef.optional(),
  /** Cumulative USD, already including title and compaction. The per-session source of truth. */
  cost: z.number().nonnegative(),
  tokens: TokenUsage.optional(),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  time: z.looseObject({
    created: z.number(),
    updated: z.number(),
    idle: z.number().optional(),
    archived: z.number().optional(),
  }),
  title: z.string().optional(),
  location: z.looseObject({ directory: z.string() }),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const PermissionEffect = z.enum(['allow', 'deny', 'ask']);
export type PermissionEffect = z.infer<typeof PermissionEffect>;

export const PermissionReply = z.enum(['once', 'always', 'reject']);
export type PermissionReply = z.infer<typeof PermissionReply>;

export const PermissionRule = z.looseObject({
  action: z.string(),
  resource: z.string(),
  effect: PermissionEffect,
});
export type PermissionRule = z.infer<typeof PermissionRule>;

/** A pending permission request (`permission.asked` payload / `GET .../permission` item). */
export const PermissionRequest = z.looseObject({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  action: z.string(),
  resources: z.array(z.string()).default([]),
  save: z.array(z.string()).optional(),
  source: z.looseObject({ type: z.string() }).optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** Subset of `Agent.Info` (`GET /api/agent`). `permissions` is an ordered list; last match wins. */
export const AgentInfo = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  mode: z.enum(['subagent', 'primary', 'all']).optional(),
  hidden: z.boolean().optional(),
  system: z.string().optional(),
  permissions: z.array(PermissionRule).default([]),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

/**
 * Envelope of one SSE event from `GET /api/event`. `type` is e.g. `session.created`,
 * `session.usage.updated`, `session.execution.{started,succeeded,failed,interrupted}`,
 * `permission.asked`, `permission.replied`. `data` is kept untyped; use the payload schemas below.
 */
export const ServerEvent = z.looseObject({
  id: z.string().optional(),
  type: z.string().min(1),
  created: z.number().optional(),
  location: z.looseObject({ directory: z.string() }).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type ServerEvent = z.infer<typeof ServerEvent>;

export const EXECUTION_TERMINAL_EVENTS = [
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
] as const;
export function isExecutionTerminal(type: string): boolean {
  return (EXECUTION_TERMINAL_EVENTS as readonly string[]).includes(type);
}

export const SessionCreatedData = z.looseObject({
  sessionID: z.string().min(1),
  parentID: z.string().optional(),
  title: z.string().optional(),
  agent: z.string().optional(),
  model: ModelRef.optional(),
});
export type SessionCreatedData = z.infer<typeof SessionCreatedData>;

/** `session.usage.updated`: cumulative session cost. */
export const SessionUsageData = z.looseObject({
  sessionID: z.string().min(1),
  cost: z.number().nonnegative(),
  tokens: TokenUsage.optional(),
});
export type SessionUsageData = z.infer<typeof SessionUsageData>;

/** `session.execution.*` and similar events that only carry the session id. */
export const SessionRefData = z.looseObject({ sessionID: z.string().min(1) });
export type SessionRefData = z.infer<typeof SessionRefData>;

export const PermissionRepliedData = z.looseObject({
  sessionID: z.string().min(1),
  requestID: z.string().min(1),
  reply: PermissionReply,
});
export type PermissionRepliedData = z.infer<typeof PermissionRepliedData>;

// ---------------------------------------------------------------------------
// RunApi: the seam implemented by the opencode client
// ---------------------------------------------------------------------------

export interface EvalPermissionInput {
  sessionId: string;
  action: string;
  resources: string[];
  agent: string;
}

export interface CreateSessionInput {
  /** Always explicit; without it the server silently falls back to a free default model. */
  model: ModelRef;
  agent?: string;
  parentId?: string;
  title?: string;
}

export interface PromptInput {
  text: string;
  delivery?: 'steer' | 'queue';
  resume?: boolean;
}

export interface ListSessionsInput {
  parentId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface RunApi {
  /** `GET /api/agent` (effective per-agent permission rules). */
  listAgents(): Promise<AgentInfo[]>;
  /** Free (no LLM) rule evaluator: `POST /api/session/:id/permission`. */
  evalPermission(input: EvalPermissionInput): Promise<PermissionEffect>;
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** Enqueue a user message. Resolves once accepted, not when the turn finishes. */
  prompt(sessionId: string, input: PromptInput): Promise<void>;
  /** `POST /api/session/:id/interrupt`. Resolves true if something was running. */
  interrupt(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<SessionInfo>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /** Pending permission requests; all sessions when `sessionId` is omitted. */
  listPendingPermissions(sessionId?: string): Promise<PermissionRequest[]>;
  replyPermission(sessionId: string, requestId: string, reply: PermissionReply): Promise<void>;
  /** SSE stream of `GET /api/event`. Ends when `signal` aborts or the stream closes. */
  events(opts?: { signal?: AbortSignal }): AsyncIterable<ServerEvent>;
}
