/**
 * A fake `RunApi` that models the opencode 2.0.29 permission semantics (read from the binary's `VN`/`C5` and pinned
 * live in OpenCode 2.0.29): an ordered rule list per agent, the LAST rule whose action AND resource both match wins, and no
 * match means `ask`. The wildcard matcher is `wildcardMatch` below.
 */
import type { AgentInfo, PermissionEffect, PermissionRule, RunApi } from '../../../src/contracts.ts';

export const AGENT_IDS = ['orchestrator', 'oracle', 'fixer', 'designer', 'explorer', 'librarian'] as const;

const globCache = new Map<string, RegExp>();

/**
 * opencode 2.0.29 wildcard semantics (`VN(input, pattern)` in the binary), mirrored exactly:
 *  - backslashes become `/` in BOTH input and pattern;
 *  - `. + ^ $ { } ( ) | [ ]` are literal; there are no character classes or alternation;
 *  - `*` matches any run of characters, including `/`, spaces and newlines (so `**` is the same as `*`);
 *  - `?` matches exactly ONE character (it is not literal);
 *  - a trailing ` *` is OPTIONAL: `git *` matches `git` as well as `git status`;
 *  - matching is anchored at both ends and case-sensitive.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    let body = pattern
      .replaceAll('\\', '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    if (body.endsWith(' .*')) body = `${body.slice(0, -3)}( .*)?`;
    re = new RegExp(`^${body}$`, 's');
    globCache.set(pattern, re);
  }
  return re.test(input.replaceAll('\\', '/'));
}

export function evaluate(rules: readonly PermissionRule[], action: string, resource: string): PermissionEffect {
  let effect: PermissionEffect = 'ask';
  for (const r of rules) {
    if (wildcardMatch(action, r.action) && wildcardMatch(resource, r.resource)) effect = r.effect;
  }
  return effect;
}

/** Slim/opencode defaults seen on the real server before our config: asks that the leading allow must cancel. */
export function inheritedDefaults(): PermissionRule[] {
  return [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'ask' },
    { action: 'read', resource: '*.env.*', effect: 'ask' },
    { action: 'external_directory', resource: '*', effect: 'ask' },
    { action: 'shell', resource: 'git push *', effect: 'ask' },
    { action: 'question', resource: '*', effect: 'allow' },
    { action: 'wait_for_user', resource: '*', effect: 'allow' },
    { action: 'acp_run', resource: '*', effect: 'allow' },
    { action: 'marketplace_manage', resource: '*', effect: 'allow' },
  ];
}

export function fakeAgents(profile: readonly PermissionRule[], ids: readonly string[] = AGENT_IDS): AgentInfo[] {
  return ids.map((id) => ({
    id,
    permissions: [...inheritedDefaults(), ...profile, { action: 'browser', resource: '*', effect: 'deny' as const }],
  }));
}

export interface FakeRunApiOptions {
  evalError?: (agent: string, action: string, resource: string) => boolean;
}

export function fakeRunApi(agents: AgentInfo[], opts: FakeRunApiOptions = {}): RunApi & { evalCalls: number } {
  const unsupported = (): never => {
    throw new Error('not used by rulecheck');
  };
  const api = {
    evalCalls: 0,
    listAgents: async () => agents,
    evalPermission: async (i: { sessionId: string; action: string; resources: string[]; agent: string }) => {
      api.evalCalls++;
      const agent = agents.find((a) => a.id === i.agent);
      if (!agent) throw new Error(`unknown agent ${i.agent}`);
      const res = i.resources[0] ?? '';
      if (opts.evalError?.(i.agent, i.action, res)) throw new Error('boom');
      return evaluate(agent.permissions, i.action, res);
    },
    createSession: unsupported,
    prompt: unsupported,
    interrupt: unsupported,
    getSession: unsupported,
    listSessions: unsupported,
    listPendingPermissions: unsupported,
    replyPermission: unsupported,
    events: unsupported,
  };
  return api as unknown as RunApi & { evalCalls: number };
}
