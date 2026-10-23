/**
 * Docs link test: every relative markdown link in the public docs must point at a file that exists, and every `#anchor`
 * must match a GitHub-style heading slug of its target. `README.md#…` / `docs/…#…` references in `src/`, `commands/` and
 * `templates/` are checked too, because code and slash commands point users at those sections. Files under `.github/`
 * (issue templates, PR template) get the same treatment, and so do absolute links to this repository's own README or
 * `blob/main/…` files. Other http(s) and mailto links are skipped; the check is offline.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixtures/paths.ts';

/** Remove fenced code blocks (``` and ~~~), keeping line numbers stable by blanking the lines. */
function blankFences(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence === null) {
        if (m) {
          fence = m[1]![0]!;
          return '';
        }
        return line;
      }
      if (m && m[1]![0] === fence) fence = null;
      return '';
    })
    .join('\n');
}

/** Heading text → GitHub slug: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Strip inline markdown from a heading so the slug matches what GitHub renders. */
function headingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, (c) => (c === '_' ? '_' : ''))
    .trim();
}

/** All anchors a markdown file defines, with GitHub's `-1`, `-2` suffixes for duplicate headings. */
function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of blankFences(text).split('\n')) {
    const m = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(headingText(m[1]!));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

interface Ref {
  from: string; // repo-relative source file
  line: number;
  target: string; // as written
}

/** Markdown links (inline, image, reference definitions) and HTML `href` / `src` / `srcset` attributes. */
function markdownRefs(file: string, text: string): Ref[] {
  const refs: Ref[] = [];
  const lines = blankFences(text).split('\n');
  lines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/`[^`]*`/g, ''); // inline code is not a link
    const add = (target: string): void => {
      refs.push({ from: file, line: idx + 1, target: target.trim() });
    };
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      add(m[1]!.replace(/^<|>$/g, ''));
    }
    const def = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (def) add(def[1]!);
    for (const m of line.matchAll(/\b(?:href|src)="([^"]+)"/g)) add(m[1]!);
    for (const m of line.matchAll(/\bsrcset="([^"]+)"/g)) {
      for (const part of m[1]!.split(',')) add(part.trim().split(/\s+/)[0]!);
    }
  });
  return refs;
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(join(dir, name), accept));
    else if (accept(name)) out.push(join(dir, name));
  }
  return out;
}

const rootDocs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].filter((f) => existsSync(join(REPO_ROOT, f)));
const docFiles = [...rootDocs, ...listFiles('docs', (n) => n.endsWith('.md'))];
const codeFiles = ['src', 'commands', 'templates'].flatMap((d) => listFiles(d, () => true));

const githubFiles = listFiles('.github', (n) => n.endsWith('.md') || n.endsWith('.yml'));

const anchorCache = new Map<string, Set<string>>();
function anchorsForFile(rel: string): Set<string> {
  let a = anchorCache.get(rel);
  if (!a) {
    a = anchorsOf(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    anchorCache.set(rel, a);
  }
  return a;
}

/** Returns an error message, or null when the reference resolves. `baseDir` is the repo-relative dir links resolve against. */
function check(ref: Ref, baseDir: string): string | null {
  const t = ref.target;
  if (t === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) return null; // http(s), mailto, other schemes
  const hash = t.indexOf('#');
  const pathPart = hash === -1 ? t : t.slice(0, hash);
  const anchor = hash === -1 ? '' : t.slice(hash + 1);
  const targetRel = pathPart === '' ? ref.from : relative(REPO_ROOT, resolve(REPO_ROOT, baseDir, decodeURIComponent(pathPart)));
  if (targetRel.startsWith('..')) return `${t} leaves the repository`;
  const abs = join(REPO_ROOT, targetRel);
  if (!existsSync(abs)) return `${t}: file ${targetRel} does not exist`;
  if (anchor !== '' && targetRel.endsWith('.md') && statSync(abs).isFile()) {
    let want = anchor;
    try {
      want = decodeURIComponent(anchor);
    } catch {
      /* keep raw */
    }
    if (!anchorsForFile(targetRel).has(want.toLowerCase())) return `${t}: no heading with slug "${want}" in ${targetRel}`;
  }
  return null;
}

const SELF_URL = /https:\/\/github\.com\/lokers\/nightgem(?:\/blob\/main\/([\w./-]+))?(#[\w%-]+)?(?=[\s)"'>]|$)/g;

/** Own-repo GitHub URLs in a file, rewritten as repo-relative targets (`#x` on the bare repo URL is the README). */
function selfUrlRefs(file: string, text: string): Ref[] {
  const refs: Ref[] = [];
  text.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(SELF_URL)) {
      refs.push({ from: file, line: idx + 1, target: `${m[1] ?? 'README.md'}${m[2] ?? ''}` });
    }
  });
  return refs;
}

describe('docs links', () => {
  it('finds the docs it is meant to check', () => {
    expect(rootDocs).toEqual(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']);
    expect(docFiles).toContain('docs/safety-model.md');
    expect(docFiles).toContain('docs/troubleshooting.md');
  });

  it('slugs follow GitHub rules', () => {
    const a = anchorsOf('# A `code` & B?\n\n## Same\n\n## Same\n\n```\n# not a heading\n```\n\n### 5-minute quickstart\n');
    expect([...a].sort()).toEqual(['5-minute-quickstart', 'a-code--b', 'same', 'same-1']);
  });

  it('every relative link and #anchor in the public markdown resolves', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of docFiles) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const ref of markdownRefs(file, text)) {
        checked++;
        const err = check(ref, dirname(file));
        if (err) problems.push(`${file}:${ref.line} ${err}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  });

  it('finds the .github files it is meant to check', () => {
    expect(githubFiles).toContain('.github/ISSUE_TEMPLATE/config.yml');
    expect(githubFiles).toContain('.github/pull_request_template.md');
  });

  it('links in .github/ resolve: relative links, README.md#… / docs/…#… references and own-repo GitHub URLs', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of githubFiles) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const refs = [...markdownRefs(file, text), ...selfUrlRefs(file, text)];
      text.split('\n').forEach((line, idx) => {
        for (const m of line.matchAll(/(?<![\w./-])((?:README\.md|docs\/[\w.-]+\.md))(#[\w%-]+)?/g)) {
          refs.push({ from: file, line: idx + 1, target: `${m[1]}${m[2] ?? ''}` });
        }
      });
      for (const ref of refs) {
        checked++;
        // Relative links in .github/ markdown resolve against that file; the bare README.md / docs/ references and
        // the rewritten URLs are repo-root relative.
        const rootRelative = /^(?:README\.md|docs\/)/.test(ref.target) || ref.target.startsWith('CHANGELOG') || ref.target.startsWith('.github/');
        const err = check(ref, rootRelative ? '' : dirname(file));
        if (err) problems.push(`${file}:${ref.line} ${err}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('flags a dead anchor in an own-repo GitHub URL', () => {
    const refs = selfUrlRefs('x.yml', 'url: https://github.com/lokers/nightgem#no-such-heading\nurl: https://github.com/lokers/nightgem/blob/main/docs/safety-model.md\n');
    expect(refs.map((r) => r.target)).toEqual(['README.md#no-such-heading', 'docs/safety-model.md']);
    expect(check(refs[0]!, '')).toMatch(/no heading with slug/);
    expect(check(refs[1]!, '')).toBeNull();
  });

  it('every README.md#… / docs/…#… reference in src/, commands/ and templates/ resolves', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of codeFiles) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      text.split('\n').forEach((line, idx) => {
        for (const m of line.matchAll(/(?<![\w./-])((?:README\.md|docs\/[\w.-]+\.md))(#[\w%-]+)?/g)) {
          checked++;
          const err = check({ from: file, line: idx + 1, target: `${m[1]}${m[2] ?? ''}` }, '');
          if (err) problems.push(`${file}:${idx + 1} ${err}`);
        }
      });
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
