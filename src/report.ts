/**
 * Deterministic REPORT.md generator (no LLM, no network).
 *
 * Inputs: RUN.json, tasks.jsonl (latest event per task id wins), decisions.jsonl, cost.jsonl and
 * the existing REPORT.md (only its `## Narrative` section is carried over). It tolerates missing
 * or empty files and never throws on git failures: those render as "unknown" plus a note.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ZodError, type z } from 'zod';

import {
  CostLine,
  Decision,
  ManifestUpgradeError,
  RunManifest,
  TaskEvent,
  attemptsOf,
  isTerminalRunState,
  parseRunManifest,
  type CostLine as CostLineT,
  type Decision as DecisionT,
  type RepoEntry,
  type RunAttempt,
  type TaskEvent as TaskEventT,
} from './contracts.ts';
import {
  checkRemoteBranch,
  commitsBetween,
  currentBranch,
  defaultGit,
  diffBetween,
  headSha,
  porcelainHash,
  stashCount,
  type GitRunner,
  type RemoteBranchState,
} from './gitinfo.ts';
import type { RunPaths } from './paths.ts';
import { scanDiff, type SuppressionHit } from './suppressions.ts';

export const NARRATIVE_PLACEHOLDER = '(no narrative: run ended before report phase)';
const NARRATIVE_HEADING = '## Narrative';
const INTEGRATION_PREFIX = 'integration:';
const PHASE_PREFIX = 'phase:';
const WIND_DOWN_PREFIX = 'wind-down:';
/** The stop reason of a resume that was rolled back before it ran (see `resume`). */
const RESUME_FAILED = 'resume-failed';
export const FINAL_REVIEW_FILE = 'FINAL_REVIEW.md';
/** The checklist the review phase writes into the specs dir: what a human has to verify by hand. */
export const MANUAL_CHECKS_FILE = 'MANUAL_CHECKS.md';

export interface BuildReportInput {
  paths: RunPaths;
  git?: GitRunner;
}

// ---------------------------------------------------------------------------
// Reading artifacts
// ---------------------------------------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

interface Jsonl<T> {
  items: T[];
  skipped: number;
}

async function readJsonl<S extends z.ZodType>(path: string, schema: S): Promise<Jsonl<z.output<S>>> {
  const text = await readText(path);
  const items: z.output<S>[] = [];
  let skipped = 0;
  if (text === null) return { items, skipped };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) items.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { items, skipped };
}

async function readManifest(path: string): Promise<{ manifest: RunManifest | null; problem?: string }> {
  const text = await readText(path);
  if (text === null) return { manifest: null, problem: `RUN.json not found at ${path}` };
  try {
    // v1 and v2 manifests both load; v1 is upgraded in memory (nothing is rewritten).
    return { manifest: parseRunManifest(JSON.parse(text)) };
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return { manifest: null, problem: `RUN.json is invalid (${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'})` };
    }
    if (err instanceof ManifestUpgradeError) return { manifest: null, problem: `RUN.json is invalid (${errMsg(err)})` };
    return { manifest: null, problem: `RUN.json is unreadable (${errMsg(err)})` };
  }
}

/** Body of an existing `## Narrative` section (up to the next `## ` heading, fences respected). */
export function extractNarrative(markdown: string | null): string | null {
  if (markdown === null) return null;
  const all = markdown.split('\n');
  let start = -1;
  let fence: string | null = null;
  for (let i = 0; i < all.length; i++) {
    const line = all[i] ?? '';
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0] ?? null;
      else if (f[0] === fence) fence = null;
      continue;
    }
    if (fence === null && start === -1 && line.trimEnd() === NARRATIVE_HEADING) start = i;
  }
  if (start === -1) return null;
  const body: string[] = [];
  fence = null;
  for (let i = start + 1; i < all.length; i++) {
    const line = all[i] ?? '';
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0] ?? null;
      else if (f[0] === fence) fence = null;
    } else if (fence === null && /^## /.test(line)) {
      break;
    }
    body.push(line);
  }
  while (body.length > 0 && (body[0] ?? '').trim() === '') body.shift();
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
  const text = body.join('\n');
  return text.length === 0 || text === NARRATIVE_PLACEHOLDER ? null : text;
}

/**
 * `FINAL_REVIEW-attempt<n>.md` (specs dir) and `run-complete-attempt<n>.json` (run dir): the review markers a resume
 * renames before the next attempt starts. Sorted by attempt, then collision suffix, then name.
 */
async function readEarlierReviews(specsDir: string, runDir: string): Promise<EarlierReview[]> {
  const found: Array<EarlierReview & { n: number; k: number }> = [];
  const scan = async (dir: string, re: RegExp): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (m) found.push({ name, path: join(dir, name), n: Number(m[1]), k: Number(m[2] ?? 0) });
    }
  };
  await scan(specsDir, /^FINAL_REVIEW-attempt(\d+)(?:-(\d+))?\.md$/);
  await scan(runDir, /^run-complete-attempt(\d+)(?:-(\d+))?\.json$/);
  found.sort((a, b) => a.n - b.n || a.k - b.k || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found.map(({ name, path }) => ({ name, path }));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0] ?? m;
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

function short(sha: string): string {
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : sha;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function latestBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    map.delete(k); // keep first-seen order stable but let the latest value win
    map.set(k, it);
  }
  return [...map.values()];
}

/** Latest event per id, ordered by the first time the id was seen. */
function latestTasks(events: readonly TaskEventT[]): TaskEventT[] {
  const order: string[] = [];
  const latest = new Map<string, TaskEventT>();
  for (const e of events) {
    if (!latest.has(e.id)) order.push(e.id);
    latest.set(e.id, e);
  }
  return order.map((id) => latest.get(id) as TaskEventT);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Ctx {
  manifest: RunManifest | null;
  tasks: TaskEventT[]; // latest per id, regular tasks
  integrations: Map<string, TaskEventT>; // repo name -> latest integration event
  phaseEvents: TaskEventT[]; // every `phase:<name>` marker event, in file order
  finalReviewPath: string | null; // set when <specsDir>/FINAL_REVIEW.md exists
  finalReviewText: string | null; // its text
  /** `<specsDir>/MANUAL_CHECKS.md` and its text; `text` is null when the file does not exist. */
  manualChecks: { path: string; text: string | null };
  /** Review files renamed with an `-attempt<n>` suffix by a resume, in attempt order. */
  earlierReviews: EarlierReview[];
  decisions: DecisionT[];
  costs: CostLineT[];
  git: GitRunner;
  repoByName: Map<string, RepoEntry>;
  /** Push-check results, computed once before the sections are rendered. */
  pushChecks: PushCheck[];
  /** Suppression scan of each integration branch, computed once before the sections are rendered. */
  suppressionScans: SuppressionScan[];
}

interface SuppressionScan {
  repo: string;
  branch: string;
  /** The ref the diff was taken against; unset when no base is known. */
  base?: string;
  /** `null` = the diff could not be read (see `reason`). */
  hits: SuppressionHit[] | null;
  reason?: string;
}

interface EarlierReview {
  name: string;
  path: string;
}

interface PushCheck {
  repo: string;
  branch: string;
  state: RemoteBranchState | 'no-repo';
  reason?: string;
}

/** Sum of the attempts' own durations (the gaps between a stop and a resume are not run time). */
function attemptsDuration(attempts: readonly RunAttempt[]): string {
  let total = 0;
  for (const a of attempts) {
    if (!a.endedAt) return 'unknown (an attempt has no end time)';
    total += Date.parse(a.endedAt) - Date.parse(a.startedAt);
  }
  return `${formatDuration(total)} (sum of attempts)`;
}

/** Attempt spend of the last attempt: its recorded figure, else the cumulative cost minus the cost at its start. */
function attemptSpend(m: RunManifest, a: RunAttempt, isLast: boolean): number | null {
  if (a.costUsd !== undefined) return a.costUsd;
  return isLast ? Math.max(0, m.costUsd - a.costAtStartUsd) : null;
}

/** The last attempt that actually ran: a rolled-back resume (`resume-failed`) never did, and the run's budget is the one before it. */
function lastRanAttempt(attempts: readonly RunAttempt[]): RunAttempt | undefined {
  return attempts.filter((a) => a.stopReason !== RESUME_FAILED).at(-1);
}

function attemptsTable(m: RunManifest): string[] {
  const attempts = attemptsOf(m);
  const lastRan = lastRanAttempt(attempts);
  const out = ['', '### Attempts', '', '| n | Started | Ended | State | Stop reason | Budget | Attempt spend |', '| --- | --- | --- | --- | --- | --- | --- |'];
  attempts.forEach((a, i) => {
    const spend = attemptSpend(m, a, a === lastRan);
    out.push(
      `| ${a.n} | ${cell(a.startedAt)} | ${cell(a.endedAt ?? '(not ended)')} | ${a.state ?? '-'} | ${cell(a.stopReason ?? '-')} | ${usd(a.budgetUsd)} | ${spend === null ? 'unknown' : usd(spend)} |`,
    );
  });
  out.push('', `Cumulative cost over all attempts: **${usd(m.costUsd)}**.`);
  return out;
}

function headerSection(ctx: Ctx, problem: string | undefined, skipped: number): string[] {
  const m = ctx.manifest;
  const out: string[] = [];
  if (!m) {
    out.push('## Run', '');
    out.push(`- Slug: unknown`, `- Final state: unknown`);
    if (problem) out.push(`- ⚠ ${problem}`);
  } else {
    const attempts = attemptsOf(m);
    // a resume that was rolled back never ran: it is listed in the table, but it is not a run attempt
    const ran = attempts.filter((a) => a.stopReason !== RESUME_FAILED);
    const failedStarts = attempts.length - ran.length;
    const resumed = ran.length > 1;
    const start = (attempts.length > 1 ? attempts[0]?.startedAt : undefined) ?? m.startedAt ?? m.createdAt;
    const startMs = Date.parse(start);
    const endMs = m.endedAt ? Date.parse(m.endedAt) : NaN;
    out.push('## Run', '');
    out.push(`- Slug: ${code(m.slug)}`);
    out.push(`- Final state: **${m.state}** (phase: ${m.phase})`);
    out.push(`- Stop reason: ${m.stopReason ?? '(none recorded)'}`);
    if (resumed) out.push(`- Resumed (${ran.length} attempts${failedStarts > 0 ? `, ${failedStarts} failed to start` : ''})`);
    else if (failedStarts > 0) out.push(`- Resume failed to start (${failedStarts}x)`);
    out.push(`- Started: ${start}`);
    out.push(`- Ended: ${m.endedAt ?? '(not ended)'}`);
    if (resumed) out.push(`- Duration: ${attemptsDuration(ran)}`);
    else out.push(`- Duration: ${m.endedAt ? formatDuration(endMs - startMs) : 'unknown (run has no end time)'}`);
    out.push(`- Model: ${code(m.model)}`);
  }
  if (ctx.finalReviewPath) out.push(`- Final review: [${FINAL_REVIEW_FILE}](${ctx.finalReviewPath})`);
  if (ctx.earlierReviews.length > 0) {
    out.push(`- Earlier reviews: ${ctx.earlierReviews.map((r) => `[${r.name}](${r.path})`).join(', ')}`);
  }
  if (skipped > 0) out.push(`- ⚠ ${skipped} malformed artifact line(s) were skipped`);
  if (ctx.manifest && attemptsOf(ctx.manifest).length > 1) out.push(...attemptsTable(ctx.manifest));
  if (ctx.phaseEvents.length > 0) {
    out.push('', '### Phases', '', '| Time | Phase | State |', '| --- | --- | --- |');
    for (const e of ctx.phaseEvents) out.push(`| ${cell(e.ts)} | ${cell(e.id.slice(PHASE_PREFIX.length))} | ${e.state} |`);
  }
  return out;
}

function costSection(ctx: Ctx): string[] {
  const m = ctx.manifest;
  // cost.jsonl lines carry the *absolute* cost of a session at that point: the latest line per session wins.
  const perSession = latestBy(ctx.costs, (c) => c.sessionId);
  const phases = new Map<string, number>();
  let ledgerEstimated = 0;
  let estimatedSessions = 0;
  for (const c of perSession) {
    phases.set(c.phase, (phases.get(c.phase) ?? 0) + c.costUsd);
    if (c.estimated) {
      ledgerEstimated += c.costUsd;
      estimatedSessions++;
    }
  }
  const ledgerTotal = ctx.costs.length > 0 ? (ctx.costs[ctx.costs.length - 1] as CostLineT).totalUsd : 0;
  const total = m ? m.costUsd : ledgerTotal;
  const estimated = m ? m.costEstimatedUsd : ledgerEstimated;

  const out: string[] = ['## Cost', ''];
  const attempts = m ? attemptsOf(m) : [];
  const last = lastRanAttempt(attempts);
  out.push(attempts.length > 1 ? `- Total (all attempts): **${usd(total)}**` : `- Total: **${usd(total)}**`);
  out.push(`- Estimated portion: ${usd(estimated)}`);
  if (m && last && attempts.length > 1) {
    // The budget is per attempt: the percentage is this (last) attempt's spend over its own budget.
    const spend = attemptSpend(m, last, true) ?? 0;
    out.push(`- Budget (attempt ${last.n}): ${usd(last.budgetUsd)}, attempt spend ${usd(spend)} (${((spend / last.budgetUsd) * 100).toFixed(1)}% used)`);
    if (m.costMultiplier !== 1) out.push(`- ⚠ Cost multiplier ${m.costMultiplier} was applied (smoke test)`);
  } else if (m) {
    const pct = (total / m.budgetUsd) * 100;
    out.push(`- Budget: ${usd(m.budgetUsd)} (${pct.toFixed(1)}% used)`);
    if (m.costMultiplier !== 1) out.push(`- ⚠ Cost multiplier ${m.costMultiplier} was applied (smoke test)`);
  } else {
    out.push('- Budget: unknown');
  }
  out.push('', '| Phase | Cost |', '| --- | --- |');
  if (phases.size === 0) out.push('| (no cost recorded) | $0.0000 |');
  for (const [phase, cost] of phases) out.push(`| ${phase} | ${usd(cost)} |`);
  out.push('');
  if (estimatedSessions > 0 || estimated > 0) {
    out.push(
      `> \`estimated\`: ${estimatedSessions} session(s) have an estimated rather than server-reported cost; treat the total as approximate.`,
    );
  } else {
    out.push('> `estimated`: none. All costs come from server-reported session totals.');
  }
  if (m && (m.state === 'aborted-budget' || m.state === 'winding-down')) {
    out.push(
      '> Budget stop caveat: aborted streams can be billed without ever being recorded, so the true spend may exceed the recorded total by up to one in-flight step per busy session.',
    );
  }
  return out;
}

async function commitsFor(
  ctx: Ctx,
  repoName: string,
  worktree: string,
): Promise<{ commits: string[] | null; note?: string }> {
  const repo = ctx.repoByName.get(repoName);
  if (!repo) return { commits: null, note: `repo "${repoName}" is not in the manifest, cannot pick a base branch` };
  // Task branches are based on origin/<default> (fetched before the run), so prefer it over a possibly stale local branch.
  try {
    return { commits: await commitsBetween(worktree, `origin/${repo.defaultBranch}`, ctx.git) };
  } catch {
    try {
      return { commits: await commitsBetween(worktree, repo.defaultBranch, ctx.git) };
    } catch (err) {
      return { commits: null, note: `git log failed in ${worktree}: ${errMsg(err)}` };
    }
  }
}

function verifyCell(t: TaskEventT): string {
  if (t.verify.length === 0) return '(none)';
  return t.verify.map((v) => `${code(v.cmd)} → ${v.exit}`).join('<br>');
}

function commitsCell(commits: string[] | null): string {
  if (commits === null) return 'unknown';
  if (commits.length === 0) return '(none)';
  return commits.map((c) => cell(c)).join('<br>');
}

async function tasksSection(ctx: Ctx): Promise<string[]> {
  const out: string[] = ['## Tasks', ''];
  if (ctx.tasks.length === 0) {
    out.push('(no tasks recorded)');
    return out;
  }
  const notes: string[] = [];
  out.push(
    '| Task | Repo | Branch | Worktree | State | Attempts | Verify (cmd → exit) | Oracle | Blocked reason | Commits |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const t of ctx.tasks) {
    const { commits, note } = await commitsFor(ctx, t.repo, t.worktree);
    if (note) notes.push(`${t.id}: ${note}`);
    out.push(
      `| ${cell(t.id)} | ${cell(t.repo)} | ${code(t.branch)} | ${code(t.worktree)} | ${t.state} | ${t.attempt} | ${verifyCell(t)} | ${cell(t.oracleVerdict ?? '-')} | ${cell(t.blockedReason ?? '-')} | ${commitsCell(commits)} |`,
    );
  }
  for (const n of notes) out.push('', `> ⚠ ${n}`);
  const counts = new Map<string, number>();
  for (const t of ctx.tasks) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
  out.push('', `Summary: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const windDown = ctx.tasks.filter((t) => t.state === 'blocked' && t.blockedReason?.startsWith(WIND_DOWN_PREFIX));
  const skippedTasks = ctx.tasks.filter((t) => t.state === 'skipped');
  if (windDown.length > 0) out.push(`Unfinished at wind-down (blocked): ${windDown.map((t) => t.id).join(', ')}`);
  if (skippedTasks.length > 0) out.push(`Never started (skipped): ${skippedTasks.map((t) => t.id).join(', ')}`);
  return out;
}

interface IntegrationTarget {
  name: string;
  branch?: string;
  worktree?: string;
  event?: TaskEventT;
}

/** One entry per repo with an integration branch, from the manifest worktrees and the `integration:<repo>` events. */
function integrationTargets(ctx: Ctx): IntegrationTarget[] {
  const m = ctx.manifest;
  const names = new Set<string>(ctx.integrations.keys());
  for (const w of m?.worktrees ?? []) if (w.kind === 'integration') names.add(w.repo);
  return [...names].map((name) => {
    const wt = m?.worktrees.find((w) => w.kind === 'integration' && w.repo === name);
    const event = ctx.integrations.get(name);
    return { name, branch: wt?.branch ?? event?.branch, worktree: wt?.path ?? event?.worktree, event };
  });
}

async function integrationSection(ctx: Ctx): Promise<string[]> {
  const out: string[] = ['## Integration branches', ''];
  const targets = integrationTargets(ctx);
  if (targets.length === 0) {
    out.push('(no integration branches)');
    return out;
  }
  for (const { name, branch, worktree, event: ev } of targets) {
    out.push(`### ${name}`, '');
    out.push(`- Branch: ${branch ? code(branch) : 'unknown'}`);
    out.push(`- Worktree: ${worktree ? code(worktree) : 'unknown'}`);
    if (worktree) {
      const { commits, note } = await commitsFor(ctx, name, worktree);
      if (commits === null) out.push(`- Commits: unknown${note ? ` (${note})` : ''}`);
      else if (commits.length === 0) out.push('- Commits: (none)');
      else {
        out.push('- Commits:');
        for (const c of commits) out.push(`  - ${code(c)}`);
      }
    } else {
      out.push('- Commits: unknown (no worktree recorded)');
    }
    if (ev) {
      out.push(`- State: ${ev.state}`);
      out.push(
        `- Last verify: ${ev.verify.length === 0 ? '(none)' : ev.verify.map((v) => `${code(v.cmd)} → ${v.exit}`).join(', ')}`,
      );
      if (ev.oracleVerdict) out.push(`- Oracle: ${ev.oracleVerdict}`);
      if (ev.blockedReason) out.push(`- Blocked: ${ev.blockedReason}`);
    } else {
      out.push('- Last verify: (no integration events recorded)');
    }
    out.push('');
  }
  while (out[out.length - 1] === '') out.pop();
  return out;
}

const CHECK_ITEM_RE = /^(\s*)[-*] \[([ xX])\]/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

interface ManualCheck {
  done: boolean;
  /** The item line and its continuation lines, verbatim (blank lines inside an item are kept). */
  lines: string[];
}

/**
 * The checklist items of MANUAL_CHECKS.md: every `- [ ]` / `- [x]` (or `*`) line with the indented lines that follow it
 * (the steps), verbatim. A blank line stays in the item when the next non-blank line is still indented, or when a fenced
 * block is open (a fence the file never closes is closed here, and an unindented line ends the item), so an item can
 * never leave an open fence behind in the report. Other lines (title, prose) are not copied.
 */
function parseManualChecks(markdown: string): ManualCheck[] {
  const items: ManualCheck[] = [];
  let cur: ManualCheck | null = null;
  let fence: { indent: string; marker: string } | null = null;
  let blanks: string[] = [];
  const end = (): void => {
    if (cur && fence) cur.lines.push(`${fence.indent}${fence.marker}`);
    cur = null;
    fence = null;
    blanks = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const start = CHECK_ITEM_RE.exec(line);
    if (start) {
      end();
      cur = { done: start[2] !== ' ', lines: [line] };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line === '') {
      blanks.push(line);
      continue;
    }
    if (!/^\s/.test(line)) {
      end();
      continue;
    }
    cur.lines.push(...blanks, line);
    blanks = [];
    const f = FENCE_RE.exec(line);
    if (f) {
      const marker = f[2] as string;
      if (!fence) fence = { indent: f[1] as string, marker };
      else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length) fence = null;
    }
  }
  end();
  return items;
}

/** The lines of every checklist item of MANUAL_CHECKS.md (see `parseManualChecks`). */
export function extractManualChecks(markdown: string): string[] {
  return parseManualChecks(markdown).flatMap((i) => i.lines);
}

function verifyByHandSection(ctx: Ctx): string[] {
  const out: string[] = ['## Verify by hand', ''];
  const { path, text } = ctx.manualChecks;
  if (text === null) {
    out.push(
      `Unknown: \`${MANUAL_CHECKS_FILE}\` is missing (the review phase did not write it), so checks that need a human may exist. Go through the success criteria in \`SPEC.md\` by hand.`,
    );
    return out;
  }
  const items = parseManualChecks(text);
  if (items.length > 0) {
    const open = items.filter((i) => !i.done);
    const done = items.filter((i) => i.done);
    if (open.length > 0) out.push(`From [${MANUAL_CHECKS_FILE}](${path}). Runs have no browser or dev server, so these were not checked:`, '', ...open.flatMap((i) => i.lines));
    else out.push(`From [${MANUAL_CHECKS_FILE}](${path}). Nothing is left open.`);
    if (done.length > 0) out.push('', 'Marked done in the file:', '', ...done.flatMap((i) => i.lines));
    return out;
  }
  const body = text
    .split('\n')
    .filter((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l))
    .join('\n')
    .trim();
  if (body === '' || /^none\.?$/i.test(body)) out.push('None listed.');
  else out.push(`⚠ [${MANUAL_CHECKS_FILE}](${path}) has content but no \`- [ ]\` items. Read it by hand.`);
  return out;
}

/** What `finalReviewVerdict` found. Everything but `ok: true` is listed under "Needs human attention". */
export type FinalReviewCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'no-verdict' | 'none' | 'reject'; verdicts?: string[] }
  | { ok: false; reason: 'unrecognised'; verdict: string; verdicts?: string[] };

const VERDICT_LINE_RE = /^[\s>#*_`-]*verdict[\s*_`]*:[\s*_`]*(.*?)[\s*_`]*$/i;
const VERDICT_TOKEN_RE = /^[A-Za-z]+(?:-[A-Za-z]+)*(?![\w|-])/;

type VerdictKind = 'ok' | 'reject' | 'none' | 'unrecognised';
/** How bad a verdict is when several are in one file (higher wins). */
const SEVERITY: Record<VerdictKind, number> = { ok: 0, unrecognised: 1, none: 2, reject: 3 };

function classifyVerdict(value: string): { kind: VerdictKind; label: string } {
  const token = value.includes('|') ? undefined : VERDICT_TOKEN_RE.exec(value)?.[0];
  if (token === undefined) return { kind: 'unrecognised', label: value };
  const up = token.toUpperCase();
  if (up === 'APPROVE' || up === 'APPROVE-WITH-FIXES') return { kind: 'ok', label: up };
  if (up === 'NONE') return { kind: 'none', label: up };
  if (up === 'REJECT') return { kind: 'reject', label: up };
  return { kind: 'unrecognised', label: token };
}

/**
 * Read the verdicts of a final review: every `VERDICT:` (or `Verdict:`) line with a value, markdown decoration
 * tolerated. The review is fine only if there is at least one and all of them are APPROVE or APPROVE-WITH-FIXES. The
 * WORST one decides (REJECT, then NONE, then anything unrecognised, including the unfilled `APPROVE | ... | REJECT`
 * template), so neither the first nor the last verdict (an initial review and the re-checks appended after the fix
 * rounds) can hide a problem. A missing file or no verdict line is flagged too. With several verdict lines the result
 * carries them all, in file order, as `verdicts`.
 */
export function finalReviewVerdict(text: string | null): FinalReviewCheck {
  if (text === null) return { ok: false, reason: 'missing' };
  const found: Array<{ kind: VerdictKind; label: string }> = [];
  for (const line of text.split('\n')) {
    const value = VERDICT_LINE_RE.exec(line)?.[1];
    if (value !== undefined && value !== '') found.push(classifyVerdict(value));
  }
  if (found.length === 0) return { ok: false, reason: 'no-verdict' };
  const worst = found.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
  if (worst.kind === 'ok') return { ok: true };
  const verdicts = found.length > 1 ? { verdicts: found.map((v) => v.label) } : {};
  return worst.kind === 'unrecognised'
    ? { ok: false, reason: 'unrecognised', verdict: worst.label, ...verdicts }
    : { ok: false, reason: worst.kind, ...verdicts };
}

function finalReviewMessage(check: Exclude<FinalReviewCheck, { ok: true }>): string {
  const f = `\`${FINAL_REVIEW_FILE}\``;
  const v = check.verdicts;
  if (v && v.length > 1) {
    const first = v[0] as string;
    const last = v[v.length - 1] as string;
    const trail = `initial ${first}, round ${v.length - 1} re-check ${last}`;
    const lastOk = last === 'APPROVE' || last === 'APPROVE-WITH-FIXES';
    if (lastOk) return `${f}: ${trail}: check the fixes (the worst verdict in the file is ${check.reason === 'unrecognised' ? `"${check.verdict}"` : check.reason.toUpperCase()}).`;
    const worst = check.reason === 'none' ? 'a review did not run' : check.reason === 'reject' ? 'the review is not approved' : 'a verdict is unrecognised';
    return `${f}: ${trail}. ${worst[0]?.toUpperCase()}${worst.slice(1)}. ${check.reason === 'none' ? 'The work was not fully reviewed.' : 'Read its findings first.'}`;
  }
  switch (check.reason) {
    case 'missing':
      return `${f} is missing: no final review was saved, so @oracle did not review this run's work.`;
    case 'no-verdict':
      return `${f} has no \`VERDICT:\` line, so there is no verdict to rely on. Read it by hand.`;
    case 'none':
      return `${f} says \`VERDICT: NONE\`: the oracle review did not run, so the work was not reviewed.`;
    case 'reject':
      return `${f} says \`VERDICT: REJECT\`. Read its findings first.`;
    case 'unrecognised':
      return `${f} has an unrecognised verdict "${check.verdict}" (expected APPROVE, APPROVE-WITH-FIXES or REJECT). Read it by hand.`;
  }
}

function attentionSection(ctx: Ctx): string[] {
  const out: string[] = ['## Needs human attention', ''];
  const flagged = ctx.decisions.filter((d) => d.needsHumanAttention);
  const defects = ctx.manifest?.defects ?? [];
  const blocked = [...ctx.tasks, ...ctx.integrations.values()].filter((t) => t.state === 'blocked');
  const unverified = ctx.pushChecks.filter((c) => c.state === 'unknown' || c.state === 'no-repo');
  const withHits = ctx.suppressionScans.filter((s) => s.hits !== null && s.hits.length > 0);
  const unscanned = ctx.suppressionScans.filter((s) => s.hits === null);
  // without a RUN.json nothing is known about what ran, and a report written mid-run (`nightgem report`) is too early to
  // say the review is missing: only a run that has ended is held to it
  const ended = ctx.manifest !== null && isTerminalRunState(ctx.manifest.state);
  const review = ended ? finalReviewVerdict(ctx.finalReviewText) : ({ ok: true } as const);
  if (flagged.length === 0 && defects.length === 0 && blocked.length === 0 && unverified.length === 0 && withHits.length === 0 && unscanned.length === 0 && review.ok) {
    out.push('Nothing flagged.');
    return out;
  }
  if (!review.ok) {
    out.push('### Final review', '', `- ${finalReviewMessage(review)}`, '');
  }
  if (flagged.length > 0) {
    out.push('### Decisions', '');
    for (const d of flagged) {
      const approved = d.oracleApproved === undefined ? 'oracle: n/a' : d.oracleApproved ? 'oracle: approved' : 'oracle: REJECTED';
      out.push(`- **${d.id}** (${d.kind}, ${approved}): ${d.summary}`);
      if (d.rationale) out.push(`  - Rationale: ${d.rationale}`);
    }
    out.push('');
  }
  if (blocked.length > 0) {
    out.push('### BLOCKED tasks', '');
    for (const t of blocked) {
      const wd = t.blockedReason?.startsWith(WIND_DOWN_PREFIX) ? ' [unfinished at wind-down]' : '';
      out.push(`- **${t.id}** (${t.repo}, ${t.branch})${wd}: ${t.blockedReason ?? '(no reason recorded)'}`);
    }
    out.push('');
  }
  if (unverified.length > 0) {
    out.push('### Unverified: nothing pushed', '');
    out.push('Could not confirm these branches are absent from `origin`. Check by hand before trusting the "nothing pushed" claim:', '');
    for (const c of unverified) {
      out.push(`- ${c.repo} ${code(c.branch)}: ${c.state === 'no-repo' ? 'no repo path known' : `unknown (${c.reason ?? 'no reason'})`}`);
    }
    out.push('');
  }
  if (withHits.length > 0 || unscanned.length > 0) {
    out.push('### Suppressions and skipped tests', '');
    out.push('Check these before trusting that the tests prove the change (details under "Safety checks"):', '');
    for (const s of withHits) out.push(`- ${s.repo} ${code(s.branch)}: ${s.hits?.length ?? 0} hit(s)`);
    for (const s of unscanned) out.push(`- ${s.repo} ${code(s.branch)}: not scanned (${s.reason ?? 'could not read the diff'}). Check the diff by hand.`);
    out.push('');
  }
  if (defects.length > 0) {
    out.push('### Defects', '');
    for (const d of defects) out.push(`- ${d.ts} [${d.kind}] ${d.message}${d.sessionId ? ` (session ${d.sessionId})` : ''}`);
    out.push('');
  }
  while (out[out.length - 1] === '') out.pop();
  return out;
}

interface CreatedBranch {
  repo: string;
  branch: string;
  worktree?: string;
}

function createdBranches(ctx: Ctx): CreatedBranch[] {
  const seen = new Map<string, CreatedBranch>();
  const add = (repo: string, branch: string, worktree?: string): void => {
    const key = `${repo}\0${branch}`;
    if (!seen.has(key)) seen.set(key, { repo, branch, worktree });
  };
  for (const w of ctx.manifest?.worktrees ?? []) add(w.repo, w.branch, w.path);
  for (const t of [...ctx.tasks, ...ctx.integrations.values()]) add(t.repo, t.branch, t.worktree);
  return [...seen.values()];
}

async function checkPushed(ctx: Ctx): Promise<PushCheck[]> {
  const out: PushCheck[] = [];
  for (const b of createdBranches(ctx)) {
    const repoPath = ctx.repoByName.get(b.repo)?.path ?? b.worktree;
    if (!repoPath) {
      out.push({ repo: b.repo, branch: b.branch, state: 'no-repo' });
      continue;
    }
    const check = await checkRemoteBranch(repoPath, b.branch, ctx.git);
    out.push({ repo: b.repo, branch: b.branch, state: check.state, reason: check.reason });
  }
  return out;
}

async function safetySection(ctx: Ctx): Promise<string[]> {
  const out: string[] = ['## Safety checks', ''];

  // Nothing pushed (results were computed up front by `checkPushed`).
  out.push('### Nothing pushed', '');
  if (ctx.pushChecks.length === 0) out.push('(no created branches to check)');
  let violations = 0;
  let unknowns = 0;
  for (const c of ctx.pushChecks) {
    if (c.state === 'yes') {
      violations++;
      out.push(`- ❌ VIOLATION: ${c.repo} ${code(c.branch)} exists on origin`);
    } else if (c.state === 'no') {
      out.push(`- ✅ ${c.repo} ${code(c.branch)}: not on origin`);
    } else {
      unknowns++;
      out.push(
        `- ⚠️ ${c.repo} ${code(c.branch)}: unknown (${c.state === 'no-repo' ? 'no repo path' : (c.reason ?? 'could not query origin')})`,
      );
    }
  }
  if (violations > 0) out.push('', `❌ ${violations} branch(es) were pushed. The run must never push.`);
  if (unknowns > 0) out.push('', `⚠️ ${unknowns} branch(es) could not be checked against origin (see "Needs human attention").`);

  // Main checkouts unchanged.
  out.push('', '### Main checkouts unchanged', '');
  const repos = ctx.manifest?.repos ?? [];
  if (repos.length === 0) out.push('(no repos in manifest)');
  for (const r of repos) {
    const b = r.baseline;
    const diffs: string[] = [];
    const unknowns: string[] = [];
    const probe = async <T>(label: string, fn: () => Promise<T>, baseline: T, fmt: (v: T) => string): Promise<void> => {
      try {
        const now = await fn();
        if (now !== baseline) diffs.push(`${label}: baseline ${fmt(baseline)} → now ${fmt(now)}`);
      } catch (err) {
        unknowns.push(`${label}: unknown (${errMsg(err)})`);
      }
    };
    await probe('HEAD', () => headSha(r.path, ctx.git), b.head, short);
    await probe('branch', () => currentBranch(r.path, ctx.git), b.branch, (v) => code(v));
    await probe('status hash', () => porcelainHash(r.path, ctx.git), b.porcelainHash, short);
    await probe('stash count', () => stashCount(r.path, ctx.git), b.stashCount, String);
    if (diffs.length > 0) {
      out.push(`- ❌ ${r.name} (${code(r.path)}) changed since baseline:`);
      for (const d of diffs) out.push(`  - ${d}`);
    } else if (unknowns.length === 0) {
      out.push(`- ✅ ${r.name} (${code(r.path)}): HEAD, branch, status and stashes match baseline`);
    }
    if (unknowns.length > 0) {
      out.push(`- ⚠ ${r.name} (${code(r.path)}): could not verify everything`);
      for (const u of unknowns) out.push(`  - ${u}`);
    }
  }

  out.push('', ...suppressionSection(ctx));
  return out;
}

/** `origin/<default>` when that ref exists in the main checkout, else the local default branch. */
async function reviewBase(ctx: Ctx, repoName: string): Promise<string | undefined> {
  const repo = ctx.repoByName.get(repoName);
  if (!repo) return undefined;
  try {
    await ctx.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${repo.defaultBranch}`], { cwd: repo.path });
    return `origin/${repo.defaultBranch}`;
  } catch {
    return repo.defaultBranch;
  }
}

/** Hits listed per integration branch before the rest is summarised. */
const MAX_LISTED_HITS = 30;

async function scanSuppressions(ctx: Ctx): Promise<SuppressionScan[]> {
  const out: SuppressionScan[] = [];
  for (const t of integrationTargets(ctx)) {
    const branch = t.branch ?? '(unknown branch)';
    if (!t.worktree) {
      out.push({ repo: t.name, branch, hits: null, reason: 'no worktree recorded' });
      continue;
    }
    const base = await reviewBase(ctx, t.name);
    if (!base) {
      out.push({ repo: t.name, branch, hits: null, reason: `repo "${t.name}" is not in the manifest, cannot pick a base branch` });
      continue;
    }
    try {
      out.push({ repo: t.name, branch, base, hits: scanDiff(await diffBetween(t.worktree, base, ctx.git)) });
    } catch (err) {
      out.push({ repo: t.name, branch, base, hits: null, reason: errMsg(err) });
    }
  }
  return out;
}

function hitLine(h: SuppressionHit): string {
  switch (h.kind) {
    case 'suppression':
      return `- ${code(`${h.file}:${h.line}`)}: ${code(h.pattern)} added`;
    case 'deleted-test':
      return `- ${code(h.file)}: test file deleted`;
    case 'assertion-loss':
      return `- ${code(h.file)}: net loss of assertions (${h.removed} removed, ${h.added} added)`;
    case 'constraints-changed':
      return `- ${code(h.file)}: quality bar file changed (agents must not edit it)`;
  }
}

function suppressionSection(ctx: Ctx): string[] {
  const out: string[] = ['### Suppressions and skipped tests', ''];
  out.push(
    'Added lint or type suppressions and test skips, deleted test files and test files with fewer assertions, found in the diff of each integration branch against its base. A heuristic for the reviewer: it never fails the run.',
    '',
  );
  if (ctx.suppressionScans.length === 0) {
    out.push('(no integration branches to scan)');
    return out;
  }
  for (const s of ctx.suppressionScans) {
    const label = `${s.repo} ${code(s.branch)}`;
    if (s.hits === null) {
      out.push(`- ⚠️ ${label}: not scanned (${s.reason ?? 'could not read the diff'})`);
    } else if (s.hits.length === 0) {
      out.push(`- ✅ ${label}: none found (against ${code(s.base ?? '')})`);
    } else {
      out.push(`- ⚠️ ${label}: ${s.hits.length} hit(s) (against ${code(s.base ?? '')})`);
      for (const h of s.hits.slice(0, MAX_LISTED_HITS)) out.push(`  ${hitLine(h)}`);
      if (s.hits.length > MAX_LISTED_HITS) out.push(`  - … and ${s.hits.length - MAX_LISTED_HITS} more`);
    }
  }
  return out;
}

async function nextStepsSection(ctx: Ctx): Promise<string[]> {
  const out: string[] = ['## Next steps', ''];
  out.push('The run never pushes, opens PRs, merges or touches the issue tracker. Review and ship by hand:', '');
  const seen = new Set<string>();
  const targets: Array<{ repo: string; branch: string; worktree: string }> = [];
  for (const w of ctx.manifest?.worktrees ?? []) targets.push({ repo: w.repo, branch: w.branch, worktree: w.path });
  for (const t of [...ctx.tasks, ...ctx.integrations.values()]) {
    targets.push({ repo: t.repo, branch: t.branch, worktree: t.worktree });
  }
  const lines: string[] = [];
  for (const t of targets) {
    if (seen.has(t.worktree)) continue;
    seen.add(t.worktree);
    const base = await reviewBase(ctx, t.repo);
    lines.push(`git -C ${t.worktree} log --oneline${base ? ` ${base}..HEAD` : ''}`);
    if (base) lines.push(`git -C ${t.worktree} diff --stat ${base}...HEAD`);
  }
  if (lines.length > 0) out.push('1. Review each branch:', '', '```sh', ...lines, '```', '');
  out.push('2. When satisfied, push each branch yourself, e.g.:', '', '```sh');
  const pushed = new Set<string>();
  for (const t of targets) {
    if (pushed.has(t.worktree)) continue;
    pushed.add(t.worktree);
    out.push(`git -C ${t.worktree} push -u origin ${t.branch}`);
  }
  if (pushed.size === 0) out.push('# (no branches were created)');
  out.push('```', '');
  out.push('3. Open the PRs manually, following each repo\'s commit and PR conventions.');
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the REPORT.md markdown. Never throws on git failures or missing artifacts. */
export async function buildReport(input: BuildReportInput): Promise<string> {
  const { paths } = input;
  const git = input.git ?? defaultGit;

  const [{ manifest, problem }, tasksRead, decisionsRead, costRead, existing] = await Promise.all([
    readManifest(paths.runJson),
    readJsonl(paths.tasksJsonl, TaskEvent),
    readJsonl(paths.decisionsJsonl, Decision),
    readJsonl(paths.costJsonl, CostLine),
    readText(paths.reportMd),
  ]);

  const latest = latestTasks(tasksRead.items);
  const integrations = new Map<string, TaskEventT>();
  const tasks: TaskEventT[] = [];
  for (const t of latest) {
    if (t.id.startsWith(INTEGRATION_PREFIX)) integrations.set(t.id.slice(INTEGRATION_PREFIX.length), t);
    else if (!t.id.startsWith(PHASE_PREFIX)) tasks.push(t);
  }
  const phaseEvents = tasksRead.items.filter((e) => e.id.startsWith(PHASE_PREFIX));
  const finalReview = join(paths.specsDir, FINAL_REVIEW_FILE);
  const finalReviewText = await readText(finalReview);
  const finalReviewPath = finalReviewText === null ? null : finalReview;

  const manualChecksPath = join(paths.specsDir, MANUAL_CHECKS_FILE);

  const ctx: Ctx = {
    manifest,
    tasks,
    integrations,
    phaseEvents,
    finalReviewPath,
    finalReviewText,
    manualChecks: { path: manualChecksPath, text: await readText(manualChecksPath) },
    earlierReviews: await readEarlierReviews(paths.specsDir, paths.runDir),
    decisions: latestBy(decisionsRead.items, (d) => d.id),
    costs: costRead.items,
    git,
    repoByName: new Map((manifest?.repos ?? []).map((r) => [r.name, r])),
    pushChecks: [],
    suppressionScans: [],
  };
  ctx.pushChecks = await checkPushed(ctx);
  ctx.suppressionScans = await scanSuppressions(ctx);

  const skipped = tasksRead.skipped + decisionsRead.skipped + costRead.skipped;
  const narrative = extractNarrative(existing);

  const sections: string[][] = [
    [`# Run report${manifest ? `: ${manifest.slug}` : ''}`, '', ...headerSection(ctx, problem, skipped)],
    costSection(ctx),
    await tasksSection(ctx),
    await integrationSection(ctx),
    attentionSection(ctx),
    verifyByHandSection(ctx),
    await safetySection(ctx),
    [NARRATIVE_HEADING, '', narrative ?? NARRATIVE_PLACEHOLDER],
    await nextStepsSection(ctx),
  ];
  return `${sections.map((s) => s.join('\n')).join('\n\n')}\n`;
}

/** Build the report and write it to `paths.reportMd` (atomic temp + rename). Returns the markdown. */
export async function writeReport(input: BuildReportInput): Promise<string> {
  const markdown = await buildReport(input);
  const target = input.paths.reportMd;
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, markdown, 'utf8');
  await rename(tmp, target);
  return markdown;
}
