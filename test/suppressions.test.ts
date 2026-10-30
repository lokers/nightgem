import { describe, expect, it } from 'vitest';

import { SUPPRESSION_PATTERNS, isTestFile, scanDiff } from '../src/suppressions.ts';

/** A unified diff (`git diff -U0`) for one modified file, built from added and removed lines. */
function modified(file: string, opts: { added?: string[]; removed?: string[]; at?: number }): string {
  const added = opts.added ?? [];
  const removed = opts.removed ?? [];
  const at = opts.at ?? 10;
  return [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${at},${removed.length} +${at},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function deleted(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${file}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
    '',
  ].join('\n');
}

describe('scanDiff: added suppressions and skips', () => {
  it('returns no hits for an empty or clean diff', () => {
    expect(scanDiff('')).toEqual([]);
    expect(scanDiff(modified('src/a.ts', { added: ['export const a = 1;'] }))).toEqual([]);
  });

  it('flags every pattern on added lines with the file and the new line number', () => {
    const samples: Array<[string, string]> = [
      ['eslint-disable', '// eslint-disable-next-line no-console'],
      ['@ts-ignore', '// @ts-ignore'],
      ['@ts-expect-error', '// @ts-expect-error legacy'],
      ['@ts-nocheck', '// @ts-nocheck'],
      ['.skip(', "  it.skip('works', () => {});"],
      ['.only(', "  describe.only('suite', () => {});"],
      ['xit(', "  xit('works', () => {});"],
      ['xdescribe(', "xdescribe('suite', () => {});"],
      ['t.Skip(', '\tt.Skip("flaky")'],
      ['//nolint', 'x := f() //nolint:errcheck'],
      ['# noqa', 'import os  # noqa: F401'],
      ['# type: ignore', 'x: int = f()  # type: ignore'],
      ['@Disabled', '    @Disabled("flaky")'],
      ['@Ignore', '    @Ignore'],
      ['pytest.mark.skip', '@pytest.mark.skip(reason="later")'],
    ];
    for (const [pattern, line] of samples) {
      const hits = scanDiff(modified('src/a.x', { added: ['ok', line], at: 20 }));
      expect(hits, pattern).toEqual([{ kind: 'suppression', file: 'src/a.x', line: 21, pattern }]);
    }
  });

  it('lists several patterns of one line and several lines, in file order', () => {
    const diff = modified('src/a.ts', { added: ['// eslint-disable @ts-ignore', 'ok', "it.skip('x', f)"], at: 3 });
    expect(scanDiff(diff)).toEqual([
      { kind: 'suppression', file: 'src/a.ts', line: 3, pattern: 'eslint-disable' },
      { kind: 'suppression', file: 'src/a.ts', line: 3, pattern: '@ts-ignore' },
      { kind: 'suppression', file: 'src/a.ts', line: 5, pattern: '.skip(' },
    ]);
  });

  it('ignores removed lines and unchanged context', () => {
    expect(scanDiff(modified('src/a.ts', { removed: ['// eslint-disable-next-line', "it.skip('x', f)"], added: ['ok'] }))).toEqual([]);
  });

  it('does not mistake look-alikes for a hit (exit(, @IgnoreProperties, a non-test .Skip())', () => {
    const added = ['process.exit(1)', 'sys.exit(0)', '@IgnoreProperties({"a"})', 'items.Skip(5).Take(2)', 'it("skips nothing", f)'];
    expect(scanDiff(modified('src/a.ts', { added }))).toEqual([]);
  });

  it('skips documentation files, which only talk about suppressions', () => {
    expect(scanDiff(modified('docs/lint.md', { added: ['Use `// eslint-disable` sparingly.'] }))).toEqual([]);
    expect(scanDiff(modified('NOTES.txt', { added: ['@ts-ignore'] }))).toEqual([]);
  });

  it('reads the line numbers of every hunk, and treats a "+++" content line as content', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +2,2 @@',
      '+ok',
      '+++ not a header // @ts-ignore',
      '@@ -40 +42 @@',
      '-old',
      '+// @ts-nocheck',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(scanDiff(diff)).toEqual([
      { kind: 'suppression', file: 'src/a.ts', line: 3, pattern: '@ts-ignore' },
      { kind: 'suppression', file: 'src/a.ts', line: 42, pattern: '@ts-nocheck' },
    ]);
  });

  it('follows a rename to the new file name', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+// @ts-ignore',
      '',
    ].join('\n');
    expect(scanDiff(diff)).toEqual([{ kind: 'suppression', file: 'src/new.ts', line: 1, pattern: '@ts-ignore' }]);
  });

  it('ignores binary files and pure mode changes', () => {
    const diff = ['diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ', ''].join('\n');
    expect(scanDiff(diff)).toEqual([]);
  });

  it('exports its pattern labels so the docs and the code stay in step', () => {
    expect(SUPPRESSION_PATTERNS.map((p) => p.label)).toEqual([
      'eslint-disable',
      '@ts-ignore',
      '@ts-expect-error',
      '@ts-nocheck',
      '.skip(',
      '.only(',
      'xit(',
      'xdescribe(',
      't.Skip(',
      '//nolint',
      '# noqa',
      '# type: ignore',
      '@Disabled',
      '@Ignore',
      'pytest.mark.skip',
    ]);
  });
});

describe('scanDiff: tests that were deleted or lost assertions', () => {
  it('flags a deleted test file, but not a deleted non-test file', () => {
    const diff = [deleted('src/a.test.ts', ["expect(a()).toBe(1);"]), deleted('src/a.ts', ['export const a = 1;'])].join('');
    expect(scanDiff(diff)).toEqual([{ kind: 'deleted-test', file: 'src/a.test.ts' }]);
  });

  it('flags a deleted empty test file (no hunk, no header lines)', () => {
    const diff = ['diff --git a/pkg/a_test.go b/pkg/a_test.go', 'deleted file mode 100644', 'index 1111111..0000000', ''].join('\n');
    expect(scanDiff(diff)).toEqual([{ kind: 'deleted-test', file: 'pkg/a_test.go' }]);
  });

  it('flags a test file with a net loss of assertions, with the counts', () => {
    const diff = modified('src/a.test.ts', {
      removed: ['expect(a()).toBe(1);', 'expect(b()).toBe(2);', 'assert.equal(c(), 3);'],
      added: ['expect(a()).toBe(1);'],
    });
    expect(scanDiff(diff)).toEqual([{ kind: 'assertion-loss', file: 'src/a.test.ts', removed: 3, added: 1 }]);
  });

  it('does not flag a test file that keeps or adds assertions, or a non-test file that loses them', () => {
    expect(scanDiff(modified('src/a.test.ts', { removed: ['expect(a()).toBe(1);'], added: ['expect(a()).toBe(2);'] }))).toEqual([]);
    expect(scanDiff(modified('src/a.test.ts', { removed: ['it("a", f)'], added: ['expect(a()).toBe(1);'] }))).toEqual([]);
    expect(scanDiff(modified('src/a.ts', { removed: ['assert(x)'], added: [] }))).toEqual([]);
  });

  it('counts assertion helpers of other languages', () => {
    const diff = modified('pkg/a_test.go', { removed: ['assert.Equal(t, 1, a())', 'assertThat(x)', 'assert_eq!(a, b);'], added: [] });
    expect(scanDiff(diff)).toEqual([{ kind: 'assertion-loss', file: 'pkg/a_test.go', removed: 3, added: 0 }]);
  });

  it('reports a renamed test file that lost assertions under its new name', () => {
    const diff = [
      'diff --git a/src/a.test.ts b/src/b.test.ts',
      'similarity index 80%',
      'rename from src/a.test.ts',
      'rename to src/b.test.ts',
      '--- a/src/a.test.ts',
      '+++ b/src/b.test.ts',
      '@@ -1 +0,0 @@',
      '-expect(a()).toBe(1);',
      '',
    ].join('\n');
    expect(scanDiff(diff)).toEqual([{ kind: 'assertion-loss', file: 'src/b.test.ts', removed: 1, added: 0 }]);
  });
});

describe('isTestFile', () => {
  it('recognises common test file names and test directories with code files', () => {
    for (const f of [
      'src/a.test.ts',
      'src/a.spec.tsx',
      'pkg/a_test.go',
      'tests/test_a.py',
      'app/test_a.py',
      'app/a_test.py',
      'spec/a_spec.rb',
      'src/test/java/com/acme/AServiceTest.java',
      'src/__tests__/a.js',
      'test/a.mjs',
      'Acme.Tests/ATests.cs',
    ]) {
      expect(isTestFile(f), f).toBe(true);
    }
  });

  it('rejects ordinary sources and non-code files in a test directory', () => {
    for (const f of ['src/a.ts', 'src/latest.ts', 'test/fixtures/data.json', 'test/README.md', 'docs/testing.md', 'src/contest.ts']) {
      expect(isTestFile(f), f).toBe(false);
    }
  });
});
