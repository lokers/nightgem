/**
 * Skill detection.
 *
 * Pure and explicit: `detectSkills` takes `home`, `fs` and every other input as parameters and never reads the real
 * HOME, `process.env` or the cwd. A skill is a directory `<root>/<name>/SKILL.md`; one level of nesting
 * (`<root>/<plugin>/<name>/SKILL.md`) is also scanned.
 *
 * Secrets: the user's `opencode.json` holds provider API keys. Only the `skills` key is ever read (via a JSONC syntax
 * tree, so no other key is even materialised), and nothing but skill paths is returned or logged.
 */
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';

import type { SkillDetection, SkillEntry } from './contracts.js';
import { globMatch } from './glob.js';
import { expandHome, validateSkillRoot } from './userprofile.js';

/** The skills `doctor` hard-fails without. */
export const CORE_REQUIRED_SKILLS = [
  'spec-driven-development',
  'planning-and-task-breakdown',
  'test-driven-development',
  'incremental-implementation',
  'code-review-and-quality',
] as const;

/** Generic patterns for skills that make no sense in an unattended run (tracker, release and publish workflows). */
export const DEFAULT_DISABLE_PATTERNS: readonly string[] = ['*jira*', '*release*', '*ship*', '*changelog*', '*publish*'];

/** The slice of `node:fs` this module uses. `import * as fs from 'node:fs'` satisfies it. */
export interface SkillsFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
}

export interface DetectSkillsInput {
  home: string;
  fs: SkillsFs;
  /** Path of the user's `opencode.json`; only its `skills` key is read. Omit to skip. */
  opencodeConfigPath?: string;
  /** Profile `skills.extraRoots`. */
  extraRoots?: readonly string[];
  /** Profile `skills.exclude`: globs matched on the skill name and on its realpath. */
  exclude?: readonly string[];
  /** Profile `skills.required`: added to {@link CORE_REQUIRED_SKILLS}. */
  required?: readonly string[];
}

/**
 * `SkillDetection` plus the extra facts `doctor` and the launcher need. The extra fields are not part of the
 * `SkillDetection` contract schema (a zod parse strips them), so consumers must read them before persisting.
 */
export interface SkillDetectionResult extends SkillDetection {
  /** Required skills that an exclude pattern removed. Non-empty means `doctor` must hard-fail. */
  excludedRequired: string[];
  /** Roots (or skill directories) that exist but failed `validateSkillRoot`, and were not scanned. */
  rootRejected: { root: string; reasons: string[] }[];
  /** Realpaths of available skills that lie outside every scanned root (so the run would not be allowed to read them). */
  outsideRoots: string[];
}

// ---------------------------------------------------------------------------
// opencode.json (`skills` key only)
// ---------------------------------------------------------------------------

/** Skill roots from the `skills` key. Accepts a string, an array, or an object with `paths`. Never throws. */
export function readConfiguredSkillRoots(configPath: string, home: string, fs: Pick<SkillsFs, 'readFileSync'>): string[] {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  let value: unknown;
  try {
    const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    const node = tree ? findNodeAtLocation(tree, ['skills']) : undefined;
    value = node ? getNodeValue(node) : undefined;
  } catch {
    return [];
  }

  const raw: unknown[] = [];
  const take = (v: unknown): void => {
    if (typeof v === 'string') raw.push(v);
    else if (Array.isArray(v)) v.forEach((x) => (typeof x === 'string' ? raw.push(x) : take(pathOf(x))));
  };
  const pathOf = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)['path'] : undefined;

  if (typeof value === 'string' || Array.isArray(value)) take(value);
  else if (value !== null && typeof value === 'object') take((value as Record<string, unknown>)['paths']);

  const base = dirname(configPath);
  return raw
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim()))
    .map((p) => {
      const expanded = expandHome(p.trim(), home);
      return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
    });
}

// ---------------------------------------------------------------------------
// SKILL.md
// ---------------------------------------------------------------------------

/** `name:` from the leading `---` frontmatter block, or undefined. */
export function parseSkillName(skillMd: string): string | undefined {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(skillMd);
  if (!m) return undefined;
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const nm = /^name[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!nm) continue;
    let v = nm[1] as string;
    if (/^(["']).*\1$/.test(v) && v.length >= 2) v = v.slice(1, -1);
    v = v.trim();
    return v === '' ? undefined : v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const isDir = (fs: SkillsFs, p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (fs: SkillsFs, p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const realOr = (fs: SkillsFs, p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const listDir = (fs: SkillsFs, p: string): string[] => {
  try {
    return fs.readdirSync(p).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
};

const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

interface Candidate {
  name: string;
  root: string;
  /** Realpath of the skill directory. */
  path: string;
  /** The unresolved path it was found under. */
  alias: string;
}

function skillAt(fs: SkillsFs, dir: string, fallbackName: string): { name: string } | undefined {
  const md = join(dir, 'SKILL.md');
  if (!isFile(fs, md)) return undefined;
  let name: string | undefined;
  try {
    name = parseSkillName(fs.readFileSync(md, 'utf8'));
  } catch {
    name = undefined;
  }
  return { name: name ?? fallbackName };
}

export function detectSkills(input: DetectSkillsInput): SkillDetectionResult {
  const { home, fs } = input;
  const exclude = (input.exclude ?? []).map((g) => expandHome(g, home));

  // 1. Candidate roots, in order.
  const candidateRoots: string[] = [
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
    ...(input.opencodeConfigPath ? readConfiguredSkillRoots(input.opencodeConfigPath, home, fs) : []),
    ...(input.extraRoots ?? []).map((r) => expandHome(r, home)),
  ];

  // 2. Validate: drop non-existent, reject unsafe, de-duplicate by realpath.
  const roots: string[] = [];
  const rootRejected: SkillDetectionResult['rootRejected'] = [];
  for (const cand of candidateRoots) {
    if (!isAbsolute(cand)) {
      rootRejected.push({ root: cand, reasons: [`"${cand}" is not an absolute path`] });
      continue;
    }
    if (!isDir(fs, cand)) continue;
    const reasons = validateSkillRoot(cand, { home, fs });
    if (reasons.length > 0) {
      rootRejected.push({ root: cand, reasons });
      continue;
    }
    const real = realOr(fs, cand);
    if (!roots.includes(real)) roots.push(real);
  }

  // 3. Discover, de-duplicating by realpath (first root wins).
  const byReal = new Map<string, Candidate>();
  const aliases = new Map<string, string[]>();
  const ordered: Candidate[] = [];
  const consider = (root: string, dir: string, fallbackName: string): boolean => {
    const found = skillAt(fs, dir, fallbackName);
    if (!found) return false;
    const real = realOr(fs, dir);
    const seen = byReal.get(real);
    if (seen) {
      aliases.get(real)?.push(dir);
      return true;
    }
    const skillReasons = validateSkillRoot(real, { home, fs });
    if (skillReasons.length > 0) {
      rootRejected.push({ root: real, reasons: skillReasons });
      return true;
    }
    const cand: Candidate = { name: found.name, root, path: real, alias: dir };
    byReal.set(real, cand);
    aliases.set(real, [dir]);
    ordered.push(cand);
    return true;
  };
  for (const root of roots) {
    for (const entry of listDir(fs, root)) {
      const dir = join(root, entry);
      if (!isDir(fs, dir)) continue;
      if (consider(root, dir, entry)) continue;
      for (const sub of listDir(fs, dir)) {
        const subDir = join(dir, sub);
        if (isDir(fs, subDir)) consider(root, subDir, sub);
      }
    }
  }

  // 4. Name collisions: the same name at different realpaths. First one wins.
  const keptByName = new Map<string, Candidate>();
  const collisionPaths = new Map<string, string[]>();
  const kept: Candidate[] = [];
  for (const c of ordered) {
    const first = keptByName.get(c.name);
    if (!first) {
      keptByName.set(c.name, c);
      kept.push(c);
    } else {
      const list = collisionPaths.get(c.name) ?? [first.path];
      list.push(c.path);
      collisionPaths.set(c.name, list);
    }
  }
  const collisions = [...collisionPaths].map(([name, paths]) => ({ name, paths }));

  // 5. Exclusion on the skill name and on the realpath (and the paths it was reached through).
  const available: SkillEntry[] = [];
  const excluded: SkillDetection['excluded'] = [];
  for (const c of kept) {
    const targets = [c.path, ...(aliases.get(c.path) ?? [])];
    const pattern = exclude.find((g) => globMatch(g, c.name) || targets.some((t) => globMatch(g, t)));
    if (pattern !== undefined) {
      excluded.push({ name: c.name, path: c.path, reason: `pattern:${pattern}` });
    } else {
      available.push({ name: c.name, root: c.root, path: c.path });
    }
  }

  // 6. Required skills.
  const requiredAll = [...new Set<string>([...CORE_REQUIRED_SKILLS, ...(input.required ?? [])])];
  const have = new Set(available.map((s) => s.name));
  const excludedNames = new Set(excluded.map((s) => s.name));
  const missingRequired = requiredAll.filter((n) => !have.has(n));
  const excludedRequired = missingRequired.filter((n) => excludedNames.has(n));

  return {
    available,
    excluded,
    missingRequired,
    collisions,
    roots,
    excludedRequired,
    rootRejected,
    outsideRoots: available.filter((s) => !roots.some((r) => within(r, s.path))).map((s) => s.path),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Names only, sorted, one per line (`- name`). Descriptions are loaded by the agent on demand. */
export function renderSkillsList(det: Pick<SkillDetection, 'available'>): string {
  return [...new Set(det.available.map((s) => s.name))]
    .sort()
    .map((n) => `- ${n}`)
    .join('\n');
}

/**
 * The skills text the prompt appends offer to the agents: the available skills minus the ones the run disables (slim
 * `disabled_skills`: the profile's excludes plus the default patterns), by name, one `- name` per line. `(none detected)` when empty.
 */
export function offeredSkillsText(ctx: { skills: Pick<SkillDetection, 'available'>; safety: { disabledSkills: readonly string[] } }): string {
  const disabled = new Set(ctx.safety.disabledSkills);
  const text = renderSkillsList({ available: ctx.skills.available.filter((s) => !disabled.has(s.name)) });
  return text === '' ? '(none detected)' : text;
}

/**
 * Concrete names for slim `disabled_skills`: every excluded skill, plus every available skill matching
 * {@link DEFAULT_DISABLE_PATTERNS} or `disablePatterns` (case-insensitive, on the name). Sorted, unique.
 */
export function disabledSkillNames(det: Pick<SkillDetection, 'available' | 'excluded'>, disablePatterns: readonly string[] = []): string[] {
  const patterns = [...DEFAULT_DISABLE_PATTERNS, ...disablePatterns];
  const out = new Set<string>(det.excluded.map((s) => s.name));
  for (const s of det.available) {
    if (patterns.some((p) => globMatch(p, s.name, { caseSensitive: false }))) out.add(s.name);
  }
  return [...out].sort();
}
