/**
 * Leak audit: finds user-specific facts in text files.
 *
 * Pure: `auditFiles` takes file contents, `auditRepo` takes an injected `git` runner and `fs`.
 * Generic checks (no private knowledge needed): absolute home paths, emails, ticket-like keys.
 * `bannedTerms` (from the local profile, never committed) are matched case-insensitively as substrings.
 */
import { readFileSync } from 'node:fs';
import { MAINTAINER_EMAIL } from './brand.ts';
import { join } from 'node:path';

export const HIT_KINDS = ['home-path', 'email', 'ticket-key', 'banned-term'] as const;
export type HitKind = (typeof HIT_KINDS)[number];

export interface Hit {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based column of the match start. */
  col: number;
  kind: HitKind;
  match: string;
}

export interface AuditFile {
  path: string;
  text: string;
}

export interface AuditOptions {
  bannedTerms: readonly string[];
  /** Run the generic checks (home paths, emails, ticket keys). */
  generic: boolean;
}

// --- allowlists ----------------------------------------------------------------

/** User names that may appear in `/Users/<name>/` and `/home/<name>/` (neutral fixtures and placeholders). */
export const HOME_NAME_ALLOWLIST: readonly string[] = ['alice', 'bob', 'test', 'x', 'someone', 'u', 'example', 'me', 'user', '*'];

/** Email domains that are never real. */
export const EMAIL_DOMAIN_ALLOWLIST: readonly string[] = ['example.com', 'example.invalid', 'example.org'];
/** Email local parts that are never personal (`git@host:path` ssh remotes). */
export const EMAIL_LOCAL_ALLOWLIST: readonly string[] = ['git'];

/**
 * Prefixes of `PREFIX-<digits>` tokens that are standards, licences, algorithms or specs, not tracker keys.
 * `JIRA-123` is the documented neutral example key.
 */
export const TICKET_PREFIX_ALLOWLIST: readonly string[] = [
  'JIRA', // neutral example key
  'UTF', // UTF-8, UTF-16
  'MPL', // MPL-2
  'BSD', // BSD-2, BSD-3
  'ISO', // ISO-8601
  'SHA', // SHA-1, SHA-256, SHA-512
  'AES', // AES-256
  'RFC', // RFC-2119
  'ES', // ES-2022
  'CVE', // CVE-2024-1234
  'GPT', // GPT-4
  'TLS', // TLS-1
];

/**
 * The neutral stand-in for a macOS per-user temp dir hash (`/var/folders/<2 chars>/<hash>/`). A real hash identifies the
 * machine's user, so recorded fixtures must carry this placeholder instead.
 */
export const TMPDIR_HASH_PLACEHOLDER = 'xx/abcdefghijklmnopqrstuvwxyz0000gn';

// --- checks --------------------------------------------------------------------

const HOME_PATH_RE = /(?<![A-Za-z0-9_])\/(?:Users|home)\/([^/\s'"`<>()[\],;:]+)/g;
/** macOS per-user temp dir: `/var/folders/<2>/<28+ chars>/` (also behind `/private`). */
const TMPDIR_HASH_RE = /\/var\/folders\/([A-Za-z0-9_]{2}\/[A-Za-z0-9_]{28,})(?=\/|$)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const TICKET_RE = /\b([A-Z][A-Z0-9]+)-\d+\b/g;
/** The tail of a regex character class: `[A-Z0-9]`, `[A-F0-9]` read as the key `Z0-9`, `F0-9`. */
const CHAR_RANGE_RE = /^[A-Z]0-9$/;

/** `{{USER}}`-style template placeholders (the name capture stops at whitespace/slash, so a closing `}}` may be absent). */
const isPlaceholder = (s: string): boolean => s.startsWith('{{');

/** Dot-names are path-traversal artefacts, not user names: `../../home/.config`, `/home/.con?ig`. */
const isTraversalOrGlob = (name: string): boolean => name.startsWith('.');

function homeNameAllowed(name: string): boolean {
  return name === '*' || HOME_NAME_ALLOWLIST.includes(name) || isPlaceholder(name) || isTraversalOrGlob(name);
}

function emailAllowed(email: string): boolean {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (EMAIL_LOCAL_ALLOWLIST.includes(local)) return true;
  // the project's own public contact, published on purpose (SECURITY.md, CODE_OF_CONDUCT.md)
  if (email.toLowerCase() === MAINTAINER_EMAIL) return true;
  // retina asset names (`hero@2x.png`, `icon@3x.svg`) are file names, not addresses
  if (/^\d+x\.(png|jpe?g|gif|svg|webp|ico|avif)$/.test(domain)) return true;
  return EMAIL_DOMAIN_ALLOWLIST.includes(domain);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function locate(starts: number[], index: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: index - (starts[lo] as number) + 1 };
}

function genericHits(file: AuditFile, starts: number[]): Hit[] {
  const hits: Hit[] = [];
  const push = (index: number, kind: HitKind, match: string): void => {
    hits.push({ file: file.path, ...locate(starts, index), kind, match });
  };
  for (const m of file.text.matchAll(HOME_PATH_RE)) {
    if (!homeNameAllowed(m[1] as string)) push(m.index, 'home-path', m[0]);
  }
  for (const m of file.text.matchAll(TMPDIR_HASH_RE)) {
    if (m[1] !== TMPDIR_HASH_PLACEHOLDER) push(m.index, 'home-path', m[0]);
  }
  for (const m of file.text.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0])) push(m.index, 'email', m[0]);
  }
  for (const m of file.text.matchAll(TICKET_RE)) {
    if (TICKET_PREFIX_ALLOWLIST.includes(m[1] as string)) continue;
    if (CHAR_RANGE_RE.test(m[0])) continue;
    push(m.index, 'ticket-key', m[0]);
  }
  return hits;
}

function bannedHits(file: AuditFile, starts: number[], terms: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  const lower = file.text.toLowerCase();
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      hits.push({ file: file.path, ...locate(starts, idx), kind: 'banned-term', match: file.text.slice(idx, idx + needle.length) });
      from = idx + needle.length;
    }
  }
  return hits;
}

/** Audit file contents. Hits are ordered by file, then line, then column. */
export function auditFiles(files: readonly AuditFile[], opts: AuditOptions): Hit[] {
  const out: Hit[] = [];
  for (const file of files) {
    const starts = lineStarts(file.text);
    const hits = [...(opts.generic ? genericHits(file, starts) : []), ...bannedHits(file, starts, opts.bannedTerms)];
    hits.sort((a, b) => a.line - b.line || a.col - b.col);
    out.push(...hits);
  }
  return out;
}

// --- repo audit ----------------------------------------------------------------

/** Runs `git <args>` in `cwd` and returns stdout. Injected so the audit stays testable. */
export type GitRunner = (args: string[], cwd: string) => string | Promise<string>;

export interface AuditRepoInput {
  dir: string;
  bannedTerms: readonly string[];
  git: GitRunner;
  /** Defaults to a UTF-8 read from the real filesystem. Returns a Buffer so binaries can be detected. */
  readFile?: (path: string) => Buffer;
  /** Defaults to true. */
  generic?: boolean;
}

export interface AuditRepoResult {
  hits: Hit[];
  scanned: number;
  skippedBinary: string[];
  /** Tracked paths that could not be read (deleted in the work tree, submodules, ...). */
  unreadable: string[];
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Audit the tracked files of the git work tree at `dir`. */
export async function auditRepo(input: AuditRepoInput): Promise<AuditRepoResult> {
  const read = input.readFile ?? ((p: string): Buffer => readFileSync(p));
  const listing = await input.git(['ls-files', '-z'], input.dir);
  const paths = listing.split('\0').filter((p) => p.length > 0);
  const files: AuditFile[] = [];
  const skippedBinary: string[] = [];
  const unreadable: string[] = [];
  for (const rel of paths) {
    let buf: Buffer;
    try {
      buf = read(join(input.dir, rel));
    } catch {
      unreadable.push(rel);
      continue;
    }
    if (isBinary(buf)) {
      skippedBinary.push(rel);
      continue;
    }
    files.push({ path: rel, text: buf.toString('utf8') });
  }
  const hits = auditFiles(files, { bannedTerms: input.bannedTerms, generic: input.generic ?? true });
  return { hits, scanned: files.length, skippedBinary, unreadable };
}
