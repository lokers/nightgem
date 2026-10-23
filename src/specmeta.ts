/**
 * Parse SPEC.md: approval status, ticket key and the affected repos. Repos resolve under the configured workspace root.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { specsDir } from './paths.ts';

export interface SpecRepo {
  name: string;
  path: string;
}

export interface SpecMeta {
  title: string;
  status: string;
  approved: boolean;
  /** Issue-tracker key found in the spec title (see `ParseSpecOptions.keyPattern`). */
  ticketKey?: string;
  repos: SpecRepo[];
}

const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** First path segment under the workspace for `<workspaceRoot>/x/...` and `~/x/...` (when `~` resolves into it), else null. */
function underWorkspace(token: string, workspaceRoot: string, home: string): string | null {
  const root = workspaceRoot.replace(/\/+$/, '');
  let abs: string | null = null;
  if (token.startsWith('~/')) abs = join(home, token.slice(2));
  else if (token.startsWith('$HOME/')) abs = join(home, token.slice(6));
  else if (isAbsolute(token)) abs = token;
  if (abs === null) return null;
  if (!abs.startsWith(`${root}/`)) return '';
  return abs.slice(root.length + 1).split('/')[0] ?? '';
}

/** Pull candidate repo names out of the first cell of an "Affected repos" table row. */
function candidatesFromCell(cell: string, workspaceRoot: string, home: string): string[] {
  const out: string[] = [];
  const tokens = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  const raw = tokens.length > 0 ? tokens : [cell.replace(/\*\*/g, '').trim()];
  for (let token of raw) {
    token = token.trim();
    if (token === '' || token.includes('<')) continue;
    const inside = underWorkspace(token, workspaceRoot, home);
    if (inside !== null) {
      if (NAME_RE.test(inside)) out.push(inside);
    } else if (!token.includes('/') && NAME_RE.test(token)) {
      out.push(token);
    }
  }
  return out;
}

function affectedReposSection(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Affected repos/i.test(l));
  if (start < 0) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trim().startsWith('|')) rows.push(line);
  }
  return rows;
}

function firstCell(row: string): string {
  return (row.trim().replace(/^\|/, '').split('|')[0] ?? '').trim();
}

export interface ParseSpecOptions {
  home?: string;
  /** Directory holding the repos and `.specs`. Required: there is no built-in default location. */
  workspaceRoot: string;
  /** Ticket key pattern for the spec title; group 1 (else the whole match) is the key. Default: `[A-Z][A-Z0-9]+-\d+`. */
  keyPattern?: RegExp;
  /** `--repos a,b`: names under the workspace root or absolute paths. Replaces the table. */
  repoOverride?: string[];
}

export function parseSpec(text: string, opts: ParseSpecOptions): SpecMeta {
  const home = opts.home ?? homedir();
  const workspaceRoot = opts.workspaceRoot;

  const statusMatch = /^Status:\s*(.+)$/im.exec(text);
  const status = (statusMatch?.[1] ?? '').trim();
  const statusWord = /^[A-Za-z-]+/.exec(status)?.[0] ?? '';
  const approved = statusWord.toUpperCase() === 'APPROVED';

  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? '').trim();
  const keyMatch = (opts.keyPattern ?? TICKET_KEY_RE).exec(title);
  const ticketKey = keyMatch?.[1] ?? keyMatch?.[0];

  if (!approved) {
    throw new Error(
      `Spec is not approved (Status: ${status === '' ? 'missing' : status}). Set "Status: APPROVED" in SPEC.md before launching.`,
    );
  }

  const repos: SpecRepo[] = [];
  const add = (name: string, path: string): void => {
    if (!repos.some((r) => r.path === path)) repos.push({ name, path });
  };

  if (opts.repoOverride && opts.repoOverride.length > 0) {
    for (const entry of opts.repoOverride) {
      const path = isAbsolute(entry) ? resolve(entry) : join(workspaceRoot, entry);
      if (!isGitRepo(path)) throw new Error(`--repos: "${entry}" is not a git repo (${path})`);
      add(path.slice(path.lastIndexOf('/') + 1), path);
    }
  } else {
    for (const row of affectedReposSection(text)) {
      for (const name of candidatesFromCell(firstCell(row), workspaceRoot, home)) {
        const path = join(workspaceRoot, name);
        if (isGitRepo(path)) add(name, path);
      }
    }
    if (repos.length === 0) {
      throw new Error(
        `No repos found in the "Affected repos" table of SPEC.md (need a first-column entry such as \`<name>\` or \`${workspaceRoot}/<name>\` that is a git repo under the workspace ${workspaceRoot}). Use --repos a,b to override.`,
      );
    }
  }

  return { title, status, approved, ...(ticketKey ? { ticketKey } : {}), repos };
}

/** Read `<workspaceRoot>/.specs/<slug>/SPEC.md` and parse it. */
export function loadSpec(slug: string, opts: ParseSpecOptions): SpecMeta {
  const file = join(specsDir(slug, opts.workspaceRoot), 'SPEC.md');
  if (!existsSync(file)) throw new Error(`SPEC.md not found: ${file}`);
  return parseSpec(readFileSync(file, 'utf8'), opts);
}
