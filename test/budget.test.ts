import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BudgetLedger, type BudgetEvent, type BudgetLedgerOptions } from '../src/budget.ts';
import { CostLine, SessionInfo } from '../src/contracts.ts';
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
