/**
 * Minimal shared glob matcher (no dependencies).
 *
 * Syntax: `*` (any run of characters except `/`), `**` (any run including `/`), `?` (one character except `/`).
 * A `**` segment followed by a slash also matches zero directories, so "globstar, slash, generated, slash, globstar"
 * matches both `generated/x` and `a/generated/x`.
 * Everything else is literal. Matching is anchored (the whole text must match).
 */

export interface GlobOptions {
  /** Default true. */
  caseSensitive?: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Compile a glob to an anchored RegExp. */
export function globToRegExp(pattern: string, opts: GlobOptions = {}): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        let j = i + 2;
        while (pattern[j] === '*') j++;
        if (pattern[j] === '/') {
          out += '(?:.*/)?';
          i = j + 1;
        } else {
          out += '.*';
          i = j;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += escapeRe(c);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`, `s${opts.caseSensitive === false ? 'i' : ''}`);
}

/** True when `text` matches `pattern` in full. */
export function globMatch(pattern: string, text: string, opts: GlobOptions = {}): boolean {
  return globToRegExp(pattern, opts).test(text);
}

/** True when `text` matches at least one of `patterns`. */
export function globMatchAny(patterns: readonly string[], text: string, opts: GlobOptions = {}): boolean {
  return patterns.some((p) => globMatch(p, text, opts));
}
