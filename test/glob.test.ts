import { describe, expect, it } from 'vitest';

import { globMatch, globMatchAny, globToRegExp } from '../src/glob.ts';

describe('globMatch', () => {
  it('matches literals, anchored', () => {
    expect(globMatch('abc', 'abc')).toBe(true);
    expect(globMatch('abc', 'abcd')).toBe(false);
    expect(globMatch('abc', 'xabc')).toBe(false);
  });

  it('* does not cross slashes', () => {
    expect(globMatch('*.ts', 'a.ts')).toBe(true);
    expect(globMatch('*.ts', 'src/a.ts')).toBe(false);
    expect(globMatch('src/*', 'src/a')).toBe(true);
    expect(globMatch('src/*', 'src/a/b')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
  });

  it('? matches exactly one non-slash character', () => {
    expect(globMatch('a?c', 'abc')).toBe(true);
    expect(globMatch('a?c', 'ac')).toBe(false);
    expect(globMatch('a?c', 'a/c')).toBe(false);
  });

  it('** crosses slashes and matches zero directories before a slash', () => {
    expect(globMatch('**/generated/**', 'generated/x')).toBe(true);
    expect(globMatch('**/generated/**', 'a/b/generated/x/y.ts')).toBe(true);
    expect(globMatch('**/generated/**', 'a/generatedx/y')).toBe(false);
    expect(globMatch('**/api-spec.yaml', 'api-spec.yaml')).toBe(true);
    expect(globMatch('**/api-spec.yaml', 'x/y/api-spec.yaml')).toBe(true);
    expect(globMatch('src/**', 'src/a/b')).toBe(true);
    expect(globMatch('**', 'a/b/c')).toBe(true);
  });

  it('escapes regex metacharacters', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('(x)+[y]', '(x)+[y]')).toBe(true);
    expect(globMatch('a|b', 'a')).toBe(false);
    expect(globMatch('$HOME^', '$HOME^')).toBe(true);
  });

  it('is case sensitive by default and can be made insensitive', () => {
    expect(globMatch('Foo-*', 'foo-x')).toBe(false);
    expect(globMatch('Foo-*', 'foo-x', { caseSensitive: false })).toBe(true);
  });

  it('matches newlines in ** and *-free text without surprises', () => {
    expect(globMatch('a**b', 'a\nb')).toBe(true);
  });

  it('globMatchAny', () => {
    expect(globMatchAny(['a*', 'b*'], 'bz')).toBe(true);
    expect(globMatchAny([], 'bz')).toBe(false);
  });

  it('globToRegExp is anchored', () => {
    expect(globToRegExp('a*').source.startsWith('^')).toBe(true);
  });
});
