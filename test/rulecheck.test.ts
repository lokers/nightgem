import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '../src/contracts.ts';
import type { SafetyInputs } from '../src/contracts.ts';
import { renderRunConfig } from '../src/profile.ts';
import { checkAgentRules, corpusVars, deriveProbes, loadCorpus, parseCorpus, preflightRules } from '../src/rulecheck.ts';
import { AGENT_IDS, evaluate, fakeAgents, fakeRunApi, inheritedDefaults } from './fixtures/profile/fake-run-api.ts';
import { REPO_ROOT, OPENCODE_FIXTURES } from './fixtures/paths.ts';
import { WORKSPACE_MCP_SERVERS, corpusSafety, emptySafety } from './fixtures/profile/corpus-safety.ts';

const HOME = '/Users/alice';
const WORKSPACE = `${HOME}/work`;
const SLUG = 'my-run';
const TMP = '/private/var/folders/xx/T/opencode-tmp';

const VARS = corpusVars({ workspaceRoot: WORKSPACE, home: HOME, slug: SLUG, tmp: TMP, worktree: `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1` });
const CORPUS_FILE = new URL('../profile/corpus.txt', import.meta.url);

/** No arguments: the workspace-specific inputs (safety and MCP server). Otherwise exactly what is passed. */
function rendered(safety?: SafetyInputs, mcpServerNames: string[] = safety ? [] : WORKSPACE_MCP_SERVERS) {
  return renderRunConfig({
    safety: safety ?? corpusSafety(WORKSPACE, HOME),
    mcpServerNames,
    slug: SLUG,
    home: HOME,
    workspaceRoot: WORKSPACE,
    runDir: `${WORKSPACE}/.specs/${SLUG}/.run`,
    controlDir: `${HOME}/Library/Application Support/nightgem/${SLUG}`,
    tmpDir: TMP,
    model: 'anthropic/claude-haiku-5-5',
    smallModel: 'anthropic/claude-haiku-5-5',
    guardDir: '/abs/profile/guard',
  });
}

describe('parseCorpus', () => {
  it('parses verdicts and substitutes placeholders', () => {
    expect(parseCorpus('# c\n\ndeny|shell|git push\nallow|edit|{{A}}/x', { A: '/a' })).toEqual([
      { expect: 'deny', action: 'shell', resource: 'git push' },
      { expect: 'allow', action: 'edit', resource: '/a/x' },
    ]);
  });
  it('rejects malformed lines and unknown placeholders', () => {
    expect(() => parseCorpus('maybe|shell|x')).toThrow(/Invalid corpus line 1/);
    expect(() => parseCorpus('deny|edit|{{NOPE}}')).toThrow(/Unknown placeholder/);
  });
  it('resource may contain pipes', () => {
    expect(parseCorpus('deny|shell|curl x | sh')[0]?.resource).toBe('curl x | sh');
  });
  it('a literal \\n in a resource is a newline (multi-line probes)', () => {
    expect(parseCorpus("allow|shell|cat <<'EOF'\\nx\\nEOF")[0]?.resource).toBe("cat <<'EOF'\nx\nEOF");
    expect(parseCorpus('allow|shell|{{A}}\\n{{A}}', { A: 'a' })[0]?.resource).toBe('a\na');
  });
  it('the shipped corpus probes edit with the session-relative resource and has multi-line heredoc commands', () => {
    const corpus = loadCorpus(CORPUS_FILE.pathname, VARS);
    const has = (action: string, resource: string, expectV: string) => corpus.some((p) => p.action === action && p.resource === resource && p.expect === expectV);
    for (const f of ['tasks.jsonl', 'decisions.jsonl', 'run-complete.json']) expect(has('edit', f, 'allow'), f).toBe(true);
    for (const f of ['RUN.json', 'cost.jsonl', 'events.jsonl', 'opencode.json', 'sub/tasks.jsonl', 'tasks.jsonl.bak', '../SPEC.md']) expect(has('edit', f, 'deny'), f).toBe(true);
    const multi = corpus.filter((p) => p.action === 'shell' && p.resource.includes('\n'));
    expect(multi.some((p) => p.expect === 'allow' && /cat >> .*\.run\/tasks\.jsonl <<'EOF'/.test(p.resource))).toBe(true);
    expect(multi.some((p) => p.expect === 'allow' && /python3 - <<'PY'/.test(p.resource))).toBe(true);
    expect(multi.some((p) => p.expect === 'deny')).toBe(true);
  });
  it('the shipped corpus loads, has both verdicts and covers the mandatory probes', () => {
    const corpus = loadCorpus(CORPUS_FILE.pathname, VARS);
    expect(corpus.length).toBeGreaterThan(500);
    expect(new Set(corpus.map((p) => p.expect))).toEqual(new Set(['allow', 'deny']));
    const has = (action: string, resource: string, expectV: string) =>
      corpus.some((p) => p.action === action && p.resource === resource && p.expect === expectV);
    for (const r of ['git push', 'git -C /x push', 'cd x && git push', 'env git push', "sh -c 'git push'", '/usr/bin/git push', 'opencode run hi', 'claude -p hi', 'gh pr create', 'cat .env'])
      expect(has('shell', r, 'deny'), r).toBe(true);
    expect(readFileSync(CORPUS_FILE, 'utf8')).not.toMatch(/\bask\b\|/);
  });
});

describe('checkAgentRules', () => {
  it('requires a leading allow and flags asks after the last one', () => {
    const rules = (...r: Array<[string, string, PermissionRule['effect']]>): PermissionRule[] => r.map(([action, resource, effect]) => ({ action, resource, effect }));
    expect(checkAgentRules({ id: 'a', permissions: rules(['*', '*', 'allow'], ['shell', 'x', 'deny']) })).toEqual([]);
    // asks BEFORE the last `* * allow` are cancelled by it
    expect(checkAgentRules({ id: 'a', permissions: rules(['shell', '*', 'ask'], ['*', '*', 'allow']) })).toEqual([]);
    expect(checkAgentRules({ id: 'a', permissions: rules(['*', '*', 'allow'], ['shell', 'x', 'ask']) })[0]).toMatchObject({ kind: 'ask-rule', agent: 'a' });
    expect(checkAgentRules({ id: 'a', permissions: rules(['shell', 'x', 'deny']) })[0]).toMatchObject({ kind: 'no-leading-allow' });
    expect(checkAgentRules({ id: 'a', permissions: [] })[0]).toMatchObject({ kind: 'no-leading-allow' });
  });
});

describe('preflightRules over the rendered profile (fake RunApi with the recorded rule semantics)', () => {
  // with the workspace-specific inputs (the baseline `rendered()` default): the whole corpus including the workspace-specific section
  const corpus = loadCorpus(CORPUS_FILE.pathname, VARS, { includeWorkspaceInputs: true });

  it('passes: every probe x every agent resolves to its expected verdict, nothing is ask', async () => {
    const api = fakeRunApi(fakeAgents(rendered().configContent.permissions));
    const res = await preflightRules(api, { sessionId: 'ses_1', agents: [...AGENT_IDS], corpus });
    expect(res.failures.map((f) => f.message)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.evaluated).toBe(corpus.length * AGENT_IDS.length);
    expect(api.evalCalls).toBe(res.evaluated);
  });

  it('the inherited defaults alone fail (asks and allowed pushes), proving the check bites', async () => {
    const api = fakeRunApi(fakeAgents([]));
    const res = await preflightRules(api, { sessionId: 's', agents: ['fixer'], corpus });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.kind === 'verdict-mismatch' && f.probe?.resource === 'git push')).toBe(true);
  });

  it('flags an ask rule that survives after the leading allow', async () => {
    const perms: PermissionRule[] = [...rendered().configContent.permissions, { action: 'shell', resource: 'git push *', effect: 'ask' }];
    const res = await preflightRules(fakeRunApi(fakeAgents(perms)), { sessionId: 's', agents: ['fixer'], corpus: [] });
    expect(res.ok).toBe(false);
    expect(res.failures.filter((f) => f.kind === 'ask-rule')).toHaveLength(AGENT_IDS.length);
  });

  it('reports a profile whose rule order is wrong (allow after deny re-opens edits)', async () => {
    const perms = [...rendered().configContent.permissions, { action: 'edit', resource: '*', effect: 'allow' as const }];
    const res = await preflightRules(fakeRunApi(fakeAgents(perms)), { sessionId: 's', agents: ['fixer'], corpus });
    expect(res.ok).toBe(false);
    expect(res.failures.filter((f) => f.kind === 'verdict-mismatch').every((f) => f.probe?.action === 'edit')).toBe(true);
    expect(res.failures[0]?.message).toMatch(/expected deny, got allow/);
  });

  it('reports missing agents, evaluator errors and an empty agent list', async () => {
    const perms = rendered().configContent.permissions;
    const missing = await preflightRules(fakeRunApi(fakeAgents(perms, ['fixer'])), { sessionId: 's', agents: ['fixer', 'oracle'], corpus: corpus.slice(0, 3) });
    expect(missing.failures).toEqual([expect.objectContaining({ kind: 'missing-agent', agent: 'oracle' })]);

    const flaky = await preflightRules(fakeRunApi(fakeAgents(perms, ['fixer']), { evalError: (_a, _act, r) => r === 'git push' }), {
      sessionId: 's',
      agents: ['fixer'],
      corpus,
    });
    expect(flaky.failures.map((f) => f.kind)).toEqual(['eval-error']);

    const none = await preflightRules(fakeRunApi([]), { sessionId: 's', agents: ['fixer'], corpus });
    expect(none).toMatchObject({ ok: false, evaluated: 0, failures: [{ kind: 'no-agents' }] });
  });

  it('every ask in the inherited defaults is overridden by the profile for the probed resources', () => {
    const rules = [...inheritedDefaults(), ...rendered().configContent.permissions];
    for (const p of corpus) expect(evaluate(rules, p.action, p.resource), `${p.action} ${p.resource}`).not.toBe('ask');
  });
});

describe('legacy profile recorded from OpenCode 2.0.29 (profile.config.json)', () => {
  it('still satisfies the push / agent / env probes it was verified against', async () => {
    const legacy = JSON.parse(readFileSync(join(REPO_ROOT, OPENCODE_FIXTURES, 'profile.config.json'), 'utf8')) as { permissions: PermissionRule[] };
    const probes = parseCorpus(
      ['deny|shell|git push origin main', 'deny|shell|git -C /x push', 'deny|shell|opencode run hi', 'deny|shell|gh pr create', 'deny|shell|cat .env', 'deny|question|*', 'allow|shell|git status', 'allow|shell|ls', 'allow|read|/x/.env.example'].join('\n'),
    );
    const res = await preflightRules(fakeRunApi(fakeAgents(legacy.permissions)), { sessionId: 's', agents: ['orchestrator', 'fixer'], corpus: probes });
    expect(res.failures.map((f) => f.message)).toEqual([]);
  });
});

describe('corpusVars', () => {
  it('maps the context to the placeholder names; WT comes from ctx.worktree', () => {
    const ctx = { workspaceRoot: '/Users/alice/work', home: '/Users/alice', slug: 'my-run', tmp: '/tmp/x', worktree: '/Users/alice/work/acme-api/.worktrees/my-run/T1' };
    expect(corpusVars(ctx)).toEqual({ WORKSPACE: ctx.workspaceRoot, HOME: ctx.home, SLUG: ctx.slug, TMP: ctx.tmp, WT: ctx.worktree });
    expect(parseCorpus('allow|edit|{{WT}}/a.ts\ndeny|read|{{WORKSPACE}}/.env', corpusVars(ctx)).map((p) => p.resource)).toEqual([`${ctx.worktree}/a.ts`, '/Users/alice/work/.env']);
  });
  it('the shipped corpus uses only known placeholders ({{WORKSPACE}}, not a hard-coded root) and unknown ones are rejected', () => {
    const text = readFileSync(CORPUS_FILE, 'utf8');
    expect(text).toContain('{{WORKSPACE}}');
    expect(() => parseCorpus(text, VARS)).not.toThrow();
    expect(() => parseCorpus('allow|read|{{NOPE}}/x', VARS)).toThrow(/Unknown placeholder \{\{NOPE\}\}/);
  });
});

describe('standalone corpus section: holds with the generic defaults, the workspace-specific inputs and the skills carve-out', () => {
  const text = readFileSync(CORPUS_FILE, 'utf8');
  const marker = '# ---- standalone: generic defaults ----';
  const section = parseCorpus(text.slice(text.indexOf(marker)), VARS);
  const carve: SafetyInputs = { ...emptySafety(WORKSPACE), skillRoots: [`${HOME}/.config/opencode/skills`, `${HOME}/.agents/skills`] };
  const variants: Array<[string, SafetyInputs]> = [
    ['generic defaults', emptySafety(WORKSPACE)],
    ['workspace-specific inputs', corpusSafety(WORKSPACE, HOME)],
    ['skills carve-out', carve],
    ['skills carve-out + workspace-specific', { ...corpusSafety(WORKSPACE, HOME), skillRoots: carve.skillRoots }],
  ];

  it('the section exists after the original probes and has both verdicts', () => {
    expect(text.indexOf(marker)).toBeGreaterThan(0);
    expect(text.split(marker)).toHaveLength(2);
    expect(section.length).toBeGreaterThan(30);
    expect(new Set(section.map((p) => p.expect))).toEqual(new Set(['allow', 'deny']));
  });
  for (const [name, safety] of variants) {
    it(`[${name}] every probe x every agent resolves as expected, nothing is ask`, async () => {
      const api = fakeRunApi(fakeAgents(rendered(safety).configContent.permissions));
      const res = await preflightRules(api, { sessionId: 's', agents: [...AGENT_IDS], corpus: section });
      expect(res.failures.map((f) => f.message)).toEqual([]);
    });
  }
  it('the original sections replay under the skills carve-out too (the carve-out must not shadow the .env examples)', async () => {
    const original = parseCorpus(text.slice(0, text.indexOf(marker)), VARS, { includeWorkspaceInputs: true });
    const api = fakeRunApi(fakeAgents(rendered({ ...corpusSafety(WORKSPACE, HOME), skillRoots: [...corpusSafety(WORKSPACE, HOME).skillRoots, ...carve.skillRoots] }, WORKSPACE_MCP_SERVERS).configContent.permissions));
    const res = await preflightRules(api, { sessionId: 's', agents: [...AGENT_IDS], corpus: original });
    expect(res.failures.map((f) => f.message)).toEqual([]);
  });
  it('the DEFAULT corpus (workspace-specific section skipped) passes under the generic defaults, with derived probes: a generic launch passes preflight', async () => {
    const generic = emptySafety(WORKSPACE);
    const corpus = [...loadCorpus(CORPUS_FILE.pathname, VARS), ...deriveProbes(generic, CTX)];
    const res = await preflightRules(fakeRunApi(fakeAgents(rendered(generic).configContent.permissions)), { sessionId: 's', agents: [...AGENT_IDS], corpus });
    expect(res.failures.map((f) => f.message)).toEqual([]);
    expect(corpus.length).toBeGreaterThan(500);
  });
  it('the workspace-specific section is skipped by default and included on request; the derived probes cover the same ground', () => {
    const def = loadCorpus(CORPUS_FILE.pathname, VARS);
    const all = loadCorpus(CORPUS_FILE.pathname, VARS, { includeWorkspaceInputs: true });
    const skipped = all.filter((p) => !def.some((d) => d.expect === p.expect && d.action === p.action && d.resource === p.resource));
    // 7 probes for the shell pattern, edit paths, skill roots and the MCP server, plus 22 for the twg CLI and its login dir
    expect(skipped).toHaveLength(29);
    const twg = skipped.filter((p) => p.resource.includes('twg'));
    expect(twg).toHaveLength(22);
    expect(twg.every((p) => p.expect === 'deny')).toBe(true);
    expect(def.some((p) => p.resource.includes('twg'))).toBe(false);
    expect(
      skipped
        .filter((p) => !p.resource.includes('twg'))
        .map((p) => `${p.expect} ${p.action}`)
        .sort(),
    ).toEqual(['allow external_directory', 'allow external_directory', 'deny atlassian_getJiraIssue', 'deny atlassian_search', 'deny edit', 'deny edit', 'deny shell']);
    // probes that follow the section header are NOT skipped
    expect(def.some((p) => p.action === 'read' && p.resource.endsWith('/.env.example'))).toBe(true);
    const derived = deriveProbes(corpusSafety(WORKSPACE, HOME), CTX, { mcpServerNames: WORKSPACE_MCP_SERVERS });
    for (const p of skipped.filter((q) => !q.action.startsWith('atlassian_'))) expect(derived.some((d) => d.expect === p.expect && d.action === p.action), `${p.action} ${p.resource}`).toBe(true);
    // an MCP tool probe is derived per server name (`<server>_probe`)
    expect(derived).toContainEqual({ expect: 'deny', action: 'atlassian_probe', resource: '*' });
    expect(deriveProbes(emptySafety(WORKSPACE), CTX).some((d) => d.action.endsWith('_probe'))).toBe(false);
    // the configured twg CLI and login dir are probed too (deny.commands / deny.secretPaths), and not under the generic defaults
    expect(derived.some((d) => d.action === 'shell' && d.resource.includes('twg'))).toBe(true);
    expect(derived.some((d) => d.action === 'read' && d.resource.includes('.config/twg'))).toBe(true);
    expect(deriveProbes(emptySafety(WORKSPACE), CTX).some((d) => d.resource.includes('twg'))).toBe(false);
  });
  it('the scrubbed original sections under the generic defaults fail exactly the probes that encode the workspace-specific inputs', async () => {
    const original = parseCorpus(text.slice(0, text.indexOf(marker)), VARS, { includeWorkspaceInputs: true });
    const api = fakeRunApi(fakeAgents(rendered(emptySafety(WORKSPACE)).configContent.permissions));
    const res = await preflightRules(api, { sessionId: 's', agents: ['fixer'], corpus: original });
    const failed = res.failures.map((f) => `${f.probe!.expect} ${f.probe!.action} ${f.probe!.resource}`).sort();
    const twgFailed = original.filter((p) => p.resource.includes('twg')).map((p) => `${p.expect} ${p.action} ${p.resource}`);
    expect(twgFailed).toHaveLength(22);
    expect(failed).toEqual(
      [
        ...twgFailed,
        `deny shell node ~/work/other-runner/bin/x.js`,
        `deny atlassian_search *`,
        `deny atlassian_getJiraIssue *`,
        `deny edit ${VARS.WT}/api-spec.yaml`,
        `deny edit ${VARS.WT}/libs/api-client/src/generated/x.ts`,
        `allow external_directory ${HOME}/.claude/plugins/marketplaces/x/SKILL.md`,
        `allow external_directory ${HOME}/.agents/skills/x/SKILL.md`,
      ].sort(),
    );
    // ... and none of them under the workspace-specific inputs
    const specific = await preflightRules(fakeRunApi(fakeAgents(rendered(corpusSafety(WORKSPACE, HOME), WORKSPACE_MCP_SERVERS).configContent.permissions)), { sessionId: 's', agents: [...AGENT_IDS], corpus: original });
    expect(specific.failures).toEqual([]);
  });
  it('probes the sibling-prefix write and the opencode config files by name', () => {
    const has = (a: string, r: string) => section.some((p) => p.expect === 'deny' && p.action === a && p.resource === r);
    expect(has('edit', `${WORKSPACE}-evil/x`)).toBe(true);
    expect(has('read', `${HOME}/.config/opencode/opencode.json`)).toBe(true);
    expect(has('read', `${HOME}/.config/opencode/service.json`)).toBe(true);
  });
});

const CTX = { workspaceRoot: WORKSPACE, home: HOME, slug: SLUG, tmp: TMP, worktree: `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1` };
const DERIVE_SAFETY: SafetyInputs = {
  workspaceRoot: WORKSPACE,
  skillRoots: [`${HOME}/.config/opencode/skills`, `${HOME}/.agents/skills`],
  disabledSkills: [],
  deny: {
    commands: ['deploytool', 'ship-cli'],
    shellPatterns: ['*internal-sync*'],
    secretPaths: ['.config/corp-vpn', '.corp/token'],
    editPaths: ['**/openapi.yaml', '**/gen/**'],
  },
};

describe('deriveProbes', () => {
  const probes = deriveProbes(DERIVE_SAFETY, CTX);
  const has = (expectV: string, action: string, resource: string) => probes.some((p) => p.expect === expectV && p.action === action && p.resource === resource);

  it('yields bare, `env X`, absolute-path, chained, `sh -c` and relative-path deny probes per denied command', () => {
    for (const c of ['deploytool', 'ship-cli']) {
      expect(has('deny', 'shell', c), c).toBe(true);
      expect(has('deny', 'shell', `env ${c}`), c).toBe(true);
      expect(has('deny', 'shell', `/usr/local/bin/${c}`), c).toBe(true);
      expect(has('deny', 'shell', `cd x && ${c} x`), c).toBe(true);
      expect(has('deny', 'shell', `sh -c '${c} x'`), c).toBe(true);
      expect(has('deny', 'shell', `./bin/${c} x`), c).toBe(true);
    }
    // 6 probes per command, 2 commands
    expect(probes.filter((p) => p.action === 'shell' && /deploytool|ship-cli/.test(p.resource) && !p.resource.startsWith('cat '))).toHaveLength(12);
  });
  it('yields a concrete worktree edit probe per edit glob, and read + grep + glob + shell probes per secret path', () => {
    expect(has('deny', 'edit', `${CTX.worktree}/openapi.yaml`)).toBe(true);
    expect(has('deny', 'edit', `${CTX.worktree}/gen/probe`)).toBe(true);
    for (const rel of ['.config/corp-vpn', '.corp/token']) {
      expect(has('deny', 'read', `${HOME}/${rel}`)).toBe(true);
      expect(has('deny', 'read', `${HOME}/${rel}/probe`)).toBe(true);
      expect(has('deny', 'grep', `${HOME}/${rel}`)).toBe(true);
      expect(has('deny', 'glob', `${HOME}/${rel}/*`)).toBe(true);
      expect(has('deny', 'shell', `cat ~/${rel}/probe`)).toBe(true);
    }
  });
  it('yields a probe for a shell pattern (wildcards filled in) and allow probes for the skill roots', () => {
    expect(has('deny', 'shell', 'xinternal-syncx')).toBe(true);
    expect(has('allow', 'external_directory', `${HOME}/.agents/skills/probe-skill/SKILL.md`)).toBe(true);
    expect(has('allow', 'read', `${HOME}/.config/opencode/skills/probe-skill/SKILL.md`)).toBe(true);
    expect(has('allow', 'read', `${HOME}/.agents/skills/probe-skill/SKILL.md`)).toBe(false);
  });
  it('yields `deny|skill|<name>` per disabled skill, and the corpus parser accepts the skill action', async () => {
    const withSkills = deriveProbes({ ...DERIVE_SAFETY, disabledSkills: ['skill-a', 'skill-b'] }, CTX);
    expect(withSkills.filter((p) => p.action === 'skill')).toEqual([
      { expect: 'deny', action: 'skill', resource: 'skill-a' },
      { expect: 'deny', action: 'skill', resource: 'skill-b' },
    ]);
    expect(parseCorpus('deny|skill|skill-a\nallow|skill|other')).toEqual([
      { expect: 'deny', action: 'skill', resource: 'skill-a' },
      { expect: 'allow', action: 'skill', resource: 'other' },
    ]);
    const api = fakeRunApi(fakeAgents(rendered({ ...DERIVE_SAFETY, disabledSkills: ['skill-a', 'skill-b'] }).configContent.permissions));
    const res = await preflightRules(api, { sessionId: 's', agents: [...AGENT_IDS], corpus: withSkills });
    expect(res.failures.map((f) => f.message)).toEqual([]);
  });
  it('the workspace-specific inputs (twg configured) pass their own derived probes in the preflight', async () => {
    const specific = corpusSafety(WORKSPACE, HOME);
    const corpus = deriveProbes(specific, CTX, { mcpServerNames: WORKSPACE_MCP_SERVERS });
    expect(corpus.filter((p) => p.resource.includes('twg')).map((p) => `${p.action} ${p.resource}`)).toEqual(
      expect.arrayContaining(['shell cd x && twg x', "shell sh -c 'twg x'", 'shell ./bin/twg x', `grep ${HOME}/.config/twg`, `glob ${HOME}/.config/twg/*`]),
    );
    const res = await preflightRules(fakeRunApi(fakeAgents(rendered(specific, WORKSPACE_MCP_SERVERS).configContent.permissions)), { sessionId: 's', agents: [...AGENT_IDS], corpus });
    expect(res.failures.map((f) => f.message)).toEqual([]);
  });
  it('probes the normalised lists: a relative edit glob and a wildcard-free shell pattern', () => {
    const probes = deriveProbes({ ...DERIVE_SAFETY, deny: { ...DERIVE_SAFETY.deny, editPaths: ['vendored/**'], shellPatterns: ['internal-sync'] } }, CTX);
    expect(probes).toContainEqual({ expect: 'deny', action: 'edit', resource: `${CTX.worktree}/vendored/probe` });
    expect(probes).toContainEqual({ expect: 'deny', action: 'shell', resource: 'xinternal-syncx' });
  });
  it('is empty for empty inputs and rejects malformed entries', () => {
    expect(deriveProbes({ workspaceRoot: WORKSPACE, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } }, CTX)).toEqual([]);
    expect(() => deriveProbes({ ...DERIVE_SAFETY, deny: { ...DERIVE_SAFETY.deny, commands: ['a b'] } }, CTX)).toThrow(/deny\.commands/);
    expect(() => deriveProbes({ ...DERIVE_SAFETY, deny: { ...DERIVE_SAFETY.deny, secretPaths: ['/etc'] } }, CTX)).toThrow(/deny\.secretPaths/);
  });
  it('every derived probe holds against the profile rendered from the same inputs, for every agent', async () => {
    const api = fakeRunApi(fakeAgents(rendered(DERIVE_SAFETY).configContent.permissions));
    const res = await preflightRules(api, { sessionId: 's', agents: [...AGENT_IDS], corpus: probes });
    expect(res.failures.map((f) => f.message)).toEqual([]);
    expect(res.evaluated).toBe(probes.length * AGENT_IDS.length);
  });
  it('the derived probes bite: the profile without those inputs fails them', async () => {
    const api = fakeRunApi(fakeAgents(rendered({ ...DERIVE_SAFETY, deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } }).configContent.permissions));
    const res = await preflightRules(api, { sessionId: 's', agents: ['fixer'], corpus: probes });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.probe?.resource === 'deploytool')).toBe(true);
  });
});
