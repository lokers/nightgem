/**
 * Preflight rule check Runs against the LIVE run server through the `RunApi` seam:
 *  1. `listAgents()`: every agent must end with a leading `* * allow` and no `ask` rule after it;
 *  2. `evalPermission()` (free evaluator, no LLM): every corpus probe x every agent must resolve exactly to its
 *     expected verdict (`allow` or `deny`), never `ask`.
 * The launch refuses on any failure.
 */
import { readFileSync } from 'node:fs';

import type { AgentInfo, PermissionEffect, RunApi, SafetyInputs } from './contracts.ts';
import { mcpServerNames, mcpToolPrefix, normalizeDeny, skillRootAccess, secretHomePaths } from './profile.ts';

export type ProbeVerdict = 'allow' | 'deny';

export interface Probe {
  expect: ProbeVerdict;
  action: string;
  resource: string;
}

export type RuleCheckFailureKind = 'missing-agent' | 'no-leading-allow' | 'ask-rule' | 'eval-error' | 'verdict-mismatch' | 'no-agents';

export interface RuleCheckFailure {
  kind: RuleCheckFailureKind;
  agent?: string;
  probe?: Probe;
  actual?: string;
  message: string;
}

export interface RuleCheckResult {
  ok: boolean;
  failures: RuleCheckFailure[];
  /** Number of evaluator calls made. */
  evaluated: number;
}

export interface PreflightInput {
  /** Any session id on the run server (the evaluator is session scoped but does not call a model). */
  sessionId: string;
  /** Agents to run the corpus against. Each must exist in `listAgents()`. */
  agents: string[];
  corpus: Probe[];
  /** Max parallel evaluator calls (default 8). */
  concurrency?: number;
}

export const WORKSPACE_INPUTS_MARKER = '# ---- inputs: workspace-specific (skipped by default) ----';

export interface ParseCorpusOptions {
  /**
   * Include the `# ---- inputs: workspace-specific (skipped by default) ----` section (up to the next `# ---- ` header): probes that
   * hold only with the workspace-specific SafetyInputs. Off by default, so a launch with generic inputs passes the shipped corpus.
   */
  includeWorkspaceInputs?: boolean;
}

/**
 * Substitute `{{NAME}}` placeholders; unknown names throw so a typo cannot silently weaken a probe. A literal `\n` in a
 * resource becomes a newline. The workspace-specific inputs section is skipped unless `opts.includeWorkspaceInputs`.
 */
export function parseCorpus(text: string, vars: Record<string, string> = {}, opts: ParseCorpusOptions = {}): Probe[] {
  const probes: Probe[] = [];
  let skipping = false;
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trimEnd();
    if (line.startsWith('# ---- ')) skipping = !opts.includeWorkspaceInputs && line === WORKSPACE_INPUTS_MARKER;
    if (skipping || line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^(allow|deny)\|([^|]+)\|(.*)$/.exec(line);
    if (!m) throw new Error(`Invalid corpus line ${n + 1}: ${raw}`);
    // `\n` (backslash, n) in a resource is a newline: multi-line shell commands (heredocs) need a one-line probe
    const resource = m[3]!.replaceAll('\\n', '\n').replace(/\{\{(\w+)\}\}/g, (_all, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`Unknown placeholder {{${k}}} on corpus line ${n + 1}`);
      return v;
    });
    probes.push({ expect: m[1] as ProbeVerdict, action: m[2]!, resource });
  }
  return probes;
}

export interface CorpusContext {
  workspaceRoot: string;
  home: string;
  slug: string;
  /** The run's `$TMPDIR`. */
  tmp: string;
  /** A task worktree inside the workspace (the allowed write area), e.g. `<repo>/.worktrees/<slug>/T1`. */
  worktree: string;
}

/** The `{{...}}` placeholder map of `profile/corpus.txt`. `WT` comes from `ctx.worktree`; nothing is derived from a repo name. */
export function corpusVars(ctx: CorpusContext): Record<string, string> {
  return { WORKSPACE: ctx.workspaceRoot, HOME: ctx.home, SLUG: ctx.slug, TMP: ctx.tmp, WT: ctx.worktree };
}

/**
 * Probes derived from the user's `SafetyInputs`, appended to the shipped corpus by the launch preflight:
 *  - per `deny.commands` entry: `X`, `env X`, an absolute path to `X`, `cd x && X x`, `sh -c 'X x'` and `./bin/X x` must be denied;
 *  - per `deny.editPaths` entry: an edit of a concrete path matching the glob, inside the task worktree, must be denied;
 *  - per `deny.secretPaths` entry: reads of the path and of a file below it, a `grep` of the path, a `glob` below it and a shell `cat` of it, must be denied;
 *  - per `deny.shellPatterns` entry: the command the pattern spells with every wildcard replaced by `x` must be denied;
 *  - per MCP server name (`opts.mcpServerNames`): a tool `<server>_probe` must be denied;
 *  - per skill root: `external_directory` below it is allowed, and so is `read` below a root inside the
 *    `~/.config/opencode/skills` carve-out.
 * The probes use the same resources the evaluator would receive, so a typo in the profile fails the launch instead of
 * silently weakening a deny.
 */
export function deriveProbes(safety: SafetyInputs, ctx: CorpusContext, opts: { mcpServerNames?: readonly string[] } = {}): Probe[] {
  const probes: Probe[] = [];
  const seen = new Set<string>();
  const add = (expect: ProbeVerdict, action: string, resource: string): void => {
    const key = `${expect}|${action}|${resource}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push({ expect, action, resource });
  };
  const deny = normalizeDeny(safety.deny);
  for (const c of deny.commands) {
    add('deny', 'shell', c);
    add('deny', 'shell', `env ${c}`);
    add('deny', 'shell', `/usr/local/bin/${c}`);
    add('deny', 'shell', `cd x && ${c} x`);
    add('deny', 'shell', `sh -c '${c} x'`);
    add('deny', 'shell', `./bin/${c} x`);
  }
  for (const glob of deny.editPaths) {
    const concrete = glob
      .replace(/^\*\*\//, `${ctx.worktree}/`)
      .replace(/\*+/g, 'probe')
      .replace(/\?/g, 'x');
    add('deny', 'edit', concrete.startsWith('/') ? concrete : `${ctx.worktree}/${concrete}`);
  }
  for (const rel of deny.secretPaths) {
    add('deny', 'read', `${ctx.home}/${rel}`);
    add('deny', 'read', `${ctx.home}/${rel}/probe`);
    add('deny', 'grep', `${ctx.home}/${rel}`);
    add('deny', 'glob', `${ctx.home}/${rel}/*`);
    add('deny', 'shell', `cat ~/${rel}/probe`);
  }
  for (const p of deny.shellPatterns) add('deny', 'shell', p.replace(/[*?]+/g, 'x'));
  // every MCP server of the user's global config: its tools (`<server>_<tool>`) are denied
  for (const name of mcpServerNames(opts.mcpServerNames ? [...opts.mcpServerNames] : [])) add('deny', `${mcpToolPrefix(name)}_probe`, '*');
  // config-level skill denies (`skill` action): the skill is refused even if a harness would offer it
  for (const name of safety.disabledSkills) if (name.trim() !== '') add('deny', 'skill', name);
  const access = skillRootAccess(ctx.home, safety.skillRoots, secretHomePaths(safety));
  for (const root of access.external) add('allow', 'external_directory', `${root}/probe-skill/SKILL.md`);
  for (const root of access.carveOuts) add('allow', 'read', `${root}/probe-skill/SKILL.md`);
  return probes;
}

export function loadCorpus(file: string, vars: Record<string, string> = {}, opts: ParseCorpusOptions = {}): Probe[] {
  return parseCorpus(readFileSync(file, 'utf8'), vars, opts);
}

/** Static check of one agent's effective rule list. */
export function checkAgentRules(agent: AgentInfo): RuleCheckFailure[] {
  const rules = agent.permissions;
  let lastAllow = -1;
  rules.forEach((r, i) => {
    if (r.action === '*' && r.resource === '*' && r.effect === 'allow') lastAllow = i;
  });
  if (lastAllow === -1) {
    return [{ kind: 'no-leading-allow', agent: agent.id, message: `${agent.id}: no "* * allow" rule in the effective rules` }];
  }
  const failures: RuleCheckFailure[] = [];
  rules.forEach((r, i) => {
    if (i > lastAllow && r.effect === 'ask') {
      failures.push({
        kind: 'ask-rule',
        agent: agent.id,
        message: `${agent.id}: rule #${i} ${r.action} ${r.resource} has effect "ask" after the leading allow`,
      });
    }
  });
  return failures;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function preflightRules(api: RunApi, input: PreflightInput): Promise<RuleCheckResult> {
  const failures: RuleCheckFailure[] = [];
  const agentInfos = await api.listAgents();
  if (agentInfos.length === 0) {
    return { ok: false, evaluated: 0, failures: [{ kind: 'no-agents', message: 'listAgents() returned no agents (slim not registered yet?)' }] };
  }

  // 1. static: no ask after the leading allow, for EVERY agent the server knows
  for (const a of agentInfos) failures.push(...checkAgentRules(a));

  // 2. dynamic: corpus x agents through the evaluator
  const known = new Set(agentInfos.map((a) => a.id));
  const targets = input.agents.filter((id) => {
    if (known.has(id)) return true;
    failures.push({ kind: 'missing-agent', agent: id, message: `agent "${id}" is not registered on the run server` });
    return false;
  });

  const jobs = targets.flatMap((agent) => input.corpus.map((probe) => ({ agent, probe })));
  const results = await mapLimit(jobs, input.concurrency ?? 8, async ({ agent, probe }) => {
    try {
      const actual: PermissionEffect = await api.evalPermission({
        sessionId: input.sessionId,
        action: probe.action,
        resources: [probe.resource],
        agent,
      });
      return { agent, probe, actual, error: undefined as string | undefined };
    } catch (err) {
      return { agent, probe, actual: undefined, error: err instanceof Error ? err.message : String(err) };
    }
  });
  for (const r of results) {
    if (r.error !== undefined) {
      failures.push({ kind: 'eval-error', agent: r.agent, probe: r.probe, message: `${r.agent}: evaluator failed for ${r.probe.action} ${r.probe.resource}: ${r.error}` });
    } else if (r.actual !== r.probe.expect) {
      failures.push({
        kind: 'verdict-mismatch',
        agent: r.agent,
        probe: r.probe,
        actual: r.actual,
        message: `${r.agent}: ${r.probe.action} ${JSON.stringify(r.probe.resource)} expected ${r.probe.expect}, got ${r.actual}`,
      });
    }
  }
  return { ok: failures.length === 0, failures, evaluated: results.length };
}
