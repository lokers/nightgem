/**
 * Pinned price table used ONLY as a fallback estimate when the server reports `cost` 0 (or
 * missing) for a session that has consumed tokens ("missing cost"). `Session.Info.cost`
 * is always the source of truth when it is non-zero.
 *
 * Pure module: no I/O.
 */

/** USD per million tokens. */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Token counts as found on `Session.Info.tokens`. Every field is optional/lenient. */
export interface TokenCounts {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * APPROXIMATE placeholder rates (USD per MTok), keyed by bare model id (no provider prefix).
 * They are NOT authoritative and are only used when the server reports cost 0 for a session
 * that has tokens. Update them when real prices are known; the ledger never prefers them over
 * a reported cost.
 */
export const APPROXIMATE_RATES_USD_PER_MTOK = {
  'claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
} as const satisfies Record<string, ModelRates>;

export type PricedModel = keyof typeof APPROXIMATE_RATES_USD_PER_MTOK;

/** Models that are not in the table are priced as Opus (the most expensive, so budgets stay safe). */
export const FALLBACK_MODEL: PricedModel = 'claude-opus-5-5';

/** Strip an optional `providerID/` prefix. */
function bareModelId(modelId: string): string {
  const i = modelId.indexOf('/');
  return (i >= 0 ? modelId.slice(i + 1) : modelId).trim().toLowerCase();
}

/**
 * Resolve rates for `anthropic/claude-sonnet-5-5`, `claude-sonnet-5-5` or a dated variant such
 * as `claude-sonnet-5-5-20261001`. Unknown or missing models resolve to the Opus rates.
 */
export function ratesFor(modelId: string | undefined): ModelRates {
  if (modelId) {
    const id = bareModelId(modelId);
    for (const key of Object.keys(APPROXIMATE_RATES_USD_PER_MTOK) as PricedModel[]) {
      if (id === key || id.startsWith(`${key}-`)) return APPROXIMATE_RATES_USD_PER_MTOK[key];
    }
  }
  return APPROXIMATE_RATES_USD_PER_MTOK[FALLBACK_MODEL];
}

/** Total of all token counters (used to decide whether a zero-cost session actually did work). */
export function totalTokens(tokens: TokenCounts | undefined): number {
  if (!tokens) return 0;
  return (
    Math.max(0, tokens.input ?? 0) +
    Math.max(0, tokens.output ?? 0) +
    Math.max(0, tokens.reasoning ?? 0) +
    Math.max(0, tokens.cache?.read ?? 0) +
    Math.max(0, tokens.cache?.write ?? 0)
  );
}

/** Estimated USD for `tokens` on `modelId`. Reasoning tokens are billed as output. */
export function estimateCost(tokens: TokenCounts | undefined, modelId?: string): number {
  if (!tokens) return 0;
  const r = ratesFor(modelId);
  const perToken =
    Math.max(0, tokens.input ?? 0) * r.input +
    (Math.max(0, tokens.output ?? 0) + Math.max(0, tokens.reasoning ?? 0)) * r.output +
    Math.max(0, tokens.cache?.read ?? 0) * r.cacheRead +
    Math.max(0, tokens.cache?.write ?? 0) * r.cacheWrite;
  return perToken / 1_000_000;
}
