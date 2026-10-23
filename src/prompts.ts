/**
 * Prompt loader and renderer for the autonomous run.
 *
 * Templates live in `prompts/*.md` and use `{{var}}` placeholders. Rendering is strict: a missing or
 * unknown placeholder throws, so a typo can never reach an unattended agent. `{{neverList}}` is built in
 * (from `prompts/_partials/never-list.md`) so every append carries the identical never-list. The partial may use
 * placeholders too (e.g. `{{workspaceRoot}}`); they are filled from the same vars, so they count as required vars of
 * every prompt that embeds it.
 *
 * Run-context vars (filled from the resolved run context): `workspaceRoot`, `workspaceInstructions` (the profile's
 * instructions file, or a "none" default) and `skillsList` (names of the skills the run may load).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPT_NAMES = [
  'orchestrator_append',
  'fixer_append',
  'designer_append',
  'oracle_append',
  'phase-plan',
  'phase-build',
  'phase-review',
  'phase-review-lite',
  'phase-report',
  'nudge',
  'wind-down',
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export type PromptVars = Record<string, string | number>;

/** Placeholder filled by the renderer itself. Callers do not pass it. */
export const BUILTIN_VARS = ['neverList'] as const;

export const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function assertPromptName(name: string): asserts name is PromptName {
  if (!(PROMPT_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown prompt "${name}" (expected one of: ${PROMPT_NAMES.join(', ')})`);
  }
}

function loadTemplate(name: PromptName): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
}

function loadNeverList(): string {
  return readFileSync(join(PROMPTS_DIR, '_partials', 'never-list.md'), 'utf8').trimEnd();
}

/** Variables the caller must supply for `name` (built-ins excluded, the never-list's vars included), sorted. */
export function promptVars(name: PromptName): string[] {
  assertPromptName(name);
  const template = loadTemplate(name);
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) found.add(m[1]!);
  if (found.has('neverList')) {
    for (const m of loadNeverList().matchAll(PLACEHOLDER_RE)) found.add(m[1]!);
  }
  for (const b of BUILTIN_VARS) found.delete(b);
  return [...found].sort();
}

/**
 * Render a prompt. Throws on an unknown prompt name and on any placeholder without a value (a placeholder
 * the caller does not know about counts as missing). Extra vars are ignored, so one shared var set can
 * render every prompt.
 */
export function renderPrompt(name: PromptName | string, vars: PromptVars): string {
  assertPromptName(name);
  const template = loadTemplate(name);
  const needed = new Set(promptVars(name));

  const missing = [...needed].filter((v) => !(v in vars) || vars[v] === undefined || vars[v] === null);
  if (missing.length > 0) {
    throw new Error(`Prompt "${name}" is missing vars: ${missing.join(', ')}`);
  }

  // Single pass over the template (and over the never-list partial), so substituted values are never re-scanned
  // for placeholders.
  const fill = (text: string): string => text.replace(PLACEHOLDER_RE, (_all, key: string) => String(vars[key]));
  const never = fill(loadNeverList());
  return template.replace(PLACEHOLDER_RE, (_all, key: string) => (key === 'neverList' ? never : String(vars[key])));
}

export interface AppendFile {
  name: PromptName;
  /** File name to install under `.run/.opencode/oh-my-opencode-slim/`. */
  fileName: string;
  /** Absolute path of the template. */
  path: string;
}

/** The `*_append.md` templates to install as slim system appends (render each with `renderPrompt`). */
export function listAppends(): AppendFile[] {
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('_append.md'))
    .sort()
    .map((fileName) => {
      const name = fileName.slice(0, -3);
      assertPromptName(name);
      return { name, fileName, path: join(PROMPTS_DIR, fileName) };
    });
}
