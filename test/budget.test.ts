import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BudgetLedger, type BudgetEvent, type BudgetLedgerOptions } from '../src/budget.ts';
import { CostLine, SessionInfo, type Phase } from '../src/contracts.ts';
import { APPROXIMATE_RATES_USD_PER_MTOK, estimateCost, ratesFor } from '../src/pricing.ts';
import { RECORDED_FIXTURES, REPO_ROOT } from './fixtures/paths.ts';

const FIXTURES = join(REPO_ROOT, RECORDED_FIXTURES);
const fixtureSession = (name: string): SessionInfo =>
  SessionInfo.parse(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')).body.data);

function session(id: string, cost: number, extra: Record<string, unknown> = {}): SessionInfo {
  return SessionInfo.parse({
    id,
    cost,
    time: { created: 1, updated: 2 },
    location: { directory: '/tmp/run' },
    ...extra,
  });
}

function ledger(over: Partial<BudgetLedgerOptions> = {}): BudgetLedger {
  return new BudgetLedger({
    budgetUsd: 10,
    softPct: 0.85,
    hardPct: 1,
    costMultiplier: 1,
    rootSessionIds: [],
    now: () => new Date('2026-10-21T10:00:00.000Z'),
    ...over,
  });
}

describe('pricing', () => {
  it('prices known models per MTok and strips the provider prefix', () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cache: { read: 1_000_000, write: 1_000_000 } };
    const r = APPROXIMATE_RATES_USD_PER_MTOK['claude-sonnet-5-5'];
    expect(estimateCost(tokens, 'anthropic/claude-sonnet-5-5')).toBeCloseTo(
      r.input + r.output + r.cacheRead + r.cacheWrite,
    );
    expect(estimateCost(tokens, 'claude-haiku-5-5')).toBeLessThan(estimateCost(tokens, 'claude-sonnet-5-5'));
  });

  it('prices unknown / missing models at Opus rates and bills reasoning as output', () => {
    expect(ratesFor('openai/gpt-9')).toEqual(APPROXIMATE_RATES_USD_PER_MTOK['claude-opus-5-5']);
    expect(ratesFor(undefined)).toEqual(APPROXIMATE_RATES_USD_PER_MTOK['claude-opus-5-5']);
    expect(estimateCost({ reasoning: 1_000_000 }, 'x/unknown')).toBeCloseTo(
      APPROXIMATE_RATES_USD_PER_MTOK['claude-opus-5-5'].output,
    );
    expect(estimateCost(undefined, 'x')).toBe(0);
  });
});

describe('BudgetLedger ingest', () => {
  it('is idempotent and latest value wins', () => {
    const l = ledger();
    expect(l.ingestSession(session('a', 1))).toBe(true);
    expect(l.ingestSession(session('a', 1))).toBe(false);
    expect(l.ingestSession(session('a', 1))).toBe(false);
    expect(l.total().costUsd).toBe(1);
    l.ingestSession(session('a', 2.5));
    expect(l.total()).toEqual({ costUsd: 2.5, estimatedUsd: 0, effectiveUsd: 2.5 });
  });

  it('sums sessions in isolated-db mode regardless of parents', () => {
    const l = ledger();
    l.ingestSession(session('a', 1));
    l.ingestSession(session('b', 2, { parentID: 'never-seen' }));
    l.ingestSession(session('c', 0.5));
    expect(l.total().effectiveUsd).toBeCloseTo(3.5);
  });

  it('estimates from tokens when cost is 0 and marks the session estimated', () => {
    const l = ledger();
    l.ingestSession(
      session('a', 0, {
        model: { providerID: 'anthropic', id: 'claude-haiku-5-5' },
        tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const t = l.total();
    expect(t.costUsd).toBe(0);
    expect(t.estimatedUsd).toBeCloseTo(APPROXIMATE_RATES_USD_PER_MTOK['claude-haiku-5-5'].input);
    expect(t.effectiveUsd).toBeCloseTo(t.estimatedUsd);
    const [line] = l.toCostLines(() => 'build');
    expect(line).toMatchObject({ estimated: true, source: 'estimate' });
  });

  it('prefers reported cost over an estimate, and keeps the earlier model when later snapshots omit it', () => {
    const l = ledger();
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    l.ingestSession(session('a', 0, { model: { providerID: 'anthropic', id: 'claude-haiku-5-5' }, tokens }));
    l.ingestSession(session('a', 0, { tokens: { ...tokens, input: 2_000_000 } })); // no model now
    expect(l.total().estimatedUsd).toBeCloseTo(2 * APPROXIMATE_RATES_USD_PER_MTOK['claude-haiku-5-5'].input);
    l.ingestSession(session('a', 0.42, { tokens }));
    expect(l.total()).toEqual({ costUsd: 0.42, estimatedUsd: 0, effectiveUsd: 0.42 });
  });

  it('applies the cost multiplier to the effective total only', () => {
    const l = ledger({ costMultiplier: 10 });
    l.ingestSession(session('a', 1));
    expect(l.total()).toEqual({ costUsd: 1, estimatedUsd: 0, effectiveUsd: 10 });
    expect(l.check()).toBe('hard');
  });

  it('handles the real recorded Session.Info shape (cost wins; zero-cost fresh session adds nothing)', () => {
    const l = ledger();
    l.ingestSession(fixtureSession('session.create.json'));
    expect(l.total().effectiveUsd).toBe(0);
    l.ingestSession(fixtureSession('session.get.json'));
    expect(l.total()).toEqual({ costUsd: 0.00267965, estimatedUsd: 0, effectiveUsd: 0.00267965 });
    // same id: the later snapshot replaced the earlier one, not added to it
    expect(l.toCostLines(() => 'plan')).toHaveLength(1);
  });
});

describe('BudgetLedger tree attribution', () => {
  it('counts only sessions reaching a root, including grandchildren', () => {
    const l = ledger({ attribution: 'tree', rootSessionIds: ['root'] });
    l.ingestSession(session('root', 1));
    l.ingestSession(session('kid', 2, { parentID: 'root' }));
    l.ingestSession(session('grandkid', 4, { parentID: 'kid' }));
    l.ingestSession(session('stranger', 100));
    l.ingestSession(session('stranger-kid', 100, { parentID: 'stranger' }));
    expect(l.total().effectiveUsd).toBe(7);
    expect(l.pendingSessionIds()).toEqual([]);
  });

  it('keeps a child pending until its parent shows up (out-of-order), then resolves it', () => {
    const l = ledger({ attribution: 'tree', rootSessionIds: ['root'] });
    l.ingestSession(session('grandkid', 4, { parentID: 'kid' }));
    l.ingestSession(session('kid', 2, { parentID: 'root' }));
    // kid arrived second: grandkid resolves through it
    expect(l.total().effectiveUsd).toBe(6);

    const m = ledger({ attribution: 'tree', rootSessionIds: ['root'] });
    m.ingestSession(session('child', 3, { parentID: 'root2' }));
    expect(m.total().effectiveUsd).toBe(0);
    expect(m.pendingSessionIds()).toEqual(['child']);
    expect(m.toCostLines(() => 'build')).toEqual([]);
    m.ingestSession(session('root2', 1, { parentID: 'root' }));
    expect(m.total().effectiveUsd).toBe(4);
    expect(m.pendingSessionIds()).toEqual([]);
    expect(m.toCostLines(() => 'build').map((x) => x.sessionId).sort()).toEqual(['child', 'root2']);
  });

  it('supports adding roots later (next phase) and survives parent cycles', () => {
    const l = ledger({ attribution: 'tree', rootSessionIds: ['r1'] });
    l.ingestSession(session('r2', 5));
    expect(l.total().effectiveUsd).toBe(0);
    l.addRootSession('r2');
    expect(l.total().effectiveUsd).toBe(5);
    l.ingestSession(session('x', 1, { parentID: 'y' }));
    l.ingestSession(session('y', 1, { parentID: 'x' }));
    expect(l.total().effectiveUsd).toBe(5);
  });
});

describe('BudgetLedger thresholds', () => {
  function watched(over: Partial<BudgetLedgerOptions> = {}) {
    const l = ledger(over);
    const events: BudgetEvent[] = [];
    l.onEvent((e) => events.push(e));
    return { l, events };
  }

  it('is ok below soft and emits nothing', () => {
    const { l, events } = watched();
    l.ingestSession(session('a', 8.4));
    expect(l.check()).toBe('ok');
    expect(events).toEqual([]);
  });

  it('emits soft once and hard once, however often check() runs', () => {
    const { l, events } = watched();
    l.ingestSession(session('a', 8.5));
    expect(l.check()).toBe('soft');
    expect(l.check()).toBe('soft');
    expect(events).toEqual(['soft']);
    l.ingestSession(session('a', 10));
    expect(l.check()).toBe('hard');
    expect(l.check()).toBe('hard');
    l.ingestSession(session('a', 12));
    l.check();
    expect(events).toEqual(['soft', 'hard']);
  });

  it('emits soft then hard when one jump passes hard', () => {
    const { l, events } = watched();
    l.ingestSession(session('a', 50));
    expect(l.check()).toBe('hard');
    expect(events).toEqual(['soft', 'hard']);
    l.check();
    expect(events).toEqual(['soft', 'hard']);
  });

  it('keeps the level sticky if a later snapshot lowers the total', () => {
    const { l, events } = watched();
    l.ingestSession(session('a', 9));
    l.check();
    l.ingestSession(session('a', 1));
    expect(l.check()).toBe('soft');
    expect(events).toEqual(['soft']);
  });

  it('honours custom pct and rejects invalid options', () => {
    const { l } = watched({ budgetUsd: 100, softPct: 0.5, hardPct: 0.9 });
    l.ingestSession(session('a', 50));
    expect(l.check()).toBe('soft');
    l.ingestSession(session('a', 90));
    expect(l.check()).toBe('hard');
    expect(() => ledger({ budgetUsd: 0 })).toThrow();
    expect(() => ledger({ softPct: 1.1, hardPct: 1 })).toThrow();
    expect(() => ledger({ costMultiplier: 0 })).toThrow();
  });
});

function line(sessionId: string, costUsd: number, phase: Phase = 'plan', extra: Partial<CostLine> = {}): CostLine {
  return CostLine.parse({
    ts: '2026-10-20T10:00:00.000Z',
    sessionId,
    parentId: null,
    phase,
    costUsd,
    estimated: false,
    source: 'session-info',
    totalUsd: costUsd,
    ...extra,
  });
}

describe('BudgetLedger budget validation', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects budgetUsd %s', (budgetUsd) => {
    expect(() => ledger({ budgetUsd })).toThrow(/budgetUsd must be a finite number > 0/);
  });

  it('rejects non-finite percentages and multipliers, which would disable the stop', () => {
    expect(() => ledger({ hardPct: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => ledger({ softPct: Number.NaN })).toThrow();
    expect(() => ledger({ costMultiplier: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => ledger({ costMultiplier: Number.NaN })).toThrow();
    expect(() => ledger({ costAtStartUsd: -1 })).toThrow();
    expect(() => ledger({ costAtStartUsd: Number.NaN })).toThrow();
  });
});

describe('BudgetLedger fresh run: attempt spend equals cumulative spend', () => {
  it('has zero baselines and the thresholds behave as before', () => {
    const l = ledger();
    expect(l.baselineUsd).toBe(0);
    l.ingestSession(session('a', 3));
    l.ingestSession(session('b', 5.5));
    expect(l.attemptSpendUsd).toBeCloseTo(8.5);
    expect(l.cumulativeUsd).toBeCloseTo(8.5);
    expect(l.check()).toBe('soft');
  });

  it('treats an empty cost.jsonl like no cost.jsonl', () => {
    const l = ledger({ costLines: [] });
    l.ingestSession(session('a', 9.9));
    expect(l.attemptSpendUsd).toBe(l.cumulativeUsd);
    expect(l.check()).toBe('soft');
  });
});

describe('BudgetLedger resume across attempts', () => {
  /** Attempt 1 spent $4: plan session p1 ($1) and build session b1 ($3). */
  const attempt1 = [line('p1', 1, 'plan'), line('b1', 3, 'build', { parentId: 'p1' })];
  const watchedResume = (over: Partial<BudgetLedgerOptions> = {}) => {
    const l = ledger({ budgetUsd: 1, costLines: attempt1, costAtStartUsd: 4, ...over });
    const events: BudgetEvent[] = [];
    l.onEvent((e) => events.push(e));
    return { l, events };
  };
  /** What reconcile feeds: the earlier sessions with their final costs, in database order. */
  const ingestAttempt1 = (l: BudgetLedger) => {
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('b1', 3, { parentID: 'p1' }));
  };

  it('counts the earlier sessions in the cumulative total only, so a small budget does not stop at once', () => {
    const { l, events } = watchedResume();
    ingestAttempt1(l);
    expect(l.cumulativeUsd).toBeCloseTo(4);
    expect(l.baselineUsd).toBeCloseTo(4);
    expect(l.attemptSpendUsd).toBe(0);
    expect(l.check()).toBe('ok');
    expect(events).toEqual([]);
  });

  it('adds new attempt-2 sessions and growth of old ones, without double-counting attempt 1', () => {
    const { l } = watchedResume({ budgetUsd: 10 });
    ingestAttempt1(l);
    l.ingestSession(session('b1', 3.25, { parentID: 'p1' })); // old session grows by 0.25
    l.ingestSession(session('n1', 0.5)); // new in attempt 2
    expect(l.cumulativeUsd).toBeCloseTo(1 + 3.25 + 0.5);
    expect(l.attemptSpendUsd).toBeCloseTo(0.75);
  });

  it('fires soft at 85% and hard at 100% of the attempt budget, once each', () => {
    const { l, events } = watchedResume({ budgetUsd: 1 });
    ingestAttempt1(l);
    expect(l.check()).toBe('ok');
    l.ingestSession(session('n1', 0.84));
    expect(l.check()).toBe('ok');
    l.ingestSession(session('n1', 0.85));
    expect(l.check()).toBe('soft');
    expect(l.check()).toBe('soft');
    expect(events).toEqual(['soft']);
    l.ingestSession(session('b1', 3.2, { parentID: 'p1' })); // 0.85 + 0.2 = 1.05, clear of float noise
    expect(l.check()).toBe('hard');
    expect(l.check()).toBe('hard');
    l.ingestSession(session('n1', 5));
    l.check();
    expect(events).toEqual(['soft', 'hard']);
  });

  it('does not stop when the cumulative cost already passes the attempt budget', () => {
    const { l, events } = watchedResume({ budgetUsd: 2 });
    ingestAttempt1(l);
    expect(l.cumulativeUsd).toBeGreaterThan(l.hardLimitUsd);
    expect(l.check()).toBe('ok');
    expect(events).toEqual([]);
  });

  it('applies the cost multiplier to attempt spend and baseline', () => {
    const { l } = watchedResume({ budgetUsd: 10, costMultiplier: 2, costAtStartUsd: 8 });
    ingestAttempt1(l);
    l.ingestSession(session('n1', 1));
    expect(l.baselineUsd).toBeCloseTo(8);
    expect(l.cumulativeUsd).toBeCloseTo(10);
    expect(l.attemptSpendUsd).toBeCloseTo(2);
  });

  it('ignores a session whose cost went down (stale snapshot) instead of subtracting it', () => {
    const { l } = watchedResume({ budgetUsd: 10 });
    ingestAttempt1(l);
    l.ingestSession(session('b1', 2, { parentID: 'p1' })); // below its baseline of 3
    l.ingestSession(session('n1', 0.5));
    expect(l.attemptSpendUsd).toBeCloseTo(0.5);
  });

  it('in tree mode only counts attributed sessions, baselines included', () => {
    const l = ledger({ attribution: 'tree', rootSessionIds: ['p1'], budgetUsd: 10, costLines: attempt1, costAtStartUsd: 4 });
    ingestAttempt1(l);
    l.ingestSession(session('stranger', 50));
    l.ingestSession(session('n1', 1, { parentID: 'b1' }));
    expect(l.cumulativeUsd).toBeCloseTo(5);
    expect(l.attemptSpendUsd).toBeCloseTo(1);
  });

  it('keeps old sessions in their phase and emits no duplicate cost lines for unchanged sessions', () => {
    const { l } = watchedResume({ budgetUsd: 10 });
    ingestAttempt1(l);
    // the orchestrator of attempt 2 is in the build phase and knows nothing about the old sessions
    expect(l.toCostLines(() => 'build')).toEqual([]);
    const byPhase = l.perPhase(() => 'build');
    expect(byPhase.plan.costUsd).toBe(1);
    expect(byPhase.build.costUsd).toBe(3);
    expect(l.perPhase().plan.costUsd).toBe(1);

    l.ingestSession(session('p1', 1.5)); // old plan session grows
    l.ingestSession(session('n1', 0.5));
    const lines = l.toCostLines(() => 'report');
    expect(lines.map((x) => [x.sessionId, x.phase, x.costUsd])).toEqual([
      ['p1', 'plan', 1.5],
      ['n1', 'report', 0.5],
    ]);
    // running total continues from the earlier lines (1.5 + 3 + 0.5), not from zero
    expect(lines[1]?.totalUsd).toBeCloseTo(5);
    expect(l.toCostLines(() => 'report')).toEqual([]);
    const after = l.perPhase(() => 'report');
    expect(after.plan.costUsd).toBe(1.5);
    expect(after.build.costUsd).toBe(3);
    expect(after.report.costUsd).toBe(0.5);
  });

  it('uses the latest cost.jsonl line per session as baseline and emitted value', () => {
    const lines = [line('a', 1), line('b', 2, 'build'), line('a', 1.5), line('a', 2, 'plan', { totalUsd: 4 })];
    const l = ledger({ budgetUsd: 10, costLines: lines, costAtStartUsd: 4 });
    expect(l.baselineUsd).toBeCloseTo(4);
    l.ingestSession(session('a', 2));
    l.ingestSession(session('b', 2));
    expect(l.attemptSpendUsd).toBe(0);
    expect(l.toCostLines(() => 'build')).toEqual([]);
  });

  it('keeps the estimated flag of an emitted line, so an estimate that becomes a real cost is re-emitted', () => {
    const l = ledger({ budgetUsd: 10, costLines: [line('a', 0.4, 'plan', { estimated: true, source: 'estimate' })] });
    l.ingestSession(session('a', 0.4));
    expect(l.toCostLines(() => 'plan')).toHaveLength(1);
  });
});

describe('BudgetLedger crash mid-attempt (cost.jsonl lags behind the database)', () => {
  it('over-counts by at most the lag of the lagging session, never under-counts', () => {
    // At crash time the database knew b1 at $3.6 and p1 at $1, but cost.jsonl only got b1 up to $3.
    const lagging = [line('p1', 1), line('b1', 3, 'build')];
    const l = ledger({ budgetUsd: 10, costLines: lagging, costAtStartUsd: 4 });
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('b1', 3.6)); // true attempt-1 cost, 0.6 not yet in cost.jsonl
    l.ingestSession(session('n1', 0.4)); // real attempt-2 spend
    const trueAttempt2 = 0.4;
    const lag = 0.6;
    expect(l.attemptSpendUsd).toBeGreaterThanOrEqual(trueAttempt2);
    expect(l.attemptSpendUsd).toBeLessThanOrEqual(trueAttempt2 + lag + 1e-9);
    expect(l.attemptSpendUsd).toBeCloseTo(1.0);
    expect(l.cumulativeUsd).toBeCloseTo(5.0);
  });

  it('a lag can trip a stop earlier than strictly necessary, which is the safe side', () => {
    const l = ledger({ budgetUsd: 1, costLines: [line('b1', 3, 'build')], costAtStartUsd: 3.9 });
    const events: BudgetEvent[] = [];
    l.onEvent((e) => events.push(e));
    l.ingestSession(session('b1', 3.9));
    // the true attempt-2 spend is 0, but the 0.9 of lag is counted: 0.9 >= soft (0.85)
    expect(l.attemptSpendUsd).toBeCloseTo(0.9);
    expect(l.check()).toBe('soft');
    expect(events).toEqual(['soft']);
  });

  it('a session missing from cost.jsonl counts in full', () => {
    const l = ledger({ budgetUsd: 10, costLines: [line('p1', 1)], costAtStartUsd: 1 });
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('lost', 2)); // existed before the crash, never made it into cost.jsonl
    expect(l.attemptSpendUsd).toBeCloseTo(2);
  });

  it('a restart inside the same attempt cannot hide its spend (costAtStartUsd floor)', () => {
    // fresh run, attempt 1 started with 0; the orchestrator restarted after cost.jsonl already caught up to $9
    const l = ledger({ budgetUsd: 10, costLines: [line('a', 9)], costAtStartUsd: 0 });
    l.ingestSession(session('a', 9));
    expect(l.attemptSpendUsd).toBeCloseTo(9);
    expect(l.check()).toBe('soft');
    l.ingestSession(session('a', 10));
    expect(l.check()).toBe('hard');
  });
});

describe('BudgetLedger cost lines and phases', () => {
  const phaseOf = (id: string) => (id.startsWith('p') ? ('plan' as const) : ('build' as const));

  it('emits deltas only, with parent links and running totals, and validates against CostLine', () => {
    const l = ledger({ costMultiplier: 2 });
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('b1', 2, { parentID: 'p1' }));
    const first = l.toCostLines(phaseOf);
    expect(first.map((x) => [x.sessionId, x.parentId, x.phase, x.costUsd, x.totalUsd])).toEqual([
      ['p1', null, 'plan', 1, 2],
      ['b1', 'p1', 'build', 2, 6],
    ]);
    for (const x of first) expect(() => CostLine.parse(x)).not.toThrow();
    expect(first[0]).toMatchObject({ ts: '2026-10-21T10:00:00.000Z', source: 'session-info', estimated: false });

    expect(l.toCostLines(phaseOf)).toEqual([]); // nothing changed
    l.ingestSession(session('b1', 3, { parentID: 'p1' }));
    const second = l.toCostLines(phaseOf);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ sessionId: 'b1', costUsd: 3, totalUsd: 8 });
  });

  it('splits totals per phase and reports unphased sessions', () => {
    const l = ledger();
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('b1', 2));
    l.ingestSession(session('b2', 0.5));
    l.ingestSession(
      session('r1', 0, { tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    );
    const byFn = l.perPhase((id) => (id.startsWith('p') ? 'plan' : id.startsWith('r') ? 'review' : 'build'));
    expect(byFn.plan.costUsd).toBe(1);
    expect(byFn.build.costUsd).toBe(2.5);
    expect(byFn.review.estimatedUsd).toBeGreaterThan(0);
    expect(byFn.report.effectiveUsd).toBe(0);

    // remembered phases via toCostLines
    const l2 = ledger();
    l2.ingestSession(session('p1', 1));
    l2.ingestSession(session('b1', 2));
    expect(l2.perPhase().unassigned.costUsd).toBe(3);
    l2.toCostLines(phaseOf);
    const p = l2.perPhase();
    expect(p.plan.costUsd).toBe(1);
    expect(p.build.costUsd).toBe(2);
    expect(p.unassigned.costUsd).toBe(0);
    const sum = Object.values(p).reduce((s, t) => s + t.effectiveUsd, 0);
    expect(sum).toBeCloseTo(l2.total().effectiveUsd);
  });
});

describe('BudgetLedger overshoot tolerance', () => {
  it('sums the largest observed step of each busy session', () => {
    const l = ledger();
    l.ingestSession(session('a', 1));
    l.ingestSession(session('a', 1.5)); // step 0.5
    l.ingestSession(session('a', 3.5)); // step 2
    l.ingestSession(session('a', 4)); // step 0.5
    l.ingestSession(session('b', 0));
    l.ingestSession(session('b', 0.3)); // step 0.3
    l.ingestSession(session('c', 9)); // not busy
    expect(l.overshootTolerance(['a', 'b'])).toBeCloseTo(2.3);
    expect(l.overshootTolerance(['a'])).toBeCloseTo(2);
    expect(l.overshootTolerance(['a', 'a', 'nope'])).toBeCloseTo(2);
    expect(l.overshootTolerance([])).toBe(0);
  });

  it('ignores decreases, is idempotent, and scales with the multiplier', () => {
    const l = ledger({ costMultiplier: 3 });
    l.ingestSession(session('a', 2));
    l.ingestSession(session('a', 2));
    l.ingestSession(session('a', 1)); // stale lower snapshot: not a step
    l.ingestSession(session('a', 1.5)); // step 0.5
    expect(l.overshootTolerance(['a'])).toBeCloseTo(2 * 3); // first step 2 is the max
  });
});

describe('BudgetLedger baseline clamp, restart inside an attempt, and once-per-ledger events', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const haiku = { providerID: 'anthropic', id: 'claude-haiku-5-5' };

  it('counts growth from a lower real cost that replaced a higher estimate (no under-count)', () => {
    const estimate = estimateCost({ input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 'anthropic/claude-haiku-5-5');
    expect(estimate).toBeGreaterThan(0.3);
    const prior = [line('a', estimate, 'build', { estimated: true, source: 'estimate' })];
    // the costAtStart floor (0.3 - estimate < 0) cannot help here: the clamp is what carries the growth
    const clamped = ledger({ budgetUsd: 10, costLines: prior, costAtStartUsd: estimate });
    clamped.ingestSession(session('a', 0.1, { tokens }));
    clamped.ingestSession(session('a', 0.3, { tokens }));
    expect(clamped.baselineUsd).toBeCloseTo(0.1);
    expect(clamped.attemptSpendUsd).toBeCloseTo(0.2);
  });

  it('clamps a lower re-estimate the same way, and never raises a baseline', () => {
    const high = estimateCost(tokens, 'anthropic/claude-haiku-5-5');
    const l = ledger({ budgetUsd: 10, costLines: [line('a', high, 'build', { estimated: true, source: 'estimate' })], costAtStartUsd: high });
    l.ingestSession(session('a', 0, { model: haiku, tokens: { ...tokens, input: 500_000 } })); // re-estimate: half
    expect(l.baselineUsd).toBeCloseTo(high / 2);
    // a higher first value leaves the baseline alone
    const m = ledger({ budgetUsd: 10, costLines: [line('a', 1)], costAtStartUsd: 1 });
    m.ingestSession(session('a', 2.5));
    expect(m.baselineUsd).toBe(1);
    expect(m.attemptSpendUsd).toBeCloseTo(1.5);
    // only the first ingest clamps: a later dip does not move it again
    const n = ledger({ budgetUsd: 10, costLines: [line('a', 3)], costAtStartUsd: 3 });
    n.ingestSession(session('a', 3));
    n.ingestSession(session('a', 1));
    expect(n.baselineUsd).toBe(3);
  });

  it('a restart inside attempt 2 counts only attempt 2: n1 is already in cost.jsonl', () => {
    const lines = [line('p1', 1, 'plan'), line('b1', 3, 'build'), line('n1', 0.6, 'build')];
    const l = ledger({ budgetUsd: 10, costLines: lines, costAtStartUsd: 4 });
    l.ingestSession(session('p1', 1));
    l.ingestSession(session('b1', 3));
    l.ingestSession(session('n1', 0.8));
    expect(l.attemptSpendUsd).toBeCloseTo(0.8); // 0.6 from before the restart + 0.2 of growth, via the floor
    expect(l.cumulativeUsd).toBeCloseTo(4.8);
  });

  it('a new ledger (a restart) fires soft again: the events are once per ledger, i.e. once per process', () => {
    const lines = [line('a', 0.9, 'build')];
    const first = ledger({ budgetUsd: 1, costLines: lines, costAtStartUsd: 0 });
    const e1: BudgetEvent[] = [];
    first.onEvent((e) => e1.push(e));
    first.ingestSession(session('a', 0.9));
    first.check();
    first.check();
    expect(e1).toEqual(['soft']);
    // the process restarts: the same spend, a fresh ledger, the floor keeps it above soft
    const second = ledger({ budgetUsd: 1, costLines: lines, costAtStartUsd: 0 });
    const e2: BudgetEvent[] = [];
    second.onEvent((e) => e2.push(e));
    second.ingestSession(session('a', 0.9));
    second.check();
    expect(e2).toEqual(['soft']);
  });
});
