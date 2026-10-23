/**
 * Budget ledger. Pure and deterministic: callers feed it `Session.Info` snapshots
 * (from polling or `session.usage.updated`) and ask for totals, threshold transitions,
 * `cost.jsonl` deltas and the overshoot tolerance.
 *
 * - `Session.Info.cost` is the per-session source of truth (cumulative, already includes title
 *   and compaction); the latest ingested value wins, so ingesting is idempotent.
 * - When a session reports cost 0 but has tokens, a price-table estimate is used and the
 *   session is marked estimated.
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
  private readonly listeners = new Set<(event: BudgetEvent) => void>();
  private readonly fired = new Set<BudgetEvent>();
  private level: BudgetLevel = 'ok';
  private readonly now: () => Date;

  constructor(opts: BudgetLedgerOptions) {
    if (!(opts.budgetUsd > 0)) throw new Error(`budgetUsd must be > 0 (got ${opts.budgetUsd})`);
    if (!(opts.softPct > 0) || !(opts.hardPct > 0) || opts.softPct > opts.hardPct) {
      throw new Error(`Need 0 < softPct <= hardPct (got ${opts.softPct}, ${opts.hardPct})`);
    }
    if (!(opts.costMultiplier > 0)) throw new Error(`costMultiplier must be > 0 (got ${opts.costMultiplier})`);
    this.budgetUsd = opts.budgetUsd;
    this.softPct = opts.softPct;
    this.hardPct = opts.hardPct;
    this.costMultiplier = opts.costMultiplier;
    this.attribution = opts.attribution ?? 'isolated-db';
    this.now = opts.now ?? (() => new Date());
    for (const id of opts.rootSessionIds ?? []) this.roots.add(id);
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

  total(): BudgetTotals {
    return this.totalsOf(this.countedRecords());
  }

  /**
   * Totals by phase. Uses `phaseOf` when given, else the phases remembered from earlier
   * `toCostLines` calls. Counted sessions with no known phase land in `unassigned`.
   */
  perPhase(phaseOf?: (sessionId: string) => Phase): PhaseTotals {
    const groups = new Map<Phase | 'unassigned', SessionRecord[]>();
    for (const rec of this.countedRecords()) {
      const phase = phaseOf ? phaseOf(rec.id) : (this.phases.get(rec.id) ?? 'unassigned');
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
   * Evaluate the thresholds. Each of `soft` and `hard` is emitted at most once, `soft` first
   * (a jump straight past hard emits both). The returned level is sticky: once reached it is
   * not revoked even if a later snapshot lowers the total.
   */
  check(): BudgetLevel {
    const effective = this.total().effectiveUsd;
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
      const phase = phaseOf(rec.id);
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
