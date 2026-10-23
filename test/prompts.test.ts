import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Decision, RunComplete, TaskEvent } from '../src/contracts.ts';
import {
  PROMPTS_DIR,
  PROMPT_NAMES,
  listAppends,
  promptVars,
  renderPrompt,
  type PromptName,
  type PromptVars,
} from '../src/prompts.ts';

const VARS: PromptVars = {
  slug: 'demo-run',
  specsDir: '/Users/alice/work/.specs/demo-run',
  specMd: '/Users/alice/work/.specs/demo-run/SPEC.md',
  planMd: '/Users/alice/work/.specs/demo-run/PLAN.md',
  statusMd: '/Users/alice/work/.specs/demo-run/STATUS.md',
  decisionsMd: '/Users/alice/work/.specs/demo-run/DECISIONS.md',
  reportMd: '/Users/alice/work/.specs/demo-run/REPORT.md',
  tasksJsonl: '/Users/alice/work/.specs/demo-run/.run/tasks.jsonl',
  decisionsJsonl: '/Users/alice/work/.specs/demo-run/.run/decisions.jsonl',
  eventsDir: '/Users/alice/work/.specs/demo-run/.run',
  phase: 'build',
  nextTask: 'api-endpoint',
  reason: 'soft stop at 85%',
  costUsd: 85.2,
  budgetUsd: 100,
  workspaceRoot: '/Users/alice/work',
  workspaceInstructions: 'ACME-WS-INSTRUCTIONS: commits put the ticket in the body.',
  skillsList: '- test-driven-development\n- incremental-implementation\n- code-review-and-quality\n- planning-and-task-breakdown',
};

const render = (name: PromptName) => renderPrompt(name, VARS);

/** Terms the generic prompts must not carry (assembled from parts so this file stays clean too). */
const LEAK_TERMS = [
  ['hq', 'ui'].join('-'),
  ['hq', 'backend'].join('-'),
  ['Len', 'ses'].join(''),
  ['len', 'ses'].join(''),
  ['ht', 'docs'].join(''),
  ['HQ', 'BACKEND'].join('_'),
  ['pull', 'dtos'].join(':'),
  ['generate', 'dtos'].join(':'),
  ['PA', 'N-\\d'].join(''),
  ['K2', 'K-'].join(''),
  ['sbt', 'git'].join('-'),
  '\\bJira\\b',
  'Confluence',
  ['publish', 'ui'].join('-'),
  ['push', 'notif'].join('-'),
];
const LEAK_RE = new RegExp(LEAK_TERMS.join('|'));

describe('prompt registry', () => {
  it('has one template file per name, and every name is listed', () => {
    for (const name of PROMPT_NAMES) {
      expect(() => readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8')).not.toThrow();
    }
    expect(new Set(PROMPT_NAMES).size).toBe(PROMPT_NAMES.length);
  });

  it('listAppends returns the four *_append.md files', () => {
    const appends = listAppends();
    expect(appends.map((a) => a.fileName)).toEqual([
      'designer_append.md',
      'fixer_append.md',
      'oracle_append.md',
      'orchestrator_append.md',
    ]);
    for (const a of appends) expect(a.path.endsWith(a.fileName)).toBe(true);
  });

  it('promptVars reports placeholders without built-ins', () => {
    expect(promptVars('nudge')).toEqual(['nextTask', 'phase', 'slug', 'statusMd', 'tasksJsonl']);
    expect(promptVars('fixer_append')).toEqual(['skillsList', 'slug', 'workspaceInstructions', 'workspaceRoot']);
    expect(promptVars('designer_append')).toEqual(['skillsList', 'slug', 'workspaceInstructions', 'workspaceRoot']);
  });
});

describe('renderPrompt', () => {
  it.each(PROMPT_NAMES)('renders %s with no placeholder left over', (name) => {
    const out = render(name);
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(out.length).toBeGreaterThan(100);
  });

  it.each(PROMPT_NAMES)('throws when a var is missing for %s', (name) => {
    for (const v of promptVars(name)) {
      const { [v]: _omit, ...rest } = VARS;
      expect(() => renderPrompt(name, rest), `${name} without ${v}`).toThrow(new RegExp(`missing vars: .*${v}`));
    }
  });

  it('throws on an unknown prompt name', () => {
    expect(() => renderPrompt('nope', VARS)).toThrow(/Unknown prompt/);
  });

  it('fills run-context vars into the appends and the never-list partial', () => {
    for (const name of ['orchestrator_append', 'fixer_append', 'designer_append', 'oracle_append'] as const) {
      const out = render(name);
      expect(out).toContain('ACME-WS-INSTRUCTIONS: commits put the ticket in the body.');
      expect(out).toContain('## Workspace instructions');
    }
    expect(render('designer_append')).toContain('outside the workspace root (`/Users/alice/work`)');
  });

  it('does not re-scan substituted values for placeholders', () => {
    const out = renderPrompt('nudge', { ...VARS, nextTask: '{{slug}}' });
    expect(out).toContain('**{{slug}}**');
  });
});

describe('orchestrator_append', () => {
  const out = render('orchestrator_append');

  it('states autonomous mode and bans interactive tools', () => {
    expect(out).toContain('No human is present');
    for (const t of ['question', 'wait_for_user', 'interview', 'marketplace']) expect(out).toContain(t);
  });

  it('replaces the gates (no ship, risky-change approval)', () => {
    expect(out).toContain('Mandatory @oracle plan review');
    expect(out).toMatch(/never push/i);
    expect(out).toMatch(/touch the issue tracker/);
    expect(out).toContain('needsHumanAttention: true');
    expect(out).toContain('### Risky changes');
  });

  it('states the failure policy', () => {
    expect(out).toContain('## Failure policy');
    expect(out).toContain('3 fix-up attempts');
    expect(out).toMatch(/2nd/);
    expect(out).toContain('BLOCKED');
    expect(out).toContain('skipped');
    expect(out).toContain('independent lanes');
  });

  it('describes worktrees, integration branch and cross-repo flow', () => {
    expect(out).toContain('origin/<default-branch>');
    expect(out.replace(/\s+/g, ' ')).toContain('`origin` was fetched before the run started');
    expect(out).toContain('No `git fetch`.');
    expect(out).toContain('.worktrees/demo-run/<task>');
    expect(out).toContain('.worktrees/demo-run/_integration');
    expect(out).toContain('<type>/<TICKET|slug>-<task>');
    expect(out).toContain('## Cross-repo order');
    expect(out).toMatch(/cross-repo order and the generated-code flow in the workspace\s+instructions/);
    expect(out).toContain('under the workspace root (`/Users/alice/work`)');
  });

  it('carries no workspace-specific repo, tracker or command names', () => {
    for (const name of PROMPT_NAMES) {
      const out = render(name).replace(String(VARS.workspaceInstructions), '');
      expect(out, name).not.toMatch(LEAK_RE);
    }
  });

  it('has Workspace instructions and Available skills sections with the skill-use rule', () => {
    const out = render('orchestrator_append');
    expect(out).toMatch(/## Workspace instructions\n\nACME-WS-INSTRUCTIONS/);
    expect(out).toMatch(/## Available skills\n\n- test-driven-development/);
    expect(out).toContain('Load a listed skill with the skill tool when it matches the task. Never use a skill that is not listed.');
    expect(out).toContain('planning-and-task-breakdown');
  });

  it('has no instruction to fetch, and bases on origin as it is', () => {
    expect(out).not.toMatch(/git -C <repo> fetch origin/);
    expect(out).toMatch(/base directly on\s+`origin\/<default-branch>`/);
    expect(out).toMatch(/no `origin` ref, base on the local default branch/);
  });

  it('installs dependencies before verification, because Node resolves the main node_modules otherwise', () => {
    expect(out).toMatch(/BEFORE any verification|before any verification/);
    expect(out).toContain('npm ci');
    expect(out).toMatch(/AGENTS.md or CLAUDE.md says/);
    expect(out).toMatch(/main checkout's `node_modules`/);
  });

  it('requires explicit shell timeouts, capped at 1080000 ms', () => {
    expect(out).toContain('timeout');
    expect(out).toContain('120 s');
    expect(out).toMatch(/900000 to 1080000/);
    expect(out).toMatch(/Never exceed 1080000/);
    expect(out).toContain('--outputStyle=stream');
    expect(out).toContain('CI=1');
    expect(out).toMatch(/project-scoped/);
    expect(out).toMatch(/only in the `_integration`/);
    expect(out).toMatch(/40 minutes/);
  });

  it('logs JSONL through a quoted heredoc or the write tool, never echo', () => {
    expect(out).toContain(`cat >> ${VARS.tasksJsonl} <<'EOF'`);
    expect(out).toMatch(/write tool/);
    expect(out).toMatch(/Never\*\* build a line with `echo/);
    expect(out).toContain('Heredocs and bare `mktemp` work in runs');
  });

  it('keeps task ids free of push, gh and ssh, and says soft stop allows only oracle', () => {
    expect(out).toMatch(/standalone words `push`, `gh` or `ssh`/);
    expect(out).toContain('release-web');
    expect(out).toMatch(/@oracle only/);
  });

  it('covers verification, delegation, budget and phases', () => {
    expect(out).toMatch(/no watch mode/);
    expect(out).toMatch(/No two writers may share files/);
    expect(out).toMatch(/45 minutes/);
    expect(out).toMatch(/wind-down message/);
    expect(out).toMatch(/obey it\s+immediately/);
    expect(out).toContain('separate root session');
    expect(out).toContain('"phase:<name>"');
  });

  it('points logging at the injected paths', () => {
    expect(out).toContain(VARS.tasksJsonl);
    expect(out).toContain(VARS.decisionsJsonl);
    expect(out).toContain(`${VARS.eventsDir}/run-complete.json`);
    expect(out).toContain(String(VARS.statusMd));
    expect(out).toContain(String(VARS.decisionsMd));
  });

  it('stays concise', () => {
    expect(out.split('\n').length).toBeLessThan(260);
  });
});

describe('never-list and subagent appends', () => {
  const never = readFileSync(join(PROMPTS_DIR, '_partials', 'never-list.md'), 'utf8')
    .trim()
    .replace('{{workspaceRoot}}', String(VARS.workspaceRoot));

  it.each(['orchestrator_append', 'fixer_append', 'designer_append', 'oracle_append'] as const)(
    '%s carries the never-list and autonomous mode',
    (name) => {
      const out = render(name);
      expect(out).toContain(never);
      expect(out).toContain('No human is present');
      expect(out).toMatch(/No `git push`/);
      expect(out).toContain('choose another approach and log it');
      expect(out).toMatch(/Never work around a denial/);
      expect(out).toMatch(/No hand edits of generated files/);
      expect(out).toContain('.env');
    },
  );

  it.each(['fixer_append', 'designer_append'] as const)('%s defines the evidence format', (name) => {
    const out = render(name);
    for (const h of ['Files changed:', 'Commits:', 'Verify:', 'Open risks:']) expect(out).toContain(h);
    expect(out).toContain('exit <code>');
    expect(out).toMatch(/Never push/);
  });

  it.each(['orchestrator_append', 'fixer_append', 'designer_append', 'oracle_append'] as const)(
    '%s carries the C4 never-list rules',
    (name) => {
      const out = render(name);
      expect(out).toContain('Never use `git stash`');
      expect(out).toContain('git stash');
      expect(out).toMatch(/commit it\s+as `wip:`|Commit WIP|git worktree/);
      expect(out).toContain('Never run network git');
      expect(out).toContain('origin` was fetched before the');
      expect(out).toContain('`git ls-remote`');
      for (const cli of ['gh', 'glab', 'acli', 'jira', 'linear']) expect(out).toContain(`\`${cli}\``);
      expect(out).toContain('issue-tracker or forge CLIs');
      expect(out).toContain('other agent runners');
      expect(out).not.toMatch(/sdlc/);
      expect(out).toContain('No `npm publish`');
      expect(out).toMatch(/standalone words `push`, `gh` or `ssh`/);
      expect(out).toContain("<<'EOF'");
      expect(out).toMatch(/`echo "\.\.\."`/);
    },
  );

  it.each(['orchestrator_append', 'fixer_append', 'designer_append', 'oracle_append'] as const)(
    '%s states the temp-file facts and the plain-spaces line',
    (name) => {
      const out = render(name).replace(/\s+/g, ' ');
      expect(out).toContain("`$TMPDIR` is the run's own writable temp dir");
      expect(out).toContain('bare `mktemp` already uses it');
      expect(out).toContain('`/tmp`, `/var/tmp` and other shared temp dirs are not writable');
      expect(out).toContain("Quoted heredocs (`<<'EOF'`) work for files and JSONL");
      expect(out).toContain('bash and `sh` need a writable cwd');
      expect(out).toContain('retype it with plain ASCII spaces');
      expect(out).toContain('even inside a heredoc body or a quoted string');
      expect(out).toContain('write the file with the write tool');
      expect(out).toContain('`git commit -F <file>`');
    },
  );

  it.each(['fixer_append', 'designer_append'] as const)('%s requires timeouts, scoped commands and installed deps', (name) => {
    const out = render(name);
    expect(out).toContain('timeout');
    expect(out).toContain('120 s');
    expect(out).toMatch(/never above 1080000/);
    expect(out).toMatch(/project-scoped/);
    expect(out).toContain('--outputStyle=stream');
    expect(out).toContain('npm ci');
    expect(out).toContain('go mod download');
    expect(out).toMatch(/main checkout's `node_modules`/);
    expect(out).toContain('git stash');
  });

  it.each(['fixer_append', 'designer_append'] as const)('%s has the skills section and names the dev skills', (name) => {
    const out = render(name);
    expect(out).toMatch(/## Available skills\n\n- test-driven-development/);
    expect(out).toContain('Never use a skill that is not listed');
    expect(out).toContain('`test-driven-development`');
    expect(out).toContain('`incremental-implementation`');
    expect(out).toMatch(/AGENTS.md or CLAUDE.md/);
  });

  it('oracle_append has the review duties', () => {
    const out = render('oracle_append');
    expect(out).toContain('Plan review');
    expect(out).toContain('Second-failure escalation');
    expect(out).toContain('Risky-change approval');
    expect(out).toContain('APPROVE');
    expect(out).toContain('REJECT');
    expect(out).toContain('rationale');
    expect(out).toContain('Final review');
    expect(out).toContain('workspace instructions');
    expect(out).toContain('`code-review-and-quality`');
    expect(out).toContain('Open risks:');
  });
});

describe('phase prompts', () => {
  it('phase-plan', () => {
    const out = render('phase-plan');
    expect(out).toContain('planning-and-task-breakdown');
    expect(out).toContain('workspace instructions');
    expect(out).toContain(String(VARS.planMd));
    expect(out).toMatch(/@oracle/);
    expect(out).toContain('phase:plan');
    expect(out).toContain(String(VARS.decisionsJsonl));
  });

  it('phase-build', () => {
    const out = render('phase-build');
    expect(out).toContain('workspace instructions');
    expect(out).toContain('`incremental-implementation` and `test-driven-development`');
    expect(out).toContain('_integration');
    expect(out).toContain('phase:build');
    expect(out).toMatch(/3 fix-up attempts/);
    expect(out).toMatch(/Never push/);
  });

  it('phase-build: no fetch, deps before verification, shell timeouts, scoped task verify', () => {
    const out = render('phase-build');
    expect(out).not.toMatch(/git -C <repo> fetch/);
    expect(out).toContain('Do not run `git fetch`');
    expect(out.replace(/\s+/g, ' ')).toContain('`origin` was fetched before the run started');
    expect(out).toContain('origin/<default-branch>');
    expect(out).toMatch(/BEFORE any verification/);
    expect(out).toContain('timeout');
    expect(out).toMatch(/900000 to\s+1080000/);
    expect(out).toMatch(/never more than 1080000/);
    expect(out).toContain('--outputStyle=stream');
    expect(out).toMatch(/project-scoped/);
    expect(out).toMatch(/runs only in `_integration`/);
    expect(out).toMatch(/45 minutes/);
    expect(out).toContain('git stash');
  });

  it('phase-plan: ids avoid push/gh/ssh and task verify is project-scoped', () => {
    const out = render('phase-plan');
    expect(out).toMatch(/standalone `push`, `gh` or\s+`ssh`/);
    expect(out).toMatch(/project-scoped/);
  });

  it('phase-review-lite: one oracle review, no fix-ups, writes FINAL_REVIEW and RunComplete', () => {
    const out = render('phase-review-lite');
    expect(out).toMatch(/exactly one\*\* @oracle review/);
    expect(out).toMatch(/No fix-ups and no new tasks/);
    expect(out).toMatch(/Do not dispatch @fixer or @designer/);
    expect(out).toContain(`${VARS.specsDir}/FINAL_REVIEW.md`);
    expect(out).toContain('phase:review');
    expect(out).toContain('RunComplete');
    expect(out).toContain(`${VARS.eventsDir}/run-complete.json`);
    expect(out).toMatch(/under 10 minutes/);
    expect(out).toMatch(/Never use `git stash` or network git/);
    expect(out).not.toMatch(/At most one fix-up round/);
  });

  it('phase-review-lite takes the same vars as phase-review', () => {
    expect(promptVars('phase-review-lite')).toEqual(promptVars('phase-review'));
    expect(PROMPT_NAMES).toContain('phase-review-lite');
  });

  it('phase-review: one fix-up round, then RunComplete', () => {
    const out = render('phase-review');
    expect(out).toMatch(/At most one fix-up round/);
    expect(out).toContain('RunComplete');
    expect(out).toContain(`${VARS.eventsDir}/run-complete.json`);
    expect(out).toContain('FINAL_REVIEW.md');
    expect(out).toContain('phase:review');
  });

  it('phase-report writes only the Narrative', () => {
    const out = render('phase-report');
    expect(out).toContain('## Narrative');
    expect(out).toContain(String(VARS.reportMd));
    expect(out).toMatch(/only/);
    expect(out).toContain('Needs human attention');
  });

  it('nudge names the next task and does not redo work', () => {
    const out = render('nudge');
    expect(out).toContain('api-endpoint');
    expect(out).toContain(String(VARS.statusMd));
    expect(out).toContain(String(VARS.tasksJsonl));
    expect(out).toMatch(/Do not redo/);
  });

  it('wind-down is a soft stop with conditional wip commits', () => {
    const out = render('wind-down');
    expect(out).toMatch(/Dispatch no new tasks/);
    expect(out).toContain('`wip:`');
    expect(out).toMatch(/passes/);
    expect(out).toMatch(/uncommitted/);
    expect(out).toContain('## Narrative');
    expect(out).toMatch(/stop/i);
    expect(out).toContain('$85.2');
    expect(out).toMatch(/@oracle only/);
    expect(out).toMatch(/oracle-only review/);
    expect(out).toMatch(/reviewable state/);
    expect(out).toContain('git stash');
  });
});

describe('JSON example lines parse with the contracts', () => {
  function jsonLines(text: string): unknown[] {
    const lines: unknown[] = [];
    for (const block of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      for (const line of block[1]!.split('\n').filter((l) => l.trim() !== '')) lines.push(JSON.parse(line));
    }
    return lines;
  }

  const examples = jsonLines(render('orchestrator_append'));

  it('has one example per schema', () => {
    expect(examples).toHaveLength(3);
  });

  it('TaskEvent example', () => {
    const ev = examples.find((e) => (e as { state?: string }).state !== undefined);
    const parsed = TaskEvent.parse(ev);
    expect(parsed.verify).toEqual([
      { cmd: 'go test ./...', exit: 0 },
      { cmd: 'golangci-lint run', exit: 0 },
    ]);
  });

  it('Decision example', () => {
    const d = examples.find((e) => (e as { kind?: string }).kind !== undefined);
    const parsed = Decision.parse(d);
    expect(parsed.needsHumanAttention).toBe(true);
    expect(parsed.oracleApproved).toBe(true);
  });

  it('RunComplete example', () => {
    const r = examples.find((e) => (e as { type?: string }).type === 'run.complete');
    const parsed = RunComplete.parse(r);
    expect(parsed.finalReviewPath).toBe(`${VARS.specsDir}/FINAL_REVIEW.md`);
  });

  it('the phase-done TaskEvent shape from the prompt validates', () => {
    const line = {
      ts: '2026-10-21T22:00:00Z',
      id: 'phase:plan',
      repo: '_run',
      branch: '-',
      worktree: VARS.specsDir,
      state: 'done',
      phase: 'plan',
    };
    expect(TaskEvent.parse(line).id).toBe('phase:plan');
  });
});
