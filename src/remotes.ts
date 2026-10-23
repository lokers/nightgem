/**
 * Remote URLs of the spec repos and the git URL rewrites that make every push to them impossible (no-push, any host).
 *
 * How git applies the rewrites (verified on git 2.39):
 *  - `url.<x>.pushInsteadOf` is IGNORED when a remote has an explicit `pushurl`; `url.<x>.insteadOf` does apply to a pushurl.
 *  - Matching is a plain string-prefix match against the RAW configured URL (userinfo included), never a normalised one.
 *  - The longest matching prefix wins. The exact full-URL rules below are the longest possible, so only an identical rule
 *    of the user's own can tie with them (theirs wins); the shell canary (`remote get-url --push --all`) catches that.
 *
 * So each `url` value gets a `pushInsteadOf` rule for the exact raw value plus its host prefix, and each `pushurl` value gets an
 * `insteadOf` rule for the exact raw value. A URL that carries a credential (`scheme://user:password@host`) is never turned into
 * a rule: it is a hard failure (`remoteCredentialIssues`), and the secret never appears in any output.
 *
 * Pure functions with an injectable git runner; nothing here reads the environment.
 */
import type { GitRunner } from './gitinfo.ts';

import { defaultGit } from './gitinfo.ts';

export interface RemoteUrlEntry {
  remote: string;
  kind: 'url' | 'pushurl';
  value: string;
}

export interface RewriteRules {
  /** `url.nopush://.pushInsteadOf` values. */
  pushInsteadOf: string[];
  /** `url.nopush://.insteadOf` values (pushurls only). */
  insteadOf: string[];
  /** Pushurls that could not be covered without also rewriting a fetch URL (their remote name); a hard failure. */
  conflicts: RemoteUrlEntry[];
}

const GET_REGEXP = '^remote\\..*\\.(url|pushurl)$';
/** Matched against the KEY only (never the value: a URL may itself contain `.url`). */
const KEY_RE = /^remote\.(.+)\.(url|pushurl)$/;

/**
 * Every `remote.<name>.url` / `.pushurl` value of the repo, multi-valued remotes included. No remotes gives `[]`.
 * Uses `git config -z`: records end with NUL and hold `key\nvalue`, so a value can contain anything (dots, newlines).
 */
export async function readRemoteUrls(repo: string, git: GitRunner = defaultGit): Promise<RemoteUrlEntry[]> {
  let out: string;
  try {
    out = await git(['-C', repo, 'config', '-z', '--get-regexp', GET_REGEXP], { cwd: repo });
  } catch (err) {
    // `git config --get-regexp` exits 1 when nothing matches. Anything else (not a repo, git missing) must not read as "no remotes".
    if ((err as { exitCode?: number } | null)?.exitCode === 1) return [];
    throw err;
  }
  const entries: RemoteUrlEntry[] = [];
  for (const record of out.split('\0')) {
    const nl = record.indexOf('\n');
    if (nl < 0) continue;
    const m = KEY_RE.exec(record.slice(0, nl));
    const value = record.slice(nl + 1);
    if (!m || value === '') continue;
    entries.push({ remote: m[1] as string, kind: m[2] as 'url' | 'pushurl', value });
  }
  return entries;
}

const URL_FORM_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/|$)/i;
/** Token shapes that are credentials even without a `:password` part (the token is the userinfo). */
const TOKEN_USER_RE = /^(?:gh[pousr]_|github_pat_|glpat-|glptt-|gldt-|glrt-|glcbt-|xox[abprs]-|hf_)/;
/** A long username-only userinfo is a token too (classic 40-hex GitHub tokens, Azure PATs). */
const LONG_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;
/** `persistent-https::https://…`: a git remote helper prefix in front of a URL. */
const HELPER_RE = /^[a-z][a-z0-9+.-]*::/i;

function authorityOf(url: string): string | undefined {
  const m = URL_FORM_RE.exec(url.replace(HELPER_RE, ''));
  return m ? m[2] : undefined;
}

/**
 * True for `scheme://user:password@host` (any non-empty password) and for a userinfo that is itself a well-known access-token
 * shape or a 32+ character token-like string. `https://user@host` and `ssh://git@host` are fine.
 */
export function hasEmbeddedSecret(url: string): boolean {
  const authority = authorityOf(url);
  if (authority === undefined) return false;
  const at = authority.lastIndexOf('@');
  if (at < 0) return false;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon >= 0 && userinfo.slice(colon + 1) !== '') return true;
  const user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
  return TOKEN_USER_RE.test(user) || LONG_TOKEN_RE.test(user);
}

type UrlShape = { form: 'url'; prefix: string } | { form: 'scp'; prefix: string } | { form: 'local'; extra: string[] };

function shapeOf(raw: string): UrlShape {
  const helper = HELPER_RE.exec(raw)?.[0] ?? '';
  const inner = shapeOfPlain(raw.slice(helper.length));
  // the prefix must be a prefix of the RAW value, so the helper stays in front
  if (helper === '') return inner;
  return inner.form === 'local' ? { form: 'local', extra: [] } : { form: inner.form, prefix: `${helper}${inner.prefix}` };
}

function shapeOfPlain(value: string): UrlShape {
  if (value.startsWith('file://')) {
    // today's behaviour for local origins: the URL and its plain path
    const path = value.slice('file://'.length);
    return { form: 'local', extra: path === '' ? [] : [path] };
  }
  const u = URL_FORM_RE.exec(value);
  if (u) return { form: 'url', prefix: `${u[1]}://${u[2]}/` };
  // scp-like: a colon before any slash (`user@host:path`, `host:path`)
  const scp = /^((?:[^@/:]+@)?[^/:@]+):/.exec(value);
  if (scp) return { form: 'scp', prefix: `${scp[1]}:` };
  if (value.startsWith('/')) return { form: 'local', extra: [`file://${value}`] };
  return { form: 'local', extra: [] };
}

/** Rewrite rules that send every push to these remotes to `nopush://`. Credential-bearing URLs are skipped (see the header). */
export function rewriteRules<T extends RemoteUrlEntry>(entries: readonly T[]): RewriteRules & { conflicts: T[] } {
  const pushInsteadOf = new Set<string>();
  const insteadOf = new Set<string>();
  const conflicts: T[] = [];
  const clean = entries.filter((e) => !hasEmbeddedSecret(e.value));
  const fetchUrls = clean.filter((e) => e.kind === 'url').map((e) => e.value);

  for (const e of clean) {
    if (e.kind === 'url') {
      pushInsteadOf.add(e.value);
      const s = shapeOf(e.value);
      if (s.form === 'local') for (const x of s.extra) pushInsteadOf.add(x);
      else pushInsteadOf.add(s.prefix);
    } else if (fetchUrls.some((u) => u.startsWith(e.value))) {
      // `insteadOf` would rewrite a fetch URL to nopush:// too
      conflicts.push(e);
    } else {
      insteadOf.add(e.value);
    }
  }
  return { pushInsteadOf: [...pushInsteadOf].sort(), insteadOf: [...insteadOf].sort(), conflicts };
}

export interface RemoteCredentialIssue {
  repo: string;
  remote: string;
  /** `credentials`: the URL carries a secret. `pushurl-conflict`: the pushurl cannot be covered without breaking fetch. */
  problem: 'credentials' | 'pushurl-conflict';
}

/** One line per issue. It names the repo and the remote, never the URL. */
export function describeRemoteIssue(i: RemoteCredentialIssue): string {
  return i.problem === 'credentials'
    ? `repo ${i.repo}: remote ${i.remote} has credentials in its URL (remove them: use ssh keys or a credential helper)`
    : `repo ${i.repo}: remote ${i.remote} has a pushurl that is also a prefix of a fetch URL, so pushes cannot be blocked without breaking fetch (remove or change the pushurl)`;
}

export interface RemotesPlan {
  pushInsteadOf: string[];
  insteadOf: string[];
  /** Remote names per repo (every remote that has a url or a pushurl). */
  remotes: Array<{ repo: string; names: string[] }>;
  issues: RemoteCredentialIssue[];
}

const repoLabel = (repo: string): string => repo.split('/').filter(Boolean).pop() ?? repo;

/** Read the remotes of each repo and compute the combined rewrite rules and the hard-failure issues. */
export async function planRemotes(repos: readonly string[], git: GitRunner = defaultGit): Promise<RemotesPlan> {
  const all: Array<RemoteUrlEntry & { repo: string }> = [];
  const remotes: RemotesPlan['remotes'] = [];
  const issues: RemoteCredentialIssue[] = [];
  const seen = new Set<string>();
  const results = await Promise.all(repos.map(async (repo) => ({ repo, entries: await readRemoteUrls(repo, git) })));
  for (const { repo, entries } of results) {
    remotes.push({ repo, names: [...new Set(entries.map((e) => e.remote))].sort() });
    for (const e of entries) {
      all.push({ ...e, repo });
      const key = `${repo}\0${e.remote}\0credentials`;
      if (hasEmbeddedSecret(e.value) && !seen.has(key)) {
        seen.add(key);
        issues.push({ repo: repoLabel(repo), remote: e.remote, problem: 'credentials' });
      }
    }
  }
  const rules = rewriteRules(all);
  for (const c of rules.conflicts) issues.push({ repo: repoLabel(c.repo), remote: c.remote, problem: 'pushurl-conflict' });
  return { pushInsteadOf: rules.pushInsteadOf, insteadOf: rules.insteadOf, remotes, issues };
}

/** Throws (message without any URL) when a repo's remote carries credentials or cannot be covered. */
export function assertRemotesSafe(plan: Pick<RemotesPlan, 'issues'>): void {
  if (plan.issues.length > 0) throw new Error(`refusing to start: ${plan.issues.map(describeRemoteIssue).join('; ')}`);
}
