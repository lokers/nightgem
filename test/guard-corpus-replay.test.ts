import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decide, type GuardConfig } from '../profile/guard/decide.mjs';
import { corpusVars, loadCorpus, type Probe } from '../src/rulecheck.ts';
import { guardConfigFor } from '../src/wiring.ts';
import { corpusSafety } from './fixtures/profile/corpus-safety.ts';

/**
 * Replays every shell probe of `profile/corpus.txt` (the permission layer's corpus) through the guard, with the config the run
 * builds (`guardConfigFor`) and the working directory set to the task worktree (`{{WT}}`), as the agent's shell has it.
 *
 * The two layers overlap but do not coincide, so a probe whose guard verdict differs from the corpus verdict must be listed in
 * `EXCEPTIONS` with the guard's verdict and a reason. Any difference that is not in the table fails the test, and so does a row
 * the guard no longer agrees with (a fix flips its row: remove it then, never relax it).
 *
 * Rows are only ever added or removed when the behaviour they record is fixed. Do not edit a row to make a failure go away.
 */

type Kind = 'by-design' | 'fixed-in-T3b' | 'known-gap' | 'found-in-T3a';

interface Exception {
  /** The resource, with the corpus placeholders (`{{WT}}`, `{{HOME}}`, ...). */
  probe: string;
  /** What the corpus (or, for rows outside the corpus, the desired verdict) says. */
  corpus: 'allow' | 'deny';
  /** What the guard says today. */
  guard: 'allow' | 'block';
  kind: Kind;
  reason: string;
}

/** Rows for probes that share one verdict pair and one reason. */
const rows = (probes: string[], rest: Omit<Exception, 'probe'>): Exception[] => probes.map((probe) => ({ probe, ...rest }));

const EXCEPTIONS: Exception[] = [
  // ---- differences by design
  ...rows(
    [
      'npm run dev',
      'npm run start',
      'npx nx serve foo',
    ],
    {
      corpus: 'deny',
      guard: 'allow',
      kind: 'by-design',
      reason: 'never-ending dev servers are denied by the permission profile only; the guard has no rule for them (a liveness rule, not a safety boundary)',
    },
  ),
  ...rows(
    [
      'npm test -- --watch',
      'vitest --watch',
      'npx vitest --watch --reporter dot',
      'vitest --watch=true',
      'jest --watchAll',
      'jest --watchAll --coverage',
      'npm test -- --watchAll',
      'sh -c "vitest --watch"',
      '(vitest --watch)',
      'vitest --watch; echo done',
      'vitest --watch&',
      'cd x && tsc --watch',
    ],
    {
      corpus: 'deny',
      guard: 'allow',
      kind: 'by-design',
      reason: 'watch mode never ends; only the permission profile denies it (a liveness rule, not a safety boundary of the guard)',
    },
  ),
  {
    probe: 'npm install -g foo',
    corpus: 'deny',
    guard: 'allow',
    kind: 'by-design',
    reason: 'a global install is denied by the permission profile only; the guard has no rule for it, and the sandbox write boundary confines where it can write',
  },
  {
    probe: 'git config --global user.name x',
    corpus: 'deny',
    guard: 'allow',
    kind: 'by-design',
    reason: 'denied by the permission profile; the guard has no git config rule, and the global config lies outside the sandbox write boundary. Possible guard rule later',
  },
  {
    probe: 'git fetch origin',
    corpus: 'allow',
    guard: 'block',
    kind: 'by-design',
    reason: 'network git is refused by the guard (argv-aware), and the permission profile deliberately leaves it to the guard; the corpus pins only that the profile does not deny it',
  },
  // ---- today's false positives: the textual backstop matches a denied name after `/`, `=` or `.`. Allowed after T3b narrows it.
  {
    probe: 'ls docs/gh',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'CMD_WORD treats `/` as a boundary, so the directory docs/gh matches the denied command gh',
  },
  {
    probe: 'ls tools/brew',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'same: `/brew` in a path argument',
  },
  {
    probe: 'ls src/opencode',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'same: `/opencode` in a path argument',
  },
  {
    probe: 'ls infra/docker',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'same: `/docker` in a path argument',
  },
  {
    probe: 'ls infra/terraform',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'same: `/terraform` in a path argument',
  },
  {
    probe: 'cat config/ssh',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'same: `/ssh` in a path argument',
  },
  {
    probe: 'node cli.js --tool=docker',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: '`=` is a boundary too, so an option value that names a denied command matches',
  },
  {
    probe: 'export TMPDIR=/private/var/folders/xx/abcdefghijklmnopqrstuvwxyz0000gn/T/opencode',
    corpus: 'allow',
    guard: 'block',
    kind: 'fixed-in-T3b',
    reason: 'the macOS temp dir ends in `/T/opencode`, which matches the denied command opencode after `/`',
  },
  // ---- known gaps: the guard allows these today and they stay recorded, not fixed here. `corpus` is the verdict we want.
  {
    probe: 'GH pr list',
    corpus: 'deny',
    guard: 'allow',
    kind: 'known-gap',
    reason: 'the command match is case-sensitive, but the macOS filesystem is not: GH resolves to gh. The sandbox and the missing credentials are the backstop',
  },
  {
    probe: '/usr/bin/g? x',
    corpus: 'deny',
    guard: 'allow',
    kind: 'known-gap',
    reason: 'the shell expands the glob g? to gh; the guard reads words and does not expand globs in the command position',
  },
];

let base: string;
let cfg: GuardConfig;
let vars: Record<string, string>;
let shellProbes: Probe[];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ng-replay-')));
  const workspaceRoot = join(base, 'work');
  const home = join(base, 'home');
  const slug = 'my-run';
  const worktree = join(workspaceRoot, 'repo', '.worktrees', slug, 'T1');
  const runDir = join(workspaceRoot, '.specs', slug, '.run');
  const controlDir = join(home, 'Library', 'Application Support', 'nightgem', slug);
  const tmpDir = join(base, 'run-tmp');
  const xdgDataHome = join(controlDir, 'xdg-data');
  for (const d of [worktree, runDir, tmpDir, xdgDataHome, home]) mkdirSync(d, { recursive: true });
  vars = corpusVars({ workspaceRoot, home, slug, tmp: tmpDir, worktree });
  // the run's own config, with the working directory of the agent's shell: the task worktree
  cfg = {
    ...guardConfigFor({ home, workspaceRoot, slug, controlDir, tmpDir, runDir, xdgDataHome, port: 54176, safety: corpusSafety(workspaceRoot, home) }),
    cwd: worktree,
  };
  shellProbes = loadCorpus(new URL('../profile/corpus.txt', import.meta.url).pathname, vars, { includeWorkspaceInputs: true }).filter((p) => p.action === 'shell');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const subst = (s: string): string => s.replace(/\{\{(\w+)\}\}/g, (_all, k: string) => vars[k] ?? `{{${k}}}`);
const guardVerdict = (command: string): string => decide({ tool: 'shell', input: { command }, agent: 'fixer' }, cfg).verdict;
const want = (p: Probe): 'allow' | 'block' => (p.expect === 'deny' ? 'block' : 'allow');

describe('guard replay of the shell probes in profile/corpus.txt', () => {
  it('replays a substantial number of deny and allow shell probes', () => {
    expect(shellProbes.length).toBeGreaterThan(400);
    expect(shellProbes.filter((p) => p.expect === 'deny').length).toBeGreaterThan(300);
    expect(shellProbes.filter((p) => p.expect === 'allow').length).toBeGreaterThan(40);
  });

  it('agrees with the corpus on every probe that is not in the exception table', () => {
    const excepted = new Set(EXCEPTIONS.map((e) => subst(e.probe)));
    const differences = shellProbes
      .filter((p) => !excepted.has(p.resource))
      .map((p) => ({ p, got: guardVerdict(p.resource) }))
      .filter(({ p, got }) => got !== want(p))
      .map(({ p, got }) => `${p.expect} but the guard says ${got}: ${JSON.stringify(p.resource)}`);
    expect(differences).toEqual([]);
  });

  describe('exception table', () => {
    for (const e of EXCEPTIONS) {
      it(`${e.kind}: ${e.probe.slice(0, 80)}`, () => {
        const command = subst(e.probe);
        // the guard still gives the recorded verdict; when a fix flips it, the row must go (never be edited to match)
        expect(guardVerdict(command), `${e.kind}: ${e.reason}`).toBe(e.guard);
        const inCorpus = shellProbes.filter((p) => p.resource === command);
        for (const p of inCorpus) expect(p.expect, 'the corpus verdict of an excepted probe').toBe(e.corpus);
        // a row that is not a difference is stale
        expect(e.guard).not.toBe(e.corpus === 'deny' ? 'block' : 'allow');
      });
    }
    it('has no duplicate rows', () => {
      expect(new Set(EXCEPTIONS.map((e) => e.probe)).size).toBe(EXCEPTIONS.length);
    });
  });
});
