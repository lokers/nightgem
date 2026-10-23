import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configFromEnv } from '../profile/guard/config.mjs';
import { SECRET_HOME_ROOTS } from '../profile/guard/secrets.mjs';
import { controlDir, runDir, xdgDataHome } from '../src/paths.ts';
import {
  DEFAULT_AGENT_VARIANTS,
  DEFAULT_DENIED_COMMANDS,
  DEFAULT_DENIED_COMMAND_HEADS,
  DEFAULT_DENIED_TRACKER_BINARIES,
  DEFAULT_FIXER_MODEL,
  DEFAULT_NOPUSH_PREFIXES,
  DEFAULT_RUN_WRITABLE,
  DEFAULT_SCOUT_MODEL,
  SLIM_DISABLED_TOOLS,
  INERT_MCP_COMMAND,
  TOOL_DENIES,
  buildGuardEnv,
  SSH_LOG_ENV,
  SSH_REAL_ENV,
  binaryPathPatterns,
  buildPermissions,
  buildSafetyEnv,
  cmdAnywhere,
  commandPositionPatterns,
  defaultAgentModels,
  flagPatterns,
  publishPatterns,
  renderRunConfig,
  SECRET_HOME_PATHS,
  secretHomePaths,
  guardSafetyPayload,
  normalizeDeny,
  normalizeEditPath,
  normalizeShellPattern,
  shellDenyPatterns,
  skillRootAccess,
  writeRunDirFiles,
  type RenderRunConfigInput,
  type Rule,
} from '../src/profile.ts';
import { renderSandboxProfile, sandboxArgs, canonicalMacPath, sandboxReadDenies, SANDBOX_EXEC_DENIES, SANDBOX_READ_EXEMPT } from '../src/sandbox.ts';
import { DENIED_COMMANDS, DENIED_HEADS } from '../profile/guard/decide.mjs';
import { corpusSafety, emptySafety } from './fixtures/profile/corpus-safety.ts';
import { evaluate, fakeAgents, wildcardMatch } from './fixtures/profile/fake-run-api.ts';

const HOME = '/Users/alice';
const SLUG = 'my-run';
const WORKSPACE = `${HOME}/work`;
const TMP = '/private/var/folders/xx/T/opencode-tmp';

const input: RenderRunConfigInput = {
  slug: SLUG,
  home: HOME,
  workspaceRoot: WORKSPACE,
  runDir: runDir(SLUG, WORKSPACE),
  controlDir: controlDir(SLUG, HOME),
  tmpDir: TMP,
  model: 'anthropic/claude-opus-5-5',
  smallModel: 'anthropic/claude-haiku-5-5',
  guardDir: '/abs/nightgem/profile/guard',
  // workspace-specific inputs: the baseline every test below renders with unless it says otherwise
  safety: corpusSafety(WORKSPACE, HOME),
};

const rendered = renderRunConfig(input);
const perms = rendered.configContent.permissions;

function walk(value: unknown, visit: (v: unknown, path: string) => void, path = '$'): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, `${path}.${k}`);
}

const idx = (action: string, resource: string, effect?: string): number =>
  perms.findIndex((r) => r.action === action && r.resource === resource && (effect === undefined || r.effect === effect));

describe('renderRunConfig: no ask, no secrets', () => {
  const documents = { configContent: rendered.configContent, slimOverrides: rendered.slimOverrides, readableCopy: rendered.readableCopy };

  for (const [name, doc] of Object.entries(documents)) {
    it(`${name} contains no "ask" value anywhere (recursive)`, () => {
      const hits: string[] = [];
      walk(doc, (v, p) => {
        if (v === 'ask') hits.push(p);
        if (typeof v === 'string' && /(^|[^a-z])ask([^a-z]|$)/i.test(v) && !/^(\*|shell|edit|read)/.test(v)) hits.push(`${p}=${v}`);
      });
      expect(hits).toEqual([]);
    });

    it(`${name} contains no secret-looking strings`, () => {
      const text = JSON.stringify(doc);
      expect(text).not.toMatch(/apiKey/i);
      expect(text).not.toContain('sk-');
      expect(text).not.toMatch(/api[_-]?key|bearer|BEGIN [A-Z ]*PRIVATE KEY|ghp_|xox[bp]-/i);
    });
  }

  it('configContentJson is the compact JSON of configContent', () => {
    expect(JSON.parse(rendered.configContentJson)).toEqual(rendered.configContent);
    expect(rendered.configContentJson).not.toContain('\n');
  });
});

describe('renderRunConfig: configContent', () => {
  it('has model, small_model, warming off and the guard plugin by absolute package dir', () => {
    expect(rendered.configContent.model).toBe(input.model);
    expect(rendered.configContent.small_model).toBe(input.smallModel);
    expect(rendered.configContent.warming).toBe(false);
    expect(rendered.configContent.plugins).toEqual([{ package: input.guardDir }]);
  });

  it('uses the v2 rule shape only', () => {
    for (const r of perms) {
      expect(Object.keys(r).sort()).toEqual(['action', 'effect', 'resource']);
      expect(['allow', 'deny']).toContain(r.effect);
    }
  });

  it('starts with `* * allow`', () => {
    expect(perms[0]).toEqual({ action: '*', resource: '*', effect: 'allow' });
    expect(perms.slice(1).some((r) => r.action === '*' && r.resource === '*')).toBe(false);
  });

  it('denies push in every form and the forbidden shell commands', () => {
    const denied = new Set(perms.filter((r) => r.action === 'shell' && r.effect === 'deny').map((r) => r.resource));
    for (const p of [
      '*git*push*',
      '*receive-pack*',
      '*git*-c remote.*',
      '*git*-c url.*',
      'gh *',
      'opencode *',
      'claude *',
      'cursor-agent *',
      'security *',
      'launchctl *',
      'osascript *',
      'crontab *',
      '*git config --global*',
      '*npm * -g*',
      'brew *',
      'aws *',
      'gcloud *',
      'gsutil *',
      'kubectl *',
      'docker *',
      'helm *',
      'argocd *',
      'terraform *',
      'ssh *',
      'scp *',
      'sftp *',
      'rsync *',
      '*--watch',
      '*--watch *',
      '*--watchAll',
      '*--watchAll *',
      '*git*stash*',
      // twg is denied here because the baseline inputs configure it (deny.commands); the generic defaults do not carry it
      'twg',
      'twg *',
      '* twg *',
      'acli *',
      '*/acli',
      'jira *',
      '*npm*publish*',
      '*yarn*publish*',
      '*pnpm*publish*',
      '*npx np',
      '*npx np *',
      '*npm run dev*',
      '*npm run start*',
      '*npm run serve*',
      '*nx serve*',
      '*curl * | *sh*',
      '*OPENCODE_SERVER_PASSWORD*',
    ])
      expect(denied.has(p), p).toBe(true);
    // ordinary work is not denied by a catch-all
    expect(denied.has('*')).toBe(false);
    // switching a watcher OFF is not a watcher
    for (const p of ['*--watch*', '*--watchAll*', '*--watch=*', '*watch*']) expect(denied.has(p), p).toBe(false);
    for (const p of flagPatterns('--watch')) expect(wildcardMatch('vitest run --watch=false', p), p).toBe(false);
    expect(publishPatterns().length).toBeGreaterThan(8);
    expect(new Set(shellDenyPatterns()).size).toBe(shellDenyPatterns().length);
  });

  it('shell + read/grep/glob: denies the user secret locations and environment dumps', () => {
    const denied = new Set(shellDenyPatterns(HOME));
    for (const p of [
      '*/.config/opencode*',
      '*/.local/share/opencode*',
      '*/.ssh/*',
      '*~/.config/opencode*',
      '*$HOME/.ssh*',
      '*${HOME}/.aws*',
      `*${HOME}/.netrc*`,
      `*${HOME}/.git-credentials*`,
      `*${HOME}/Library/Keychains*`,
      `*${HOME}/Library/Application Support/nightgem*`,
      'export -p*',
      'set',
      'declare -p*',
      'env',
      '*printenv*',
    ])
      expect(denied.has(p), p).toBe(true);
    expect(new Set(shellDenyPatterns(HOME)).size).toBe(shellDenyPatterns(HOME).length);
    // plain `env FOO=1 cmd` is not covered by a catch-all pattern
    expect(denied.has('env *')).toBe(false);
    for (const action of ['read', 'grep', 'glob']) {
      for (const rel of SECRET_HOME_PATHS) {
        expect(idx(action, `${HOME}/${rel}`, 'deny'), `${action} ${rel}`).toBeGreaterThan(0);
        expect(idx(action, `${HOME}/${rel}/*`, 'deny'), `${action} ${rel}/*`).toBeGreaterThan(0);
      }
    }
    // the deny comes after the leading allow-all
    expect(idx('read', `${HOME}/.config/opencode`, 'deny')).toBeGreaterThan(0);
  });

  it('SECRET_HOME_PATHS (profile) equals SECRET_HOME_ROOTS (guard secrets.mjs)', () => {
    expect([...SECRET_HOME_PATHS]).toEqual(SECRET_HOME_ROOTS);
  });

  it('tool output: read/grep/glob and external_directory allow <xdg>/opencode/tool-output after the secret denies; the rest stays denied', () => {
    const toolOut = `${xdgDataHome(SLUG, HOME)}/opencode/tool-output`;
    expect(toolOut).toBe(`${controlDir(SLUG, HOME)}/xdg-data/opencode/tool-output`);
    for (const action of ['read', 'grep', 'glob']) {
      expect(idx(action, toolOut, 'allow'), action).toBeGreaterThan(idx(action, `${HOME}/Library/Application Support/nightgem/*`, 'deny'));
      expect(idx(action, `${toolOut}/*`, 'allow'), action).toBeGreaterThan(idx(action, `${HOME}/Library/Application Support/nightgem/*`, 'deny'));
    }
    expect(idx('external_directory', `${toolOut}/**`, 'allow')).toBeGreaterThan(idx('external_directory', '*', 'deny'));
    // no allow for the control dir itself, the run auth store or the database
    const allowed = perms.filter((r) => r.effect === 'allow' && ['read', 'grep', 'glob', 'external_directory'].includes(r.action)).map((r) => r.resource);
    for (const bad of [controlDir(SLUG, HOME), `${controlDir(SLUG, HOME)}/*`, `${xdgDataHome(SLUG, HOME)}/opencode/*`, `${xdgDataHome(SLUG, HOME)}/*`]) expect(allowed, bad).not.toContain(bad);
  });

  it('shell .env deny patterns are reader-specific, so naming/listing/copy-to .env stays possible', () => {
    const denied = new Set(shellDenyPatterns(HOME));
    expect(denied.has('*.env')).toBe(false);
    expect(denied.has('*.env *')).toBe(false);
    for (const p of ['cat *.env', 'cat *.env *', '*; cat *.env', 'grep *.env', 'source *.env', '. *.env']) expect(denied.has(p), p).toBe(true);
  });

  it('denies the tools that need a human or reach outside', () => {
    for (const t of ['question', 'wait_for_user', 'interview_submit_state', 'acp_run', 'marketplace_*']) {
      expect(idx(t, '*', 'deny'), t).toBeGreaterThan(0);
      expect(TOOL_DENIES).toContain(t);
    }
  });

  it('read: denies .env but allows the examples, in that order', () => {
    const deny = idx('read', '*.env', 'deny');
    expect(deny).toBeGreaterThan(0);
    expect(idx('read', '*.env.*', 'deny')).toBeGreaterThan(0);
    expect(idx('read', '*.env.example', 'allow')).toBeGreaterThan(idx('read', '*.env.*', 'deny'));
    expect(idx('read', '*.env.defaults', 'allow')).toBeGreaterThan(idx('read', '*.env.*', 'deny'));
  });

  it('edit: deny all, then allow worktrees/spec dir/tmp, then deny the protected files (in order)', () => {
    const base = idx('edit', '*', 'deny');
    const wt = idx('edit', `${WORKSPACE}/*/.worktrees/${SLUG}/**`, 'allow');
    const spec = idx('edit', `${WORKSPACE}/.specs/${SLUG}/**`, 'allow');
    const tmp = idx('edit', `${TMP}/**`, 'allow');
    expect(base).toBeGreaterThan(0);
    for (const a of [wt, spec, tmp]) expect(a).toBeGreaterThan(base);
    const protectedDenies = [
      '**/SPEC.md',
      '**/RUN.json',
      `${WORKSPACE}/.specs/${SLUG}/.run/**`,
      '**/.run/.opencode/**',
      '**/.run/opencode.json',
      `${WORKSPACE}/.opencode/**`,
      `${WORKSPACE}/opencode.json*`,
      `${WORKSPACE}/.specs/.opencode/**`,
    ];
    for (const g of protectedDenies) expect(idx('edit', g, 'deny'), g).toBeGreaterThan(Math.max(wt, spec, tmp));
  });

  it('external_directory: deny all, then allow the workspace root and tmp (a provided safety without skill roots adds none)', () => {
    const perms = renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions;
    const idx = (a: string, r: string, e?: string) => idxIn(perms, a, r, e ?? 'allow');
    const base = idx('external_directory', '*', 'deny');
    expect(base).toBeGreaterThan(0);
    for (const g of [`${WORKSPACE}/**`, `${TMP}/**`]) expect(idx('external_directory', g), g).toBeGreaterThan(base);
    expect(perms.filter((r) => r.action === 'external_directory' && r.effect === 'allow').map((r) => r.resource)).not.toContainEqual(expect.stringMatching(/skills|marketplaces/));
  });

  it('sections appear in the documented order: read, shell, tools, edit, external_directory', () => {
    const firstOf = (a: string) => perms.findIndex((r) => r.action === a);
    expect(firstOf('read')).toBeLessThan(firstOf('shell'));
    expect(firstOf('shell')).toBeLessThan(firstOf('question'));
    expect(firstOf('question')).toBeLessThan(firstOf('edit'));
    expect(firstOf('edit')).toBeLessThan(firstOf('external_directory'));
  });

  it('the run tmp dir may live outside the control dir (<os.tmpdir()>/nightgem-<slug>): allowlists use the tmpDir parameter', () => {
    const tmp = '/private/var/folders/xx/T/nightgem-my-run';
    const r = renderRunConfig({ ...input, tmpDir: tmp }).configContent.permissions;
    const control = controlDir(SLUG, HOME);
    expect(tmp.startsWith(control)).toBe(false);
    expect(r.some((x) => x.resource === `${tmp}/**` && x.action === 'edit' && x.effect === 'allow')).toBe(true);
    expect(r.some((x) => x.resource === `${tmp}/**` && x.action === 'external_directory' && x.effect === 'allow')).toBe(true);
    expect(evaluate(r, 'edit', `${tmp}/msg`)).toBe('allow');
    expect(evaluate(r, 'external_directory', `${tmp}/msg`)).toBe('allow');
    expect(evaluate(r, 'read', `${tmp}/msg`)).toBe('allow');
    expect(evaluate(r, 'shell', `git commit -F ${tmp}/msg`)).toBe('allow');
    expect(evaluate(r, 'shell', `echo x > ${tmp}/x`)).toBe('allow');
    // the control dir stays secret, whatever the tmp dir is
    for (const f of [`${control}/password`, `${control}/control.json`, `${control}/xdg-data/opencode/auth.json`]) expect(evaluate(r, 'read', f), f).toBe('deny');
    expect(evaluate(r, 'edit', `${control}/x`)).toBe('deny');
    expect(evaluate(r, 'external_directory', `${control}/password`)).toBe('deny');
    expect(evaluate(r, 'shell', `cat "${control}/password"`)).toBe('deny');
    // the old in-control-dir tmp is no longer special-cased
    const sb = renderSandboxProfile({ home: HOME, workspaceRoot: WORKSPACE, tmpDir: tmp, xdgDataHome: xdgDataHome(SLUG, HOME), port: 1234, safety: input.safety });
    expect(sb).toContain(`(subpath "${tmp}")`);
    expect(sb).not.toContain(`(subpath "${control}")`);
    expect(buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: control, tmpDir: tmp, safety: input.safety }).NIGHTGEM_ALLOWED_WRITE_ROOTS?.split(':')).toContain(tmp);
  });

  it('is deterministic and slug-scoped', () => {
    expect(renderRunConfig(input).configContentJson).toBe(rendered.configContentJson);
    const other = renderRunConfig({ ...input, slug: 'other-run' }).configContent.permissions;
    expect(other.some((r: Rule) => r.resource.includes('my-run'))).toBe(false);
    expect(other.some((r: Rule) => r.resource.includes('other-run'))).toBe(true);
  });
});

describe('renderRunConfig: .run dir', () => {
  const RUN = `${WORKSPACE}/.specs/${SLUG}/.run`;
  const find = (p: Rule[], res: string, eff: string) => p.findIndex((r) => r.action === 'edit' && r.resource === res && r.effect === eff);

  it('denies the .run dir, then allows exactly tasks.jsonl, decisions.jsonl and run-complete.json after the deny', () => {
    const deny = find(perms, `${RUN}/**`, 'deny');
    expect(deny).toBeGreaterThan(find(perms, `${WORKSPACE}/.specs/${SLUG}/**`, 'allow'));
    const allows = perms.map((r, i) => ({ r, i })).filter(({ r }) => r.action === 'edit' && r.effect === 'allow' && r.resource.startsWith(`${RUN}/`));
    expect(allows.map(({ r }) => r.resource)).toEqual([`${RUN}/tasks.jsonl`, `${RUN}/decisions.jsonl`, `${RUN}/run-complete.json`]);
    for (const { i } of allows) expect(i).toBeGreaterThan(deny);
    // the only other allows after the deny are the same three files as bare names: opencode hands the edit rule a path
    // relative to the session directory (`.run`) for files inside it (smoke D2 root cause)
    expect(perms.slice(deny).filter((r) => r.action === 'edit' && r.effect === 'allow' && !r.resource.startsWith(`${RUN}/`)).map((r) => r.resource)).toEqual(['tasks.jsonl', 'decisions.jsonl', 'run-complete.json']);
  });
  it('keeps RUN.json, opencode.json, .opencode/** and SPEC.md denied; cost/events/log are covered by the .run deny', () => {
    for (const g of ['**/RUN.json', '**/SPEC.md', '**/.run/opencode.json', '**/.run/.opencode/**', `${RUN}/**`]) expect(find(perms, g, 'deny'), g).toBeGreaterThan(0);
    for (const n of ['tasks.jsonl', 'decisions.jsonl', 'run-complete.json']) expect(find(perms, `${RUN}/${n}`, 'deny')).toBe(-1);
    for (const n of ['RUN.json', 'cost.jsonl', 'events.jsonl', 'orchestrator.log', 'opencode.json']) expect(find(perms, `${RUN}/${n}`, 'allow'), n).toBe(-1);
  });
  it('runDirWritable overrides the default, [] closes it, invalid names throw', () => {
    const only = renderRunConfig({ ...input, runDirWritable: ['tasks.jsonl'] }).configContent.permissions;
    expect(find(only, `${RUN}/tasks.jsonl`, 'allow')).toBeGreaterThan(0);
    expect(find(only, `${RUN}/decisions.jsonl`, 'allow')).toBe(-1);
    const closed = renderRunConfig({ ...input, runDirWritable: [] }).configContent.permissions;
    expect(closed.some((r) => r.action === 'edit' && r.effect === 'allow' && r.resource.startsWith(`${RUN}/`))).toBe(false);
    for (const bad of ['../x', 'RUN.json', 'opencode.json', 'a*', 'a?', 'a\\b']) expect(() => renderRunConfig({ ...input, runDirWritable: [bad] }), bad).toThrow(/Invalid runDirWritable/);
  });
  it('buildGuardEnv passes the same list (default and explicit)', () => {
    const base = { slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: input.safety };
    expect(buildGuardEnv(base).NIGHTGEM_RUN_WRITABLE).toBe(DEFAULT_RUN_WRITABLE.join(':'));
    expect(buildGuardEnv({ ...base, runDirWritable: ['tasks.jsonl'] }).NIGHTGEM_RUN_WRITABLE).toBe('tasks.jsonl');
  });
});

describe('renderRunConfig: slimOverrides', () => {
  const slim = rendered.slimOverrides;
  it('defaults: orchestrator/oracle run the run model, fixer/designer Sonnet, explorer/librarian Haiku, observer the small model', () => {
    expect(DEFAULT_FIXER_MODEL).toBe('anthropic/claude-sonnet-5-5');
    expect(DEFAULT_SCOUT_MODEL).toBe('anthropic/claude-haiku-5-5');
    expect(slim.agents).toEqual({
      orchestrator: { model: input.model, variant: 'high' },
      oracle: { model: input.model, variant: 'xhigh' },
      fixer: { model: 'anthropic/claude-sonnet-5-5', variant: 'high' },
      designer: { model: 'anthropic/claude-sonnet-5-5', variant: 'medium' },
      explorer: { model: 'anthropic/claude-haiku-5-5', variant: 'low' },
      librarian: { model: 'anthropic/claude-haiku-5-5', variant: 'low' },
      observer: { model: input.smallModel },
    });
    expect(defaultAgentModels('m/x', 'm/small')).toEqual({
      orchestrator: 'm/x',
      oracle: 'm/x',
      fixer: DEFAULT_FIXER_MODEL,
      designer: DEFAULT_FIXER_MODEL,
      explorer: DEFAULT_SCOUT_MODEL,
      librarian: DEFAULT_SCOUT_MODEL,
      observer: 'm/small',
    });
    // the variants mirror the default slim preset
    expect(DEFAULT_AGENT_VARIANTS).toEqual({ orchestrator: 'high', oracle: 'xhigh', fixer: 'high', designer: 'medium', explorer: 'low', librarian: 'low' });
    // the run model does not leak into small_model / fixer
    expect(rendered.configContent.model).toBe(input.model);
    expect(rendered.configContent.small_model).toBe(input.smallModel);
  });
  it('agentModels overrides model and variant per agent (and may add one); the override variant wins, otherwise the default stays', () => {
    const custom = renderRunConfig({
      ...input,
      agentModels: { fixer: { model: 'anthropic/claude-opus-5-5', variant: 'medium' }, explorer: { model: 'openai/gpt-x' }, oracle: { model: 'p/o', variant: 'high' }, extra: { model: 'p/m' } },
    });
    expect(custom.slimOverrides.agents.fixer).toEqual({ model: 'anthropic/claude-opus-5-5', variant: 'medium' });
    expect(custom.slimOverrides.agents.explorer).toEqual({ model: 'openai/gpt-x', variant: 'low' });
    expect(custom.slimOverrides.agents.oracle).toEqual({ model: 'p/o', variant: 'high' });
    expect(custom.slimOverrides.agents.extra).toEqual({ model: 'p/m' });
    expect(custom.slimOverrides.agents.designer).toEqual({ model: DEFAULT_FIXER_MODEL, variant: 'medium' });
    expect(custom.slimOverrides.agents.orchestrator).toEqual({ model: input.model, variant: 'high' });
    // never a nested object as a model
    for (const a of Object.values(custom.slimOverrides.agents)) expect(typeof a.model).toBe('string');
    // the permission list does not depend on the models
    expect(custom.configContent.permissions).toEqual(perms);
  });
  it('sets background, interview and acp keys', () => {
    expect(slim.backgroundJobs.maxSessionsPerAgent).toBeGreaterThanOrEqual(4);
    expect(slim.backgroundJobs.concurrency.defaultConcurrency).toBe(4);
    expect(slim.backgroundJobs.wallClockTimeoutMs).toBe(7_200_000);
    expect(slim.interview.autoOpenBrowser).toBe(false);
    expect(slim.acpAgents).toEqual({});
    expect(slim.disabled_mcps).toEqual([]); // MCP servers come from the user's config (mcpServerNames), none are hard-coded
    expect(JSON.stringify(slim)).not.toContain('council');
  });
  it('disabled_tools mirrors the tool denies', () => {
    for (const t of TOOL_DENIES.filter((d) => !d.endsWith('*'))) expect(slim.disabled_tools).toContain(t);
    for (const t of SLIM_DISABLED_TOOLS) expect(slim.disabled_tools).toContain(t);
    expect(slim.disabled_tools).toContain('marketplace_manage');
  });
  it('disabled_skills is empty for a provided safety without any, and carries exactly safety.disabledSkills (deduplicated) otherwise', () => {
    expect(renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).slimOverrides.disabled_skills).toEqual([]);
    const custom = renderRunConfig({ ...input, safety: { ...emptySafety(WORKSPACE), disabledSkills: ['skill-a', 'skill-b', 'skill-a'] } }).slimOverrides;
    expect(custom.disabled_skills).toEqual(['skill-a', 'skill-b']);
  });
});

describe('writeRunDirFiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ng-profile-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the readable copy and slim jsonc as 0444, and can rewrite them', () => {
    const run = join(dir, '.run');
    const w = writeRunDirFiles(run, rendered);
    expect(w.opencodeJson).toBe(join(run, 'opencode.json'));
    expect(w.slimJsonc).toBe(join(run, '.opencode', 'oh-my-opencode-slim.jsonc'));
    for (const f of [w.opencodeJson, w.slimJsonc]) expect(statSync(f).mode & 0o777).toBe(0o444);
    const copy = JSON.parse(readFileSync(w.opencodeJson, 'utf8'));
    expect(copy).toEqual(rendered.readableCopy);
    expect(copy.plugins).toBeUndefined();
    expect(readFileSync(w.slimJsonc, 'utf8')).toMatch(/^\/\/ /);
    expect(JSON.parse(readFileSync(w.slimJsonc, 'utf8').replace(/^\/\/.*\n/, ''))).toEqual(rendered.slimOverrides);
    // idempotent over read-only files
    expect(() => writeRunDirFiles(run, rendered)).not.toThrow();
    expect(statSync(w.opencodeJson).mode & 0o777).toBe(0o444);
    expect(w.appends).toEqual([]);
  });

  it('copies *_append.md files read-only when appendsDir is given', () => {
    const run = join(dir, '.run2');
    const appends = join(dir, 'prompts');
    mkdirSync(appends, { recursive: true });
    writeFileSync(join(appends, 'orchestrator_append.md'), 'ORCH');
    writeFileSync(join(appends, 'fixer_append.md'), 'FIX');
    writeFileSync(join(appends, 'phase-plan.md'), 'not an append');
    const w = writeRunDirFiles(run, rendered, appends);
    expect(w.appends.map((p) => p.split('/').pop())).toEqual(['fixer_append.md', 'orchestrator_append.md']);
    const dest = join(run, '.opencode', 'oh-my-opencode-slim');
    expect(readFileSync(join(dest, 'orchestrator_append.md'), 'utf8')).toBe('ORCH');
    expect(existsSync(join(dest, 'phase-plan.md'))).toBe(false);
    for (const f of w.appends) expect(statSync(f).mode & 0o777).toBe(0o444);
    expect(() => writeRunDirFiles(run, rendered, appends)).not.toThrow();
  });
});

describe('env helpers', () => {
  it('buildGuardEnv', () => {
    const env = buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: input.controlDir, tmpDir: TMP, port: 5555, safety: input.safety });
    expect(env.NIGHTGEM_CONTROL_DIR).toBe(input.controlDir);
    expect(env.NIGHTGEM_ALLOWED_WRITE_ROOTS?.split(':')).toEqual([`${WORKSPACE}/*/.worktrees/${SLUG}`, `${WORKSPACE}/.specs/${SLUG}`, TMP]);
    expect(env.NIGHTGEM_RUN_PORT).toBe('5555');
    expect(buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: input.safety }).NIGHTGEM_RUN_PORT).toBeUndefined();
  });
  it('buildSafetyEnv removes push capability', () => {
    const env = buildSafetyEnv({ sshWrapper: '/abs/git-ssh-fetch-only.sh' });
    expect(env).toMatchObject({
      GIT_SSH_COMMAND: '/abs/git-ssh-fetch-only.sh',
      GIT_SSH_VARIANT: 'ssh',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      GH_TOKEN: 'invalid',
      SSH_AUTH_SOCK: '',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
    expect(env.GIT_CONFIG_COUNT).toBe(String(DEFAULT_NOPUSH_PREFIXES.length + 1));
    DEFAULT_NOPUSH_PREFIXES.forEach((p, i) => {
      expect(env[`GIT_CONFIG_KEY_${i + 1}`]).toBe('url.nopush://.pushInsteadOf');
      expect(env[`GIT_CONFIG_VALUE_${i + 1}`]).toBe(p);
    });
  });
});

describe('renderSandboxProfile', () => {
  const sbInput = { home: HOME, workspaceRoot: WORKSPACE, tmpDir: TMP, xdgDataHome: xdgDataHome(SLUG, HOME), port: 54176, safety: input.safety };
  const sb = renderSandboxProfile(sbInput);

  it('starts with allow default then deny file-write*', () => {
    const lines = sb.split('\n').filter((l) => !l.startsWith(';;'));
    expect(lines.slice(0, 3)).toEqual(['(version 1)', '(allow default)', '(deny file-write*)']);
  });
  it('allows exactly the v3 delta 7 subpaths (macOS-canonical)', () => {
    for (const p of [WORKSPACE, TMP, sbInput.xdgDataHome, `${HOME}/.cache`, `${HOME}/.npm`, `${HOME}/Library/Caches`, `${HOME}/go/pkg/mod`, `${HOME}/Library/Logs`]) {
      expect(sb).toContain(`(subpath "${p}")`);
    }
    expect(sb).toContain('(literal "/dev/null")');
    expect(sb).toContain('/dev/(tty|ttys[0-9]+|fd/[0-9]+)');
    const writeSection = sb.slice(sb.indexOf('(allow file-write*'), sb.indexOf('(deny file-read*'));
    expect([...writeSection.matchAll(/\(subpath /g)]).toHaveLength(8);
    expect(sb).not.toMatch(new RegExp(`subpath "${HOME}"\\)`));
  });
  it('denies file-read* for credential locations the run never reads, after the write allowlist', () => {
    const deny = sb.slice(sb.indexOf('(deny file-read*'), sb.indexOf('(deny network-outbound'));
    for (const p of ['.aws', '.config/gcloud', '.kube', '.docker', '.config/gh', '.config/glab-cli', '.config/linear', '.config/twg', '.ssh', 'Library/Keychains', '.local/share/opencode']) expect(deny).toContain(`(subpath "${HOME}/${p}")`);
    for (const p of ['.netrc', '.git-credentials']) expect(deny).toContain(`(literal "${HOME}/${p}")`);
    expect(sb.indexOf('(allow file-write*')).toBeLessThan(sb.indexOf('(deny file-read*'));
    // the server reads its own config: never denied at the kernel level (the guard covers it)
    for (const p of ['.config/opencode', '.npmrc']) expect(deny).not.toContain(`${HOME}/${p}`);
    expect([...sb.matchAll(/file-read\*/g)]).toHaveLength(1);
    expect(sandboxReadDenies({ home: HOME })).toHaveLength(12);
    // the twg login dir is denied only when the inputs configure it (deny.secretPaths)
    expect(sandboxReadDenies({ home: HOME }).map((d) => d.path)).not.toContain(`${HOME}/.config/twg`);
    expect(sandboxReadDenies({ home: HOME, safety: input.safety }).map((d) => d.path)).toContain(`${HOME}/.config/twg`);
  });
  it('denies network-outbound to the run port (SBPL accepts only localhost, which covers 127.0.0.1) and to port 22 (ssh push)', () => {
    expect(sb).toContain('(deny network-outbound (remote ip "localhost:54176"))');
    expect(sb).toContain('(deny network-outbound (remote ip "*:22"))');
    expect(sb).not.toContain('127.0.0.1');
    expect([...sb.matchAll(/network-outbound/g)]).toHaveLength(2);
    // nothing else is cut off: https (git over https, npm, go) must keep working
    expect(sb).not.toMatch(/network-outbound[^\n]*:(80|443|\*)\b/);
  });
  it('widens by extraWriteSubpaths and canonicalises /var, /tmp, /etc', () => {
    const wide = renderSandboxProfile({ ...sbInput, tmpDir: '/var/folders/a/T/x', extraWriteSubpaths: [`${HOME}/.cache/ms-playwright`, '/tmp/build'] });
    expect(wide).toContain('(subpath "/private/var/folders/a/T/x")');
    expect(wide).toContain('(subpath "/private/tmp/build")');
    expect(wide).toContain(`(subpath "${HOME}/.cache/ms-playwright")`);
    expect(canonicalMacPath('/private/var/x')).toBe('/private/var/x');
    expect(canonicalMacPath('/Users/x')).toBe('/Users/x');
  });
  it('denies exec of the host-control binaries (launchctl, osascript, crontab) with valid SBPL', () => {
    const sb = renderSandboxProfile(sbInput);
    expect(sb).toContain('(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/osascript") (literal "/usr/bin/crontab"))');
    expect([...SANDBOX_EXEC_DENIES]).toEqual(['/bin/launchctl', '/usr/bin/osascript', '/usr/bin/crontab']);
    // after `(allow default)`, so the deny wins for these literals only
    expect(sb.indexOf('(allow default)')).toBeLessThan(sb.indexOf('process-exec'));
  });
  it('rejects invalid ports and unsafe paths, and escapes quotes', () => {
    expect(() => renderSandboxProfile({ ...sbInput, port: 0 })).toThrow(/Invalid port/);
    expect(() => renderSandboxProfile({ ...sbInput, port: 70000 })).toThrow(/Invalid port/);
    expect(() => renderSandboxProfile({ ...sbInput, tmpDir: '/x\n(allow file-write*)' })).toThrow(/Invalid character/);
    expect(renderSandboxProfile({ ...sbInput, tmpDir: '/x"y' })).toContain('(subpath "/x\\"y")');
  });
  it('sandboxArgs builds the sandbox-exec argv', () => {
    expect(sandboxArgs('/p.sb', ['opencode', 'serve', '--port', '1'])).toEqual(['-f', '/p.sb', 'opencode', 'serve', '--port', '1']);
    expect(() => sandboxArgs('/p.sb', [])).toThrow();
  });
});

describe('opencode 2.0.29 wildcard semantics (the matcher the tests evaluate rules with)', () => {
  // Read from `VN(input, pattern)` in the 2.0.29 binary and confirmed against the live evaluator (docs/opencode-notes.md).
  it('`*` crosses `/`, spaces and newlines; matching is anchored and case-sensitive', () => {
    expect(wildcardMatch('a/b/c', 'a*c')).toBe(true);
    expect(wildcardMatch('a b\nc', 'a*c')).toBe(true);
    expect(wildcardMatch('abc', '*')).toBe(true);
    expect(wildcardMatch('', '*')).toBe(true);
    expect(wildcardMatch('abcd', 'abc')).toBe(false); // anchored at the end
    expect(wildcardMatch('xabc', 'abc')).toBe(false); // anchored at the start
    expect(wildcardMatch('ABC', 'abc')).toBe(false); // case-sensitive
    expect(wildcardMatch('a/b', 'a**b')).toBe(true); // `**` is `*`
  });

  it('`?` matches exactly one character', () => {
    expect(wildcardMatch('ab', 'a?')).toBe(true);
    expect(wildcardMatch('a', 'a?')).toBe(false);
    expect(wildcardMatch('abc', 'a?')).toBe(false);
    expect(wildcardMatch('a?', 'a?')).toBe(true);
  });

  it('regex metacharacters, brackets and `|` are literal (no classes, no alternation)', () => {
    expect(wildcardMatch('a.b', 'a.b')).toBe(true);
    expect(wildcardMatch('axb', 'a.b')).toBe(false);
    expect(wildcardMatch('a;b', 'a[;&|]b')).toBe(false);
    expect(wildcardMatch('a[;&|]b', 'a[;&|]b')).toBe(true);
    expect(wildcardMatch('ab', 'a|b')).toBe(false);
    expect(wildcardMatch('a|b', 'a|b')).toBe(true);
    expect(wildcardMatch('(x)', '(x)')).toBe(true);
    expect(wildcardMatch('a+', 'a+')).toBe(true);
    expect(wildcardMatch('aa', 'a+')).toBe(false);
    expect(wildcardMatch('$HOME/x', '$HOME/*')).toBe(true);
    expect(wildcardMatch('~/x', '~/*')).toBe(true);
  });

  it('backslashes are read as `/` in both the input and the pattern', () => {
    expect(wildcardMatch('a\\b', 'a/b')).toBe(true);
    expect(wildcardMatch('a/b', 'a\\b')).toBe(true);
    expect(wildcardMatch('a\\b', 'a\\b')).toBe(true);
  });

  it('a TRAILING " *" is optional; a space-star elsewhere is not', () => {
    expect(wildcardMatch('git', 'git *')).toBe(true);
    expect(wildcardMatch('git status', 'git *')).toBe(true);
    expect(wildcardMatch('git ', 'git *')).toBe(true);
    expect(wildcardMatch('gitx', 'git *')).toBe(false);
    expect(wildcardMatch('ls libs/jira', '*/jira *')).toBe(true); // the smoke D finding
    expect(wildcardMatch('ls libs/jira', '*/jira')).toBe(true);
    expect(wildcardMatch('ls libs/jira/x', '*/jira *')).toBe(false);
    expect(wildcardMatch('a', 'a * b')).toBe(false); // only the trailing one
    expect(wildcardMatch('a b', 'a * b')).toBe(false);
    expect(wildcardMatch('a x b', 'a * b')).toBe(true);
    expect(wildcardMatch('git', 'git*')).toBe(true);
    expect(wildcardMatch('x', ' *')).toBe(false);
    expect(wildcardMatch('', ' *')).toBe(true);
  });

  it('evaluate(): the LAST rule whose action AND resource match wins; no match is ask; action names are globs', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'allow' as const },
      { action: 'shell', resource: 'rm *', effect: 'deny' as const },
      { action: 'shell', resource: 'rm -i *', effect: 'allow' as const },
    ];
    expect(evaluate(rules, 'shell', 'rm')).toBe('deny');
    expect(evaluate(rules, 'shell', 'rm -i x')).toBe('allow');
    expect(evaluate(rules, 'read', 'rm')).toBe('allow');
    expect(evaluate([], 'shell', 'ls')).toBe('ask');
    expect(evaluate([{ action: 'mcp_*', resource: '*', effect: 'deny' }], 'mcp_x', 'y')).toBe('deny');
  });
});

describe('size of the rendered config', () => {
  it('configContentJson stays under 256 KB (it travels in the OPENCODE_CONFIG_CONTENT environment variable)', () => {
    expect(rendered.configContentJson.length).toBeLessThan(256 * 1024);
    expect(JSON.stringify(rendered.readableCopy).length).toBeLessThan(256 * 1024);
  });
});

describe('command-name patterns over-match nothing but the command', () => {
  const dirNames = ['jira', 'gh', 'claude', 'brew', 'opencode', 'docker', 'ssh', 'security', 'eval'];

  it('no generated pattern is a path-suffix match on a command name, except the acli binary', () => {
    const suffix = shellDenyPatterns(HOME).filter((p) => /^\*\/[A-Za-z-]+( \*)?$/.test(p));
    expect(suffix.sort()).toEqual(['*/acli', '*/acli *']);
    for (const c of dirNames) {
      for (const p of [...cmdAnywhere(c), ...commandPositionPatterns(c), ...binaryPathPatterns(c)]) {
        expect(p.startsWith(`*/${c}`), p).toBe(false);
      }
    }
  });

  it('a directory called like a command is not matched by any of its patterns', () => {
    for (const c of dirNames) {
      const pats = [...cmdAnywhere(c), ...commandPositionPatterns(c), ...binaryPathPatterns(c)];
      for (const input of [`ls libs/${c}`, `ls /abs/libs/${c}`, `cat src/${c}/x.ts`, `cd a/${c} && ls`, `ls ${HOME}/work/x/${c}/y`]) {
        for (const p of pats) expect(wildcardMatch(input, p), `${input} vs ${p}`).toBe(false);
      }
    }
  });

  it('commandPositionPatterns: `jira` only where a command starts', () => {
    const pats = commandPositionPatterns('jira');
    const hit = (s: string) => pats.some((p) => wildcardMatch(s, p));
    for (const s of ['jira', 'jira me', 'ls; jira me', 'ls && jira me', 'a | jira x', '(jira x)', "sh -c 'jira x'", 'bash -c "jira x"', 'sudo jira x', 'env jira x', 'cd x && env jira'])
      expect(hit(s), s).toBe(true);
    for (const s of ['ls jira', 'ls libs/jira', 'cat src/jira/client.ts', 'echo jira', 'ls jira/x', 'git checkout jira-fix', 'cd jira'])
      expect(hit(s), s).toBe(false);
  });

  it('binaryPathPatterns: an executable invoked by absolute or home path at a command start', () => {
    const pats = binaryPathPatterns('gh');
    const hit = (s: string) => pats.some((p) => wildcardMatch(s, p));
    for (const s of [
      '/opt/homebrew/bin/gh',
      '/opt/homebrew/bin/gh pr list',
      '~/.local/bin/gh pr',
      '$HOME/bin/gh x',
      '${HOME}/bin/gh x',
      'cd x && /usr/bin/gh pr',
      'ls; /usr/bin/gh pr',
      'echo | /usr/bin/gh',
      'bash -lc "/usr/bin/gh pr"',
      "sh -c '/usr/bin/gh pr'",
      '(/usr/bin/gh pr)',
    ])
      expect(hit(s), s).toBe(true);
    for (const s of ['ls docs/gh', 'ls /abs/docs/gh', 'cat /abs/docs/gh/x', 'echo "/tmp/gh"', 'cat src/gh.ts', 'ls /usr/bin/ghost']) expect(hit(s), s).toBe(false);
  });

  it('the rendered profile: listing a directory named like a CLI is allowed, running the CLI is denied', () => {
    for (const c of ['jira', 'gh', 'claude', 'brew', 'opencode', 'docker', 'ssh', 'security']) {
      for (const cmd of [`ls libs/${c}`, `cat src/${c}/x.ts`, `ls ${HOME}/work/x/${c}/y`]) expect(evaluate(perms, 'shell', cmd), cmd).toBe('allow');
    }
    expect(evaluate(perms, 'shell', 'ls libs/jira')).toBe('allow');
    for (const cmd of ['jira me', '~/go/bin/jira me', '/Users/x/go/bin/jira me', 'sudo jira me', 'cd x && jira me', '/usr/bin/gh pr list', 'cd x && /usr/bin/gh pr list', '~/.claude/local/claude -p hi', 'gh pr list', 'echo | gh pr'])
      expect(evaluate(perms, 'shell', cmd), cmd).toBe('deny');
    // acli keeps the broad path-suffix deny (a real binary, never a directory worth listing); twg is denied by the configured inputs
    for (const cmd of ['/Users/x/.local/bin/twg', 'ls docs/acli', '~/.local/bin/twg status']) expect(evaluate(perms, 'shell', cmd), cmd).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Smoke run D2: the profile refused edit/write of the agent-writable .run files
// ---------------------------------------------------------------------------
interface SmokeEntry {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  expect: 'allow' | 'deny';
  group: string;
  denyBy?: string;
  externalDirectory?: string;
}

/**
 * What opencode 2.0.29 passes as the `edit` resource (`FileAccess.resolve` in the binary): the path RELATIVE to the session
 * directory when the file is inside it (the serve cwd, `<specs>/<slug>/.run`), the absolute path otherwise.
 */
function editResource(file: string, sessionDir: string): string {
  const rel = relative(sessionDir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
}

describe('smoke D2 replay: profile evaluator (opencode wildcard semantics, last match wins)', () => {
  // the recorded run's own workspace (taken from the fixture, whose paths are scrubbed separately)
  const fixtureText = readFileSync(new URL('./fixtures/profile/smoke-d2-blocked.json', import.meta.url), 'utf8');
  const REAL_WORKSPACE = /"(\/[^"]*?)\/\.specs\//.exec(fixtureText)![1]!;
  const REAL_HOME = REAL_WORKSPACE.slice(0, REAL_WORKSPACE.lastIndexOf('/'));
  const REAL_SLUG = 'ng-smoke-d';
  const sessionDir = `${REAL_WORKSPACE}/.specs/${REAL_SLUG}/.run`;
  const real = buildPermissions({ slug: REAL_SLUG, home: REAL_HOME, workspaceRoot: REAL_WORKSPACE, tmpDir: `/tmp/nightgem-${REAL_SLUG}`, safety: corpusSafety(REAL_WORKSPACE, REAL_HOME) });
  const rules = fakeAgents(real, ['orchestrator'])[0]!.permissions;
  const entries = JSON.parse(readFileSync(new URL('./fixtures/profile/smoke-d2-blocked.json', import.meta.url), 'utf8')) as SmokeEntry[];

  for (const e of entries) {
    if (e.tool === 'write' || e.tool === 'edit') {
      const file = String(e.input.path);
      it(`#${e.index} ${e.tool} ${file.split('/').slice(-2).join('/')}: allowed for the absolute AND the session-relative resource`, () => {
        expect(evaluate(rules, 'edit', file)).toBe('allow');
        expect(evaluate(rules, 'edit', editResource(file, sessionDir))).toBe('allow');
      });
    } else if (e.expect === 'allow') {
      it(`#${e.index} shell command is not matched by any shell deny`, () => {
        expect(evaluate(rules, 'shell', String(e.input.command))).toBe('allow');
      });
    } else {
      it(`#${e.index} stays denied by ${e.denyBy}`, () => {
        expect(evaluate(rules, e.denyBy!, e.externalDirectory!)).toBe('deny');
      });
    }
  }

  it('only the three agent-writable run files are editable inside .run; everything else there (and SPEC.md) stays denied', () => {
    for (const name of DEFAULT_RUN_WRITABLE) {
      expect(evaluate(rules, 'edit', name), name).toBe('allow');
      expect(evaluate(rules, 'edit', `${sessionDir}/${name}`), name).toBe('allow');
    }
    const denied = ['RUN.json', 'cost.jsonl', 'events.jsonl', 'orchestrator.log', 'opencode.json', 'other.txt', 'tasks.jsonl.bak', 'sub/tasks.jsonl', 'x/../RUN.json', '.opencode/oh-my-opencode-slim.jsonc', '.opencode/oh-my-opencode-slim/orchestrator_append.md', '.git/config'];
    for (const name of denied) {
      expect(evaluate(rules, 'edit', name), name).toBe('deny');
      expect(evaluate(rules, 'edit', `${sessionDir}/${name}`), name).toBe('deny');
    }
    for (const spec of [`${REAL_WORKSPACE}/.specs/${REAL_SLUG}/SPEC.md`, '../SPEC.md']) expect(evaluate(rules, 'edit', spec), spec).toBe('deny');
    // the rest of the spec dir stays writable (absolute: it is outside the session directory)
    expect(evaluate(rules, 'edit', `${REAL_WORKSPACE}/.specs/${REAL_SLUG}/PLAN.md`)).toBe('allow');
  });
});

describe('multi-line commands: a newline is a command separator for the shell deny patterns', () => {
  const rules = fakeAgents(perms, ['orchestrator'])[0]!.permissions;
  const shell = (cmd: string) => evaluate(rules, 'shell', cmd);
  it('denies a forbidden command that starts a later line (the old patterns needed a space or `;` before it)', () => {
    for (const cmd of ['echo x\ngh pr list', 'ls\njira me', 'cd a\nopencode run x', 'true\ndocker ps', 'echo ok\ncat .env', 'x\naws s3 ls', 'x\nclaude -p hi', 'x\ntwg search']) expect(shell(cmd), cmd).toBe('deny');
  });
  it('still allows realistic multi-line commands: heredoc logging and a test run', () => {
    for (const cmd of [
      `cd ${WORKSPACE}/.specs/${SLUG}; date -u +%Y-%m-%dT%H:%M:%SZ\ncat >> .run/tasks.jsonl <<'EOF'\n{"id":"a","summary":"x => y \`z\`"}\nEOF\ntail -1 .run/tasks.jsonl`,
      `cd wt && mkdir -p scripts && cat > test/a.test.js <<'EOF'\nconst f = () => 1;\nEOF\nCI=1 node --test test/a.test.js >/dev/null 2>&1; echo red $?\nls libs/jira\nnpm test`,
    ]) expect(shell(cmd), cmd).toBe('allow');
  });
});


// ---------------------------------------------------------------------------
// SafetyInputs consumption (AD5, AD6, AD11)
// ---------------------------------------------------------------------------

describe('SafetyInputs: generic defaults (no inputs)', () => {
  const generic = renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions;
  const sh = (cmd: string) => evaluate(generic, 'shell', cmd);

  it('the generic defaults are not weaker than the sum of their parts: every deny of the generic render is also in the workspace-specific render', () => {
    for (const r of renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions) {
      if (r.effect === 'deny') expect(perms, `${r.action} ${r.resource}`).toContainEqual(r);
    }
  });
  it('denies the common forge / tracker CLIs and agent runners in every spelling', () => {
    for (const c of ['gh', 'glab', 'acli', 'opencode', 'claude', 'cursor-agent', 'codex', 'aider']) {
      for (const cmd of [c, `${c} x`, `env ${c} x`, `cd a && ${c} x`, `/opt/homebrew/bin/${c} x`, `sudo ${c} x`]) expect(sh(cmd), cmd).toBe('deny');
    }
    for (const c of ['jira', 'linear']) {
      for (const cmd of [c, `${c} issue list`, `env ${c} x`, `cd a && ${c} x`, `$HOME/go/bin/${c} x`]) expect(sh(cmd), cmd).toBe('deny');
      for (const cmd of [`ls libs/${c}`, `cat src/${c}/x.ts`, `grep ${c} README.md`]) expect(sh(cmd), cmd).toBe('allow');
    }
  });
  it('a configured deny.commands entry is also denied as a relative path (./bin/x, node_modules/.bin/x, ../x)', () => {
    const configured = renderRunConfig({ ...input, safety: corpusSafety(WORKSPACE, HOME) }).configContent.permissions;
    for (const cmd of ['./bin/twg x', 'bin/twg x', 'node_modules/.bin/twg x', '../twg x', 'cd a && ./twg x', './bin/twg', 'ls; ./twg x']) {
      expect(evaluate(configured, 'shell', cmd), cmd).toBe('deny');
      expect(sh(cmd), `generic ${cmd}`).toBe('allow');
    }
    // the broad suffix is for configured commands only; names that merely contain the command stay allowed
    for (const cmd of ['./bin/twgx x', 'cat src/twg/x.ts', 'ls twgx']) expect(evaluate(configured, 'shell', cmd), cmd).toBe('allow');
    expect(shellDenyPatterns(HOME, corpusSafety(WORKSPACE, HOME))).toContain('*/twg *');
    expect(shellDenyPatterns(HOME, emptySafety(WORKSPACE))).not.toContain('*/twg *');
  });
  it('a configured secret path is denied when more words follow it (any home), without catching a sibling name', () => {
    const configured = renderRunConfig({ ...input, safety: corpusSafety(WORKSPACE, HOME) }).configContent.permissions;
    for (const cmd of ['ls /Users/bob/.config/twg | head', 'ls /Users/bob/.config/twg', 'cat /Users/bob/.config/twg/token']) {
      expect(evaluate(configured, 'shell', cmd), cmd).toBe('deny');
      expect(sh(cmd), `generic ${cmd}`).toBe('allow');
    }
    // a sibling name is not caught by the new `*/rel *` pattern (nor by the other two path patterns)
    for (const cmd of ['ls /Users/bob/.config/twgx | head', 'ls /Users/bob/.config/twgx', 'cat /Users/bob/.config/twgx/token']) expect(evaluate(configured, 'shell', cmd), cmd).toBe('allow');
    expect(shellDenyPatterns(HOME, corpusSafety(WORKSPACE, HOME))).toContain('*/.config/twg *');
    // unchanged: the user's own HOME spellings are substring patterns, so a sibling below that home was already denied
    expect(evaluate(configured, 'shell', `ls ${HOME}/.config/twgx`)).toBe('deny');
  });
  it('does not carry the twg tracker CLI or its login dir; configuring them denies both', () => {
    const configured = renderRunConfig({ ...input, safety: corpusSafety(WORKSPACE, HOME) }).configContent.permissions;
    for (const cmd of ['twg', 'twg x', 'env twg x', 'cd a && twg x', '/Users/x/.local/bin/twg x', '~/.local/bin/twg status']) {
      expect(sh(cmd), cmd).toBe('allow');
      expect(evaluate(configured, 'shell', cmd), cmd).toBe('deny');
    }
    for (const [action, res] of [['shell', `cat ${HOME}/.config/twg/token`], ['shell', 'ls $HOME/.config/twg'], ['read', `${HOME}/.config/twg/config.json`], ['grep', `${HOME}/.config/twg/*`], ['glob', `${HOME}/.config/twg/*`]] as const) {
      expect(evaluate(generic, action, res), `${action} ${res}`).toBe('allow');
      expect(evaluate(configured, action, res), `${action} ${res}`).toBe('deny');
    }
    expect(SECRET_HOME_PATHS).not.toContain('.config/twg');
    expect(shellDenyPatterns(HOME, emptySafety(WORKSPACE)).filter((p) => p.includes('twg'))).toEqual([]);
    expect(shellDenyPatterns(HOME, corpusSafety(WORKSPACE, HOME)).some((p) => p.includes('twg'))).toBe(true);
  });
  it('carries no user-specific tooling: no shell-pattern deny, no generated-code edit denies, no skill roots, no disabled skills', () => {
    expect(sh('node ~/tools/internal-sdlc/bin/x.js')).toBe('allow');
    const wt = `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1`;
    for (const f of [`${wt}/api-spec.yaml`, `${wt}/libs/api-client/src/generated/x.ts`, `${wt}/src/a.ts`]) expect(evaluate(generic, 'edit', f), f).toBe('allow');
    expect(generic.filter((r) => r.action === 'external_directory' && r.effect === 'allow').map((r) => r.resource)).toEqual([`${WORKSPACE}/**`, `${TMP}/**`, `${xdgDataHome(SLUG, HOME)}/opencode/tool-output/**`]);
    expect(renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).slimOverrides.disabled_skills).toEqual([]);
  });
  it('the generic rendering mentions no employer-specific names (profile, slim, sandbox, guard env)', () => {
    // the names are assembled from fragments so that this file stays free of them itself (the leak audit reads it)
    const banned = new RegExp(['len' + 'ses', 'land' + 'oop', 'cel' + 'onis', 'hq' + '-ui', 'hq' + '-backend'].join('|'), 'i');
    const rc = renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) });
    expect(JSON.stringify(rc)).not.toMatch(banned);
    expect(renderSandboxProfile({ home: HOME, workspaceRoot: WORKSPACE, tmpDir: TMP, xdgDataHome: xdgDataHome(SLUG, HOME), port: 1234, safety: emptySafety(WORKSPACE) })).not.toMatch(banned);
    expect(JSON.stringify(buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: emptySafety(WORKSPACE) }))).not.toMatch(banned);
    expect(shellDenyPatterns(HOME, emptySafety(WORKSPACE)).join('\n')).not.toMatch(banned);
  });
  it('the new credential dirs are secret locations everywhere', () => {
    for (const rel of ['.config/glab-cli', '.config/linear']) {
      expect(SECRET_HOME_PATHS).toContain(rel);
      expect(evaluate(generic, 'read', `${HOME}/${rel}/token`), rel).toBe('deny');
      expect(sh(`cat ~/${rel}/token`), rel).toBe('deny');
      expect(sandboxReadDenies({ home: HOME }).map((d) => d.path)).toContain(`${HOME}/${rel}`);
    }
  });
});

describe('SafetyInputs: workspace-specific inputs reproduce the previous verdicts', () => {
  const specific = corpusSafety(WORKSPACE, HOME);
  const p = renderRunConfig({ ...input, safety: specific }).configContent.permissions;
  const wt = `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1`;

  it('the shell-pattern deny is appended raw and denies the old command forms', () => {
    const pattern = specific.deny.shellPatterns[0]!;
    const word = pattern.replaceAll('*', '');
    expect(p).toContainEqual({ action: 'shell', resource: pattern, effect: 'deny' });
    for (const cmd of [`node ~/work/${word}/bin/x.js`, `${word} run`, `cd x && ./${word}`]) expect(evaluate(p, 'shell', cmd), cmd).toBe('deny');
    expect(evaluate(renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions, 'shell', `${word} run`)).toBe('allow');
  });
  it('edit path denies come after the worktree allow and win over it, in order', () => {
    const allow = idxIn(p, 'edit', `${WORKSPACE}/*/.worktrees/${SLUG}/**`, 'allow');
    for (const g of specific.deny.editPaths) expect(idxIn(p, 'edit', g, 'deny'), g).toBeGreaterThan(allow);
    expect(evaluate(p, 'edit', `${wt}/api-spec.yaml`)).toBe('deny');
    expect(evaluate(p, 'edit', `${wt}/libs/api-client/src/generated/x.ts`)).toBe('deny');
    expect(evaluate(p, 'edit', `${wt}/src/a.ts`)).toBe('allow');
  });
  it('skill roots become external_directory allows', () => {
    const base = idxIn(p, 'external_directory', '*', 'deny');
    for (const g of [`${HOME}/.claude/plugins/marketplaces/**`, `${HOME}/.agents/skills/**`]) expect(idxIn(p, 'external_directory', g, 'allow'), g).toBeGreaterThan(base);
    expect(evaluate(p, 'external_directory', `${HOME}/.agents/skills/x/SKILL.md`)).toBe('allow');
    expect(evaluate(p, 'external_directory', `${HOME}/.agents/other/x`)).toBe('deny');
  });
});

function idxIn(rules: readonly Rule[], action: string, resource: string, effect: string): number {
  return rules.findIndex((r) => r.action === action && r.resource === resource && r.effect === effect);
}

describe('SafetyInputs: deny lists', () => {
  const safety = {
    ...emptySafety(WORKSPACE),
    deny: { commands: ['deploytool'], shellPatterns: ['*internal-sync*'], secretPaths: ['.config/corp-vpn', '~/.corp/token/'], editPaths: ['**/openapi.yaml'] },
  };
  const p = renderRunConfig({ ...input, safety }).configContent.permissions;

  it('deny.commands get the same treatment as the built-in CLIs', () => {
    for (const cmd of ['deploytool', 'deploytool up', 'env deploytool up', 'cd a && deploytool', '/usr/local/bin/deploytool up', '$HOME/bin/deploytool up', 'bash -c "deploytool up"']) {
      expect(evaluate(p, 'shell', cmd), cmd).toBe('deny');
    }
    // relative-path invocations are denied too; the `*/c *` pattern also matches a path that merely ENDS in the name
    // (`ls libs/deploytool`, a deliberate over-match: a configured command is never a directory worth listing)
    for (const cmd of ['./bin/deploytool up', 'node_modules/.bin/deploytool up', 'ls libs/deploytool']) expect(evaluate(p, 'shell', cmd), cmd).toBe('deny');
    for (const cmd of ['cat src/deploytool/x.ts', 'git status']) expect(evaluate(p, 'shell', cmd), cmd).toBe('allow');
    for (const bad of ['a b', 'x*', '/usr/bin/x', '', '-x', 'a;b']) expect(() => shellDenyPatterns(HOME, { ...safety, deny: { ...safety.deny, commands: [bad] } }), bad).toThrow(/deny\.commands/);
  });
  it('deny.shellPatterns are appended raw to the shell denies', () => {
    expect(evaluate(p, 'shell', 'run internal-sync now')).toBe('deny');
    expect(evaluate(p, 'shell', 'echo hi')).toBe('allow');
    expect(shellDenyPatterns(HOME, safety).at(-1)).toBe('*internal-sync*');
  });
  it('deny.secretPaths deny read/grep/glob (path and below) and every plain shell spelling', () => {
    for (const rel of ['.config/corp-vpn', '.corp/token']) {
      for (const action of ['read', 'grep', 'glob']) for (const r of [`${HOME}/${rel}`, `${HOME}/${rel}/a/b`]) expect(evaluate(p, action, r), `${action} ${r}`).toBe('deny');
      for (const h of ['~', '$HOME', '${HOME}', HOME]) expect(evaluate(p, 'shell', `cat ${h}/${rel}/x`), h).toBe('deny');
    }
    expect(evaluate(p, 'read', `${HOME}/.config/other/x`)).toBe('allow');
    for (const bad of ['/etc/x', '../x', 'a/../b', 'a/*', '', '.', 'a//b']) expect(() => secretHomePaths({ deny: { ...safety.deny, secretPaths: [bad] } }), bad).toThrow(/deny\.secretPaths/);
    expect(secretHomePaths({ deny: { ...safety.deny, secretPaths: ['.ssh', '.aws'] } })).toEqual([...SECRET_HOME_PATHS]);
  });
  it('deny.editPaths are appended to the edit denies', () => {
    expect(evaluate(p, 'edit', `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1/sub/openapi.yaml`)).toBe('deny');
    expect(evaluate(p, 'edit', `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1/sub/other.yaml`)).toBe('allow');
  });
  it('the profile still contains no ask, with every input populated', () => {
    walk(renderRunConfig({ ...input, safety: { ...safety, skillRoots: [`${HOME}/.config/opencode/skills`], disabledSkills: ['x'] } }), (v, path) => {
      if (v === 'ask') throw new Error(`ask at ${path}`);
    });
  });
});

describe('SafetyInputs: skill roots and the ~/.config/opencode/skills carve-out (AD6)', () => {
  const SKILLS = `${HOME}/.config/opencode/skills`;
  const safety = { ...emptySafety(WORKSPACE), skillRoots: [SKILLS, `${HOME}/.agents/skills`, `${HOME}/.ssh/skills`, '/', HOME, `${HOME}/.config`, 'relative/skills', `${HOME}/a/../.ssh`] };
  const p = renderRunConfig({ ...input, safety }).configContent.permissions;
  const ev = (action: string, resource: string) => evaluate(p, action, resource);

  it('read/grep/glob and external_directory allow exactly the skills subtree', () => {
    for (const action of ['read', 'grep', 'glob']) {
      for (const r of [SKILLS, `${SKILLS}/x`, `${SKILLS}/x/SKILL.md`, `${SKILLS}/x/y/z.md`]) expect(ev(action, r), `${action} ${r}`).toBe('allow');
    }
    expect(ev('external_directory', `${SKILLS}/x/SKILL.md`)).toBe('allow');
  });
  it('opencode.json, service.json and the rest of the config dir stay denied in every form', () => {
    for (const action of ['read', 'grep', 'glob']) {
      for (const f of ['opencode.json', 'service.json', 'auth.json', 'skills-evil/x', 'skillsx', 'skills/../opencode.json', 'skills/x/../../service.json', 'skills/..']) {
        expect(ev(action, `${HOME}/.config/opencode/${f}`), `${action} ${f}`).toBe('deny');
      }
      expect(ev(action, `${HOME}/.config/opencode`), action).toBe('deny');
    }
    expect(ev('external_directory', `${HOME}/.config/opencode/opencode.json`)).toBe('deny');
  });
  it('`.env` files inside the skills dir stay denied; shell access to the subtree stays blocked', () => {
    expect(ev('read', `${SKILLS}/x/.env`)).toBe('deny');
    expect(ev('read', `${SKILLS}/x/.env.local`)).toBe('deny');
    expect(ev('read', `${SKILLS}/.env`)).toBe('deny');
  });
  it('the carve-out does not shadow the .env examples elsewhere (they stay readable, the real .env files stay denied)', () => {
    for (const f of ['.env.example', '.env.defaults', '.env.sample', '.env.template', '.env.dist', '.env.cursor.example']) {
      expect(ev('read', `${WORKSPACE}/repo-a/${f}`), f).toBe('allow');
      expect(ev('read', `${HOME}/other/${f}`), f).toBe('allow');
    }
    for (const f of ['.env', '.env.local', '.env.production']) expect(ev('read', `${WORKSPACE}/repo-a/${f}`), f).toBe('deny');
    for (const h of ['~', '$HOME', '${HOME}', HOME]) {
      expect(ev('shell', `cat ${h}/.config/opencode/skills/x/SKILL.md`), h).toBe('deny');
      expect(ev('shell', `cat ${h}/.config/opencode/opencode.json`), h).toBe('deny');
    }
  });
  it('is only active when the skills dir is a skill root', () => {
    const none = renderRunConfig({ ...input, safety: { ...emptySafety(WORKSPACE), skillRoots: [`${HOME}/.agents/skills`] } }).configContent.permissions;
    expect(evaluate(none, 'read', `${SKILLS}/x/SKILL.md`)).toBe('deny');
    expect(evaluate(none, 'external_directory', `${SKILLS}/x/SKILL.md`)).toBe('deny');
    expect(evaluate(none, 'external_directory', `${HOME}/.agents/skills/x`)).toBe('allow');
  });
  it('drops roots that are unsafe: inside another secret location, `/`, $HOME or an ancestor, relative or with `..`', () => {
    expect(skillRootAccess(HOME, safety.skillRoots, secretHomePaths()).external).toEqual([SKILLS, `${HOME}/.agents/skills`]);
    expect(ev('external_directory', `${HOME}/.ssh/skills/x`)).toBe('deny');
    expect(ev('external_directory', `${HOME}/.config/x`)).toBe('deny');
    expect(ev('read', `${HOME}/.ssh/skills/x`)).toBe('deny');
  });
  it('a deny.secretPaths entry that overlaps the skills dir switches the carve-out off for that root (the explicit deny wins); the config files stay denied', () => {
    for (const secret of ['.config/opencode/skills', '.config/opencode/skills/private']) {
      const q = renderRunConfig({ ...input, safety: { ...safety, deny: { ...safety.deny, secretPaths: [secret] } } }).configContent.permissions;
      for (const r of [`${SKILLS}/x/SKILL.md`, `${SKILLS}/private/x`]) expect(evaluate(q, 'read', r), `${secret}: ${r}`).toBe('deny');
      expect(evaluate(q, 'read', `${HOME}/.config/opencode/opencode.json`)).toBe('deny');
      expect(evaluate(q, 'external_directory', `${SKILLS}/x/SKILL.md`), secret).toBe('deny');
    }
  });
});

describe('workspace boundary (AD11)', () => {
  const p = renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions;

  it('edits and external directories outside the workspace root are denied, including a sibling that has the root as a prefix', () => {
    for (const r of [`${WORKSPACE}-evil/x`, `${WORKSPACE}-evil/repo/.worktrees/${SLUG}/x`, `${WORKSPACE}x/y`, `${HOME}/other/x`, '/etc/hosts']) {
      expect(evaluate(p, 'edit', r), `edit ${r}`).toBe('deny');
      expect(evaluate(p, 'external_directory', r), `external_directory ${r}`).toBe('deny');
    }
    expect(evaluate(p, 'external_directory', `${WORKSPACE}/repo-a/x`)).toBe('allow');
    expect(evaluate(p, 'edit', `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1/a.ts`)).toBe('allow');
  });
  it('the sandbox write boundary is a subpath (a sibling named like the root is outside) and the guard roots are slug-scoped', () => {
    const sb = renderSandboxProfile({ home: HOME, workspaceRoot: WORKSPACE, tmpDir: TMP, xdgDataHome: xdgDataHome(SLUG, HOME), port: 1234, safety: emptySafety(WORKSPACE) });
    expect(sb).toContain(`(subpath "${WORKSPACE}")`);
    expect(sb).not.toContain(`${WORKSPACE}-`);
    expect(sb).not.toMatch(/\(regex[^)]*work/);
    const roots = buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: input.safety }).NIGHTGEM_ALLOWED_WRITE_ROOTS!.split(':');
    expect(roots).toEqual([`${WORKSPACE}/*/.worktrees/${SLUG}`, `${WORKSPACE}/.specs/${SLUG}`, TMP]);
  });
  it('a safety.workspaceRoot that differs from workspaceRoot is refused by every renderer (a trailing slash is fine)', () => {
    const other = emptySafety('/Users/alice/elsewhere');
    expect(() => renderRunConfig({ ...input, safety: other })).toThrow(/does not match workspaceRoot/);
    expect(() => buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: other })).toThrow(/does not match workspaceRoot/);
    expect(() => renderSandboxProfile({ home: HOME, workspaceRoot: WORKSPACE, tmpDir: TMP, xdgDataHome: 'x', port: 1234, safety: other })).toThrow(/does not match workspaceRoot/);
    expect(() => renderRunConfig({ ...input, safety: emptySafety(`${WORKSPACE}/`) })).not.toThrow();
  });
});

describe('SafetyInputs: sandbox and guard env', () => {
  const safety = { ...emptySafety(WORKSPACE), deny: { commands: ['deploytool'], shellPatterns: ['*a:b*'], secretPaths: ['.corp/token', '.config/opencode/extra', '.npmrc', '.config', 'Library/Application Support'], editPaths: ['**/gen/**'] }, skillRoots: [`${HOME}/.agents/skills`] };

  it('sandbox: deny.secretPaths are added to the file-read* denies, except what the server tree needs', () => {
    const sb = renderSandboxProfile({ home: HOME, workspaceRoot: WORKSPACE, tmpDir: TMP, xdgDataHome: xdgDataHome(SLUG, HOME), port: 1234, safety });
    expect(sb).toContain(`(subpath "${HOME}/.corp/token")`);
    for (const exempt of ['.config/opencode/extra', '.npmrc', '.config"', 'Library/Application Support"']) expect(sb, exempt).not.toContain(`${HOME}/${exempt}`);
    expect(sandboxReadDenies({ home: HOME, safety })).toHaveLength(sandboxReadDenies({ home: HOME }).length + 1);
    // skill roots need no sandbox rule: nothing denies reads below them
    expect(sb).not.toContain('.agents/skills');
  });
  it('buildGuardEnv: NIGHTGEM_SAFETY carries the skill roots and normalised deny lists; configFromEnv reads it back', () => {
    const env = buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety });
    const cfg = configFromEnv(env);
    expect(cfg.safety).toEqual({ skillRoots: [`${HOME}/.agents/skills`], deny: safety.deny });
    expect(cfg.safetyInvalid).toBeUndefined();
    expect(JSON.parse(env.NIGHTGEM_SAFETY!)).toEqual(cfg.safety);
    expect(configFromEnv({ NIGHTGEM_CONTROL_DIR: 'c' }).safety).toBeUndefined();
  });
  it('configFromEnv flags a malformed NIGHTGEM_SAFETY (the guard then blocks everything)', () => {
    for (const bad of ['not json', '{}', '{"skillRoots":[1],"deny":{}}', '{"skillRoots":[],"deny":{"commands":[],"shellPatterns":[],"secretPaths":[]}}', 'null']) {
      const cfg = configFromEnv({ NIGHTGEM_CONTROL_DIR: 'c', NIGHTGEM_SAFETY: bad });
      expect(cfg.safetyInvalid, bad).toBe(true);
      expect(cfg.safety).toBeUndefined();
    }
  });
  it('buildGuardEnv rejects invalid entries instead of passing them on', () => {
    expect(() => buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: { ...safety, deny: { ...safety.deny, commands: ['a b'] } } })).toThrow(/deny\.commands/);
    expect(() => buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety: { ...safety, deny: { ...safety.deny, secretPaths: ['/abs'] } } })).toThrow(/deny\.secretPaths/);
  });
});

describe('normalisation of the deny lists (one place: normalizeDeny)', () => {
  const safety = {
    ...emptySafety(WORKSPACE),
    deny: { commands: ['a-cli', 'a-cli'], shellPatterns: ['internal-sync', '*glob*', 'zap ?', '  '], secretPaths: ['~/.corp/token/', '.corp/token'], editPaths: ['vendored/**', '**/gen/**', '/abs/dir/**', '*.lock', '  '] },
  };
  it('relative edit globs get `**/`, wildcard-free shell patterns get `*p*`, blanks and duplicates go', () => {
    expect(normalizeEditPath('vendored/**')).toBe('**/vendored/**');
    expect(normalizeEditPath('**/gen/**')).toBe('**/gen/**');
    expect(normalizeEditPath('/abs/x')).toBe('/abs/x');
    expect(normalizeEditPath('*.lock')).toBe('*.lock');
    expect(normalizeShellPattern('internal-sync')).toBe('*internal-sync*');
    expect(normalizeShellPattern('zap ?')).toBe('zap ?');
    expect(normalizeDeny(safety.deny)).toEqual({
      commands: ['a-cli'],
      shellPatterns: ['*internal-sync*', '*glob*', 'zap ?'],
      secretPaths: ['.corp/token'],
      editPaths: ['**/vendored/**', '**/gen/**', '/abs/dir/**', '*.lock'],
    });
  });
  it('the profile and the guard payload use the same normalised lists', () => {
    const p = renderRunConfig({ ...input, safety }).configContent.permissions;
    const wt = `${WORKSPACE}/repo-a/.worktrees/${SLUG}/T1`;
    expect(evaluate(p, 'edit', `${wt}/vendored/a.ts`)).toBe('deny'); // used to be ignored: a relative glob never matched an absolute path
    expect(evaluate(p, 'edit', `${wt}/src/myvendored/a.ts`)).toBe('allow');
    expect(evaluate(p, 'shell', 'run internal-sync now')).toBe('deny');
    expect(shellDenyPatterns(HOME, safety)).toContain('*internal-sync*');
    expect(guardSafetyPayload(safety).deny).toEqual(normalizeDeny(safety.deny));
    expect(configFromEnv(buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: 'c', tmpDir: TMP, safety })).safety!.deny.editPaths).toContain('**/vendored/**');
  });
});

describe('config-level skill denies (`skill` action)', () => {
  const safety = { ...emptySafety(WORKSPACE), disabledSkills: ['skill-a', ' skill-b ', 'skill-a', ''] };
  const p = renderRunConfig({ ...input, safety }).configContent.permissions;
  it('emits one `skill <name> deny` rule per distinct disabled skill, matching the slim list', () => {
    expect(p.filter((r) => r.action === 'skill')).toEqual([
      { action: 'skill', resource: 'skill-a', effect: 'deny' },
      { action: 'skill', resource: 'skill-b', effect: 'deny' },
    ]);
    expect(renderRunConfig({ ...input, safety }).slimOverrides.disabled_skills).toEqual(['skill-a', 'skill-b']);
    expect(evaluate(p, 'skill', 'skill-a')).toBe('deny');
    expect(evaluate(p, 'skill', 'skill-c')).toBe('allow');
    expect(renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions.filter((r) => r.action === 'skill')).toEqual([]);
  });
});

describe('MCP servers of the global config (mcpServerNames)', () => {
  const names = ['github', 'my-tracker', 'Corp.Wiki'];
  const rc = renderRunConfig({ ...input, mcpServerNames: names });
  const p = rc.configContent.permissions;

  it('puts every name into slim disabled_mcps and denies its tools (`<server>_<tool>`), and nothing else', () => {
    expect(rc.slimOverrides.disabled_mcps).toEqual(names);
    for (const tool of ['github_create_pull_request', 'my-tracker_create_issue', 'Corp_Wiki_search']) expect(evaluate(p, tool, '*'), tool).toBe('deny');
    for (const tool of ['read', 'shell', 'github', 'githubx_list', 'other_tool']) expect(evaluate(p, tool, '*'), tool).toBe('allow');
    expect(p.filter((r) => r.action.endsWith('_*') && !(TOOL_DENIES as readonly string[]).includes(r.action)).map((r) => r.action)).toEqual(['github_*', 'my-tracker_*', 'Corp_Wiki_*']);
  });
  it('switches each server off in the config: an inert, disabled stand-in per name and no other key of the user\'s definition', () => {
    expect(rc.configContent.mcp).toEqual({
      servers: Object.fromEntries(names.map((n) => [n, { type: 'local', command: [INERT_MCP_COMMAND], disabled: true }])),
    });
    // the readable run copy carries the same entries; the JSON has nothing of a real definition
    expect(rc.readableCopy.mcp).toEqual(rc.configContent.mcp);
    const json = rc.configContentJson;
    for (const key of ['url', 'headers', 'environment', 'args', 'oauth', 'token']) expect(json, key).not.toContain(`"${key}"`);
    expect(JSON.parse(json).mcp.servers['github']).toEqual({ type: 'local', command: ['/usr/bin/false'], disabled: true });
  });
  it('writes no mcp key when there are no servers', () => {
    expect(renderRunConfig(input).configContent.mcp).toBeUndefined();
    expect(renderRunConfig(input).configContentJson).not.toContain('"mcp"');
  });
  it('is empty by default, deduplicates, and never hard-codes a server name', () => {
    expect(renderRunConfig(input).slimOverrides.disabled_mcps).toEqual([]);
    expect(renderRunConfig({ ...input, mcpServerNames: ['a', 'a'] }).slimOverrides.disabled_mcps).toEqual(['a']);
    expect(TOOL_DENIES.some((t) => /atlassian/.test(t))).toBe(false);
    expect(renderRunConfig(input).configContentJson).not.toMatch(/atlassian/);
  });
  it('rejects names that are not plain (they would be spelled into a glob)', () => {
    for (const bad of ['', 'a*', 'a/b', '*', 'a_*', '-x', 'a;b']) expect(() => renderRunConfig({ ...input, mcpServerNames: [bad] }), bad).toThrow(/mcpServerNames/);
  });
  it('the profile still has no ask', () => {
    walk(rc, (v, path) => {
      if (v === 'ask') throw new Error(`ask at ${path}`);
    });
  });
});

describe('sync between the layers (the lists live in three places: profile, guard, sandbox)', () => {
  const generic = renderRunConfig({ ...input, safety: emptySafety(WORKSPACE) }).configContent.permissions;
  const sh = (cmd: string) => evaluate(generic, 'shell', cmd);

  it('every generic default command of the profile is a guard command, and the other way round: each guard command is denied by the profile', () => {
    const profileAnywhere = [...DEFAULT_DENIED_COMMANDS, ...DEFAULT_DENIED_TRACKER_BINARIES];
    for (const c of profileAnywhere) expect(DENIED_COMMANDS, `guard lacks ${c}`).toContain(c);
    for (const c of DENIED_COMMANDS) {
      for (const cmd of [c, `${c} x`, `env ${c} x`, `cd a && ${c} x`, `/usr/local/bin/${c} x`]) expect(sh(cmd), `profile lets through "${cmd}" (guard denies ${c})`).toBe('deny');
    }
  });
  it('the command-position CLIs (jira, linear) are the same set in the profile and the guard', () => {
    expect([...DEFAULT_DENIED_COMMAND_HEADS].sort()).toEqual([...DENIED_HEADS].sort());
    for (const c of DENIED_HEADS) expect(sh(`${c} issue list`)).toBe('deny');
  });
  it('the sandbox read denies are exactly SECRET_HOME_PATHS minus the paths the server tree needs (plus whole ~/.docker)', () => {
    const denies = sandboxReadDenies({ home: HOME });
    const covered = (rel: string) => denies.some((d) => `${HOME}/${rel}` === d.path || `${HOME}/${rel}`.startsWith(`${d.path}/`));
    for (const rel of SECRET_HOME_PATHS) {
      const exempt = SANDBOX_READ_EXEMPT.some((e) => rel === e || rel.startsWith(`${e}/`));
      expect(covered(rel), `${rel}: ${exempt ? 'exempt paths must NOT be denied' : 'must be denied in the sandbox'}`).toBe(!exempt);
    }
    // nothing in the sandbox list is outside the secret locations (besides the whole .docker dir)
    for (const d of denies) {
      const rel = d.path.slice(HOME.length + 1);
      expect(SECRET_HOME_PATHS.some((s) => s === rel || s.startsWith(`${rel}/`)), `${rel} is not a secret location`).toBe(true);
    }
  });
});

describe('git-ssh-fetch-only.sh env names', () => {
  it('the script reads the same variables the TS side sets', () => {
    const script = readFileSync(new URL('../profile/git-ssh-fetch-only.sh', import.meta.url), 'utf8');
    expect(script).toContain(`\${${SSH_LOG_ENV}:-`);
    expect(script).toContain(`\${${SSH_REAL_ENV}:-`);
    expect(SSH_LOG_ENV).toBe('NIGHTGEM_SSH_LOG');
    expect(SSH_REAL_ENV).toBe('NIGHTGEM_SSH_REAL');
  });
  it('buildSafetyEnv sets the log variable under that name', () => {
    const env = buildSafetyEnv({ sshWrapper: '/abs/git-ssh-fetch-only.sh', sshLog: '/log' });
    expect(env[SSH_LOG_ENV]).toBe('/log');
  });
});
