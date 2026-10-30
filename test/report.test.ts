import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LS_REMOTE_TIMEOUT_MS,
  checkRemoteBranch,
  commitsBetween,
  currentBranch,
  headSha,
  porcelainHash,
  remoteHasBranch,
  stashCount,
  type GitRunner,
} from '../src/gitinfo.ts';
import type { RunPaths } from '../src/paths.ts';
import { NARRATIVE_PLACEHOLDER, buildReport, extractManualChecks, extractNarrative, finalReviewVerdict, writeReport } from '../src/report.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/report/', import.meta.url));
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function pathsFor(dir: string): RunPaths {
  return {
    workspaceRoot: dir,
    specsDir: dir,
    runDir: dir,
    controlDir: join(dir, 'control'),
    xdgDataHome: join(dir, 'control', 'xdg'),
    runContextJson: join(dir, 'control', 'run-context.json'),
    runJson: join(dir, 'RUN.json'),
    costJsonl: join(dir, 'cost.jsonl'),
    tasksJsonl: join(dir, 'tasks.jsonl'),
    decisionsJsonl: join(dir, 'decisions.jsonl'),
    eventsJsonl: join(dir, 'events.jsonl'),
    orchestratorLog: join(dir, 'orchestrator.log'),
    reportMd: join(dir, 'REPORT.md'),
    statusMd: join(dir, 'STATUS.md'),
    decisionsMd: join(dir, 'DECISIONS.md'),
    planMd: join(dir, 'PLAN.md'),
    specMd: join(dir, 'SPEC.md'),
  };
}

const fixture = (name: string): RunPaths => pathsFor(join(FIXTURES, name));

// --- fake git ------------------------------------------------------------------

interface FakeRepo {
  head?: string;
  branch?: string;
  status?: string;
  stash?: string[];
  /** Branch names advertised by origin. `null` = no origin configured (ls-remote fails). */
  remote?: string[] | null;
  /** `<base>..HEAD` results keyed by base. A missing key makes git fail. */
  log?: Record<string, string[]>;
  /** `git diff -U0 <base>...HEAD` output keyed by base. A missing key makes git fail. */
  diff?: Record<string, string>;
  /** Default-branch names that exist as `refs/remotes/origin/<name>`. */
  originRefs?: string[];
  /** Make ls-remote fail with this message (timeout, network error). */
  lsRemoteError?: string;
  fail?: boolean;
}

function fakeGit(repos: Record<string, FakeRepo>): GitRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (args: readonly string[], opts: { cwd: string }): Promise<string> => {
    calls.push(`${opts.cwd} :: ${args.join(' ')}`);
    const r = repos[opts.cwd];
    if (!r || r.fail) throw new Error(`fatal: not a git repository: ${opts.cwd}`);
    const [cmd, ...rest] = args;
    switch (cmd) {
      case 'rev-parse': {
        if (rest[0] === '--verify') {
          const ref = rest[rest.length - 1] ?? '';
          if ((r.originRefs ?? []).some((b) => ref === `refs/remotes/origin/${b}`)) return 'a'.repeat(40);
          throw new Error(`fatal: Needed a single revision`);
        }
        return rest[0] === '--abbrev-ref' ? (r.branch ?? 'master') : (r.head ?? '');
      }
      case 'status':
        return r.status ?? '';
      case 'stash':
        return (r.stash ?? []).join('\n');
      case 'ls-remote': {
        if (r.lsRemoteError) throw new Error(r.lsRemoteError);
        if (r.remote === null || r.remote === undefined) throw new Error("fatal: 'origin' does not appear to be a git repository");
        const branch = rest[rest.length - 1] ?? '';
        return r.remote
          .filter((b) => b === branch || b.endsWith(`/${branch}`))
          .map((b) => `abc123\trefs/heads/${b}`)
          .join('\n');
      }
      case 'log': {
        const range = rest[rest.length - 1] ?? '';
        const base = range.replace(/\.\.HEAD$/, '');
        const lines = r.log?.[base];
        if (!lines) throw new Error(`fatal: bad revision '${range}'`);
        return lines.join('\n');
      }
      case 'diff': {
        const range = rest[rest.length - 1] ?? '';
        const text = r.diff?.[range.replace(/\.\.\.HEAD$/, '')];
        if (text === undefined) throw new Error(`fatal: bad revision '${range}'`);
        return text;
      }
      default:
        throw new Error(`unexpected git ${args.join(' ')}`);
    }
  };
  return Object.assign(run, { calls });
}

const ACME_API = '/fake/acme-api';
const ACME_WEB = '/fake/acme-web';
const API_WT = '/fake/acme-api/.worktrees/demo-feature/api';
const UI_WT = '/fake/acme-web/.worktrees/demo-feature/ui';
const INT_WT = '/fake/acme-api/.worktrees/demo-feature/_integration';
const FIX_WT = '/fake/acme-web/.worktrees/demo-feature/review-fix-1';

/** Git state that matches the `completed` fixture baseline exactly. */
function cleanRepos(): Record<string, FakeRepo> {
  return {
    [ACME_API]: { head: 'a'.repeat(40), branch: 'master', status: '', stash: ['stash@{0}: WIP'], remote: [] },
    [ACME_WEB]: { head: 'b'.repeat(40), branch: 'feature-x', status: '', stash: [], remote: [] },
    [API_WT]: { log: { master: ['1111111 feat: Add endpoint', '2222222 test: Cover endpoint'] } },
    [UI_WT]: { log: { master: ['3333333 feat: Add page'] } },
    [INT_WT]: { log: { master: ['4444444 merge: api', '1111111 feat: Add endpoint'] }, diff: { master: '' } },
    [FIX_WT]: { log: { master: ['6666666 fix: Address review'] } },
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ng-report-'));
  tmpDirs.push(d);
  return d;
}

/** Heading order of the `## ` sections. */
const sections = (md: string): string[] => {
  const out: string[] = [];
  let inFence = false;
  for (const l of md.split('\n')) {
    if (l.startsWith('```')) inFence = !inFence;
    else if (!inFence && l.startsWith('## ')) out.push(l.slice(3));
  }
  return out;
};

// --- gitinfo -------------------------------------------------------------------

describe('gitinfo', () => {
  it('commitsBetween splits git log --oneline output and passes the range', async () => {
    const git = fakeGit({ '/wt': { log: { master: ['aaa one', 'bbb two'] } } });
    expect(await commitsBetween('/wt', 'master', git)).toEqual(['aaa one', 'bbb two']);
    expect(git.calls).toEqual(['/wt :: log --oneline master..HEAD']);
  });

  it('commitsBetween returns [] for empty output', async () => {
    expect(await commitsBetween('/wt', 'master', fakeGit({ '/wt': { log: { master: [] } } }))).toEqual([]);
  });

  it('currentBranch, headSha and stashCount read from git', async () => {
    const git = fakeGit({ '/r': { head: 'f'.repeat(40), branch: 'dev', stash: ['s0', 's1'] } });
    expect(await currentBranch('/r', git)).toBe('dev');
    expect(await headSha('/r', git)).toBe('f'.repeat(40));
    expect(await stashCount('/r', git)).toBe(2);
  });

  it('porcelainHash hashes status output with sha256', async () => {
    expect(await porcelainHash('/r', fakeGit({ '/r': { status: '' } }))).toBe(EMPTY_SHA256);
    const dirty = await porcelainHash('/r', fakeGit({ '/r': { status: ' M a.ts' } }));
    expect(dirty).toMatch(/^[0-9a-f]{64}$/);
    expect(dirty).not.toBe(EMPTY_SHA256);
  });

  it('remoteHasBranch is tri-state: exact yes/no, unknown (no throw) without origin, on error or timeout', async () => {
    const git = fakeGit({
      '/has': { remote: ['feat/x', 'other/feat/y'] },
      '/none': { remote: null },
      '/broken': { fail: true },
      '/slow': { remote: [], lsRemoteError: 'Command timed out after 30000 milliseconds' },
    });
    expect(await remoteHasBranch('/has', 'feat/x', git)).toBe('yes');
    expect(await remoteHasBranch('/has', 'feat/y', git)).toBe('no'); // only a suffix match
    expect(await remoteHasBranch('/none', 'feat/x', git)).toBe('unknown');
    expect(await remoteHasBranch('/broken', 'feat/x', git)).toBe('unknown');
    expect(await remoteHasBranch('/slow', 'feat/x', git)).toBe('unknown');
    expect(await remoteHasBranch('/unknown-dir', 'feat/x', git)).toBe('unknown');
  });

  it('checkRemoteBranch explains an unknown result and passes a timeout to git', async () => {
    const seen: Array<number | undefined> = [];
    const git: GitRunner = async (_args, opts) => {
      seen.push(opts.timeoutMs);
      throw new Error("fatal: 'origin' does not appear to be a git repository\nhint: more");
    };
    const res = await checkRemoteBranch('/r', 'feat/x', git);
    expect(res.state).toBe('unknown');
    expect(res.reason).toBe("fatal: 'origin' does not appear to be a git repository");
    expect(seen).toEqual([LS_REMOTE_TIMEOUT_MS]);
  });
});

// --- normal completed run ------------------------------------------------------

describe('buildReport: completed run', () => {
  it('renders all sections in the required order', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(sections(md)).toEqual([
      'Run',
      'Cost',
      'Tasks',
      'Integration branches',
      'Needs human attention',
      'Verify by hand',
      'Safety checks',
      'Narrative',
      'Next steps',
    ]);
    expect(md.startsWith('# Run report: demo-feature\n')).toBe(true);
  });

  it('header has slug, state, stop reason, start, end and duration', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(md).toContain('- Slug: `demo-feature`');
    expect(md).toContain('- Final state: **completed**');
    expect(md).toContain('- Stop reason: run.complete');
    expect(md).toContain('- Started: 2026-10-21T20:05:00.000Z');
    expect(md).toContain('- Ended: 2026-10-21T22:35:30.000Z');
    expect(md).toContain('- Duration: 2h 30m 30s');
  });

  it('cost: total, estimated, budget percent and per-phase using the latest line per session', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(md).toContain('- Total: **$8.5000**');
    expect(md).toContain('- Estimated portion: $0.5000');
    expect(md).toContain('- Budget: $20.0000 (42.5% used)');
    expect(md).toContain('| plan | $1.5000 |'); // 1.0 then 1.5 for the same session: not summed
    expect(md).toContain('| build | $6.5000 |'); // 4.5 (latest ses_build) + 2.0 (ses_fixer)
    expect(md).toContain('| review | $0.5000 |');
    expect(md).toContain('1 session(s) have an estimated');
    expect(md).not.toContain('Budget stop caveat');
  });

  it('tasks table: latest event wins, verify cmd → exit, oracle, commits against the default branch', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const apiRow = md.split('\n').find((l) => l.startsWith('| api |'));
    const uiRow = md.split('\n').find((l) => l.startsWith('| ui |'));
    expect(apiRow).toBeDefined();
    expect(apiRow).toContain(`\`feat/api-endpoint\``);
    expect(apiRow).toContain(`\`${API_WT}\``);
    expect(apiRow).toContain('| done | 2 |'); // attempt 2 is the latest event
    expect(apiRow).toContain('`go build ./...` → 0<br>`go test ./...` → 0');
    expect(apiRow).toContain('| approved |');
    expect(apiRow).toContain('1111111 feat: Add endpoint<br>2222222 test: Cover endpoint');
    expect(apiRow).not.toContain('rejected');
    expect(uiRow).toContain('3333333 feat: Add page');
    expect(md).not.toContain('| integration:acme-api |');
    expect(md).toContain('⚠ 1 malformed artifact line(s) were skipped');
  });

  it('integration branches: branch, worktree, commits and last verify', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const part = md.slice(md.indexOf('## Integration branches'), md.indexOf('## Needs human attention'));
    expect(part).toContain('### acme-api');
    expect(part).toContain('- Branch: `feat/demo-feature-integration`');
    expect(part).toContain(`- Worktree: \`${INT_WT}\``);
    expect(part).toContain('`4444444 merge: api`');
    expect(part).toContain('- Last verify: `go test ./...` → 0');
    expect(part).not.toContain('### acme-web');
  });

  it('needs human attention lists flagged decisions only', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const part = md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));
    expect(part).toContain('**D-2** (dependency, oracle: approved): Add dependency zod-to-openapi');
    expect(part).not.toContain('D-1');
    expect(part).not.toContain('BLOCKED');
  });

  it('safety checks pass cleanly', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(md).not.toContain('❌');
    expect(md).toContain('- ✅ acme-api `feat/api-endpoint`: not on origin');
    expect(md).toContain('- ✅ acme-web `feat/ui-page`: not on origin');
    expect(md).toContain('- ✅ acme-api (`/fake/acme-api`): HEAD, branch, status and stashes match baseline');
    expect(md).toContain('- ✅ acme-web (`/fake/acme-web`): HEAD, branch, status and stashes match baseline');
  });

  it('next steps suggest review commands and manual push', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const part = md.slice(md.indexOf('## Next steps'));
    expect(part).toContain(`git -C ${API_WT} log --oneline master..HEAD`);
    expect(part).toContain(`git -C ${UI_WT} push -u origin feat/ui-page`);
    expect(part).toContain('Open the PRs manually');
  });

  it('next steps and commit lists use origin/<default> when it exists, else the local default', async () => {
    const repos = cleanRepos();
    repos[ACME_API] = { ...repos[ACME_API], originRefs: ['master'] };
    repos[API_WT] = { log: { 'origin/master': ['9999999 feat: Via origin'] } };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    const part = md.slice(md.indexOf('## Next steps'));
    expect(part).toContain(`git -C ${API_WT} log --oneline origin/master..HEAD`);
    expect(part).toContain(`git -C ${API_WT} diff --stat origin/master...HEAD`);
    expect(md).toContain('9999999 feat: Via origin');
    // acme-web has no origin/master ref: local default.
    expect(part).toContain(`git -C ${UI_WT} log --oneline master..HEAD`);
    expect(part).toContain(`git -C ${UI_WT} diff --stat master...HEAD`);
  });

  it('is deterministic', async () => {
    const a = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const b = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(a).toBe(b);
  });
});

// --- task id conventions ---------------------------------------------------------

describe('TaskEvent id conventions', () => {
  it('phase:<name> markers are a timeline, not tasks, and never trigger git calls', async () => {
    const git = fakeGit(cleanRepos());
    const md = await buildReport({ paths: fixture('completed'), git });
    expect(md).not.toMatch(/^\| phase:/m);
    expect(md).not.toContain('_run');
    expect(git.calls.some((c) => c.includes('_run'))).toBe(false);
    const part = md.slice(md.indexOf('### Phases'), md.indexOf('## Cost'));
    expect(part).toContain('| 2026-10-21T20:05:00.000Z | plan | running |');
    expect(part).toContain('| 2026-10-21T20:40:00.000Z | plan | done |');
    expect(part).toContain('| 2026-10-21T22:30:00.000Z | review | done |');
  });

  it('review-fix-<n> with phase review is a normal task row', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const row = md.split('\n').find((l) => l.startsWith('| review-fix-1 |')) ?? '';
    expect(row).toContain('`fix/review-1`');
    expect(row).toContain('6666666 fix: Address review');
    expect(md).toContain('Summary: 3 done'); // api, ui, review-fix-1
  });

  it('integration:<repo> stays out of the tasks table', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const tasks = md.slice(md.indexOf('## Tasks'), md.indexOf('## Integration branches'));
    expect(tasks).not.toContain('integration:');
  });

  it('links FINAL_REVIEW.md only when it exists', async () => {
    const withFile = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(withFile).toContain(`- Final review: [FINAL_REVIEW.md](${join(FIXTURES, 'completed', 'FINAL_REVIEW.md')})`);
    const without = await buildReport({ paths: fixture('aborted'), git: fakeGit({}) });
    expect(without).not.toContain('- Final review: [');
  });

  it('wind-down blocked tasks and skipped tasks are called out', async () => {
    const md = await buildReport({
      paths: fixture('aborted'),
      git: fakeGit({
        [ACME_API]: { head: 'a'.repeat(40), branch: 'master', stash: ['s'], remote: [] },
        '/fake/acme-api/.worktrees/budget-run/docs': { log: { master: ['5555555 wip: docs'] } },
      }),
    });
    expect(md).toContain('Unfinished at wind-down (blocked): docs');
    expect(md).toContain('Never started (skipped): metrics');
    expect(md).toContain('- **docs** (acme-api, feat/docs) [unfinished at wind-down]: wind-down: unfinished at soft stop');
    expect(md).not.toMatch(/^- \*\*metrics\*\*/m); // skipped is not "needs attention"
    expect(md).toContain('| metrics | acme-api |');
  });
});

// --- budget-aborted run --------------------------------------------------------

describe('buildReport: RUN.json versions', () => {
  const withManifest = (name: string): RunPaths => ({
    ...fixture('completed'),
    runJson: join(FIXTURES, name, 'RUN.json'),
  });

  it('renders a v1 run (upgraded in memory) exactly like the equivalent v2 run', async () => {
    const v2 = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const v1 = await buildReport({ paths: withManifest('completed-v1'), git: fakeGit(cleanRepos()) });
    expect(v1).toBe(v2);
    expect(v1).toContain('- Slug: `demo-feature`');
    expect(v1).not.toContain('RUN.json is');
  });

  it('renders a v2 run that carries profile, skills and instructions', async () => {
    const md = await buildReport({ paths: withManifest('completed-v2-profile'), git: fakeGit(cleanRepos()) });
    expect(md).toContain('- Final state: **completed**');
    expect(md).not.toContain('RUN.json is');
  });

  it('reports a v1 manifest whose runDir has an unexpected shape as invalid, without throwing', async () => {
    const d = await tmp();
    const v1 = JSON.parse(await readFile(join(FIXTURES, 'completed-v1', 'RUN.json'), 'utf8')) as Record<string, unknown>;
    v1.runDir = '/fake/elsewhere/run';
    await writeFile(join(d, 'RUN.json'), JSON.stringify(v1));
    const md = await buildReport({ paths: pathsFor(d), git: fakeGit({}) });
    expect(md).toContain('RUN.json is invalid');
    expect(md).toContain('- Slug: unknown');
  });

  it('reports a missing or malformed RUN.json', async () => {
    const d = await tmp();
    expect(await buildReport({ paths: pathsFor(d), git: fakeGit({}) })).toContain('RUN.json not found');
    await writeFile(join(d, 'RUN.json'), '{"schemaVersion":2}');
    expect(await buildReport({ paths: pathsFor(d), git: fakeGit({}) })).toContain('RUN.json is invalid');
    await writeFile(join(d, 'RUN.json'), 'nope');
    expect(await buildReport({ paths: pathsFor(d), git: fakeGit({}) })).toContain('RUN.json is unreadable');
  });

  it('never mentions a specific issue tracker', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(md).toMatch(/touches the issue tracker/);
    expect(md).not.toMatch(/jira/i);
  });
});

describe('buildReport: budget-aborted run', () => {
  const abortedRepos = (): Record<string, FakeRepo> => ({
    [ACME_API]: { head: 'a'.repeat(40), branch: 'master', status: '', stash: ['s'], remote: [] },
    '/fake/acme-api/.worktrees/budget-run/api': { log: { master: [] } },
    '/fake/acme-api/.worktrees/budget-run/docs': { log: { master: ['5555555 wip: docs'] } },
    '/fake/acme-api/.worktrees/budget-run/metrics': { log: { master: [] } },
  });

  it('shows the stop reason, overshoot caveat, BLOCKED task, D5 decision and defect', async () => {
    const md = await buildReport({ paths: fixture('aborted'), git: fakeGit(abortedRepos()) });
    expect(md).toContain('- Final state: **aborted-budget**');
    expect(md).toContain('- Stop reason: hard stop at 105% of budget');
    expect(md).toContain('- Duration: 45m 0s');
    expect(md).toContain('- Total: **$1.0500**');
    expect(md).toContain('(105.0% used)');
    expect(md).toContain('Budget stop caveat');

    const row = md.split('\n').find((l) => l.startsWith('| api |')) ?? '';
    expect(row).toContain('| blocked | 2 |');
    expect(row).toContain('`go test ./...` → 2');
    expect(row).toContain('rejected: new migration not allowed');
    expect(row).toContain('Oracle rejected D5 decision D-1 (DB migration)');
    expect(row).toContain('| (none) |'); // no commits

    const part = md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));
    expect(part).toContain('**D-1** (migration, oracle: REJECTED): Add column users.nickname');
    expect(part).toContain('### BLOCKED tasks');
    expect(part).toContain('- **api** (acme-api, feat/api-endpoint): Oracle rejected D5 decision D-1 (DB migration)');
    expect(part).toContain('### Defects');
    expect(part).toContain('[hard-stop-lag] Child session ses_c2 kept running 12s after interrupt (session ses_c2)');
  });

  it('uses the placeholder narrative and still has every section', async () => {
    const md = await buildReport({ paths: fixture('aborted'), git: fakeGit(abortedRepos()) });
    expect(md).toContain(`## Narrative\n\n${NARRATIVE_PLACEHOLDER}\n`);
    expect(sections(md)).toHaveLength(9);
    expect(md).not.toContain('## Integration branches\n\n### ');
    expect(md).toContain('(no integration branches)');
  });
});

// --- safety violations ---------------------------------------------------------

describe('buildReport: safety checks', () => {
  it('main checkouts: flags HEAD, branch, status hash and stash count differences with ❌', async () => {
    const repos = cleanRepos();
    repos[ACME_API] = { head: 'c'.repeat(40), branch: 'other', status: ' M x.go', stash: [], remote: [] };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    const sc4 = md.slice(md.indexOf('### Main checkouts unchanged'), md.indexOf('## Narrative'));
    expect(sc4).toContain('- ❌ acme-api (`/fake/acme-api`) changed since baseline:');
    expect(sc4).toContain(`HEAD: baseline ${'a'.repeat(12)} → now ${'c'.repeat(12)}`);
    expect(sc4).toContain("branch: baseline `master` → now `other`");
    expect(sc4).toContain('status hash:');
    expect(sc4).toContain('stash count: baseline 1 → now 0');
    expect(sc4).toContain('- ✅ acme-web'); // the other repo is unaffected
    expect(md.slice(0, md.indexOf('### Main checkouts unchanged'))).not.toContain('❌');
  });

  it('nothing pushed: flags a branch that exists on origin with ❌ VIOLATION', async () => {
    const repos = cleanRepos();
    repos[ACME_WEB] = { ...repos[ACME_WEB], remote: ['feat/ui-page'] };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    expect(md).toContain('- ❌ VIOLATION: acme-web `feat/ui-page` exists on origin');
    expect(md).toContain('❌ 1 branch(es) were pushed');
    expect(md).toContain('- ✅ acme-api `feat/api-endpoint`: not on origin');
  });

  it('nothing pushed: a repo without origin is unknown (⚠️ with the reason), not a violation and not a pass', async () => {
    const repos = cleanRepos();
    repos[ACME_WEB] = { ...repos[ACME_WEB], remote: null };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    expect(md).toContain("- ⚠️ acme-web `feat/ui-page`: unknown (fatal: 'origin' does not appear to be a git repository)");
    expect(md).not.toContain('- ✅ acme-web `feat/ui-page`: not on origin');
    expect(md).not.toContain('VIOLATION');
    expect(md).toMatch(/⚠️ \d+ branch\(es\) could not be checked against origin/);
  });

  it('nothing pushed: an ls-remote timeout is unknown and lands in Needs human attention', async () => {
    const repos = cleanRepos();
    repos[ACME_WEB] = { ...repos[ACME_WEB], lsRemoteError: 'Command timed out after 30000 milliseconds' };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    const attention = md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));
    expect(attention).toContain('### Unverified: nothing pushed');
    expect(attention).toContain('acme-web `feat/ui-page`: unknown (Command timed out after 30000 milliseconds)');
    expect(attention).not.toContain('Nothing flagged');
    expect(md).toContain('- ✅ acme-api `feat/api-endpoint`: not on origin');
  });

  it('nothing pushed: when every branch is verified absent, nothing is added to Needs human attention', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    const attention = md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));
    expect(attention).not.toContain('Unverified');
  });
});

// --- final review verdict --------------------------------------------------------------

describe('finalReviewVerdict', () => {
  it('accepts APPROVE and APPROVE-WITH-FIXES in any case, with markdown decoration', () => {
    for (const text of [
      'VERDICT: APPROVE\n',
      'Verdict: APPROVE-WITH-FIXES\nRationale: x',
      '# Final review\n\n**Verdict:** approve\n',
      '> `VERDICT: APPROVE`',
      '- verdict : Approve - looks good',
    ]) {
      expect(finalReviewVerdict(text), text).toEqual({ ok: true });
    }
  });

  it('flags a missing file, an empty one and one without a VERDICT line', () => {
    expect(finalReviewVerdict(null)).toEqual({ ok: false, reason: 'missing' });
    expect(finalReviewVerdict('')).toEqual({ ok: false, reason: 'no-verdict' });
    expect(finalReviewVerdict('Looks fine to me.\nNo issues.')).toEqual({ ok: false, reason: 'no-verdict' });
  });

  it('flags VERDICT: NONE and REJECT', () => {
    expect(finalReviewVerdict('VERDICT: NONE\nThe oracle did not answer.')).toEqual({ ok: false, reason: 'none' });
    expect(finalReviewVerdict('Verdict: REJECT\nBLOCKER ...')).toEqual({ ok: false, reason: 'reject' });
  });

  it('flags anything else, including the unfilled template and a plan verdict', () => {
    expect(finalReviewVerdict('VERDICT: APPROVE | APPROVE-WITH-FIXES | REJECT')).toEqual({ ok: false, reason: 'unrecognised', verdict: 'APPROVE | APPROVE-WITH-FIXES | REJECT' });
    expect(finalReviewVerdict('Verdict: REVISE')).toEqual({ ok: false, reason: 'unrecognised', verdict: 'REVISE' });
  });

  it('uses the first verdict line, so a later re-check cannot hide a REJECT', () => {
    expect(finalReviewVerdict('VERDICT: REJECT\n\n## Re-check round 1\nVERDICT: APPROVE')).toEqual({ ok: false, reason: 'reject' });
  });
});

describe('buildReport: final review check', () => {
  const withReview = async (content: string | null): Promise<string> => {
    const d = await tmp();
    await cp(join(FIXTURES, 'completed'), d, { recursive: true });
    if (content === null) await rm(join(d, 'FINAL_REVIEW.md'));
    else await writeFile(join(d, 'FINAL_REVIEW.md'), content);
    return buildReport({ paths: pathsFor(d), git: fakeGit(cleanRepos()) });
  };
  const attentionOf = (md: string): string => md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));

  it('an approving review adds nothing to Needs human attention', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(attentionOf(md)).not.toContain('Final review');
    for (const v of ['VERDICT: APPROVE', 'Verdict: APPROVE-WITH-FIXES']) {
      expect(attentionOf(await withReview(`${v}\n`)), v).not.toContain('Final review');
    }
  });

  it('flags a missing FINAL_REVIEW.md', async () => {
    const attention = attentionOf(await withReview(null));
    expect(attention).toContain('### Final review');
    expect(attention).toContain('`FINAL_REVIEW.md` is missing: no final review was saved');
    expect(attention).not.toContain('Nothing flagged');
  });

  it('flags a review without a VERDICT line', async () => {
    expect(attentionOf(await withReview('Looks fine to me.\n'))).toContain('has no `VERDICT:` line');
    expect(attentionOf(await withReview(''))).toContain('has no `VERDICT:` line');
  });

  it('flags VERDICT: NONE as a review that did not run', async () => {
    const attention = attentionOf(await withReview('VERDICT: NONE\nThe oracle returned no verdict.\n'));
    expect(attention).toContain('says `VERDICT: NONE`: the oracle review did not run');
  });

  it('flags VERDICT: REJECT', async () => {
    expect(attentionOf(await withReview('Verdict: REJECT\n'))).toContain('says `VERDICT: REJECT`');
  });

  it('flags an unrecognised verdict by name', async () => {
    expect(attentionOf(await withReview('VERDICT: REVISE\n'))).toContain('unrecognised verdict "REVISE"');
  });

  it('flags a run that never reached a review (no FINAL_REVIEW.md in the budget-aborted fixture)', async () => {
    const abortedRepos: Record<string, FakeRepo> = {
      [ACME_API]: { head: 'a'.repeat(40), branch: 'master', status: '', stash: ['s'], remote: [] },
    };
    const md = await buildReport({ paths: fixture('aborted'), git: fakeGit(abortedRepos) });
    expect(attentionOf(md)).toContain('`FINAL_REVIEW.md` is missing');
  });

  it('says nothing about the review when there is no RUN.json to say what ran', async () => {
    const md = await buildReport({ paths: pathsFor(await tmp()), git: fakeGit({}) });
    expect(md).toContain('Nothing flagged.');
  });
});

// --- verify by hand ------------------------------------------------------------------

describe('buildReport: verify by hand', () => {
  const withManual = async (content: string | null): Promise<string> => {
    const d = await tmp();
    await cp(join(FIXTURES, 'completed'), d, { recursive: true });
    if (content !== null) await writeFile(join(d, 'MANUAL_CHECKS.md'), content);
    return buildReport({ paths: pathsFor(d), git: fakeGit(cleanRepos()) });
  };
  const part = (md: string): string => md.slice(md.indexOf('## Verify by hand'), md.indexOf('## Safety checks'));

  it('lists the checklist items of MANUAL_CHECKS.md verbatim, with their indented steps', async () => {
    const md = await withManual(
      [
        '# Manual checks',
        '',
        '- [ ] Saving a draft shows a toast',
        '  1. Open /drafts',
        '  2. Click Save',
        '- [x] Export works for an empty list',
        '',
        'Some prose the report does not copy.',
        '',
      ].join('\n'),
    );
    const p = part(md);
    expect(p).toContain('- [ ] Saving a draft shows a toast\n  1. Open /drafts\n  2. Click Save\n- [x] Export works for an empty list');
    expect(p).not.toContain('Some prose');
    expect(p).not.toContain('None listed.');
    expect(p).toMatch(/MANUAL_CHECKS\.md\]\(.+MANUAL_CHECKS\.md\)/);
  });

  it('says "None listed." when the file says there is nothing to check', async () => {
    for (const content of ['None.\n', '# Manual checks\n\nNone\n', '']) {
      expect(part(await withManual(content)), JSON.stringify(content)).toContain('None listed.');
    }
  });

  it('says "None listed." and that the file was not written when MANUAL_CHECKS.md is missing', async () => {
    const p = part(await withManual(null));
    expect(p).toContain('None listed.');
    expect(p).toContain('MANUAL_CHECKS.md` was not found');
  });

  it('points at the file when it has content but no checklist items', async () => {
    const p = part(await withManual('Please check the export by hand.\n'));
    expect(p).not.toContain('None listed.');
    expect(p).toContain('has content but no `- [ ]` items');
  });

  it('extractManualChecks keeps only checklist items and their continuation lines', () => {
    expect(extractManualChecks('# T\n\n* [ ] a\n   detail\n\n- [X] b\nprose\n')).toEqual(['* [ ] a', '   detail', '- [X] b']);
    expect(extractManualChecks('nothing here')).toEqual([]);
  });
});

// --- suppressions and skipped tests ----------------------------------------------

describe('buildReport: suppressions and skipped tests', () => {
  const PATCH = [
    'diff --git a/src/page.ts b/src/page.ts',
    '--- a/src/page.ts',
    '+++ b/src/page.ts',
    '@@ -7,0 +8 @@',
    '+// @ts-ignore',
    'diff --git a/src/page.test.ts b/src/page.test.ts',
    'deleted file mode 100644',
    '--- a/src/page.test.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-expect(page()).toBe(1);',
    'diff --git a/src/api.test.ts b/src/api.test.ts',
    '--- a/src/api.test.ts',
    '+++ b/src/api.test.ts',
    '@@ -3,2 +3,0 @@',
    '-expect(a()).toBe(1);',
    '-expect(b()).toBe(2);',
    '',
  ].join('\n');
  const attentionOf = (md: string): string => md.slice(md.indexOf('## Needs human attention'), md.indexOf('## Verify by hand'));
  const safetyOf = (md: string): string => md.slice(md.indexOf('### Suppressions and skipped tests'), md.indexOf('## Narrative'));

  it('a clean integration branch is listed as none found and adds nothing to Needs human attention', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(sections(md)).toContain('Safety checks');
    expect(safetyOf(md)).toContain('- ✅ acme-api `feat/demo-feature-integration`: none found (against `master`)');
    expect(attentionOf(md)).not.toContain('Suppressions');
    expect(md).not.toContain('❌');
  });

  it('lists every hit with file and line, flags it under Needs human attention, and does not fail the report', async () => {
    const repos = cleanRepos();
    repos[INT_WT] = { ...repos[INT_WT], diff: { master: PATCH } };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    const part = safetyOf(md);
    expect(part).toContain('- ⚠️ acme-api `feat/demo-feature-integration`: 3 hit(s) (against `master`)');
    expect(part).toContain('  - `src/page.ts:8`: `@ts-ignore` added');
    expect(part).toContain('  - `src/page.test.ts`: test file deleted');
    expect(part).toContain('  - `src/api.test.ts`: net loss of assertions (2 removed, 0 added)');
    const attention = attentionOf(md);
    expect(attention).toContain('### Suppressions and skipped tests');
    expect(attention).toContain('- acme-api `feat/demo-feature-integration`: 3 hit(s)');
    expect(attention).not.toContain('Nothing flagged');
    expect(md).not.toContain('❌');
  });

  it('diffs against origin/<default> when that ref exists, and caps a long list', async () => {
    const repos = cleanRepos();
    repos[ACME_API] = { ...repos[ACME_API], originRefs: ['master'] };
    const many = ['diff --git a/s.ts b/s.ts', '--- a/s.ts', '+++ b/s.ts', '@@ -0,0 +1,35 @@', ...Array.from({ length: 35 }, () => '+// @ts-ignore'), ''].join('\n');
    repos[INT_WT] = { ...repos[INT_WT], log: { 'origin/master': [] }, diff: { 'origin/master': many } };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    const part = safetyOf(md);
    expect(part).toContain('35 hit(s) (against `origin/master`)');
    expect(part).toContain('  - `s.ts:30`: `@ts-ignore` added');
    expect(part).not.toContain('`s.ts:31`');
    expect(part).toContain('  - … and 5 more');
  });

  it('an unreadable diff is "not scanned", never an error or a pass', async () => {
    const repos = cleanRepos();
    repos[INT_WT] = { log: repos[INT_WT]?.log };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    expect(safetyOf(md)).toContain("- ⚠️ acme-api `feat/demo-feature-integration`: not scanned (fatal: bad revision 'master...HEAD')");
    expect(safetyOf(md)).not.toContain('none found');
    expect(attentionOf(md)).not.toContain('Suppressions');
  });

  it('is read-only: the scan only runs git diff in the integration worktree', async () => {
    const git = fakeGit(cleanRepos());
    await buildReport({ paths: fixture('completed'), git });
    const diffs = git.calls.filter((c) => c.includes(' :: diff '));
    expect(diffs).toEqual([`${INT_WT} :: diff -U0 -M --no-color master...HEAD`]);
  });
});

// --- git failures --------------------------------------------------------------

describe('buildReport: git failures', () => {
  it('never throws; renders unknown with a note', async () => {
    const git: GitRunner = async () => {
      throw new Error('git exploded\nsecond line');
    };
    const md = await buildReport({ paths: fixture('completed'), git });
    const apiRow = md.split('\n').find((l) => l.startsWith('| api |')) ?? '';
    expect(apiRow.trimEnd().endsWith('| unknown |')).toBe(true);
    expect(md).toContain('> ⚠ api: git log failed in');
    expect(md).toContain('git exploded');
    expect(md).not.toContain('second line');
    expect(md).toContain('- Commits: unknown');
    expect(md).toContain('HEAD: unknown (git exploded)');
    expect(md).toContain('could not verify everything');
    expect(md).not.toContain('match baseline');
  });

  it('falls back to origin/<default> when the local default branch is missing', async () => {
    const repos = cleanRepos();
    repos[API_WT] = { log: { 'origin/master': ['9999999 feat: via origin'] } };
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(repos) });
    expect(md).toContain('9999999 feat: via origin');
  });
});

// --- narrative -----------------------------------------------------------------

describe('narrative preservation', () => {
  const NARRATIVE = [
    'The API landed first; the UI followed.',
    '',
    '```md',
    '## not a heading',
    '```',
    '',
    '### Caveats',
    '',
    '- Pagination is untested.',
    '- Uses `a | b`.',
  ].join('\n');

  it('extractNarrative returns the body verbatim, stopping at the next ## heading', async () => {
    const existing = await readFile(join(FIXTURES, 'completed', 'REPORT.md'), 'utf8');
    expect(extractNarrative(existing)).toBe(NARRATIVE);
  });

  it('extractNarrative returns null when absent, empty, or only the placeholder', () => {
    expect(extractNarrative(null)).toBeNull();
    expect(extractNarrative('# x\n\n## Cost\n\nfoo\n')).toBeNull();
    expect(extractNarrative('## Narrative\n\n\n## Next steps\n')).toBeNull();
    expect(extractNarrative(`## Narrative\n\n${NARRATIVE_PLACEHOLDER}\n`)).toBeNull();
  });

  it('extractNarrative ignores a "## Narrative" line inside a code fence', () => {
    expect(extractNarrative('```\n## Narrative\nfake\n```\n')).toBeNull();
  });

  it('buildReport carries the narrative over verbatim and drops stale generated sections', async () => {
    const md = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(md).toContain(`## Narrative\n\n${NARRATIVE}\n\n## Next steps`);
    expect(md).not.toContain('stale content');
    expect(md).not.toContain('Old report');
  });

  it('writeReport is idempotent: regenerating keeps the narrative', async () => {
    const dir = await tmp();
    await cp(join(FIXTURES, 'completed'), dir, { recursive: true });
    const paths = pathsFor(dir);
    const first = await writeReport({ paths, git: fakeGit(cleanRepos()) });
    const second = await writeReport({ paths, git: fakeGit(cleanRepos()) });
    expect(second).toBe(first);
    expect(await readFile(paths.reportMd, 'utf8')).toBe(second);
    expect(second).toContain(NARRATIVE);
  });
});

// --- missing / empty files -----------------------------------------------------

describe('missing or empty artifacts', () => {
  it('an empty directory still yields a full report without throwing', async () => {
    const dir = await tmp();
    const md = await buildReport({ paths: pathsFor(dir), git: fakeGit({}) });
    expect(sections(md)).toHaveLength(9);
    expect(md).toContain('RUN.json not found');
    expect(md).toContain('- Final state: unknown');
    expect(md).toContain('(no tasks recorded)');
    expect(md).toContain('(no integration branches)');
    expect(md).toContain('Nothing flagged.');
    expect(md).toContain('(no created branches to check)');
    expect(md).toContain('(no repos in manifest)');
    expect(md).toContain('(no cost recorded)');
    expect(md).toContain(NARRATIVE_PLACEHOLDER);
  });

  it('empty JSONL files and an invalid RUN.json are tolerated', async () => {
    const dir = await tmp();
    const paths = pathsFor(dir);
    await Promise.all([
      writeFile(paths.tasksJsonl, ''),
      writeFile(paths.decisionsJsonl, '\n\n'),
      writeFile(paths.costJsonl, ''),
      writeFile(paths.runJson, '{"schemaVersion": 1}'),
    ]);
    const md = await buildReport({ paths, git: fakeGit({}) });
    expect(md).toContain('RUN.json is invalid');
    expect(md).toContain('(no tasks recorded)');
  });

  it('a run without cost, tasks or decisions but with a manifest renders zeros', async () => {
    const dir = await tmp();
    await cp(join(FIXTURES, 'aborted'), dir, { recursive: true });
    const paths = pathsFor(dir);
    await Promise.all([rm(paths.tasksJsonl), rm(paths.decisionsJsonl), rm(paths.costJsonl)]);
    const md = await buildReport({ paths, git: fakeGit({ [ACME_API]: { head: 'a'.repeat(40), branch: 'master', stash: ['s'], remote: [] } }) });
    expect(md).toContain('(no tasks recorded)');
    expect(md).toContain('(no cost recorded)');
    // Still lists the defect and the manifest worktree branch for the push check.
    expect(md).toContain('### Defects');
    expect(md).toContain('- ✅ acme-api `feat/api-endpoint`: not on origin');
  });

  it('writeReport creates the target directory when missing', async () => {
    const dir = await tmp();
    const paths = pathsFor(join(dir, 'nested', 'specs'));
    await writeReport({ paths, git: fakeGit({}) });
    expect(await readFile(paths.reportMd, 'utf8')).toContain('# Run report');
  });
});

// --- resumed run (several attempts) -------------------------------------------

describe('buildReport: resumed run', () => {
  const resumedRepos = (): Record<string, FakeRepo> => ({
    [ACME_API]: { head: 'a'.repeat(40), branch: 'master', status: '', stash: ['s'], remote: [] },
    '/fake/acme-api/.worktrees/budget-run/api': { log: { master: ['5555555 feat: Add endpoint'] } },
  });
  const resumed = (): Promise<string> => buildReport({ paths: fixture('resumed'), git: fakeGit(resumedRepos()) });
  const abortedRepos = (): Record<string, FakeRepo> => ({
    [ACME_API]: { head: 'a'.repeat(40), branch: 'master', status: '', stash: ['s'], remote: [] },
    '/fake/acme-api/.worktrees/budget-run/api': { log: { master: [] } },
    '/fake/acme-api/.worktrees/budget-run/docs': { log: { master: ['5555555 wip: docs'] } },
    '/fake/acme-api/.worktrees/budget-run/metrics': { log: { master: [] } },
  });
  const golden = async (name: string): Promise<string> =>
    (await readFile(join(FIXTURES, `${name}.report.golden.md`), 'utf8')).replaceAll('{{FIXTURES}}', FIXTURES.replace(/\/$/, ''));

  it('single-attempt reports are byte-identical to the pre-resume format', async () => {
    const completed = await buildReport({ paths: fixture('completed'), git: fakeGit(cleanRepos()) });
    expect(completed).toBe(await golden('completed'));
    const aborted = await buildReport({ paths: fixture('aborted'), git: fakeGit(abortedRepos()) });
    expect(aborted).toBe(await golden('aborted'));
  });

  it('a manifest with a single explicit attempt renders like one without attempts', async () => {
    const d = await tmp();
    await cp(join(FIXTURES, 'completed'), d, { recursive: true });
    const run = JSON.parse(await readFile(join(d, 'RUN.json'), 'utf8')) as Record<string, unknown>;
    run.attempts = [
      {
        n: 1,
        startedAt: '2026-10-21T20:05:00.000Z',
        endedAt: '2026-10-21T22:35:30.000Z',
        state: 'completed',
        stopReason: 'run.complete',
        budgetUsd: 20,
        costAtStartUsd: 0,
        costUsd: 8.5,
      },
    ];
    await writeFile(join(d, 'RUN.json'), JSON.stringify(run));
    const md = await buildReport({ paths: pathsFor(d), git: fakeGit(cleanRepos()) });
    expect(md).not.toContain('### Attempts');
    expect(md).not.toContain('Resumed');
    expect(md.replaceAll(d, FIXTURES + 'completed')).toBe(await golden('completed'));
  });

  it('the Run section says Resumed and has an Attempts table, one row per attempt', async () => {
    const md = await resumed();
    expect(md).toContain('- Resumed (2 attempts)');
    expect(md).toContain('- Started: 2026-10-21T20:05:00.000Z');
    expect(md).toContain('- Ended: 2026-10-22T10:30:00.000Z');
    expect(md).toContain('- Duration: 2h 15m 0s (sum of attempts)');
    expect(md).toContain('### Attempts');
    expect(md).toContain('| n | Started | Ended | State | Stop reason | Budget | Attempt spend |');
    expect(md).toContain(
      '| 1 | 2026-10-21T20:05:00.000Z | 2026-10-21T20:50:00.000Z | aborted-budget | hard stop at 105% of budget | $1.0000 | $1.0500 |',
    );
    expect(md).toContain(
      '| 2 | 2026-10-22T09:00:00.000Z | 2026-10-22T10:30:00.000Z | completed | run.complete | $5.0000 | $2.5000 |',
    );
    expect(md).toContain('Cumulative cost over all attempts: **$3.5500**.');
    expect(sections(md)[0]).toBe('Run');
  });

  it('cost section: the percentage is attempt spend over the attempt budget; the total stays cumulative', async () => {
    const md = await resumed();
    expect(md).toContain('- Total (all attempts): **$3.5500**');
    expect(md).toContain('- Budget (attempt 2): $5.0000, attempt spend $2.5000 (50.0% used)');
    expect(md).not.toContain('% used)\n- Budget');
    expect(md).not.toContain('71.0% used'); // cumulative / attempt budget would be wrong
  });

  it('links the renamed earlier review files under the final review, in attempt order', async () => {
    const md = await resumed();
    const lines = md.split('\n');
    const i = lines.findIndex((l) => l.startsWith('- Final review: '));
    expect(i).toBeGreaterThan(-1);
    const dir = join(FIXTURES, 'resumed');
    expect(lines[i + 1]).toBe(
      `- Earlier reviews: [FINAL_REVIEW-attempt1.md](${join(dir, 'FINAL_REVIEW-attempt1.md')}), [run-complete-attempt1.json](${join(dir, 'run-complete-attempt1.json')})`,
    );
  });

  it('falls back to cumulative minus the cost at attempt start when the last attempt has no recorded spend', async () => {
    const d = await tmp();
    await cp(join(FIXTURES, 'resumed'), d, { recursive: true });
    const run = JSON.parse(await readFile(join(d, 'RUN.json'), 'utf8')) as { attempts: Array<Record<string, unknown>> };
    delete run.attempts[1]?.costUsd;
    delete run.attempts[0]?.costUsd;
    await writeFile(join(d, 'RUN.json'), JSON.stringify(run));
    const md = await buildReport({ paths: pathsFor(d), git: fakeGit(resumedRepos()) });
    expect(md).toContain('| $1.0000 | unknown |'); // attempt 1: no figure recorded
    expect(md).toContain('| $5.0000 | $2.5000 |'); // attempt 2: 3.55 - 1.05
    expect(md).toContain('attempt spend $2.5000 (50.0% used)');
  });

  it('lists a resume-failed attempt with its stop reason, but the budget use is the last attempt that ran', async () => {
    const d = await tmp();
    await cp(join(FIXTURES, 'resumed'), d, { recursive: true });
    const run = JSON.parse(await readFile(join(d, 'RUN.json'), 'utf8')) as { attempts: Array<Record<string, unknown>> };
    // what a rolled-back resume leaves: the previous manifest (budget $5) and a closed, failed third attempt (budget $9)
    run.attempts.push({
      n: 3,
      startedAt: '2026-10-22T11:00:00.000Z',
      endedAt: '2026-10-22T11:00:05.000Z',
      state: 'failed',
      stopReason: 'resume-failed',
      budgetUsd: 9,
      costAtStartUsd: 3.55,
      costUsd: 0,
    });
    await writeFile(join(d, 'RUN.json'), JSON.stringify(run));
    const md = await buildReport({ paths: pathsFor(d), git: fakeGit(resumedRepos()) });
    expect(md).toContain(
      '| 3 | 2026-10-22T11:00:00.000Z | 2026-10-22T11:00:05.000Z | failed | resume-failed | $9.0000 | $0.0000 |',
    );
    expect(md).toContain('- Resumed (2 attempts, 1 failed to start)');
    expect(md).toContain('- Duration: 2h 15m 0s (sum of attempts)'); // the failed start did not run
    expect(md).toContain('- Budget (attempt 2): $5.0000, attempt spend $2.5000 (50.0% used)');
    expect(md).not.toContain('attempt 3');
  });

  it('shows an open attempt and is deterministic', async () => {
    const d = await tmp();
    await cp(join(FIXTURES, 'resumed'), d, { recursive: true });
    const run = JSON.parse(await readFile(join(d, 'RUN.json'), 'utf8')) as Record<string, unknown> & {
      attempts: Array<Record<string, unknown>>;
    };
    delete run.endedAt;
    delete run.attempts[1]?.endedAt;
    delete run.attempts[1]?.state;
    await writeFile(join(d, 'RUN.json'), JSON.stringify(run));
    const a = await buildReport({ paths: pathsFor(d), git: fakeGit(resumedRepos()) });
    const b = await buildReport({ paths: pathsFor(d), git: fakeGit(resumedRepos()) });
    expect(a).toBe(b);
    expect(a).toContain('| (not ended) | - |');
    expect(a).toContain('- Duration: unknown (an attempt has no end time)');
  });
});
