/**
 * Budget ledger. Pure and deterministic: callers feed it `Session.Info` snapshots
 * (from polling or `session.usage.updated`) and ask for totals, threshold transitions,
 * `cost.jsonl` deltas and the overshoot tolerance.
 *
 * - `Session.Info.cost` is the per-session source of truth (cumulative, already includes title
 *   and compaction); the latest ingested value wins, so ingesting is idempotent.
 * - When a session reports cost 0 but has tokens, a price-table estimate is used and the
 *   session is marked estimated.
 * - Cumulative vs attempt spend. A run can be resumed, and each attempt has its own budget. The ledger total over
 *   every session in the run's database is the *cumulative* cost (never under-counts: the database survives across
 *   attempts). The *attempt spend* is what the soft and hard thresholds compare with `budgetUsd`: per session,
 *   `max(0, current - baseline)` where the baseline is the session's latest `cost.jsonl` line at construction
 *   (`costLines`), plus the whole cost of any session new in this attempt. With no `cost.jsonl` every baseline is 0 and
 *   attempt spend equals cumulative spend. If `cost.jsonl` lags behind the database after a crash the baselines are
 *   too low, so the attempt spend over-counts: the safe direction. As a second floor, when `costAtStartUsd` is given
 *   (the cumulative cost recorded when the attempt began) the attempt spend is never below `cumulative - costAtStart`,
 *   so a restart inside the same attempt, whose own lines are already in `cost.jsonl`, cannot hide that attempt's spend.
 * - Attribution: `isolated-db` (default; the run has its own XDG_DATA_HOME so every session is
 *   ours) or `tree` (only sessions whose `parentID` chain reaches a root session count; a child
 *   seen before its parent stays pending and is resolved lazily once the parent arrives).
 */
import type { CostLine, Phase, SessionInfo } from './contracts.ts';
import { PHASES } from './contracts.ts';
import { estimateCost, totalTokens } from './pricing.ts';

export type AttributionMode = 'isolated-db' | 'tree';
export type BudgetLevel = 'ok' | 'soft' | 'hard';
export type BudgetEvent = 'soft' | 'hard';

export interface BudgetLedgerOptions {
  budgetUsd: number;
  /** Fraction of budget that triggers `soft`. */
  softPct: number;
  /** Fraction of budget that triggers `hard`. */
  hardPct: number;
  /** Multiplies every observed cost (smoke tests). */
  costMultiplier: number;
  /** Root sessions (only consulted in `tree` mode; more can be added with `addRootSession`). */
  rootSessionIds?: readonly string[];
  /** Defaults to `isolated-db`. */
  attribution?: AttributionMode;
  /** Clock for `cost.jsonl` timestamps. */
  now?: () => Date;
  /**
   * The existing `cost.jsonl` lines (file order; the latest line per session wins). They seed the per-session baselines
   * (attempt spend), the already-emitted state (no duplicate lines) and the per-session phases (old sessions keep their
   * phase). Omit on a fresh run.
   */
  costLines?: readonly CostLine[];
  /**
   * The cumulative effective cost (already multiplied) recorded when this attempt began. Floors the attempt spend at
   * `cumulative - costAtStartUsd`. Defaults to 0 (no floor beyond the per-session measure).
   */
  costAtStartUsd?: number;
}

export interface BudgetTotals {
  /** Sum of server-reported session costs (raw, before the multiplier). */
  costUsd: number;
  /** Sum of price-table estimates for sessions that reported no cost (raw). */
  estimatedUsd: number;
  /** `(costUsd + estimatedUsd) * costMultiplier`: what budget decisions use. */
  effectiveUsd: number;
}

export type PhaseTotals = Record<Phase | 'unassigned', BudgetTotals>;

interface SessionRecord {
  id: string;
  parentId: string | undefined;
  /** Current absolute value: reported cost, or the estimate when `estimated`. */
  valueUsd: number;
  estimated: boolean;
  /** Last model seen (`provider/id`), kept for estimates when a later snapshot omits it. */
  model: string | undefined;
  /** Largest positive increment between successive ingests (raw units; first ingest counts from 0). */
  maxStepUsd: number;
}

interface EmittedRecord {
  valueUsd: number;
  estimated: boolean;
}

const LEVEL_RANK: Record<BudgetLevel, number> = { ok: 0, soft: 1, hard: 2 };

function emptyTotals(): BudgetTotals {
  return { costUsd: 0, estimatedUsd: 0, effectiveUsd: 0 };
}

export class BudgetLedger {
  readonly budgetUsd: number;
  readonly softPct: number;
  readonly hardPct: number;
  readonly costMultiplier: number;
  readonly attribution: AttributionMode;

  private readonly roots = new Set<string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly emitted = new Map<string, EmittedRecord>();
  private readonly phases = new Map<string, Phase>();
  /** Phases of sessions that already had a `cost.jsonl` line at construction. They never change. */
  private readonly seededPhases = new Map<string, Phase>();
  /** Raw cost of each session at the start of this attempt (latest `cost.jsonl` line). */
  private readonly baselines = new Map<string, number>();
  private readonly costAtStartUsd: number;
  private readonly listeners = new Set<(event: BudgetEvent) => void>();
  private readonly fired = new Set<BudgetEvent>();
  private level: BudgetLevel = 'ok';
  private readonly now: () => Date;

  constructor(opts: BudgetLedgerOptions) {
    // `x > 0` is false for NaN, but true for Infinity: an infinite budget or percentage would disable the hard stop.
    if (!Number.isFinite(opts.budgetUsd) || !(opts.budgetUsd > 0)) {
      throw new Error(`budgetUsd must be a finite number > 0 (got ${opts.budgetUsd})`);
    }
    if (
      !Number.isFinite(opts.softPct) ||
      !Number.isFinite(opts.hardPct) ||
      !(opts.softPct > 0) ||
      !(opts.hardPct > 0) ||
      opts.softPct > opts.hardPct
    ) {
      throw new Error(`Need finite 0 < softPct <= hardPct (got ${opts.softPct}, ${opts.hardPct})`);
    }
    if (!Number.isFinite(opts.costMultiplier) || !(opts.costMultiplier > 0)) {
      throw new Error(`costMultiplier must be a finite number > 0 (got ${opts.costMultiplier})`);
    }
    const costAtStart = opts.costAtStartUsd ?? 0;
    if (!Number.isFinite(costAtStart) || costAtStart < 0) {
      throw new Error(`costAtStartUsd must be a finite number >= 0 (got ${costAtStart})`);
    }
    this.costAtStartUsd = costAtStart;
    this.budgetUsd = opts.budgetUsd;
    this.softPct = opts.softPct;
    this.hardPct = opts.hardPct;
    this.costMultiplier = opts.costMultiplier;
    this.attribution = opts.attribution ?? 'isolated-db';
    this.now = opts.now ?? (() => new Date());
    for (const id of opts.rootSessionIds ?? []) this.roots.add(id);
    for (const line of opts.costLines ?? []) {
      // file order: the latest line per session wins
      this.baselines.set(line.sessionId, line.costUsd);
      this.emitted.set(line.sessionId, { valueUsd: line.costUsd, estimated: line.estimated });
      this.phases.set(line.sessionId, line.phase);
      this.seededPhases.set(line.sessionId, line.phase);
    }
  }

  // --- ingest ---------------------------------------------------------------

  /** Register a further root session (e.g. the next phase's root). */
  addRootSession(sessionId: string): void {
    this.roots.add(sessionId);
  }

  /**
   * Record the latest snapshot of a session. Idempotent: re-ingesting the same snapshot changes
   * nothing. Returns true when the session's tracked value, parent or estimate flag changed.
   */
  ingestSession(info: SessionInfo): boolean {
    const prev = this.sessions.get(info.id);
    const model = info.model ? `${info.model.providerID}/${info.model.id}` : prev?.model;
    const reported = Number.isFinite(info.cost) && info.cost > 0 ? info.cost : 0;

    let valueUsd = reported;
    let estimated = false;
    if (reported === 0 && totalTokens(info.tokens) > 0) {
      valueUsd = estimateCost(info.tokens, model);
      estimated = true;
    }

    const parentId = info.parentID ?? prev?.parentId;
    const step = Math.max(0, valueUsd - (prev?.valueUsd ?? 0));
    const rec: SessionRecord = {
      id: info.id,
      parentId,
      valueUsd,
      estimated,
      model,
      maxStepUsd: Math.max(prev?.maxStepUsd ?? 0, step),
    };
    this.sessions.set(info.id, rec);
    return !prev || prev.valueUsd !== valueUsd || prev.estimated !== estimated || prev.parentId !== parentId;
  }

  // --- attribution ----------------------------------------------------------

  private isCounted(id: string): boolean {
    if (this.attribution === 'isolated-db') return true;
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined) {
      if (this.roots.has(cur)) return true;
      if (seen.has(cur)) return false; // cycle: never reaches a root
      seen.add(cur);
      cur = this.sessions.get(cur)?.parentId;
    }
    return false;
  }

  /**
   * `tree` mode only: ingested sessions whose chain ends at a parent we have not seen yet
   * (they will be counted automatically if that parent turns out to descend from a root).
   */
  pendingSessionIds(): string[] {
    if (this.attribution !== 'tree') return [];
    const out: string[] = [];
    for (const rec of this.sessions.values()) {
      const seen = new Set<string>();
      let cur: string | undefined = rec.id;
      while (cur !== undefined) {
        if (this.roots.has(cur) || seen.has(cur)) break;
        seen.add(cur);
        const parent: string | undefined = this.sessions.get(cur)?.parentId;
        if (parent !== undefined && !this.sessions.has(parent) && !this.roots.has(parent)) {
          out.push(rec.id);
          break;
        }
        cur = parent;
      }
    }
    return out;
  }

  private countedRecords(): SessionRecord[] {
    return [...this.sessions.values()].filter((r) => this.isCounted(r.id));
  }

  // --- totals ---------------------------------------------------------------

  private totalsOf(records: Iterable<Pick<SessionRecord, 'valueUsd' | 'estimated'>>): BudgetTotals {
    let costUsd = 0;
    let estimatedUsd = 0;
    for (const r of records) {
      if (r.estimated) estimatedUsd += r.valueUsd;
      else costUsd += r.valueUsd;
    }
    return { costUsd, estimatedUsd, effectiveUsd: (costUsd + estimatedUsd) * this.costMultiplier };
  }

  /** Cumulative totals over every counted session in the run's database, across all attempts. */
  total(): BudgetTotals {
    return this.totalsOf(this.countedRecords());
  }

  /** Cumulative effective cost of the run (all attempts). The source of truth; never under-counts. */
  get cumulativeUsd(): number {
    return this.total().effectiveUsd;
  }

  /** Effective cost already recorded in `cost.jsonl` when this ledger was built (the sum of the session baselines). */
  get baselineUsd(): number {
    let raw = 0;
    for (const v of this.baselines.values()) raw += v;
    return raw * this.costMultiplier;
  }

  /**
   * Effective spend of this attempt: the sum over counted sessions of `max(0, current - baseline)` (a session new in
   * this attempt has baseline 0), floored at `cumulative - costAtStartUsd`. This is what the thresholds use.
   */
  get attemptSpendUsd(): number {
    let raw = 0;
    for (const r of this.countedRecords()) raw += Math.max(0, r.valueUsd - (this.baselines.get(r.id) ?? 0));
    return Math.max(raw * this.costMultiplier, this.cumulativeUsd - this.costAtStartUsd);
  }

  /**
   * Totals by phase. Uses `phaseOf` when given, else the phases remembered from earlier
   * `toCostLines` calls. Counted sessions with no known phase land in `unassigned`.
   */
  perPhase(phaseOf?: (sessionId: string) => Phase): PhaseTotals {
    const groups = new Map<Phase | 'unassigned', SessionRecord[]>();
    for (const rec of this.countedRecords()) {
      const phase = this.seededPhases.get(rec.id) ?? (phaseOf ? phaseOf(rec.id) : (this.phases.get(rec.id) ?? 'unassigned'));
      const list = groups.get(phase) ?? [];
      list.push(rec);
      groups.set(phase, list);
    }
    const out = { unassigned: emptyTotals() } as PhaseTotals;
    for (const p of PHASES) out[p] = emptyTotals();
    for (const [phase, list] of groups) out[phase] = this.totalsOf(list);
    return out;
  }

  // --- thresholds -----------------------------------------------------------

  /** `budgetUsd` is the current attempt's budget; the limits below apply to the attempt spend. */
  get softLimitUsd(): number {
    return this.budgetUsd * this.softPct;
  }

  get hardLimitUsd(): number {
    return this.budgetUsd * this.hardPct;
  }

  /** Subscribe to the one-shot `soft` / `hard` transition events. Returns an unsubscribe fn. */
  onEvent(listener: (event: BudgetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fire(event: BudgetEvent): void {
    if (this.fired.has(event)) return;
    this.fired.add(event);
    for (const l of this.listeners) l(event);
  }

  /**
   * Evaluate the thresholds against the attempt spend (see `attemptSpendUsd`). Each of `soft` and `hard` is emitted at most once, `soft` first
   * (a jump straight past hard emits both). The returned level is sticky: once reached it is
   * not revoked even if a later snapshot lowers the total.
   */
  check(): BudgetLevel {
    const effective = this.attemptSpendUsd;
    let now: BudgetLevel = 'ok';
    if (effective >= this.hardLimitUsd) now = 'hard';
    else if (effective >= this.softLimitUsd) now = 'soft';
    if (LEVEL_RANK[now] > LEVEL_RANK[this.level]) this.level = now;
    if (LEVEL_RANK[this.level] >= LEVEL_RANK.soft) this.fire('soft');
    if (LEVEL_RANK[this.level] >= LEVEL_RANK.hard) this.fire('hard');
    return this.level;
  }

  // --- cost.jsonl -----------------------------------------------------------

  /**
   * Lines for counted sessions whose value changed since the previous call (new sessions are
   * always emitted once, even at $0, to record the parent link). `costUsd` is the session's raw
   * absolute value; `totalUsd` is the effective (multiplied) run total after applying the line.
   * Sessions are processed in ingest order.
   */
  toCostLines(phaseOf: (sessionId: string) => Phase): CostLine[] {
    const ts = this.now().toISOString();
    let runningRaw = 0;
    for (const e of this.emitted.values()) runningRaw += e.valueUsd;

    const lines: CostLine[] = [];
    for (const rec of this.countedRecords()) {
      const last = this.emitted.get(rec.id);
      if (last && last.valueUsd === rec.valueUsd && last.estimated === rec.estimated) continue;
      runningRaw += rec.valueUsd - (last?.valueUsd ?? 0);
      const phase = this.seededPhases.get(rec.id) ?? phaseOf(rec.id);
      this.phases.set(rec.id, phase);
      this.emitted.set(rec.id, { valueUsd: rec.valueUsd, estimated: rec.estimated });
      lines.push({
        ts,
        sessionId: rec.id,
        parentId: rec.parentId ?? null,
        phase,
        costUsd: rec.valueUsd,
        estimated: rec.estimated,
        source: rec.estimated ? 'estimate' : 'session-info',
        totalUsd: runningRaw * this.costMultiplier,
      });
    }
    return lines;
  }

  // --- Overshoot tolerance --------------------------------------------------------

  /**
   * Upper bound on spend that may land after a threshold trips: the sum, over the
   * sessions that were busy, of each one's largest observed step (largest increment between
   * successive ingests; the first ingest counts from 0, which is deliberately conservative).
   * Multiplied by `costMultiplier`. Unknown sessions contribute 0.
   */
  overshootTolerance(busySessionIds: Iterable<string>): number {
    let sum = 0;
    for (const id of new Set(busySessionIds)) sum += this.sessions.get(id)?.maxStepUsd ?? 0;
    return sum * this.costMultiplier;
  }
}
