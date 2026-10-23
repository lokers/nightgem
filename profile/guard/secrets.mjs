// Secret-location checks of the nightgem guard (pure; unit-tested through decide.mjs).
//
// Why: the sandbox blocks writes only, so any shell command (and the read/grep/glob tools) could read the user's
// provider API key in ~/.config/opencode/opencode.json, ssh keys, cloud credentials, the run control dir, ...
// This is the guard's best-effort layer: it expands `~`, `$HOME`, `${HOME}` and brace/glob forms and compares path
// segments case-insensitively. A determined obfuscation can still defeat it (documented in the README).
import { homedir } from 'node:os';
import path from 'node:path';

import { CONTROL_DIR_NAME } from './brand.mjs';
import { commandHead, realpathLoose, simpleCommands, tokenize } from './decide.mjs';

/** Unknown-string placeholder for `$VAR`, `$(...)`: behaves like `*` inside a segment. */
const UNK = '\u0001';

/** Sensitive locations relative to $HOME. Whole subtree unless noted. Segments are compared case-insensitively. */
export const SECRET_HOME_ROOTS = [
  '.config/opencode',
  '.local/share/opencode',
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.config/gh',
  // logins of common third-party CLIs (forge and issue-tracker CLIs): a run must not reach those services
  '.config/glab-cli',
  '.config/linear',
  'Library/Keychains',
  `Library/Application Support/${CONTROL_DIR_NAME}`,
  // `cfg.safety.deny.secretPaths` (HOME-relative, from the user profile) are added per call, see `rootsFor`/`textSequencesFor`
];

/**
 * The only skills subtree inside a secret root that the read/grep/glob tools may enter, and only when it is one of
 * `cfg.safety.skillRoots`. Shell commands that mention it stay blocked (the unanchored text backstops cannot tell the
 * subtree from `~/.config/opencode/opencode.json` once the command is obfuscated), so a skill's files are read through the tools.
 */
export const SKILLS_CARVE_OUT = '.config/opencode/skills';

/** File names probed when a glob may reach into a root (used for partially unknown paths). */
const SAMPLE_NAMES = ['opencode.json', 'service.json', 'auth.json', 'id_rsa', 'id_ed25519', 'credentials', 'config', 'hosts.yml', 'password', 'control.json', 'known_hosts'];

const SECRET_ENV_SAMPLES = ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.staging'];

/** Unanchored textual backstops (lower-case, quotes stripped). Whole segment sequences, so `.ssh-keygen` is fine. */
const TEXT_SEQUENCES = [
  ['.config', 'opencode'],
  ['.local', 'share', 'opencode'],
  ['.ssh'],
  ['.aws'],
  ['.kube'],
  ['.config', 'gcloud'],
  ['.config', 'gh'],
  ['.config', 'glab-cli'],
  ['.config', 'linear'],
  ['library', 'keychains'],
  ['library', 'application support', CONTROL_DIR_NAME],
  // ~/.docker/config.json is only matched through resolved paths: a worktree may legitimately hold its own .docker/config.json
].map((segs) => textSequence(segs));

function textSequence(segs) {
  return new RegExp(`(?<![\\w.-])${segs.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('/+')}(?![\\w-])`);
}

const extraCache = new WeakMap();
/** Per-config extras from `cfg.safety.deny.secretPaths`: root records and lower-case text sequences. */
function extrasFor(cfg) {
  const safety = cfg.safety;
  const rels = [...new Set((safety?.deny?.secretPaths ?? []).map((r) => r.trim().replace(/^~\//, '').replace(/\/+$/, '')).filter((r) => r && !r.startsWith('/')))];
  if (!safety || rels.length === 0) return { rels: [], sequences: [] };
  let e = extraCache.get(safety);
  if (!e) extraCache.set(safety, (e = { rels, sequences: rels.map((r) => textSequence(r.toLowerCase().split('/').filter(Boolean))) }));
  return e;
}

/** Word pairs that betray a path assembled from pieces (`os.path.join(h, '.config', 'opencode', ...)`). Whole segments only. */
const reEsc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const segWord = (w) => new RegExp(`(?<![\\w.-])${reEsc(w)}(?![\\w-])`);
const TEXT_PAIRS = [
  ['.config', 'opencode'],
  ['.local', 'opencode'],
  ['.config', 'gcloud'],
  ['library', 'keychains'],
  ['application support', CONTROL_DIR_NAME],
].map(([a, b]) => ({ a, b, ra: segWord(a), rb: segWord(b) }));

/** Commands that merely name or list a directory: referencing an ancestor of a secret root is fine for them. */
const ANCESTOR_SAFE_HEADS = new Set(['ls', 'cd', 'pushd', 'popd', 'echo', 'printf', 'stat', 'pwd', 'test', '[', '[[', 'dirname', 'basename', 'realpath', 'readlink', 'mkdir', 'touch', 'rmdir', 'which', 'type', 'true', 'false', 'export', 'unset', 'df', 'du']);
const RECURSIVE_HEADS = new Set(['find', 'rg', 'ag', 'ack', 'fd', 'tar', 'zip', 'ditto', 'rsync', 'tree', 'locate', 'mdfind']);
const GREP_HEADS = new Set(['grep', 'egrep', 'fgrep', 'zgrep']);
/** Commands that walk everything below an operand: `find /`, `grep -r x /Users`. */
function walksTree(head) {
  if (RECURSIVE_HEADS.has(head.name)) return true;
  return GREP_HEADS.has(head.name) && head.args.some((a) => /^-[a-zA-Z]*[rR]/.test(a.v) || a.v === '--recursive' || a.v === '--dereference-recursive' || a.v === '-d');
}
/** Bare `/` is an ordinary operand for sed/tr/grep/...; only tree walkers treat it as a search root. */
const SLASH_ROOT_HEADS = new Set(['find', 'tree', 'tar', 'zip', 'ditto', 'rsync', 'locate', 'mdfind']);

const BRACE_LIMIT = 256;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const stripQuotes = (s) => s.replace(/['"\\]/g, '');

/** Bash-style brace expansion (comma lists only), capped. Returns null when over the cap. */
export function braceExpand(s, cap = BRACE_LIMIT) {
  const out = [];
  const expand = (str) => {
    if (out.length > cap) return;
    // find first top-level {...} containing a top-level comma
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== '{') continue;
      let depth = 0;
      let j = i;
      const commas = [];
      for (; j < str.length; j++) {
        if (str[j] === '{') depth++;
        else if (str[j] === '}') {
          depth--;
          if (depth === 0) break;
        } else if (str[j] === ',' && depth === 1) commas.push(j);
      }
      if (depth !== 0 || j >= str.length || commas.length === 0) continue;
      const parts = [];
      let from = i + 1;
      for (const c of commas) {
        parts.push(str.slice(from, c));
        from = c + 1;
      }
      parts.push(str.slice(from, j));
      for (const p of parts) expand(str.slice(0, i) + p + str.slice(j + 1));
      return;
    }
    out.push(str);
  };
  expand(s);
  return out.length > cap ? null : out;
}

/** Variables the guard can resolve from the plugin's env (absolute values only). */
const KNOWN_VARS = ['HOME', 'XDG_DATA_HOME', 'TMPDIR'];
function knownVarsOf(cfg, home) {
  const vars = { HOME: home };
  for (const k of KNOWN_VARS) {
    const v = k === 'HOME' ? home : cfg.env?.[k];
    if (typeof v === 'string' && v.startsWith('/')) vars[k] = v.replace(/\/+$/, '') || '/';
  }
  return vars;
}

/** Expand `$HOME`/`${HOME}` (and `$XDG_DATA_HOME`, `$TMPDIR` when known), replace every other expansion by UNK. */
function expandVars(s, vars) {
  return s
    .replace(/\$\{(\w+)\}|\$(\w+)(?![A-Za-z0-9_])/g, (m, a, b) => vars[a ?? b] ?? m)
    .replace(/\$\{[^}]*\}/g, UNK)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, UNK)
    .replace(/\$[0-9@*#?!$-]/g, UNK)
    .replace(/\$/g, '');
}

/**
 * A `..` segment after a prefix the guard cannot resolve (`$VAR/..`, `$(cmd)/..`, a backtick prefix): its target is unknowable.
 * Only dynamic words (unquoted or double-quoted `$`/backtick) count, so a single-quoted sed script is left alone.
 */
function unresolvedDotDot(word, vars) {
  if (!word.dyn) return false;
  let s = word.v;
  // innermost-first removal of `$( ... )` and backtick substitutions
  for (let n = 0; n < 8 && /\$\([^()]*\)/.test(s); n++) s = s.replace(/\$\([^()]*\)/g, UNK);
  s = s.replace(/\$\(.*$/s, UNK).replace(/`[^`]*`?/g, UNK);
  s = expandVars(s, vars);
  const segs = s.split('/');
  const firstUnknown = segs.findIndex((x) => x.includes(UNK));
  return firstUnknown !== -1 && segs.slice(firstUnknown + 1).includes('..');
}

function expandTilde(piece, home, user) {
  if (piece === '~' || piece === '~+' || piece === '~-') return home;
  if (piece.startsWith('~/')) return home + piece.slice(1);
  const m = /^~([^/]+)(\/.*)?$/.exec(piece);
  if (m && m[1] === user) return home + (m[2] ?? '');
  return piece;
}

/**
 * All candidate path strings carried by one shell word (brace, `=`/`:`/`,` and quote aware), as `{ p, whole }`.
 * `whole` is true when the piece is the entire word (not a fragment left over from splitting on `:` or `=`).
 */
function wordPieces(word, home, user, vars) {
  const pre = expandVars(word, vars);
  const variants = braceExpand(pre);
  if (variants === null) return null;
  const pieces = [];
  for (const v of variants) {
    // a quoted/escaped path may contain spaces (`Application Support`): also consider the whole word
    if (/\s/.test(v) && !v.trim().startsWith('-')) {
      const whole = expandTilde(v.trim(), home, user);
      if (whole) pieces.push({ p: whole, whole: true });
    }
    const parts = v.split(/[\s'"`()<>;|&=,:{}]+/).filter(Boolean);
    for (const raw of parts) {
      if (raw.startsWith('-')) continue;
      const p = expandTilde(raw, home, user);
      if (p) pieces.push({ p, whole: parts.length === 1 && raw === v });
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Segment glob matching
// ---------------------------------------------------------------------------

const segReCache = new Map();
function segRegExp(seg) {
  let re = segReCache.get(seg);
  if (re) return re;
  let body = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else if (ch === UNK) body += '.*';
    else if (ch === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end === -1) body += '\\[';
      else {
        let cls = seg.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        body += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else body += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    re = new RegExp(`^${body}$`, 'i');
  } catch {
    re = /^.*$/; // unparsable class: fail closed (matches anything)
  }
  segReCache.set(seg, re);
  return re;
}

/** Does glob segment `g` possibly match the literal segment `lit`? Leading wildcards do not match dot-names. */
function segMatches(g, lit) {
  const gl = g.toLowerCase();
  const ll = lit.toLowerCase();
  if (gl === ll) return true;
  if (lit.startsWith('.') && (g.startsWith('*') || g.startsWith('?'))) return false;
  return segRegExp(g).test(ll);
}

/** Does `G[gi..]` consume exactly `R[ri..rEnd)`? (`**` = zero or more segments.) */
function exact(G, gi, R, ri, rEnd) {
  if (gi === G.length) return ri === rEnd;
  if (G[gi] === '**') return exact(G, gi + 1, R, ri, rEnd) || (ri < rEnd && exact(G, gi, R, ri + 1, rEnd));
  return ri < rEnd && segMatches(G[gi], R[ri]) && exact(G, gi + 1, R, ri + 1, rEnd);
}

/** Does `G` cover all of `R` (so that it may match R itself or anything below it)? */
function covers(G, gi, R, ri) {
  if (ri === R.length) return true;
  if (gi === G.length) return false;
  if (G[gi] === '**') return covers(G, gi + 1, R, ri) || covers(G, gi, R, ri + 1);
  return segMatches(G[gi], R[ri]) && covers(G, gi + 1, R, ri + 1);
}

const segsOf = (p) => p.split('/').filter((s) => s !== '' && s !== '.');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function rootsFor(homes, extraRels = []) {
  const roots = [];
  for (const h of homes) {
    const hs = segsOf(h);
    for (const rel of [...SECRET_HOME_ROOTS, ...extraRels]) roots.push({ segs: [...hs, ...segsOf(rel)], homeDepth: hs.length, rel: segsOf(rel) });
  }
  return roots;
}

/** 'reach' | 'ancestor' | 'shallow' | null for a normalised absolute glob. */
function classifyAbsolute(segs, roots) {
  let result = null;
  for (const r of roots) {
    if (covers(segs, 0, r.segs, 0)) return 'reach';
    for (let k = 0; k < r.segs.length; k++) {
      if (exact(segs, 0, r.segs, 0, k)) {
        if (k >= r.homeDepth) result = 'ancestor';
        else if (result === null) result = 'shallow';
      }
    }
  }
  return result;
}

/** Piece with an unknown (UNK) prefix: unify its tail with the tails of known secret paths. */
function classifyUnknownPrefix(segs, roots) {
  let i = 0;
  while (i < segs.length && segs[i].includes(UNK)) i++;
  const tail = segs.slice(i);
  if (tail.length === 0) return null;
  const seen = new Set();
  for (const r of roots) {
    const key = r.rel.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    const R = r.rel;
    if (R.length >= 2 || tail.length >= 2) {
      // the root appears inside the tail
      for (let off = 0; off + R.length <= tail.length; off++) {
        if (R.every((s, k) => segMatches(tail[off + k], s))) return 'reach';
      }
    }
    if (tail.length >= 2) {
      for (const c of [R, ...SAMPLE_NAMES.map((n) => [...R, n])]) {
        if (c.length < tail.length) continue;
        const start = c.length - tail.length;
        if (tail.every((g, k) => g === '**' || segMatches(g, c[start + k]))) return 'reach';
      }
    }
  }
  return null;
}

function isAllowedEnvName(name) {
  const n = name.toLowerCase();
  return n.endsWith('.example') || n === '.env.defaults' || n === '.env.sample' || n === '.env.template' || n === '.env.dist';
}

/** `.env` secret files: `.env`, `.env.<anything>` except `*.example`, `.env.defaults`, `.env.sample`, `.env.template` and `.env.dist`. Globs fail closed. */
function envFileHit(piece) {
  const base = piece.slice(piece.lastIndexOf('/') + 1);
  if (!base || base === UNK) return false;
  if (!/[*?[\u0001]/.test(base)) {
    const n = base.toLowerCase();
    return (n === '.env' || n.startsWith('.env.')) && !isAllowedEnvName(n);
  }
  return SECRET_ENV_SAMPLES.some((s) => segMatches(base, s));
}

// ---------------------------------------------------------------------------
// Environment dumps
// ---------------------------------------------------------------------------

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `printenv`, bare `env`, `export -p`, bare `set`, `declare -p`, ... Returns a reason or null. */
function envDumpReason(words) {
  // locate the real command, remembering whether `env` was a wrapper with nothing after it
  let i = 0;
  let sawEnv = false;
  while (i < words.length) {
    const w = words[i].v;
    const b = path.basename(w);
    if (ASSIGN_RE.test(w)) {
      i++;
      continue;
    }
    if (b === 'env') {
      sawEnv = true;
      i++;
      while (i < words.length && words[i].v.startsWith('-')) {
        const f = words[i].v;
        i++;
        if ((f === '-u' || f === '-C' || f === '-S' || f === '--unset' || f === '--chdir') && i < words.length) i++;
      }
      continue;
    }
    if (['sudo', 'command', 'builtin', 'time', 'nice', 'nohup', 'exec', 'stdbuf', 'timeout'].includes(b)) {
      i++;
      while (i < words.length && words[i].v.startsWith('-')) i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return sawEnv ? 'dumping the environment (env without a command) is forbidden' : null;
  const name = path.basename(words[i].v);
  const args = words.slice(i + 1).map((a) => a.v);
  const flagsOnly = args.every((a) => a.startsWith('-') || a.startsWith('+'));
  if (name === 'printenv') return 'printenv is forbidden (dumps the environment)';
  if (name === 'security') return 'the security command is forbidden';
  if (name === 'export' && (args.length === 0 || args.includes('-p'))) return 'export -p is forbidden (dumps the environment)';
  if (name === 'set' && args.length === 0) return 'bare set is forbidden (dumps the environment)';
  if ((name === 'declare' || name === 'typeset') && flagsOnly) return `${name} without a name is forbidden (dumps the environment)`;
  if (name === 'compgen' && args.some((a) => /^-[a-zA-Z]*[ev]/.test(a))) return 'compgen -e/-v is forbidden (lists variables)';
  if (name === 'ps' && args.some((a) => /^-[A-Za-z]*E[A-Za-z]*$/.test(a) || /^[A-Za-z]*e[A-Za-z]*$/.test(a))) return 'ps with environment output is forbidden';
  return null;
}

// ---------------------------------------------------------------------------
// Command-aware operand handling
// ---------------------------------------------------------------------------

/** Commands whose operands are only named, listed or deleted, never read: `.env` mentions are fine. */
const ENV_NAMING_HEADS = new Set(['ls', 'echo', 'printf', 'stat', 'test', '[', '[[', 'touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'basename', 'dirname', 'which', 'chmod']);
const ENV_NAMING_GIT = new Set(['check-ignore', 'ls-files', 'add', 'rm', 'mv', 'status', 'restore']);
const DEST_LAST_HEADS = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '-C' || v === '-c') {
      i++;
      continue;
    }
    if (!v.startsWith('-')) return v;
  }
  return '';
}

const GREP_SHORT_VALUE = 'eABCmdD';
const RG_SHORT_VALUE = 'eABCmMgtTjrEd';
const SEARCH_LONG_VALUE = new Set([
  '--regexp', '--glob', '--iglob', '--include', '--exclude', '--exclude-dir', '--type', '--type-not', '--max-count', '--max-depth',
  '--after-context', '--before-context', '--context', '--threads', '--replace', '--sort', '--sortr', '--max-columns', '--encoding', '--colors', '--color', '--colour', '--label', '--max-filesize',
]);

/**
 * grep/rg: the first non-flag operand is the search PATTERN (not a path) unless -e/-f/--regexp/--file is given;
 * `-g`, `--include` and similar values are globs. Returns the words that must not be treated as paths.
 */
function searchSkips(head) {
  const isGrep = GREP_HEADS.has(head.name);
  const isRg = head.name === 'rg';
  const skip = new Set();
  if (!isGrep && !isRg) return skip;
  const shortValue = isGrep ? GREP_SHORT_VALUE : RG_SHORT_VALUE;
  let explicit = false;
  let noPattern = false;
  const positional = [];
  const args = head.args;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].v;
    if (v === '--') {
      for (let j = i + 1; j < args.length; j++) positional.push(args[j]);
      break;
    }
    if (v.startsWith('--')) {
      const name = v.split('=')[0];
      const hasEq = v.includes('=');
      if (name === '--regexp') explicit = true;
      if (name === '--file') explicit = true;
      if (name === '--files' || name === '--type-list') noPattern = true;
      if (SEARCH_LONG_VALUE.has(name) && !hasEq && i + 1 < args.length) {
        skip.add(args[++i]);
      }
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      for (let k = 1; k < v.length; k++) {
        const ch = v[k];
        if (ch === 'f') {
          explicit = true; // the following word is a pattern FILE (a path): keep it
          break;
        }
        if (shortValue.includes(ch)) {
          if (ch === 'e') explicit = true;
          if (k === v.length - 1 && i + 1 < args.length) skip.add(args[++i]);
          break;
        }
      }
      continue;
    }
    positional.push(args[i]);
  }
  if (!explicit && !noPattern && positional.length > 0) skip.add(positional[0]);
  return skip;
}

const INTERPRETER_RE = /^(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby)$/;
const INLINE_FLAG_RE = /^-[a-zA-Z]*[epc]$/;
const DUMP_FORMS = [
  // JS: console.log(process.env), JSON.stringify(process.env, ...), Object.keys/entries/values(process.env), {...process.env}, -p process.env
  /(?:\(|\.\.\.|,|^)\s*process\.env\s*(?=[,)}]|$)/,
  // Python: print(os.environ), dict(os.environ), os.environ.items()/keys()/values()/copy()
  /(?:\(|,|^)\s*os\.environ\s*(?=[,)]|$)/,
  /\bos\.environ\.(?:items|keys|values|copy)\s*\(/,
  // Ruby: ENV.to_h, p ENV
  /\bENV\.(?:to_h|to_hash|to_a|each|each_pair|inspect|keys|values|map|select)\b/,
  /\b(?:p|pp|puts|print)\s+ENV\s*$/,
  // Perl: %ENV dumps (`$ENV{X}` lookups stay allowed)
  /%ENV\b/,
];

/** Inline interpreter code that dumps the whole environment. Returns a reason or null. */
function interpreterDumpReason(head) {
  if (!INTERPRETER_RE.test(head.name)) return null;
  const inline = head.args.some((a) => INLINE_FLAG_RE.test(a.v) || a.v === '--eval' || a.v === '--print') || (head.name === 'deno' && head.args[0]?.v === 'eval');
  if (!inline) return null;
  for (const a of head.args) {
    if (a.v.startsWith('-')) continue;
    if (DUMP_FORMS.some((re) => re.test(a.v))) return 'dumping the whole environment from interpreter code is forbidden';
  }
  return null;
}

/**
 * Read-only carve-outs for the read/grep/glob tools: `~/.config/opencode/skills` (or a root below it) when it is one of
 * `cfg.safety.skillRoots` (also when the list holds its realpath because the dir is a symlink).
 */
const carveCache = new WeakMap();
function skillCarveOuts(cfg, homes) {
  const roots = cfg.safety?.skillRoots;
  if (!roots?.length) return [];
  const key = homes.join('\0');
  let perSafety = carveCache.get(cfg.safety);
  if (!perSafety) carveCache.set(cfg.safety, (perSafety = new Map()));
  if (perSafety.has(key)) return perSafety.get(key);
  const result = computeCarveOuts(cfg, homes, roots);
  perSafety.set(key, result);
  return result;
}

function computeCarveOuts(cfg, homes, roots) {
  const under = (a, b) => a === b || a.startsWith(`${b}/`);
  const extraRels = extrasFor(cfg).rels;
  const out = [];
  for (const h of homes) {
    const carve = path.join(h, SKILLS_CARVE_OUT);
    const parentSecret = path.join(h, '.config', 'opencode');
    // the same overlap rule as `skillRootAccess` (src/profile.ts): a secret path in the way (inside the root, or the root inside it)
    // wins over the carve-out; the opencode config dir itself is the one allowed parent
    const secrets = [...SECRET_HOME_ROOTS, ...extraRels].map((rel) => path.join(h, rel)).filter((x) => x !== parentSecret);
    let carveReal = carve;
    try {
      carveReal = realpathLoose(carve);
    } catch {
      /* keep literal */
    }
    for (const raw of roots) {
      const r = raw.replace(/\/+$/, '');
      if (!r.startsWith('/') || /[*?[\]{}\0\n\r]/.test(r) || r.split('/').includes('..')) continue;
      if (under(h, r)) continue; // `/`, $HOME and its ancestors
      const dir = under(r, carve) ? r : r === carveReal ? carve : null;
      if (!dir) continue;
      if (secrets.some((x) => under(dir, x) || under(x, dir))) continue;
      let real = dir;
      try {
        real = realpathLoose(dir);
      } catch {
        /* keep literal */
      }
      out.push({ dir: dir.toLowerCase(), segs: segsOf(dir).map((x) => x.toLowerCase()), realSegs: segsOf(real).map((x) => x.toLowerCase()), followLinks: true });
    }
  }
  return out;
}

/** Reads of `<XDG_DATA_HOME>/opencode/tool-output/**` (truncated tool output) stay allowed. */
function toolOutputAllow(cfg) {
  const xdg = cfg.env?.XDG_DATA_HOME;
  if (!xdg || !xdg.startsWith('/')) return null;
  const dir = path.join(xdg, 'opencode', 'tool-output');
  let real = dir;
  try {
    real = realpathLoose(dir);
  } catch {
    /* keep literal */
  }
  return { dir: dir.toLowerCase(), segs: segsOf(dir).map((x) => x.toLowerCase()), realSegs: segsOf(real).map((x) => x.toLowerCase()) };
}

const startsWithSegs = (segs, prefix) => segs.length >= prefix.length && prefix.every((x, i) => segs[i].toLowerCase() === x);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function homeInfo(cfg) {
  const home = (cfg.env?.HOME || homedir()).replace(/\/+$/, '') || '/';
  const homes = [home];
  try {
    const real = realpathLoose(home);
    if (real !== home) homes.push(real);
  } catch {
    /* keep literal home */
  }
  return { home, homes, user: path.basename(home) };
}

/**
 * Text-only backstops (no shell parsing): used for heredoc bodies that are data. A body that merely NAMES a secret
 * location is refused, because it might be a script about to be run. Returns the block reason or null.
 */
export function checkSecretText(text, cfg = {}) {
  const extras = extrasFor(cfg);
  const lower = stripQuotes(text).toLowerCase();
  if (/dotglob|glob_?dots|dot_?glob/.test(lower)) return 'enabling dot-file globbing is forbidden';
  const compact = lower.replace(/\s+/g, ' ');
  for (const v of [compact, compact.replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/')]) {
    for (const re of [...TEXT_SEQUENCES, ...extras.sequences]) if (re.test(v)) return `references a secret location (${re.source.includes('opencode') ? 'opencode config/data' : 'credentials directory'})`;
    for (const { a, b, ra, rb } of TEXT_PAIRS) if (ra.test(v) && rb.test(v)) return `references a secret location assembled from pieces (${a} ... ${b})`;
  }
  return null;
}

/**
 * `null` when the shell command references no secret location, otherwise the block reason.
 * Called by `checkShellCommand` for the command and for every inner string.
 */
export function checkSecretReferences(cmd, cfg) {
  const { home, homes, user } = homeInfo(cfg);
  const vars = knownVarsOf(cfg, home);
  const extras = extrasFor(cfg);
  const roots = rootsFor(homes, extras.rels);
  // shell: only the tool-output allow; the skills carve-out is for the read/grep/glob tools (see SKILLS_CARVE_OUT)
  const allow = toolOutputAllow(cfg);
  const stripped = stripQuotes(cmd);

  // -- cheap text-level backstops
  const lower = stripped.toLowerCase();
  if (/dotglob|glob_?dots|dot_?glob/.test(lower)) return 'enabling dot-file globbing is forbidden';
  if (/\$'[^']*\\(?:x[0-9a-fA-F]|[0-7]{1,3}|u[0-9a-fA-F])/.test(cmd)) return 'ANSI-C quoted escapes ($\'\\x..\') are forbidden';
  if (/\$\{![^}]*\}/.test(cmd)) return 'indirect variable name expansion (${!...}) is forbidden';
  let compact = lower.replace(/\s+/g, ' ');
  // the allowed tool-output directory sits below the control dir: take it out before the unanchored checks
  if (allow) compact = compact.split(allow.dir).join('');
  // normalised variants: literal text, and with `/./` and `//` collapsed (the sequences are unanchored anyway)
  for (const v of [compact, compact.replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/')]) {
    for (const re of [...TEXT_SEQUENCES, ...extras.sequences]) if (re.test(v)) return `references a secret location (${re.source.includes('opencode') ? 'opencode config/data' : 'credentials directory'})`;
    for (const { a, b, ra, rb } of TEXT_PAIRS) if (ra.test(v) && rb.test(v)) return `references a secret location assembled from pieces (${a} ... ${b})`;
  }

  // -- per simple command, with `cd` tracking
  let base = cfg.cwd ?? process.cwd();
  if (cfg.workdir) base = path.resolve(base, cfg.workdir);
  let baseKnown = true;
  const fedToReader = /(?<![\w.-])(?:xargs|parallel)(?![\w-])/.test(lower);
  for (const c of simpleCommands(tokenize(cmd))) {
    const dump = envDumpReason(c.words);
    if (dump) return dump;
    const head = commandHead(c.words);
    const idump = interpreterDumpReason(head);
    if (idump) return idump;

    const skip = searchSkips(head);
    const positional = head.args.filter((a) => !a.v.startsWith('-'));
    const destWord = DEST_LAST_HEADS.has(head.name) && positional.length >= 2 ? positional[positional.length - 1] : null;
    // naming commands may mention `.env`, unless their output is piped on to a reader or `xargs` could turn names into reads
    const envIgnored = !fedToReader && !c.pipeOut && (ENV_NAMING_HEADS.has(head.name) || (head.name === 'git' && ENV_NAMING_GIT.has(gitSubcommand(head.args))));
    const entries = [
      ...c.words.map((w) => ({ w, out: false })),
      ...c.redirs.filter((r) => r.target).map((r) => ({ w: r.target, out: true })),
    ];

    let cdTarget;
    if (head.name === 'cd' || head.name === 'pushd') {
      const arg = head.args.find((a) => !a.v.startsWith('-'));
      cdTarget = arg ? arg.v : '~';
    }

    for (const { w, out } of entries) {
      if (unresolvedDotDot(w, vars)) return `path with '..' after an unresolvable prefix: ${w.v}`;
      if (skip.has(w)) continue;
      const pieces = wordPieces(w.v, home, user, vars);
      if (pieces === null) return 'brace expansion too large to inspect';
      for (const { p: piece, whole } of pieces) {
        if (!out && !envIgnored && w !== destWord && envFileHit(piece)) return `references a .env secrets file: ${piece}`;
        const verdict = classifyPiece(piece, { base, baseKnown, roots, homes, allows: allow ? [allow] : [], bareSlashIsRoot: SLASH_ROOT_HEADS.has(head.name) || (GREP_HEADS.has(head.name) && walksTree(head)) });
        if (verdict === 'reach') return `references a secret location: ${piece}`;
        if (!whole) continue; // fragments of `a:b`, `x=y`, URLs: only whole-word operands count as search roots
        if (verdict === 'ancestor' && !ANCESTOR_SAFE_HEADS.has(head.name)) return `recursive/bulk access to a directory containing secrets: ${piece}`;
        if (verdict === 'shallow' && walksTree(head)) return `recursive search over a directory containing secrets: ${piece}`;
      }
    }

    if (cdTarget !== undefined) {
      const piece = wordPieces(cdTarget, home, user, vars)?.[0]?.p;
      if (piece && !piece.includes(UNK) && !/[*?[]/.test(piece)) {
        try {
          base = realpathLoose(path.resolve(base, piece));
          baseKnown = true;
        } catch {
          baseKnown = false;
        }
      } else {
        baseKnown = false;
      }
    }
  }
  return null;
}

function classifyPiece(piece, { base, baseKnown, roots, allows, bareSlashIsRoot }) {
  let segs;
  if (piece.startsWith('/')) segs = segsOf(path.posix.normalize(piece));
  else if (piece.includes(UNK) && segsOf(piece)[0]?.includes(UNK)) return classifyUnknownPrefix(segsOf(piece), roots);
  else if (baseKnown) segs = segsOf(path.posix.normalize(path.join(base, piece)));
  else return classifyUnknownPrefix(segsOf(path.posix.normalize(piece)), roots);

  // `/`, `//`, `/./`: ordinary operands for sed/tr/grep/...; only tree walkers treat them as a search root
  if (segs.length === 0 && !bareSlashIsRoot) return null;

  // the run's truncated tool output (read-only; a symlink inside must still resolve inside)
  for (const allow of allows) {
    if (!startsWithSegs(segs, allow.segs)) continue;
    // a segment that starts with `..` could be a glob standing for the parent directory: never trust the prefix then
    if (segs.slice(allow.segs.length).some((x) => x.startsWith('..'))) continue;
    if (/[*?[\u0001]/.test(piece)) return null;
    try {
      const abs = piece.startsWith('/') ? path.posix.normalize(piece) : path.join(base, piece);
      const realPath = realpathLoose(abs);
      const real = segsOf(realPath).map((x) => x.toLowerCase());
      if (startsWithSegs(real, allow.realSegs) || startsWithSegs(real, allow.segs)) return null;
      // a symlink inside a carved-out subtree: judged on its target (a link to ~/.ssh stays blocked, one into the repo is fine)
      if (allow.followLinks) return classifyAbsolute(segsOf(realPath), roots);
    } catch {
      return null;
    }
  }

  const verdict = classifyAbsolute(segs, roots);
  if (verdict) return verdict;
  if (!/[*?[\u0001]/.test(piece)) {
    // follow symlinks of existing paths (a worktree symlink to ~/.ssh)
    try {
      const abs = piece.startsWith('/') ? piece : path.join(base, piece);
      const real = realpathLoose(abs);
      if (real !== abs) return classifyAbsolute(segsOf(real), roots);
    } catch {
      /* unresolvable: treated as not sensitive */
    }
  }
  return null;
}

const SEARCH_TOOLS = new Set(['grep', 'glob', 'ast_grep_search', 'ast_grep_replace', 'list', 'ls', 'codesearch']);
export const SECRET_READ_TOOLS = new Set(['read', 'view', ...SEARCH_TOOLS]);
const INPUT_PATH_KEYS = ['filePath', 'file_path', 'path', 'filepath', 'file', 'directory', 'dir', 'cwd'];

/** Second layer next to `external_directory` for the read, grep, glob (and listing) tools. */
export function checkSecretToolInput(tool, input, cfg) {
  const { home, homes, user } = homeInfo(cfg);
  const vars = knownVarsOf(cfg, home);
  const roots = rootsFor(homes, extrasFor(cfg).rels);
  const base = cfg.cwd ?? process.cwd();
  const toolOut = toolOutputAllow(cfg);
  const allows = [...(toolOut ? [toolOut] : []), ...skillCarveOuts(cfg, homes)];
  // listing names (glob, list, ls) never reads `.env` content; reading tools do
  const readsContent = tool === 'read' || tool === 'view' || tool === 'grep' || tool.startsWith('ast_grep') || tool === 'codesearch';
  const candidates = [];
  for (const k of INPUT_PATH_KEYS) if (typeof input[k] === 'string' && input[k]) candidates.push(input[k]);
  for (const k of ['paths', 'globs']) if (Array.isArray(input[k])) for (const v of input[k]) if (typeof v === 'string') candidates.push(v);
  if (tool === 'glob' && typeof input.pattern === 'string') candidates.push(input.pattern);
  if (typeof input.include === 'string' && /[/~]/.test(input.include)) candidates.push(input.include);
  for (const cand of candidates) {
    const pre = expandVars(cand, vars);
    const variants = braceExpand(pre);
    if (variants === null) return 'brace expansion too large to inspect';
    for (const v of variants) {
      const piece = expandTilde(v.trim(), home, user);
      if (!piece) continue;
      if (readsContent && !(tool === 'glob') && envFileHit(piece)) return `references a .env secrets file: ${piece}`;
      const verdict = classifyPiece(piece, { base, baseKnown: true, roots, allows, bareSlashIsRoot: true });
      if (verdict === 'reach') return `references a secret location: ${piece}`;
      if (SEARCH_TOOLS.has(tool) && (verdict === 'ancestor' || verdict === 'shallow') && tool !== 'ls' && tool !== 'list')
        return `recursive search over a directory containing secrets: ${piece}`;
    }
  }
  return null;
}
