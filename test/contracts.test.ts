import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentInfo,
  ControlFlags,
  CostLine,
  Decision,
  isExecutionTerminal,
  isTerminalRunState,
  ModelRef,
  parseModelRef,
  PermissionRepliedData,
  PermissionRequest,
  RunComplete,
  ManifestUpgradeError,
  parseRunManifest,
  RunContextSnapshot,
  RunManifest,
  RunManifestV1,
  SafetyInputs,
  SkillDetection,
  SkillEntry,
  ServerEvent,
  SessionCreatedData,
  SessionInfo,
  SessionUsageData,
  TaskEvent,
  type RunApi,
} from '../src/contracts.ts';
import { RECORDED_FIXTURES, REPO_ROOT } from './fixtures/paths.ts';

const FIXTURES = join(REPO_ROOT, RECORDED_FIXTURES);
const json = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const jsonl = (name: string): any[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const minimalManifest = {
  schemaVersion: 2,
  workspaceRoot: '/w',
  slug: 'my-run',
  budgetUsd: 100,
  state: 'launching',
  phase: 'plan',
  launchdLabel: 'dev.acme.nightgem.my-run',
  controlDir: '/c',
  runDir: '/r',
  xdgDataHome: '/x',
  model: 'anthropic/claude-opus-5-5',
  createdAt: '2026-10-21T10:00:00.000Z',
};

describe('RunManifest', () => {
  it('applies defaults', () => {
    const m = RunManifest.parse(minimalManifest);
    expect(m.softPct).toBe(0.85);
    expect(m.hardPct).toBe(1);
    expect(m.costMultiplier).toBe(1);
    expect(m.nudges).toBe(0);
    expect(m.rootSessions).toEqual([]);
    expect(m.knownSessionIds).toEqual([]);
    expect(m.repos).toEqual([]);
    expect(m.worktrees).toEqual([]);
    expect(m.defects).toEqual([]);
    expect(m.costUsd).toBe(0);
    expect(m.costEstimatedUsd).toBe(0);
  });

  it('round-trips a full manifest', () => {
    const full = RunManifest.parse({
      ...minimalManifest,
      state: 'running',
      phase: 'build',
      pid: 123,
      serverUrl: 'http://127.0.0.1:4097',
      port: 4097,
      opencodeVersion: '2.0.29',
      slimVersion: '3.0.4',
      rootSessions: [{ phase: 'plan', sessionId: 'ses_a', costUsd: 1.5 }],
      knownSessionIds: ['ses_a', 'ses_b'],
      costUsd: 2.5,
      costEstimatedUsd: 0.1,
      repos: [
        {
          name: 'acme-api',
          path: '/r/acme-api',
          defaultBranch: 'master',
          baseline: { head: 'abc', branch: 'master', porcelainHash: 'h', stashCount: 0 },
        },
      ],
      worktrees: [{ repo: 'acme-api', path: '/w', branch: 'feat/x', task: 't1' }],
      startedAt: '2026-10-21T10:01:00.000Z',
      stopReason: 'budget',
      nudges: 2,
      defects: [{ ts: 't', kind: 'permission.asked', message: 'auto-rejected' }],
    });
    expect(RunManifest.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(full.worktrees[0]?.kind).toBe('task');
  });

  it('rejects a bad state, phase and schema version', () => {
    expect(() => RunManifest.parse({ ...minimalManifest, state: 'done' })).toThrow();
    expect(() => RunManifest.parse({ ...minimalManifest, phase: 'ship' })).toThrow();
    expect(() => RunManifest.parse({ ...minimalManifest, schemaVersion: 3 })).toThrow();
    expect(() => RunManifest.parse({ ...minimalManifest, schemaVersion: 1 })).toThrow();
    expect(() => RunManifest.parse({ ...minimalManifest, workspaceRoot: undefined })).toThrow();
    expect(() => RunManifest.parse({ ...minimalManifest, budgetUsd: 0 })).toThrow();
  });

  it('accepts every documented state and flags terminal ones', () => {
    for (const s of ['launching', 'running', 'winding-down', 'stopping', 'completed', 'failed', 'stalled', 'aborted-budget', 'stopped']) {
      expect(RunManifest.parse({ ...minimalManifest, state: s }).state).toBe(s);
    }
    expect(isTerminalRunState('completed')).toBe(true);
    expect(isTerminalRunState('running')).toBe(false);
    expect(isTerminalRunState('winding-down')).toBe(false);
  });
});

describe('jsonl line schemas', () => {
  it('CostLine round-trips and defaults', () => {
    const line = CostLine.parse({
      ts: 't',
      sessionId: 'ses_a',
      phase: 'build',
      costUsd: 0.5,
      source: 'session-info',
      totalUsd: 1,
    });
    expect(line.parentId).toBeNull();
    expect(line.estimated).toBe(false);
    expect(CostLine.parse(JSON.parse(JSON.stringify(line)))).toEqual(line);
    expect(() => CostLine.parse({ ...line, source: 'message-sum' })).toThrow();
  });

  it('TaskEvent round-trips, defaults and rejects bad state', () => {
    const ev = TaskEvent.parse({
      ts: 't',
      id: 't1',
      repo: 'acme-api',
      branch: 'feat/x-t1',
      worktree: '/w',
      state: 'verifying',
      phase: 'build',
      verify: [{ cmd: 'npm test', exit: 0 }],
    });
    expect(ev.attempt).toBe(0);
    expect(TaskEvent.parse(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
    expect(() => TaskEvent.parse({ ...ev, state: 'finished' })).toThrow();
    expect(TaskEvent.parse({ ...ev, verify: undefined }).verify).toEqual([]);
  });

  it('Decision defaults needsHumanAttention and rejects bad kind', () => {
    const d = Decision.parse({ ts: 't', id: 'd1', kind: 'dependency', summary: 's', rationale: 'r' });
    expect(d.needsHumanAttention).toBe(false);
    expect(d.oracleApproved).toBeUndefined();
    expect(() => Decision.parse({ ...d, kind: 'whim' })).toThrow();
  });

  it('ControlFlags defaults and RunComplete', () => {
    expect(ControlFlags.parse({})).toEqual({ softStop: false, hardStop: false, heartbeatTs: 0 });
    const rc = RunComplete.parse({ ts: 't', summary: 'done', finalReviewPath: '/x/REVIEW.md' });
    expect(rc.type).toBe('run.complete');
    expect(() => RunComplete.parse({ ts: 't', summary: 'done' })).toThrow();
  });
});

describe('server shapes against recorded fixtures', () => {
  it('parses Session.Info from session.get / session.create', () => {
    for (const f of ['session.get.json', 'session.create.json']) {
      const info = SessionInfo.parse(json(f).body.data);
      expect(info.id).toMatch(/^ses_/);
      expect(info.location.directory).toContain('.run');
      expect(typeof info.cost).toBe('number');
    }
    const got = SessionInfo.parse(json('session.get.json').body.data);
    expect(got.cost).toBeCloseTo(0.00267965);
    expect(got.outcome).toBe('succeeded');
    expect((got as any).projectID).toBeDefined(); // unknown/extra fields survive
  });

  it('parses every recorded SSE event envelope', () => {
    let n = 0;
    for (const f of ['events-s1-s.jsonl', 'events-s2-s.jsonl', 'events-s4-deleg.jsonl', 'events-s5.jsonl', 'events-s7.jsonl']) {
      for (const raw of jsonl(f)) {
        const ev = ServerEvent.parse(raw);
        expect(ev.type).toBe(raw.type);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('parses typed event payloads', () => {
    const all = ['events-s1-s.jsonl', 'events-s2-s.jsonl', 'events-s4-deleg.jsonl', 'events-s7.jsonl'].flatMap(jsonl);
    const byType = (t: string) => all.filter((e) => e.type === t);

    const created = byType('session.created').map((e) => SessionCreatedData.parse(e.data));
    expect(created.some((c) => c.parentID)).toBe(true); // delegated child has parentID
    expect(created[0]?.model?.providerID ?? 'anthropic').toBe('anthropic');

    const usage = byType('session.usage.updated').map((e) => SessionUsageData.parse(e.data));
    expect(usage.length).toBeGreaterThan(0);

    expect(byType('permission.asked').map((e) => PermissionRequest.parse(e.data)).length).toBeGreaterThan(0);
    expect(byType('permission.replied').map((e) => PermissionRepliedData.parse(e.data))[0]?.reply).toBe('reject');

    expect(isExecutionTerminal('session.execution.succeeded')).toBe(true);
    expect(isExecutionTerminal('session.execution.interrupted')).toBe(true);
    expect(isExecutionTerminal('session.execution.started')).toBe(false);
    expect(byType('session.execution.succeeded').length).toBeGreaterThan(0);
  });

  it('parses pending permission lists', () => {
    const pending = json('permission.pending.json');
    const global = pending.global.data.map((p: unknown) => PermissionRequest.parse(p));
    expect(global[0]?.action).toBe('shell');
    expect(global[0]?.resources).toEqual(['echo hello-from-spike']);
    const shell = json('permission.asked.shell-resources.json');
    expect(shell.map((p: unknown) => PermissionRequest.parse(p)).length).toBeGreaterThan(1);
  });

  it('parses an agent with an ordered permission list', () => {
    const a = AgentInfo.parse({
      id: 'fixer',
      mode: 'subagent',
      permissions: [
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'shell', resource: 'git push*', effect: 'deny' },
      ],
    });
    expect(a.permissions).toHaveLength(2);
    expect(() => AgentInfo.parse({ id: 'x', permissions: [{ action: 'a', resource: 'b', effect: 'maybe' }] })).toThrow();
  });

  it('parseModelRef splits provider and model id', () => {
    expect(parseModelRef('anthropic/claude-opus-5-5')).toEqual({ providerID: 'anthropic', id: 'claude-opus-5-5' });
    expect(ModelRef.parse(parseModelRef('amazon-bedrock/eu.anthropic/x'))).toMatchObject({ providerID: 'amazon-bedrock', id: 'eu.anthropic/x' });
    expect(() => parseModelRef('nomodel')).toThrow();
    expect(() => parseModelRef('/x')).toThrow();
  });
});

describe('RunApi', () => {
  it('is implementable as a plain object (compile-time seam check)', async () => {
    const api: RunApi = {
      listAgents: async () => [],
      evalPermission: async () => 'deny',
      createSession: async () => SessionInfo.parse(json('session.create.json').body.data),
      prompt: async () => {},
      interrupt: async () => false,
      getSession: async () => SessionInfo.parse(json('session.get.json').body.data),
      listSessions: async () => [],
      listPendingPermissions: async () => [],
      replyPermission: async () => {},
      async *events() {
        yield ServerEvent.parse({ type: 'server.connected', data: {} });
      },
    };
    const seen: string[] = [];
    for await (const ev of api.events()) seen.push(ev.type);
    expect(seen).toEqual(['server.connected']);
    expect(await api.evalPermission({ sessionId: 's', action: 'shell', resources: ['git push'], agent: 'fixer' })).toBe('deny');
  });
});

describe('parseRunManifest', () => {
  const v1 = (): Record<string, unknown> => JSON.parse(readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'manifest-v1.json'), 'utf8'));

  it('upgrades the scrubbed v1 fixture to v2', () => {
    const raw = v1();
    expect(RunManifestV1.parse(raw).schemaVersion).toBe(1);
    const m = parseRunManifest(raw);
    expect(m.schemaVersion).toBe(2);
    expect(m.workspaceRoot).toBe('/Users/alice/work');
    // everything else is carried over untouched, including the legacy launchd label
    expect(m.launchdLabel).toBe('com.example.nightgem.demo');
    expect(m.slug).toBe('demo');
    expect(m.runDir).toBe('/Users/alice/work/.specs/demo/.run');
    expect(m.repos.map((r) => r.name)).toEqual(['acme-api', 'acme-web']);
    expect(m.worktrees).toHaveLength(1);
    expect(m.profile).toBeUndefined();
    expect(m.skills).toBeUndefined();
    expect(m.instructions).toBeUndefined();
    // the result is a valid v2 manifest
    expect(RunManifest.parse(m)).toEqual(m);
  });

  it('round-trips v2 with profile, skills and instructions', () => {
    const v2 = RunManifest.parse({
      ...minimalManifest,
      profile: { path: '/home/u/profile.jsonc', sha256: 'abc' },
      skills: {
        available: [{ name: 'spec-driven-development', root: '/s', path: '/s/spec-driven-development' }],
        excluded: [{ name: 'x-one', path: '/s/x-one', reason: 'matched exclude "x-*"' }],
        required: ['spec-driven-development'],
      },
      instructions: { path: '/home/u/instructions.md', sha256: 'def' },
    });
    expect(parseRunManifest(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
  });

  it('throws for a v1 runDir that is not <ws>/.specs/<slug>/.run', () => {
    const bad = { ...v1(), runDir: '/Users/alice/work/specs/demo/.run' };
    expect(() => parseRunManifest(bad)).toThrow(ManifestUpgradeError);
    expect(() => parseRunManifest({ ...v1(), runDir: '/Users/alice/work/.specs/other/.run' })).toThrow(ManifestUpgradeError);
    expect(() => parseRunManifest({ ...v1(), runDir: '/r' })).toThrow(ManifestUpgradeError);
  });

  it('upgrade guard: relative runDir, slug mismatch and a missing .specs segment throw; an absolute path upgrades', () => {
    for (const runDir of ['rel/.specs/demo/.run', '/x/.specs/other/.run', '/x/specs/demo/.run', '/x/.specs/demo/notrun']) {
      expect(() => parseRunManifest({ ...v1(), runDir }), runDir).toThrow(ManifestUpgradeError);
    }
    const m = parseRunManifest({ ...v1(), runDir: '/x/.specs/demo/.run' });
    expect(m.workspaceRoot).toBe('/x');
  });

  it('rejects unknown versions and malformed content', () => {
    expect(() => parseRunManifest({ ...minimalManifest, schemaVersion: 3 })).toThrow();
    expect(() => parseRunManifest({ schemaVersion: 1 })).toThrow();
    expect(() => parseRunManifest(null)).toThrow();
    expect(() => parseRunManifest('x')).toThrow();
  });
});

describe('run context contracts', () => {
  const safety = {
    workspaceRoot: '/w',
    skillRoots: ['/s'],
    disabledSkills: ['x-one'],
    deny: { commands: ['gh'], shellPatterns: [], secretPaths: ['.aws'], editPaths: ['**/generated/**'] },
  };

  it('parses SafetyInputs and rejects a missing deny block', () => {
    expect(SafetyInputs.parse(safety)).toEqual(safety);
    expect(() => SafetyInputs.parse({ ...safety, deny: undefined })).toThrow();
  });

  it('SkillEntry and SkillDetection (defaults to empty)', () => {
    expect(SkillEntry.parse({ name: 'a', root: '/r', path: '/r/a' }).name).toBe('a');
    expect(SkillDetection.parse({})).toEqual({
      available: [],
      excluded: [],
      missingRequired: [],
      collisions: [],
      roots: [],
      excludedRequired: [],
      rootRejected: [],
      outsideRoots: [],
    });
  });

  it('SkillDetection keeps excludedRequired, rootRejected and outsideRoots through the snapshot parse', () => {
    const skills = {
      excludedRequired: ['planner'],
      rootRejected: [{ root: '/Users/alice/skills', reasons: ['not a directory', 'outside the workspace'] }],
      outsideRoots: ['/Users/alice/elsewhere/skill-a'],
    };
    expect(SkillDetection.parse(skills)).toMatchObject(skills);
    expect(() => SkillDetection.parse({ rootRejected: [{ root: '/r' }] })).toThrow();
    const snap = {
      version: 1,
      workspaceRoot: '/w',
      model: 'anthropic/claude-opus-5-5',
      smallModel: 'anthropic/claude-haiku-5-5',
      profile: { path: '/p.jsonc', sha256: 'h', data: { version: 1, workspaceRoot: '/w' } },
      skills,
      instructions: { text: '', sha256: 'h2' },
      models: {},
      safety,
    };
    expect(RunContextSnapshot.parse(snap).skills).toMatchObject(skills);
  });

  it('RunContextSnapshot requires model and smallModel', () => {
    const snap = {
      version: 1,
      workspaceRoot: '/w',
      profile: { path: '/p.jsonc', sha256: 'h', data: { version: 1, workspaceRoot: '/w' } },
      skills: SkillDetection.parse({}),
      instructions: { text: '', sha256: 'h2' },
      models: {},
      safety,
    };
    expect(() => RunContextSnapshot.parse(snap)).toThrow();
    expect(() => RunContextSnapshot.parse({ ...snap, model: 'a/b' })).toThrow();
    expect(() => RunContextSnapshot.parse({ ...snap, model: 'a/b', smallModel: '' })).toThrow();
    expect(RunContextSnapshot.parse({ ...snap, model: 'a/b', smallModel: 'a/c' }).smallModel).toBe('a/c');
  });

  it('RunContextSnapshot round-trips', () => {
    const snap = {
      version: 1,
      workspaceRoot: '/w',
      model: 'anthropic/claude-opus-5-5',
      smallModel: 'anthropic/claude-haiku-5-5',
      profile: { path: '/p.jsonc', sha256: 'h', data: { version: 1, workspaceRoot: '/w' } },
      skills: SkillDetection.parse({}),
      instructions: { text: '', sha256: 'h2' },
      models: { orchestrator: { model: 'anthropic/claude-opus-5-5', variant: 'high' } },
      safety,
    };
    const parsed = RunContextSnapshot.parse(snap);
    expect(parsed.profile.data.skills.exclude).toEqual([]);
    expect(RunContextSnapshot.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});
