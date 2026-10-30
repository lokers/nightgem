/**
 * Deterministic scan of a unified diff for silenced checks: added lint or type suppressions, added test skips,
 * deleted test files and test files that lost assertions. Pure: the diff text is passed in (the report gets it
 * from `git diff -U0 <base>...HEAD` of each integration branch), nothing here touches git or the filesystem.
 *
 * The scan is a heuristic that informs the human reading the report; it never decides anything and never fails a run.
 */

export type SuppressionHit =
  | { kind: 'suppression'; file: string; line: number; pattern: string }
  | { kind: 'deleted-test'; file: string }
  | { kind: 'assertion-loss'; file: string; removed: number; added: number }
  /** A file named CONSTRAINTS.md (the repo's written quality bar) was changed: agents must not edit it. */
  | { kind: 'constraints-changed'; file: string };

/** Added lines that match one of these silence a check. `label` is what the report prints. */
export const SUPPRESSION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'eslint-disable', re: /eslint-disable/ },
  { label: '@ts-ignore', re: /@ts-ignore/ },
  { label: '@ts-expect-error', re: /@ts-expect-error/ },
  { label: '@ts-nocheck', re: /@ts-nocheck/ },
  { label: '.skip(', re: /(?<!pytest\.mark)\.skip\(/ },
  { label: '.only(', re: /\.only\(/ },
  { label: 'xit(', re: /(?<![\w$])xit\(/ },
  { label: 'xdescribe(', re: /(?<![\w$])xdescribe\(/ },
  { label: 't.Skip(', re: /(?<![\w$])t\.Skip(?:f|Now)?\(/ },
  { label: '//nolint', re: /\/\/\s?nolint/ },
  { label: '# noqa', re: /#\s*noqa/ },
  { label: '# type: ignore', re: /#\s*type:\s*ignore/ },
  { label: '@Disabled', re: /@Disabled(?![\w])/ },
  { label: '@Ignore', re: /@Ignore(?![\w])/ },
  { label: 'pytest.mark.skip', re: /pytest\.mark\.skip/ },
];

/** Prose files only talk about suppressions; they are not scanned. */
const DOC_EXT_RE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|java|kt|kts|rb|rs|cs|php|swift|scala|ex|exs|c|cc|cpp|h|hpp)$/i;
const TEST_NAME_RES: readonly RegExp[] = [
  /\.(?:test|spec)\.[A-Za-z0-9]+$/,
  /_test\.[A-Za-z0-9]+$/,
  /_spec\.[A-Za-z0-9]+$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /(?:Test|Tests|IT)\.(?:java|kt|kts|scala|cs)$/,
];
const TEST_DIR_RE = /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//;
const ASSERTION_RE = /\bexpect\(|\bassert/;

/** A test file by name (`a.test.ts`, `a_test.go`, `AServiceTest.java`) or a code file inside a test directory. */
export function isTestFile(file: string): boolean {
  if (TEST_NAME_RES.some((re) => re.test(file))) return true;
  return TEST_DIR_RE.test(file) && CODE_EXT_RE.test(file);
}

const CONSTRAINTS_FILE = 'CONSTRAINTS.md';
const isConstraintsFile = (file: string): boolean => file === CONSTRAINTS_FILE || file.endsWith(`/${CONSTRAINTS_FILE}`);

interface FileState {
  file: string;
  /** The name before a rename. */
  renamedFrom?: string;
  deleted: boolean;
  removedAssertions: number;
  addedAssertions: number;
  hits: SuppressionHit[];
}

/** Undo git's C-style quoting of a path (`\303\251` octal bytes, `\t`, `\"`, `\\`). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i] as string;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(quoted.slice(i + 1))?.[0];
    if (oct) {
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      const next = quoted[++i] ?? '';
      bytes.push(next in esc ? (esc[next] as number) : next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a `--- a/x`, `+++ b/x` or `rename to x` payload: strips quotes, the `a/` or `b/` prefix and git's trailing tab. */
function cleanPath(raw: string, prefix: boolean): string {
  let p = raw;
  if (p.startsWith('"')) {
    const end = p.lastIndexOf('"');
    p = unquoteGitPath(p.slice(1, end > 0 ? end : undefined));
  } else {
    p = p.replace(/\t.*$/, '');
  }
  return prefix ? p.replace(/^[ab]\//, '') : p;
}

/** The new-side path of a `diff --git a/<p> b/<q>` line (equal halves are split by length, so spaces in names work). */
function pathOfDiffHeader(rest: string): string {
  const quoted = rest.lastIndexOf(' "b/');
  if (quoted !== -1) return cleanPath(rest.slice(quoted + 1), true);
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0 && rest.slice(2, 2 + half) === rest.slice(half + 5)) return cleanPath(rest.slice(half + 5), false);
  const i = rest.lastIndexOf(' b/');
  return i === -1 ? rest : cleanPath(rest.slice(i + 1), true);
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Scan the output of `git diff -U0` (any context size works). Hits come in diff order: for each file its suppressions
 * by line, then its deleted-test or assertion-loss finding.
 */
export function scanDiff(diff: string): SuppressionHit[] {
  const out: SuppressionHit[] = [];
  let cur: FileState | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  const flush = (): void => {
    if (!cur) return;
    out.push(...cur.hits);
    if (isConstraintsFile(cur.file) || (cur.renamedFrom !== undefined && isConstraintsFile(cur.renamedFrom))) {
      out.push({ kind: 'constraints-changed', file: cur.renamedFrom !== undefined && isConstraintsFile(cur.renamedFrom) ? cur.renamedFrom : cur.file });
    }
    if (isTestFile(cur.file)) {
      if (cur.deleted) out.push({ kind: 'deleted-test', file: cur.file });
      else if (cur.removedAssertions > cur.addedAssertions) {
        out.push({ kind: 'assertion-loss', file: cur.file, removed: cur.removedAssertions, added: cur.addedAssertions });
      }
    }
    cur = null;
  };

  for (const text of diff.split('\n')) {
    // inside a hunk the line counts say how many lines are content, so "+++ x" or "--- x" content cannot be mistaken for a header
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = text[0];
      if (c === '+') {
        newLeft--;
        const body = text.slice(1);
        if (ASSERTION_RE.test(body)) cur.addedAssertions++;
        if (!DOC_EXT_RE.test(cur.file)) {
          for (const p of SUPPRESSION_PATTERNS) {
            if (p.re.test(body)) cur.hits.push({ kind: 'suppression', file: cur.file, line: newLine, pattern: p.label });
          }
        }
        newLine++;
        continue;
      }
      if (c === '-') {
        oldLeft--;
        if (ASSERTION_RE.test(text.slice(1))) cur.removedAssertions++;
        continue;
      }
      if (c === ' ') {
        oldLeft--;
        newLeft--;
        newLine++;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
    }
    if (text.startsWith('diff --git ')) {
      flush();
      cur = { file: pathOfDiffHeader(text.slice('diff --git '.length)), deleted: false, removedAssertions: 0, addedAssertions: 0, hits: [] };
      oldLeft = 0;
      newLeft = 0;
    } else if (!cur) {
      continue;
    } else if (text.startsWith('deleted file mode')) {
      cur.deleted = true;
    } else if (text.startsWith('rename from ')) {
      cur.renamedFrom = cleanPath(text.slice('rename from '.length), false);
    } else if (text.startsWith('--- ')) {
      // a deleted file has no "+++ b/<name>": its name is on this line (the diff --git header is ambiguous for quoted names)
      const p = text.slice(4);
      if (cur.deleted && p !== '/dev/null') cur.file = cleanPath(p, true);
    } else if (text.startsWith('rename to ')) {
      cur.file = cleanPath(text.slice('rename to '.length), false);
    } else if (text.startsWith('+++ ')) {
      const p = text.slice(4);
      if (p !== '/dev/null') cur.file = cleanPath(p, true);
    } else {
      const m = HUNK_RE.exec(text);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
        newLine = Number(m[2]);
      }
    }
  }
  flush();
  return out;
}
