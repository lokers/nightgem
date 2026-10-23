// Pure decision logic of the nightgem guard plugin (no opencode imports; unit-tested).
// `decide(event, cfg)` => { verdict: 'allow' | 'block' | 'rewrite', reason?, input? }
//
// Secret locations (opencode config, ssh/cloud credentials, .env files, env dumps): see ./secrets.mjs.
//
// Philosophy: best-effort second layer behind the permission profile and the env layer,
// in front of the sandbox. Everything ambiguous fails closed.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { APP, ENV_PREFIX } from './brand.mjs';
import { SECRET_READ_TOOLS, checkSecretReferences, checkSecretText, checkSecretToolInput } from './secrets.mjs';

export const GUARD_PREFIX = `${APP} guard: `;
export const CONTROL_FLAGS_FILE = 'control.json';
/** Default agent-writable files directly under .specs/<slug>/.run/ (keep in sync with src/profile.ts). */
export const DEFAULT_RUN_WRITABLE = ['tasks.jsonl', 'decisions.jsonl', 'run-complete.json'];
export const HEARTBEAT_MAX_AGE_MS = 120_000;

/** Tools that start more work; refused once the soft stop is set. */
export const SOFT_STOP_BLOCKED_TOOLS = new Set([
  'task',
  'subagent',
  'task_revive',
  'task_message',
  'task_reply',
  'delegate',
]);
const SOFT_STOP_BLOCKED_PREFIXES = ['background_', 'delegate_'];
/**
 * During the soft stop a dispatch to the `oracle` agent is still allowed (a short final review runs while the run winds
 * down). Only tools that START a new child session qualify; task_revive/task_message/task_reply continue an existing
 * session of unknown agent and stay blocked.
 */
const SOFT_STOP_ORACLE_TOOLS = new Set(['task', 'subagent', 'delegate']);
/** Input fields that name the target agent of a dispatch (the recorded payload is `{agent, description, prompt, background}`). */
const DISPATCH_AGENT_KEYS = ['agent', 'subagent_type', 'subagentType', 'subagent', 'agent_type', 'agentType'];
export const SOFT_STOP_ALLOWED_AGENT = 'oracle';

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'patch', 'notebook_edit', 'str_replace_editor']);
const PATH_KEYS = ['filePath', 'file_path', 'path', 'filepath', 'file', 'notebook_path'];
const PATCH_KEYS = ['patchText', 'patch', 'input', 'diff'];

/**
 * Files that must never be written even inside an allowed root (mirrors the profile's built-in edit denies). Extra
 * protected globs come from `cfg.safety.deny.editPaths` (see `editPathMatchers`).
 */
const PROTECTED_PATH_RES = [
  /(?:^|\/)SPEC\.md$/,
  /(?:^|\/)RUN\.json$/,
  /\/\.run\/\.opencode(?:\/|$)/,
  /\/\.run\/opencode\.jsonc?$/,
];

/**
 * opencode wildcard -> RegExp (same semantics as the permission profile): `*` (and `**`) match anything including `/`,
 * `?` one character, a trailing ` *` is optional, anchored at both ends, everything else literal.
 */
export function wildcardToRegExp(glob) {
  const optionalTail = glob.endsWith(' *');
  const body = optionalTail ? glob.slice(0, -2) : glob;
  let out = '';
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (c === '*') {
      while (body[i] === '*') i++;
      out += '.*';
    } else if (c === '?') {
      out += '.';
      i++;
    } else {
      out += escapeRe(c);
      i++;
    }
  }
  return new RegExp(`^${out}${optionalTail ? '(?: .*)?' : ''}$`, 's');
}

/** A write-protection glob from `deny.editPaths` -> RegExp over the resolved absolute target. Relative globs match at any depth; a trailing `/**` also covers the directory itself. */
function editPathToRegExp(glob) {
  let g = glob.trim();
  if (!g.startsWith('/') && !g.startsWith('*')) g = `*/${g}`;
  if (g.endsWith('/**') || g.endsWith('/*')) {
    const dir = g.replace(/\/\*+$/, '');
    return [wildcardToRegExp(g), wildcardToRegExp(dir)];
  }
  return [wildcardToRegExp(g)];
}

/**
 * The config's safety inputs. `buildGuardEnv` always sets NIGHTGEM_SAFETY (it requires `SafetyInputs`), so an absent
 * `cfg.safety` only happens for a hand-built config (tests): it means the generic defaults and nothing else.
 */
const NO_SAFETY = { skillRoots: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } };
const safetyOf = (cfg) => cfg.safety ?? NO_SAFETY;

const matcherCache = new WeakMap();
function cachedFor(safety, key, build) {
  let per = matcherCache.get(safety);
  if (!per) matcherCache.set(safety, (per = {}));
  return (per[key] ??= build());
}

/** Compiled `deny.editPaths` of a guard config (empty when unset). */
function editPathMatchers(cfg) {
  const safety = safetyOf(cfg);
  if (!safety.deny?.editPaths?.length) return [];
  return cachedFor(safety, 'edit', () => safety.deny.editPaths.filter((g) => g.trim() !== '').flatMap(editPathToRegExp));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve symlinks for as much of `p` as exists; follow dangling links; re-append the missing tail. */
export function realpathLoose(p, depth = 0) {
  if (depth > 40) throw new Error(`too many symlink levels: ${p}`);
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
  }
  try {
    if (lstatSync(abs).isSymbolicLink()) return realpathLoose(path.resolve(path.dirname(abs), readlinkSync(abs)), depth + 1);
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(realpathLoose(parent, depth + 1), path.basename(abs));
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Root pattern -> RegExp matching the root itself or anything below it. `*` is one segment, `**` is anything. */
export function rootToRegExp(root) {
  const stars = root
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : escapeRe(part)))
    .join('');
  return new RegExp(`^${stars}(?:/.*)?$`);
}

/** Resolve the literal prefix of a (possibly globbed) root through symlinks. */
function canonicalRoot(root) {
  const star = root.indexOf('*');
  if (star === -1) {
    try {
      return realpathLoose(root);
    } catch {
      return root;
    }
  }
  const cut = root.lastIndexOf('/', star);
  const prefix = cut <= 0 ? '/' : root.slice(0, cut);
  try {
    return path.join(realpathLoose(prefix), root.slice(cut + 1));
  } catch {
    return root;
  }
}

const SAFE_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** The whole `.specs/<slug>/.run/` dir is orchestrator-owned, except explicitly listed direct children. */
const RUN_DIR_RE = /\/\.specs\/[^/]+\/\.run(?:\/|$)/;
const RUN_FILE_RE = /\/\.specs\/[^/]+\/\.run\/([^/]+)$/;

export function isAllowedWritePath(resolved, allowedRoots, runWritable = DEFAULT_RUN_WRITABLE, protectedRes = []) {
  if (SAFE_DEVICES.has(resolved) || /^\/dev\/fd\/\d+$/.test(resolved)) return true;
  if (PROTECTED_PATH_RES.some((re) => re.test(resolved)) || protectedRes.some((re) => re.test(resolved))) return false;
  if (RUN_DIR_RE.test(resolved)) {
    const name = RUN_FILE_RE.exec(resolved)?.[1];
    if (!name || !runWritable.includes(name) || name === 'RUN.json' || name === 'opencode.json') return false;
  }
  return allowedRoots.some((root) => rootToRegExp(root).test(resolved) || rootToRegExp(canonicalRoot(root)).test(resolved));
}

/** `null` when the write target is fine, otherwise the reason. */
export function checkWritePath(target, base, cfg) {
  const home = cfg.env?.HOME || homedir();
  let t = target;
  if (t === '~') t = home;
  else if (t.startsWith('~/')) t = path.join(home, t.slice(2));
  let resolved;
  try {
    resolved = realpathLoose(path.resolve(base ?? cfg.cwd ?? process.cwd(), t));
  } catch (err) {
    return `cannot resolve write target ${target}: ${err.message}`;
  }
  if (!(cfg.allowedRoots?.length > 0)) return `no allowed write roots configured (target ${resolved})`;
  if (!isAllowedWritePath(resolved, cfg.allowedRoots, cfg.runWritable ?? DEFAULT_RUN_WRITABLE, editPathMatchers(cfg))) return `write target outside allowlist (or protected): ${resolved}`;
  return null;
}

// ---------------------------------------------------------------------------
// Shell tokenizer (quote aware, conservative)
// ---------------------------------------------------------------------------

/** Tokens: { t: 'word', v, dyn } | { t: 'op', v } | { t: 'redir', v: '>' | '>>' | '&>' | '>|', fd? } */
export function tokenize(cmd) {
  const toks = [];
  let i = 0;
  const n = cmd.length;
  const pushWord = (v, dyn) => toks.push({ t: 'word', v, dyn });
  while (i < n) {
    const c = cmd[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      toks.push({ t: 'op', v: ';' });
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      while (i < n && cmd[i] !== '\n') i++;
      continue;
    }
    // operators
    if (c === ';' || c === '(' || c === ')' || c === '{' || c === '}' ) {
      if ((c === '{' || c === '}') && !(i + 1 >= n || /\s/.test(cmd[i + 1]))) {
        // brace expansion / parameter text is part of a word; fall through to word parsing
      } else {
        toks.push({ t: 'op', v: c === '{' || c === '}' ? ';' : c });
        i++;
        continue;
      }
    }
    if (c === '&' && cmd[i + 1] === '>') {
      const append = cmd[i + 2] === '>';
      toks.push({ t: 'redir', v: append ? '>>' : '>' });
      i += append ? 3 : 2;
      continue;
    }
    if (c === '&' || c === '|') {
      if (cmd[i + 1] === c) {
        toks.push({ t: 'op', v: c + c });
        i += 2;
      } else {
        toks.push({ t: 'op', v: c });
        i += 1;
        if (c === '|' && cmd[i] === '&') i += 1;
      }
      continue;
    }
    if (c === '<') {
      // input redirection / heredoc / process substitution: skip the operator, keep the word as an ordinary arg
      let j = i;
      while (cmd[j] === '<') j++;
      if (cmd[j] === '(') {
        toks.push({ t: 'op', v: '(' });
        i = j + 1;
      } else {
        i = j;
      }
      continue;
    }
    // fd-number prefixed redirect:  2>file  1>>file
    const fdMatch = /^\d+(?=>)/.exec(cmd.slice(i, i + 4));
    if (c === '>' || fdMatch) {
      if (fdMatch) i += fdMatch[0].length;
      let op = '>';
      i++;
      if (cmd[i] === '>') {
        op = '>>';
        i++;
      } else if (cmd[i] === '|') {
        i++;
      }
      if (cmd[i] === '&') {
        // >&2, >&-, 2>&1 are fd duplications; `>&file` writes a file
        const m = /^&(\d+|-)(?=[\s;|&)]|$)/.exec(cmd.slice(i));
        if (m) {
          i += m[0].length;
          continue;
        }
        i++;
      }
      toks.push({ t: 'redir', v: op });
      continue;
    }
    // word
    let v = '';
    let dyn = false;
    let quoted = false;
    while (i < n) {
      const ch = cmd[i];
      if (/\s/.test(ch) || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>' || ch === '(' || ch === ')') {
        // `$(` and `<(`: keep scanning as dynamic text up to the matching paren
        if (ch === '(' && v.endsWith('$')) {
          dyn = true;
          let depth = 0;
          while (i < n) {
            if (cmd[i] === '(') depth++;
            if (cmd[i] === ')') {
              depth--;
              if (depth === 0) {
                v += cmd[i++];
                break;
              }
            }
            v += cmd[i++];
          }
          continue;
        }
        break;
      }
      if (ch === "'") {
        quoted = true;
        const end = cmd.indexOf("'", i + 1);
        const stop = end === -1 ? n : end;
        v += cmd.slice(i + 1, stop);
        i = stop + 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < n && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < n) {
            v += cmd[i + 1];
            i += 2;
            continue;
          }
          if (cmd[i] === '$' || cmd[i] === '`') dyn = true;
          v += cmd[i++];
        }
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < n) {
        v += cmd[i + 1];
        i += 2;
        continue;
      }
      if (ch === '$' || ch === '`') dyn = true;
      v += ch;
      i++;
    }
    void quoted;
    pushWord(v, dyn);
  }
  return toks;
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'time', 'nice', 'nohup', 'exec', 'env', 'xargs', 'stdbuf', 'timeout']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const MUTATORS_ALL_OPERANDS = new Set(['rm', 'rmdir', 'touch', 'mkdir', 'truncate', 'chmod', 'chown', 'chgrp', 'mkfifo', 'unlink', 'shred']);
const MUTATORS_DEST_ONLY = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);

/** Split tokens into simple commands: { words: [...], redirs: [{op,target(word|null)}], pipeOut (stdout piped on) }[] */
export function simpleCommands(toks) {
  const cmds = [];
  let cur = { words: [], redirs: [], pipeOut: false };
  const flush = () => {
    if (cur.words.length > 0 || cur.redirs.length > 0) cmds.push(cur);
    cur = { words: [], redirs: [], pipeOut: false };
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'op') {
      cur.pipeOut = tk.v === '|';
      flush();
    } else if (tk.t === 'redir') {
      const nxt = toks[i + 1];
      if (nxt && nxt.t === 'word') {
        cur.redirs.push({ op: tk.v, target: nxt });
        i++;
      } else {
        cur.redirs.push({ op: tk.v, target: null });
      }
    } else {
      cur.words.push(tk);
    }
  }
  flush();
  return cmds;
}

/**
 * Options of each wrapper that take a SEPARATE argument (`nice -n 5`, `sudo -u root`, `env -u X`, `xargs -I {}`, `timeout -s KILL`).
 * Without this the argument would be mistaken for the command word. Other flags (`-i`, `-oL`, `--user=x`) are skipped alone.
 */
const WRAPPER_ARG_OPTS = {
  nice: ['-n'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-D', '-T', '-U', '-R'],
  env: ['-u', '-C'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k'],
  time: ['-f', '-o'],
  exec: ['-a'],
};
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;

/** Strip assignments and wrappers; returns { name, args } with `name` as the basename of the command word. */
export function commandHead(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i].v;
    if (ASSIGN_RE.test(w)) {
      i++;
      continue;
    }
    const wrapper = path.basename(w);
    if (WRAPPERS.has(wrapper)) {
      i++;
      const withArg = WRAPPER_ARG_OPTS[wrapper] ?? [];
      while (i < words.length && words[i].v.startsWith('-')) {
        i += withArg.includes(words[i].v) ? 2 : 1;
      }
      // `timeout [opts] DURATION cmd`
      if (wrapper === 'timeout' && i < words.length && DURATION_RE.test(words[i].v)) i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return { name: '', args: [] };
  return { name: path.basename(words[i].v), args: words.slice(i + 1), raw: words[i].v };
}

// ---------------------------------------------------------------------------
// Shell checks
// ---------------------------------------------------------------------------

const stripQuotes = (s) => s.replace(/['"\\]/g, '');
const CMD_WORD = (name) => new RegExp(`(?:^|[\\s;&|()\`'"/=])${escapeRe(name)}(?=$|[\\s;&|()\`'"])`);
/** The same match without `/` and `=` as boundaries: the name stands alone, so it can be a command word. Never relaxed. */
const CMD_WORD_STRICT = (name) => new RegExp(`(?:^|[\\s;&|()\`'"])${escapeRe(name)}(?=$|[\\s;&|()\`'"])`);
/** Only the matches `CMD_WORD` has because of `/` or `=`: the name directly after one of them (`docs/gh`, `--tool=docker`). */
const PATH_ARG_MATCH = (name) => new RegExp(`(?<=[/=])${escapeRe(name)}(?=$|[\\s;&|()\`'"])`, 'g');

// ---------------------------------------------------------------------------
// Path and assignment arguments that merely END in a denied name (`ls docs/gh`, `--tool=docker`, `TMPDIR=/x/T/opencode`)
//
// `CMD_WORD` also matches after `/` and `=` because a path-spelled command (`/usr/bin/gh`) and an assignment fed to a
// wrapper must stay blocked. The relaxation below lets a match through only when it is certainly an ARGUMENT of a command
// that cannot run it. It is a positive proof, not a list of exceptions: anything it cannot prove falls back to a block.
//
// It applies to the main command text only (never to a heredoc body, an inner string or the quote-stripped variant), and
// only when ALL of these hold:
//  1. the text has no quote, backslash, `$`, backtick, heredoc or process substitution (nothing the tokenizer could read
//     differently from the shell, no dynamic command word, no here-string);
//  2. EVERY simple command in the text starts with a command word from PATH_ARG_HEADS (read/navigate/inspect tools that
//     run none of their arguments). A wrapper, shell, `eval`, `source`/`.`, `xargs`, `make`, `npm`/`npx`, `awk`, a
//     path-spelled word, `alias`, a function definition... is not in the list, so a line using one is never relaxed;
//  3. `git` only with a read-only subcommand and no `-c`; `find` without `-exec*`/`-ok*`; `node`/`python` without an
//     inline-code or module flag (`-c`, `-e`, `-p`, `-m`, `--eval`, ...). An interpreter RUNS a path argument
//     (`node ~/.local/bin/<cli>` is that cli), so for `node`/`python` only `--opt=name` is relaxed, never a path ending in the name;
//  4. the only redirect target is /dev/null (no file is written with the name in it for a later `./x`);
//  5. no word anywhere is an execution sink word (shells, wrappers, `xargs`, `awk`, ...);
//  6. an `NAME=...` or `--opt=...` value is only relaxed when NAME is no exec hook (`*PAGER`, `*EDITOR`, `SHELL`, `GIT_*`,
//     `npm_config_*`, `PATH`, `--extcmd`, `--exec-path`, `--use-compress-program`, ...);
//  7. every match is accounted for: the matches inside the accepted words equal the matches in the text (a match in a
//     comment, a redirect target or anything else the parse did not classify keeps the block).
// ---------------------------------------------------------------------------

/** Command words whose arguments are never run. Exact words: `./ls` or `/x/gh/ls` is not `ls`. cp/mv/ln/install are left out on purpose (they copy a denied binary). */
const PATH_ARG_HEADS = new Set([
  'ls', 'cat', 'cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'tree',
  'grep', 'egrep', 'fgrep', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', '[[', 'true', 'false',
  'mkdir', 'touch', 'rm', 'rmdir', 'sleep', 'export', 'declare', 'typeset', 'readonly', 'local', 'unset',
  'git', 'find', 'node', 'python', 'python3',
]);
/** Control-flow words that precede a command (the command after them must pass too). */
const PATH_ARG_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '!']);
/** Words that run something. Any of them anywhere in the text (as a whole word, whatever its position) ends the relaxation. A path that merely ends in one (`config/ssh`) is an ordinary argument. */
const EXEC_SINK_WORDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'eval', 'source', 'exec', 'xargs', 'env', 'command', 'builtin',
  'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'sudo', 'doas', 'caffeinate', 'arch', 'script', 'setsid', 'parallel', 'watch', 'make',
  'gmake', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'awk', 'gawk', 'mawk', 'nawk', 'perl', 'ruby', 'php', 'lua',
  'osascript', 'ssh', 'alias', 'function', 'trap',
]);
/** Names of options and variables that make a program run what their value names. Tested on the text before the `=` that precedes the match. */
const EXEC_HOOK_KEY_RE =
  /pager|editor|visual|browser|shell|exec|cmd|command|program|helper|ssh|rsh|hook|askpass|proxy|textconv|filter|launcher|wrapper|compress|script|pack|^-*path$|^git_|^npm_|^bash_env$|^env$|^ld_|^dyld_|^less|^prompt|^ps\d|ifs/i;
const INTERPRETER_HEADS = new Set(['node', 'python', 'python3']);
/** Options of an interpreter whose value is code to load. */
const INTERPRETER_LOAD_KEY_RE = /require|import|loader|preload|^-*r$|inspect|run|test|check|plugin|config/i;
/** Read-only git subcommands (no hook, pager, editor or transport of their own). */
const GIT_READ_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'branch', 'blame', 'describe', 'shortlog',
  'cat-file', 'diff-tree', 'merge-base', 'add', 'restore', 'checkout', 'switch',
]);

function pathArgHeadOk(head, args) {
  if (!PATH_ARG_HEADS.has(head)) return false;
  const vs = args.map((a) => a.v);
  if (head === 'git') {
    if (vs.some((v) => /^-c/.test(v) || /^--(?:config-env|exec-path)/.test(v))) return false;
    return GIT_READ_SUBS.has(gitInvocation(vs).sub);
  }
  if (head === 'find') return !vs.some((v) => /^-(?:exec|ok)/.test(v));
  if (head === 'node' || head === 'python' || head === 'python3') {
    return !vs.some((v) => v === '-' || /^-[A-Za-z]*[ceEpm]/.test(v) || /^--(?:eval|print|command|exec|interactive|run|test)/.test(v));
  }
  return true;
}

/** True when every `/name` or `=name` match in `text` sits in a word that provably cannot run it (see the block comment above). */
function onlyPathArguments(text, name) {
  if (/[^\x20-\x7e\t\n]|['"\\$`]|<<|<\(|>\(/.test(text)) return false;
  const match = PATH_ARG_MATCH(name);
  const total = [...text.matchAll(match)].length;
  let accepted = 0;
  const tally = (word, interpreter = false) => {
    for (const m of word.v.matchAll(PATH_ARG_MATCH(name))) {
      const before = word.v.slice(0, m.index);
      const eq = before.indexOf('=');
      if (eq !== -1 && EXEC_HOOK_KEY_RE.test(before.slice(0, eq))) return false;
      // an interpreter loads or runs a path argument: only a bare `--opt=name` value is a plain argument
      if (interpreter && (!before.endsWith('=') || INTERPRETER_LOAD_KEY_RE.test(before.slice(0, eq)))) return false;
      accepted++;
    }
    return true;
  };
  for (const c of simpleCommands(tokenize(text))) {
    for (const r of c.redirs) if (!r.target || r.target.dyn || r.target.v !== '/dev/null') return false;
    let i = 0;
    while (i < c.words.length && (ASSIGN_RE.test(c.words[i].v) || PATH_ARG_KEYWORDS.has(c.words[i].v))) {
      if (!tally(c.words[i])) return false;
      i++;
    }
    if (c.words.slice(i).some((w) => EXEC_SINK_WORDS.has(w.v))) return false;
    if (i < c.words.length) {
      if (!pathArgHeadOk(c.words[i].v, c.words.slice(i + 1))) return false;
      const interpreter = INTERPRETER_HEADS.has(c.words[i].v);
      for (const w of c.words.slice(i + 1)) if (!tally(w, interpreter)) return false;
    }
  }
  return accepted === total;
}
// Generic defaults (common third-party CLIs): forge CLIs, agent runners and the `acli` tracker CLI are denied
// wherever the word appears as a command word. The profile layer denies the same names (src/profile.ts); their login dirs
// are secret roots (secrets.mjs) and read-denied in the sandbox. `deny.commands` from the user profile are appended
// (`deniedCommands`).
export const DENIED_COMMANDS = [
  'gh', 'glab', 'opencode', 'claude', 'cursor-agent', 'codex', 'aider', 'ssh', 'scp', 'sftp', 'rsync', 'acli',
  // host control: `launchctl submit` or `crontab` starts work outside the sandbox, `osascript` drives other apps. The
  // sandbox also refuses to exec the first three (src/sandbox.ts); the profile denies all of these in plain forms.
  'launchctl', 'osascript', 'crontab',
  // cloud / container CLIs (the profile denies the plain forms; this adds wrapper, absolute-path and quoted forms)
  'docker', 'brew', 'helm', 'kubectl', 'terraform', 'aws', 'gcloud', 'gsutil', 'argocd',
];
/** Denied only in command position (a directory called `jira` or `linear` in a repo is fine to name or list). acli is in DENIED_COMMANDS. */
export const DENIED_HEADS = new Set(['jira', 'linear']);

/** Default plus `deny.commands` of the config (plain command names). */
function deniedCommands(cfg) {
  const extra = safetyOf(cfg).deny?.commands;
  if (!extra?.length) return DENIED_COMMANDS;
  return cachedFor(safetyOf(cfg), 'commands', () => [...new Set([...DENIED_COMMANDS, ...extra.filter((c) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(c))])]);
}

/** Reason when `v` matches a `deny.shellPatterns` entry (opencode wildcard when it has `*`/`?`, otherwise a substring), or null. */
function shellPatternReason(v, cfg) {
  const patterns = safetyOf(cfg).deny?.shellPatterns;
  if (!patterns?.length) return null;
  const compiled = cachedFor(safetyOf(cfg), 'shell', () =>
    patterns.filter((p) => p.trim() !== '').map((p) => ({ p, re: /[*?]/.test(p) ? wildcardToRegExp(p) : null })),
  );
  for (const { p, re } of compiled) if (re ? re.test(v) : v.includes(p)) return `command matches a denied shell pattern (${p.length > 60 ? `${p.slice(0, 57)}...` : p})`;
  return null;
}

/**
 * A standalone `push` token: delimited by whitespace, quotes, separators or the string ends. `-`, `/`, `.`, `_` and
 * word characters do not delimit, so `.worktrees/task-1-push-notif/x` and `feat/push-x` are not pushes.
 * NOTE: the permission profile glob `*git*push*` cannot be refined like this, so it keeps denying those strings. The
 * launcher rejects slugs and task ids that contain push/gh/ssh tokens (src/paths.ts), so run paths never trip it.
 */
const TOKEN_START = "(?<=^|[\\s'\"`;&|()<>])";
const TOKEN_END = "(?=$|[\\s'\"`;&|()<>])";
const PUSH_TOKEN_RE = new RegExp(`${TOKEN_START}push${TOKEN_END}`);
/** Same delimiting for `stash`: `printf 'git stash' | sh` must not depend on the profile glob alone. */
const STASH_TOKEN_RE = new RegExp(`${TOKEN_START}stash${TOKEN_END}`);

function checkPatterns(raw, cfg, allowPathArgs = false) {
  const variants = [raw, stripQuotes(raw)];
  // path/assignment arguments are only ever relaxed in the main command text, and only when stripping quotes changes nothing
  // (so both variants are the same text and the parse below is the parse of what the shell reads)
  const relax = allowPathArgs && variants[1] === raw;
  for (const v of variants) {
    // textual backstop for pushes fed to a shell as data (`printf 'git push' | sh`) and for wrapper spellings argv parsing misses
    if (/(?<![\w.])git(?!\w)/.test(v) && PUSH_TOKEN_RE.test(v)) return 'git push is forbidden (git and a standalone push token both appear)';
    if (/(?<![\w.])git(?!\w)/.test(v) && STASH_TOKEN_RE.test(v)) return 'git stash is forbidden (git and a standalone stash token both appear)';
    if (/\b(?:receive-pack|send-pack)\b/.test(v)) return 'receive-pack/send-pack is forbidden';
    if (/(?<![\w.])git(?!\w)[^\n]*\s(?:-c|--config-env)\b[\s=]*(?:remote|url|core\.ssh|core\.gitproxy|credential|http\.|protocol|alias\.)/i.test(v))
      return 'git -c remote.*/url.*/credential.*/alias.* overrides are forbidden';
    if (/\bGIT_(?:CONFIG|SSH|ASKPASS|EXEC_PATH|PROXY_COMMAND)/.test(v)) return 'overriding git transport environment is forbidden';
    for (const name of deniedCommands(cfg)) {
      if (!CMD_WORD(name).test(v)) continue;
      if (relax && !CMD_WORD_STRICT(name).test(v) && onlyPathArguments(v, name)) continue;
      return `command ${name} is forbidden`;
    }
    if (/\b(?:curl|wget)\b[^\n]*(?:^|[\s'"=])file:/i.test(v)) return 'curl/wget of file: URLs is forbidden (reads local files)';
    const shellPattern = shellPatternReason(v, cfg);
    if (shellPattern) return shellPattern;
    if (/OPENCODE_(?:SERVER_)?PASSWORD/.test(v)) return 'references to the run server password are forbidden';
    if (/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])[^\s'"]*\/api\//i.test(v)) return 'calling /api/ on localhost is forbidden (run server API)';
    if (cfg.runPort && new RegExp(`(?<!\\d)${escapeRe(String(cfg.runPort))}(?!\\d)`).test(v)) return 'references to the run server port are forbidden';
    if (/\b(?:base64|b64decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(v)) return 'decoding into a shell is forbidden';
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(v)) return 'piping a download into a shell is forbidden';
  }
  return null;
}

/** Inner command strings of `sh -c`, `eval`, `$(...)` and backticks (also from the raw text). */
export function innerStrings(cmd) {
  const out = [];
  const toks = tokenize(cmd);
  for (const c of simpleCommands(toks)) {
    const head = commandHead(c.words);
    if (SHELLS.has(head.name)) {
      for (let i = 0; i < head.args.length; i++) {
        const a = head.args[i].v;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a) && head.args[i + 1]) {
          out.push(head.args[i + 1].v);
          break;
        }
      }
    } else if (head.name === 'eval') {
      out.push(head.args.map((a) => a.v).join(' '));
    }
  }
  for (const m of cmd.matchAll(/\$\(([^()]*)\)/g)) out.push(m[1]);
  for (const m of cmd.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}

function expandStatic(word, base, cfg) {
  const env = cfg.env ?? {};
  const home = env.HOME || homedir();
  const known = { HOME: home, TMPDIR: env.TMPDIR, PWD: base };
  let s = word.v;
  if (word.dyn) {
    s = s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
      const val = known[a ?? b];
      return val ?? m;
    });
    if (/[$`]/.test(s)) return null;
  }
  return s;
}

function checkWrites(cmd, cfg) {
  const toks = tokenize(cmd);
  const cmds = simpleCommands(toks);
  const hasLn = cmds.some((c) => commandHead(c.words).name === 'ln');
  let base = cfg.cwd ?? process.cwd();
  if (cfg.workdir) base = path.resolve(base, cfg.workdir);
  let baseKnown = true;
  const check = (word, label, mustBeAbsolute) => {
    if (!word) return `${label} without a resolvable target`;
    const t = expandStatic(word, base, cfg);
    if (t === null) return `${label} target uses an unresolvable expansion: ${word.v}`;
    if (t === '') return null;
    const relative = !t.startsWith('/') && !t.startsWith('~');
    if (relative && !baseKnown) return `${label} target ${t} is relative to an unknown directory`;
    if (hasLn && label !== 'ln' && !/^\/dev\//.test(t)) return `${label} ${t} combined with ln in the same command (symlink bypass)`;
    void mustBeAbsolute;
    return checkWritePath(t, base, cfg);
  };

  for (const c of cmds) {
    const head = commandHead(c.words);
    // directory tracking
    if (head.name === 'cd' || head.name === 'pushd') {
      const arg = head.args.find((a) => !a.v.startsWith('-'));
      const t = arg ? expandStatic(arg, base, cfg) : null;
      if (t && t !== '-') {
        const abs = t.startsWith('~') ? path.join(cfg.env?.HOME || homedir(), t.slice(1)) : path.resolve(base, t);
        try {
          base = realpathLoose(abs);
          baseKnown = true;
        } catch {
          baseKnown = false;
        }
      } else {
        baseKnown = false;
      }
    }
    for (const r of c.redirs) {
      const why = check(r.target, `redirect '${r.op}'`);
      if (why) return why;
    }
    if (head.name === 'tee') {
      const files = head.args.filter((a) => !a.v.startsWith('-'));
      for (const f of files) {
        const why = check(f, 'tee');
        if (why) return why;
      }
    }
    if (head.name === 'dd') {
      for (const a of head.args) {
        if (a.v.startsWith('of=')) {
          const why = check({ v: a.v.slice(3), dyn: a.dyn }, 'dd of=');
          if (why) return why;
        }
      }
    }
    if (MUTATORS_ALL_OPERANDS.has(head.name) || MUTATORS_DEST_ONLY.has(head.name)) {
      let operands = head.args.filter((a, idx, arr) => {
        if (a.v === '--') return false;
        if (a.v.startsWith('-') && !arr.slice(0, idx).some((x) => x.v === '--')) return false;
        return true;
      });
      if (MUTATORS_DEST_ONLY.has(head.name)) operands = operands.slice(-1);
      // `mkdir -m 755 dir` style flag values are not modelled; extra operands only make the check stricter.
      for (const o of operands) {
        const why = check(o, head.name);
        if (why) return why;
      }
    }
    if ((head.name === 'sed' || head.name === 'perl') && head.args.some((a) => /^-[a-zA-Z]*i/.test(a.v))) {
      const operands = head.args.filter((a) => !a.v.startsWith('-'));
      // first operand is the script when no -e/-f is given
      const hasScriptFlag = head.args.some((a) => /^-[a-zA-Z]*[ef]$/.test(a.v));
      for (const o of hasScriptFlag ? operands : operands.slice(1)) {
        const why = check(o, `${head.name} -i`);
        if (why) return why;
      }
    }
  }
  return null;
}

function hasDynamicEval(cmd) {
  for (const c of simpleCommands(tokenize(cmd))) {
    const head = commandHead(c.words);
    if (head.name === 'eval' && head.args.some((a) => a.dyn || /[$`]/.test(a.v))) return true;
    // `sh -c "$CMD"` / `sh -c "$(...)"`: the command string only exists at run time, so it cannot be inspected
    if (SHELLS.has(head.name)) {
      for (let i = 0; i < head.args.length; i++) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(head.args[i].v) && head.args[i + 1]) {
          if (head.args[i + 1].dyn) return true;
          break;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command semantics: git subcommands, package publishing, issue-tracker CLIs
// ---------------------------------------------------------------------------

const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
export const NETWORK_GIT_MESSAGE = 'network git is disabled during runs; the launcher pre-fetched origin';

/** `{ sub, rest }` of a git invocation: skips the global options (`-C <p>`, `-c <k=v>`, `--git-dir[=]...`, `--no-pager`, ...). */
export function gitInvocation(args) {
  let i = 0;
  while (i < args.length) {
    const v = args[i];
    if (GIT_OPTS_WITH_VALUE.has(v)) {
      if (v === '-c' && /^alias\./i.test(args[i + 1] ?? '')) return { sub: 'alias-override', rest: [] };
      i += 2;
      continue;
    }
    if (v.startsWith('-')) {
      if (/^-calias\./i.test(v)) return { sub: 'alias-override', rest: [] };
      if (/^--config-env=alias\./i.test(v)) return { sub: 'alias-override', rest: [] };
      i += 1;
      continue;
    }
    return { sub: v, rest: args.slice(i + 1) };
  }
  return { sub: '', rest: [] };
}

/** Reason for a forbidden git invocation, or null. `args` are the words after the `git` word. */
function gitReason(args) {
  const { sub, rest } = gitInvocation(args);
  if (sub === 'push') return 'git push is forbidden';
  if (sub === 'stash') return 'git stash is forbidden (refs/stash is shared across linked worktrees and trips the tripwire); commit, or write a patch to $TMPDIR';
  if (sub === 'alias-override') return 'git alias overrides are forbidden';
  if (sub === 'fetch' || sub === 'pull' || sub === 'ls-remote') return `git ${sub}: ${NETWORK_GIT_MESSAGE}`;
  if (sub === 'remote' && rest.find((a) => !a.startsWith('-')) === 'update') return `git remote update: ${NETWORK_GIT_MESSAGE}`;
  if (sub === 'submodule' && rest.includes('update') && rest.some((a) => a === '--remote' || a.startsWith('--remote='))) return `git submodule update --remote: ${NETWORK_GIT_MESSAGE}`;
  if (sub === 'config' && rest.some((a) => /^alias\./i.test(a))) return 'defining git aliases is forbidden';
  return null;
}

const PACKAGE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun']);
const PUBLISH_SUBS = new Set(['publish', 'unpublish', 'dist-tag', 'deprecate', 'login', 'adduser', 'logout']);
/** After one of these the rest are script names/arguments (`npm run e2e -- --grep login`), not npm subcommands. */
const PACKAGE_STOP_SUBS = new Set(['run', 'run-script', 'test', 'exec', 'x', 'dlx']);

/** Reason for a forbidden package-manager invocation (publishing, registry login), or null. */
function packageReason(name, args) {
  if (PACKAGE_MANAGERS.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') break;
      // a word right after a flag may be that flag's value (`--prefix run`): it never ends the scan
      if (PACKAGE_STOP_SUBS.has(a) && !(i > 0 && args[i - 1].startsWith('-'))) break;
      if (PUBLISH_SUBS.has(a)) return `${name} ${a} is forbidden (no publishing from a run)`;
    }
  }
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    const first = args.find((a) => !a.startsWith('-'));
    if (first && /^np(?:@.*)?$/.test(first)) return 'npx np is forbidden (no publishing from a run)';
  }
  if (name === 'lerna' || name === 'changeset' || name === 'changesets' || name === 'vsce' || name === 'ovsx' || name === 'cargo') {
    if (args.includes('publish')) return `${name} publish is forbidden (no publishing from a run)`;
  }
  if (name === 'twine' && args.includes('upload')) return 'twine upload is forbidden (no publishing from a run)';
  if (name === 'semantic-release' || name === 'goreleaser') return `${name} is forbidden (no publishing from a run)`;
  return null;
}

/** Walks every simple command of `cmd` (not its inner strings; the caller recurses). */
function checkCommandSemantics(cmd) {
  for (const c of simpleCommands(tokenize(cmd))) {
    const head = commandHead(c.words);
    if (DENIED_HEADS.has(head.name)) return `command ${head.name} is forbidden (no issue-tracker CLI access from a run)`;
    const words = c.words.map((w) => w.v);
    for (let i = 0; i < words.length; i++) {
      const name = path.basename(words[i]);
      if (name === 'git') {
        const why = gitReason(words.slice(i + 1));
        if (why) return why;
      } else {
        const why = packageReason(name, words.slice(i + 1));
        if (why) return why;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Heredocs
// ---------------------------------------------------------------------------

/**
 * Heredoc bodies of commands that only CONSUME stdin as data (cat, tee, wc, ...) are text, not shell. A heredoc with a
 * quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) is never expanded. An unquoted one is data only when it
 * has no `$(` and no backtick (it could not run anything). Everything else (a shell or interpreter reads the body, the body is piped or
 * written for later execution on the same line, the operator sits somewhere this scanner cannot classify with
 * certainty, or an unquoted body contains `$(` or a backtick) keeps the old behaviour: the body stays in the command text and is analysed as shell.
 *
 * QUOTED bodies are stricter data: they are literal text whatever else the command runs (a later `node --test` does not turn
 * a JS test file into shell), see `quotedHeredocKind`. Their owner may also be an interpreter (`python3 - <<'PY'`). The write
 * target of the owner (`cat > f <<'EOF'`) stays in the command text and is checked against the allowlist.
 */
const DATA_HEADS = new Set(['cat', 'tee', 'wc', 'sort', 'uniq', 'head', 'tail', 'tr', 'cut', 'jq', 'nl', 'fold', 'column', 'base64', 'shasum', 'sha256sum', 'md5sum', 'diff', 'comm', 'grep', 'egrep', 'fgrep']);
const GIT_DATA_SUBS = new Set(['commit', 'tag', 'notes', 'hash-object', 'mktag']);
const INTERPRETER_HEADS_RE = /^(?:source|\.|xargs|parallel|make|gmake|node|nodejs|bun|deno|python[\d.]*|perl|ruby|php|lua|osascript|ssh)$/;

/**
 * Index just after the `)` that closes the `(` of the `$(` at `open` (the index of that `(`) (quotes, backslashes and nesting are tracked), or `-1` when it is
 * unbalanced or contains a `<<` (a heredoc inside a substitution is never classified).
 */
function skipDollarParen(cmd, open) {
  const n = cmd.length;
  let depth = 0;
  let i = open;
  while (i < n) {
    const c = cmd[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && cmd[i] !== '"') i += cmd[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') return -1;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** Index just after the backtick that closes the one at `open`, or `-1` (unterminated, or a `<<` inside). */
function skipBackticks(cmd, open) {
  let i = open + 1;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') return -1;
    if (c === '`') return i + 1;
    i++;
  }
  return -1;
}

/**
 * Heredoc operators with their body ranges. Where the scan can no longer be trusted (arithmetic `<<`, a heredoc inside a
 * substitution, unbalanced quotes, ...) it stops and returns what it has ALREADY resolved: bash reads a command front to back,
 * so a heredoc whose body was fully located before that point is certain. Anything after it stays inline (analysed as shell).
 */
function scanHeredocs(cmd) {
  const n = cmd.length;
  const found = [];
  let pending = [];
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let segStart = 0;
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return found;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\') {
          i += 2;
          continue;
        }
        if (cmd[i] === '`') {
          const after = skipBackticks(cmd, i);
          if (after === -1) return found;
          i = after;
          continue;
        }
        if (cmd[i] === '$' && cmd[i + 1] === '(') {
          const after = skipDollarParen(cmd, i + 1);
          if (after === -1) return found;
          i = after;
          continue;
        }
        if (cmd[i] === '$' && cmd[i + 1] === '{') {
          const close = cmd.indexOf('}', i);
          if (close === -1 || /['"]/.test(cmd.slice(i, close))) return found;
          i = close + 1;
          continue;
        }
        i++;
      }
      if (i >= n) return found;
      i++;
      continue;
    }
    // contexts where `<<` may be arithmetic or where quoting is hard to track: give up (the caller then analyses the body as shell)
    if (c === '`' && paren === 0 && brace === 0 && bracket === 0) {
      const after = skipBackticks(cmd, i);
      if (after === -1) return found;
      i = after;
      continue;
    }
    if (c === '[' && cmd[i + 1] === '[') {
      // `[[ ... ]]` is a test, not a redirection: skip it unless it contains a `<<`
      const close = cmd.indexOf(']]', i + 2);
      if (close === -1 || cmd.slice(i, close).includes('<<')) return found;
      i = close + 2;
      continue;
    }
    if (c === '`' || (c === '(' && cmd[i + 1] === '(') || (c === '$' && cmd[i + 1] === '[')) return found;
    if (c === 'l' && cmd.startsWith('let', i) && (i === 0 || /[\s;&|(]/.test(cmd[i - 1])) && /[\s;&|]/.test(cmd[i + 3] ?? ' ')) return found;
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      while (i < n && cmd[i] !== '\n') i++;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      paren++;
      i += 2;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '{') {
      brace++;
      i += 2;
      continue;
    }
    if (c === '}' && brace > 0) brace--;
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    if (c === ';' || c === '|' || c === '&' || c === '(') segStart = i + 1;
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] === '<') {
      i += 3;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') {
      // only a heredoc if bash certainly sees one here: top level, preceded by whitespace or a separator
      if (paren > 0 || brace > 0 || bracket > 0 || !(i === 0 || /[\s;&|]/.test(cmd[i - 1]))) return found;
      let j = i + 2;
      const dash = cmd[j] === '-';
      if (dash) j++;
      while (j < n && (cmd[j] === ' ' || cmd[j] === '\t')) j++;
      let delim = '';
      let quoted = false;
      while (j < n && !/[\s;&|()<>]/.test(cmd[j])) {
        const ch = cmd[j];
        if (ch === "'" || ch === '"') {
          const end = cmd.indexOf(ch, j + 1);
          if (end === -1) return found;
          delim += cmd.slice(j + 1, end);
          j = end + 1;
          quoted = true;
        } else if (ch === '\\') {
          if (j + 1 >= n) return found;
          delim += cmd[j + 1];
          j += 2;
          quoted = true;
        } else if (ch === '$' && cmd[j + 1] === "'") {
          j++;
          quoted = true;
        } else {
          delim += ch;
          j++;
        }
      }
      if (delim === '') return found;
      pending.push({ opStart: i, segStart, delim, quoted, dash });
      i = j;
      continue;
    }
    if (c === '\n') {
      segStart = i + 1;
      if (pending.length > 0) {
        if (paren > 0 || brace > 0 || bracket > 0) return found;
        let pos = i + 1;
        for (const h of pending) {
          const bodyStart = pos;
          let terminated = false;
          let termStart = n;
          let termEnd = n;
          while (pos < n) {
            const nl = cmd.indexOf('\n', pos);
            const lineEnd = nl === -1 ? n : nl;
            const line = cmd.slice(pos, lineEnd);
            if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) {
              terminated = true;
              termStart = pos;
              termEnd = lineEnd;
              pos = nl === -1 ? n : nl + 1;
              break;
            }
            pos = nl === -1 ? n : nl + 1;
          }
          found.push({ ...h, lineEnd: i, bodyStart, bodyEnd: terminated ? termStart : n, removeEnd: terminated ? termEnd : n });
        }
        pending = [];
        i = pos;
        segStart = pos;
        continue;
      }
    }
    i++;
  }
  for (const h of pending) found.push({ ...h, lineEnd: n, bodyStart: n, bodyEnd: n, removeEnd: n });
  return found;
}

/** The command that owns a heredoc is a pure data consumer (cat, tee, git commit -F -, ...). */
function heredocOwnerIsData(cmd, h) {
  const cmds = simpleCommands(tokenize(cmd.slice(h.segStart, h.opStart)));
  const last = cmds[cmds.length - 1];
  if (!last || last.pipeOut) return false;
  const head = commandHead(last.words);
  if (DATA_HEADS.has(head.name)) return true;
  return head.name === 'git' && GIT_DATA_SUBS.has(gitInvocation(head.args.map((a) => a.v)).sub);
}

/** A shell/interpreter/xargs/make anywhere in the text could execute data written or piped on the same line. */
function mayExecuteStdinOrFiles(text) {
  for (const c of simpleCommands(tokenize(text))) {
    const head = commandHead(c.words);
    if (SHELLS.has(head.name) && !head.args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.v))) return true;
    if (INTERPRETER_HEADS_RE.test(head.name)) return true;
  }
  return false;
}

/**
 * Quoted-delimiter heredocs (`<<'EOF'`): the body is literal text, never shell, so it is never tokenised as shell (a `=>`,
 * a `>` or a backtick in a JS/JSON/Python body must not look like a redirect or an expansion). The owner decides what the
 * text IS, from the whole line it sits on (`cd x && cat > f <<'EOF' | tee g`):
 *  - 'data': a pure stdin consumer (cat, tee, sed, git commit -F -, ...). Its redirect target stays in the command text and is
 *    checked against the write allowlist.
 *  - 'code': a script for a language interpreter (`python3 - <<'PY'`, `node - <<'JS'`, or data piped into one). It cannot be
 *    inspected like shell, so the textual backstop (`checkPatterns`) runs on it.
 *  - null: a shell, `source`, xargs, make, ssh, an unknown program, or output piped into one of those: the body may be shell,
 *    so it stays in the command text and is analysed as shell (the old behaviour).
 */
const QUOTED_DATA_EXTRA = new Set(['sed', 'awk', 'gawk', 'patch', 'tac', 'rev', 'paste', 'xxd', 'od', 'less', 'more']);
const GIT_DATA_SUBS_QUOTED = new Set([...GIT_DATA_SUBS, 'apply', 'am']);
const CODE_HEADS_RE = /^(?:node|nodejs|bun|deno|python[\d.]*|perl|ruby|php|lua)$/;
const SHELL_READING_RE = /^(?:source|\.|xargs|parallel|make|gmake|osascript|ssh|eval|exec)$/;
const LEADING_KEYWORDS = new Set(['then', 'do', 'else', '!']);

function ownerHead(cmdWords) {
  let words = cmdWords;
  while (words.length > 0 && LEADING_KEYWORDS.has(words[0].v)) words = words.slice(1);
  return commandHead(words);
}

function quotedHeredocKind(cmd, h) {
  const cmds = simpleCommands(tokenize(cmd.slice(h.segStart, h.lineEnd)));
  if (cmds.length === 0) return null;
  const own = ownerHead(cmds[0].words);
  let kind = null;
  if (DATA_HEADS.has(own.name) || QUOTED_DATA_EXTRA.has(own.name)) kind = 'data';
  else if (own.name === 'git' && GIT_DATA_SUBS_QUOTED.has(gitInvocation(own.args.map((a) => a.v)).sub)) kind = 'data';
  else if (CODE_HEADS_RE.test(own.name)) kind = 'code';
  if (kind === null) return null;
  // where the output goes next: `cat <<'EOF' | sh` feeds the body to a shell, `| python3 -` to an interpreter
  for (let k = 0; cmds[k]?.pipeOut && k + 1 < cmds.length; k++) {
    const next = ownerHead(cmds[k + 1].words);
    if (SHELLS.has(next.name) || SHELL_READING_RE.test(next.name) || next.name === '') return null;
    if (kind === 'code') return null;
    if (CODE_HEADS_RE.test(next.name)) kind = 'code';
  }
  return kind;
}

/**
 * `{ text, bodies, scanned }`: `text` is `cmd` without the data heredoc bodies; `bodies` are those bodies with their quoting;
 * `scanned` are the bodies (a subset, as text) that could still run (script code, or data in a command that also runs a
 * shell/interpreter): `checkShellCommand` applies the textual backstop to them.
 */
export function splitHeredocs(cmd) {
  const none = { text: cmd, bodies: [], scanned: [] };
  if (!cmd.includes('<<')) return none;
  const found = scanHeredocs(cmd);
  if (!found || found.length === 0) return none;
  // An unquoted body is data only when nothing in it can expand into a command: with `$(` or a backtick anywhere the whole
  // body stays inline and is analysed as shell (quotes, `case` patterns and nesting inside substitutions are not parsed).
  const expands = (h) => !h.quoted && /\$\(|`/.test(cmd.slice(h.bodyStart, h.bodyEnd));
  const kinds = new Map();
  for (const h of found) {
    if (h.quoted) {
      const k = quotedHeredocKind(cmd, h);
      if (k) kinds.set(h, k);
    } else if (heredocOwnerIsData(cmd, h) && !expands(h)) {
      kinds.set(h, 'data');
    }
  }
  if (kinds.size === 0) return none;
  const strip = (hs) => {
    let text = '';
    let at = 0;
    for (const h of hs) {
      text += cmd.slice(at, h.bodyStart);
      at = h.removeEnd;
    }
    return text + cmd.slice(at);
  };
  let data = found.filter((h) => kinds.has(h));
  // unquoted bodies keep the old rule: a shell/interpreter anywhere in the command may run what was written, so they stay inline
  if (data.some((h) => !h.quoted) && mayExecuteStdinOrFiles(strip(data))) data = data.filter((h) => h.quoted);
  if (data.length === 0) return none;
  const text = strip(data);
  const runs = mayExecuteStdinOrFiles(text);
  const bodies = [];
  const scanned = [];
  for (const h of data) {
    const body = cmd.slice(h.bodyStart, h.bodyEnd);
    bodies.push({ body, quoted: h.quoted });
    if (h.quoted && (kinds.get(h) === 'code' || runs)) scanned.push(body);
  }
  return { text, bodies, scanned };
}

/** `null` when the shell command is acceptable, otherwise the block reason. */
export function checkShellCommand(cmd, cfg, depth = 0) {
  if (depth > 4) return 'shell command nests too deeply';
  const hd = splitHeredocs(cmd);
  const text = hd.text;
  const pat = checkPatterns(text, cfg, depth === 0);
  if (pat) return pat;
  const sem = checkCommandSemantics(text);
  if (sem) return sem;
  if (hasDynamicEval(text)) return 'eval or sh -c of a dynamic string is forbidden';
  const sec = checkSecretReferences(text, cfg);
  if (sec) return sec;
  const wr = checkWrites(text, cfg);
  if (wr) return wr;
  for (const inner of innerStrings(text)) {
    if (inner === text) continue;
    const why = checkShellCommand(inner, cfg, depth + 1);
    if (why) return `inner command: ${why}`;
  }
  // heredoc bodies that are data: never parsed as shell. A secret-location mention is still refused (the text could be a
  // script about to be run). TODO: move the heredoc scanner into profile/guard/heredoc.mjs, and share one text-level
  // secret helper with checkSecretReferences instead of the checkSecretText copy.
  for (const { body } of hd.bodies) {
    const secret = checkSecretText(body, cfg);
    if (secret) return `heredoc body: ${secret}`;
  }
  // a quoted body that can still run (script code for an interpreter, or written next to a command that runs files) is
  // not parsed as shell, but the textual backstop (git push, forbidden commands, run server password/port, ...) still reads it
  for (const body of hd.scanned) {
    const why = checkPatterns(body, cfg);
    if (why) return `heredoc body: ${why}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edit / write tools
// ---------------------------------------------------------------------------

function editTargets(input) {
  const targets = [];
  for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) targets.push(input[k]);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (e && typeof e === 'object') for (const k of PATH_KEYS) if (typeof e[k] === 'string') targets.push(e[k]);
  }
  for (const k of PATCH_KEYS) {
    if (typeof input[k] === 'string') {
      for (const m of input[k].matchAll(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) targets.push(m[1]);
      for (const m of input[k].matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(\S+)/gm)) if (m[1] !== '/dev/null') targets.push(m[1]);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

const block = (reason) => ({ verdict: 'block', reason });

/** True when the dispatch input names the `oracle` agent (every agent field present must say so; none present = false). */
export function dispatchTargetsOracle(input) {
  const names = DISPATCH_AGENT_KEYS.filter((k) => k in input && input[k] !== undefined && input[k] !== null).map((k) => input[k]);
  if (names.length === 0) return false;
  return names.every((v) => typeof v === 'string' && v.trim().replace(/^@/, '').toLowerCase() === SOFT_STOP_ALLOWED_AGENT);
}

/**
 * @param {{tool: string, input?: Record<string, unknown>, agent?: string, sessionID?: string}} event
 * @param {{controlDirSet?: boolean, flags: {softStop?: boolean, hardStop?: boolean, heartbeatTs?: number} | null,
 *          allowedRoots: string[], now: number, cwd?: string, runPort?: string|number, env?: Record<string,string|undefined>}} cfg
 */
export function decide(event, cfg) {
  const tool = event.tool ?? '';
  const input = event.input && typeof event.input === 'object' ? event.input : {};

  // 1. stop flags and liveness (fail closed)
  if (cfg.controlDirSet === false) return block(`${ENV_PREFIX}CONTROL_DIR is not set; all tools blocked`);
  if (cfg.safetyInvalid) return block(`${ENV_PREFIX}SAFETY is malformed or missing; all tools blocked`);
  const flags = cfg.flags;
  if (!flags || typeof flags !== 'object') return block('control flags unreadable; all tools blocked');
  if (flags.hardStop) return block('hard stop is set; all tools blocked');
  const hb = Number(flags.heartbeatTs ?? 0);
  if (!(hb > 0) || cfg.now - hb > HEARTBEAT_MAX_AGE_MS) return block('orchestrator heartbeat is stale (>120s); all tools blocked');
  if (flags.softStop) {
    const prefixed = SOFT_STOP_BLOCKED_PREFIXES.some((p) => tool.startsWith(p));
    if (SOFT_STOP_BLOCKED_TOOLS.has(tool) || prefixed) {
      const mayStartOracle = SOFT_STOP_ORACLE_TOOLS.has(tool) || prefixed;
      if (!(mayStartOracle && dispatchTargetsOracle(input))) return block(`soft stop is set; ${tool} (new work) is blocked`);
    }
    if (tool === 'shell' && input.background === true) return block('soft stop is set; background shell is blocked');
  }

  // 2. per tool
  if (tool === 'shell') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const workdir = typeof input.workdir === 'string' ? input.workdir : undefined;
    const why = checkShellCommand(cmd, { ...cfg, workdir }, 0);
    if (why) return block(why);
    return { verdict: 'allow' };
  }

  if (WRITE_TOOLS.has(tool)) {
    const targets = editTargets(input);
    if (targets.length === 0) return block(`${tool}: no target path found in input`);
    for (const t of targets) {
      const why = checkWritePath(t, cfg.cwd, cfg);
      if (why) return block(`${tool}: ${why}`);
    }
    return { verdict: 'allow' };
  }

  if (SECRET_READ_TOOLS.has(tool)) {
    const why = checkSecretToolInput(tool, input, cfg);
    if (why) return block(`${tool}: ${why}`);
  }

  if (tool === 'webfetch' && 'prompt' in input) {
    // smartfetch's secondary-model spend is not attributable to any session: strip the prompt
    const { prompt: _dropped, ...rest } = input;
    void _dropped;
    return { verdict: 'rewrite', input: rest, reason: 'webfetch prompt stripped' };
  }

  return { verdict: 'allow' };
}

