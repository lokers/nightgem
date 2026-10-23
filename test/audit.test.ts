import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditFiles, auditRepo, isBinary, type Hit } from '../src/audit.ts';

// Leaky-looking samples are assembled at runtime so this file itself passes the audit it tests.
const slash = '/';
const homePath = (name: string, rest = 'x'): string => [slash + 'Users', name, rest].join('/');
const linuxHome = (name: string): string => [slash + 'home', name, 'x'].join('/');
const email = (local: string, domain: string): string => `${local}@${domain}`;
const key = (prefix: string, n: number | string): string => `${prefix}-${n}`;

const run = (text: string, bannedTerms: string[] = [], generic = true): Hit[] =>
  auditFiles([{ path: 'f.txt', text }], { bannedTerms, generic });
const kinds = (hits: Hit[]): string[] => hits.map((h) => `${h.kind}:${h.match}`);

describe('macOS temp dir hashes', () => {
  // assembled at runtime so this file passes its own audit
  const hash = (h: string): string => [slash + 'private', 'var', 'folders', h, 'T', 'opencode'].join('/');

  it('flags a real-looking per-user temp dir hash', () => {
    const hits = run(`"resource": "${hash('ab/' + 'k3j9x0q1w2e3r4t5y6u7i8o9p0a1sd')}/**"`);
    expect(hits.map((h) => h.kind)).toEqual(['home-path']);
    expect(hits[0]!.match).toContain(slash + 'var/folders/ab/');
    expect(run(`${slash}var/folders/ab/k3j9x0q1w2e3r4t5y6u7i8o9p0a1sd/T`)).toHaveLength(1);
  });

  it('allows the neutral placeholder and short synthetic paths', () => {
    expect(run(hash('xx/abcdefghijklmnopqrstuvwxyz0000gn'))).toEqual([]);
    expect(run(`${slash}private/var/folders/xx/T/opencode-tmp`)).toEqual([]);
  });

  it('does not flag it when the generic checks are off', () => {
    expect(run(hash('ab/' + 'k3j9x0q1w2e3r4t5y6u7i8o9p0a1sd'), [], false)).toEqual([]);
  });
});

describe('home paths', () => {
  it('flags real-looking home paths on macOS and Linux', () => {
    expect(kinds(run(`cat ${homePath('carol')}`))).toEqual([`home-path:${slash}Users/carol`]);
    expect(kinds(run(`cd ${linuxHome('dave')}`))).toEqual([`home-path:${slash}home/dave`]);
    // no trailing path component needed
    expect(run(`${slash}Users/carol`)).toHaveLength(1);
  });

  it('allows the fixture users, wildcards and template placeholders', () => {
    for (const n of ['alice', 'bob', 'test', 'x', 'someone', 'u', 'example', 'me', 'user', '*', '{{USER}}', '{{HOME_USER}}']) {
      expect(run(homePath(n)), n).toEqual([]);
    }
  });

  it('ignores dot-name traversal artefacts that are not user names', () => {
    expect(run('cat ../../../home/.config/foo')).toEqual([]);
    expect(run('cat ../../../home/.con?ig/foo')).toEqual([]);
    // but a glob inside a real-looking name is still reported
    expect(run(`cat ${slash}home/ca*ol/x`)).toHaveLength(1);
  });

  it('ignores relative paths that merely contain Users/', () => {
    expect(run('src/Users/carol/x')).toEqual([]);
    expect(run('Users/carol')).toEqual([]);
  });

  it('stops the name at quotes, whitespace and brackets', () => {
    expect(run(`"${homePath('carol')}"`)[0]?.match).toBe(`${slash}Users/carol`);
    expect(run(`(${homePath('carol')})`)[0]?.match).toBe(`${slash}Users/carol`);
  });
});

describe('emails', () => {
  it('flags personal emails', () => {
    expect(kinds(run(`ping ${email('carol.k', 'corp.io')} now`))).toEqual([`email:${email('carol.k', 'corp.io')}`]);
  });

  it('allows git@ remotes and example.* domains', () => {
    expect(run(`git clone ${email('git', 'github.com')}:org/repo.git`)).toEqual([]);
    expect(run(`remote ${email('git', 'example.invalid')}:nightgem/canary.git`)).toEqual([]);
    for (const d of ['example.com', 'example.org', 'example.invalid']) expect(run(email('anyone', d)), d).toEqual([]);
    expect(run(email('anyone', 'EXAMPLE.COM'))).toEqual([]);
  });

  it('does not treat package versions as emails', () => {
    expect(run('opencode@2.0.29 and pkg@1.2.3 and @scope/pkg@latest')).toEqual([]);
  });

  it('does not treat retina asset names as emails, but keeps flagging real ones', () => {
    expect(run('hero@2x.png, icon@3x.svg, logo@2x.webp')).toEqual([]);
    expect(run(email('anyone', '2x.example-corp.io'))).toHaveLength(1);
  });

  it('still flags look-alike domains', () => {
    expect(run(email('anyone', 'example.com.evil.io'))).toHaveLength(1);
    expect(run(email('anyone', 'notexample.com'))).toHaveLength(1);
  });
});

describe('ticket keys', () => {
  it('flags tracker-like keys', () => {
    expect(kinds(run(`fixes ${key('ABC', 123)} and ${key('X1Y', 9)}`))).toEqual([`ticket-key:${key('ABC', 123)}`, `ticket-key:${key('X1Y', 9)}`]);
  });

  it('allows the neutral example key', () => {
    expect(run(key('JIRA', 123))).toEqual([]);
  });

  it('allows the technical allowlist', () => {
    const ok = ['UTF-8', 'UTF-16', 'MPL-2', 'BSD-2', 'BSD-3', 'ISO-8601', 'SHA-1', 'SHA-256', 'SHA-512', 'AES-256', 'RFC-2119', 'ES-2022', 'CVE-2024-1234', 'GPT-4', 'TLS-1'];
    for (const k of ok) expect(run(`uses ${k}`), k).toEqual([]);
  });

  it('ignores X- headers, lowercase and ES2022', () => {
    expect(run('X-Request-Id: 1, x-api-1, target ES2022, abc-123')).toEqual([]);
  });

  it('ignores regex character-class tails like A-Z0-9 and A-F0-9', () => {
    expect(run('/[A-Z0-9]+/ and [a-fA-F0-9]')).toEqual([]);
  });

  it('needs a word boundary', () => {
    expect(run(`${key('ABC', 123)}x`)).toEqual([]);
    expect(run(`a${key('ABC', 123)}`)).toEqual([]);
    expect(run(`feat/${key('ABC', 123)}-thing`)).toHaveLength(1);
  });
});

describe('banned terms', () => {
  it('matches case-insensitively as substrings, one hit per occurrence', () => {
    const hits = run('Acme and ACMEcorp and acme', ['acme']);
    expect(hits.map((h) => [h.kind, h.match, h.col])).toEqual([
      ['banned-term', 'Acme', 1],
      ['banned-term', 'ACME', 10],
      ['banned-term', 'acme', 23],
    ]);
  });

  it('works with generic checks off, and ignores empty terms', () => {
    expect(run(homePath('carol'), ['', 'zzz'], false)).toEqual([]);
    expect(run(`the Foo-Bar thing`, ['foo-bar'], false)).toHaveLength(1);
  });

  it('reports each term separately and orders hits by position', () => {
    const hits = run(`bbb\nxx aaa bbb`, ['aaa', 'bbb']);
    expect(hits.map((h) => [h.line, h.col, h.match])).toEqual([
      [1, 1, 'bbb'],
      [2, 4, 'aaa'],
      [2, 8, 'bbb'],
    ]);
  });
});

describe('locations', () => {
  it('reports 1-based line and column across files', () => {
    const hits = auditFiles(
      [
        { path: 'a.txt', text: `line1\n  ${key('ABC', 7)}\n` },
        { path: 'b.txt', text: `\n\nok ${email('carol', 'corp.io')}` },
      ],
      { bannedTerms: [], generic: true },
    );
    expect(hits.map((h) => [h.file, h.line, h.col])).toEqual([
      ['a.txt', 2, 3],
      ['b.txt', 3, 4],
    ]);
  });

  it('handles CRLF', () => {
    expect(run(`a\r\n${key('ABC', 1)}`)[0]).toMatchObject({ line: 2, col: 1 });
  });
});

describe('auditRepo', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ng-audit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('audits tracked files only, skipping binaries and unreadable paths, via an injected git runner', async () => {
    writeFileSync(join(dir, 'a.md'), `see ${key('ABC', 5)}\n`);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'Acme here\n');
    writeFileSync(join(dir, 'untracked.txt'), `${key('ZZZ', 1)}\n`);
    writeFileSync(join(dir, 'img.bin'), Buffer.from([1, 2, 0, 3]));
    const calls: [string[], string][] = [];
    const res = await auditRepo({
      dir,
      bannedTerms: ['acme'],
      git: (args, cwd) => {
        calls.push([args, cwd]);
        return 'a.md\0sub/b.txt\0img.bin\0gone.txt\0';
      },
    });
    expect(calls).toEqual([[['ls-files', '-z'], dir]]);
    expect(res.hits.map((h) => `${h.file}:${h.kind}`)).toEqual(['a.md:ticket-key', 'sub/b.txt:banned-term']);
    expect(res.scanned).toBe(2);
    expect(res.skippedBinary).toEqual(['img.bin']);
    expect(res.unreadable).toEqual(['gone.txt']);
  });

  it('works against a real git repository (async runner)', async () => {
    const git = (args: string[], cwd: string): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git(['init', '-q'], dir);
    writeFileSync(join(dir, 'tracked.txt'), `${homePath('carol')}\n`);
    writeFileSync(join(dir, 'untracked.txt'), `${homePath('dave')}\n`);
    git(['add', 'tracked.txt'], dir);
    const res = await auditRepo({ dir, bannedTerms: [], git: async (a, c) => git(a, c) });
    expect(res.hits.map((h) => h.file)).toEqual(['tracked.txt']);
  });

  it('can run banned terms only', async () => {
    writeFileSync(join(dir, 'a.txt'), `${key('ABC', 1)} acme\n`);
    const res = await auditRepo({ dir, bannedTerms: ['acme'], generic: false, git: () => 'a.txt\0' });
    expect(res.hits.map((h) => h.kind)).toEqual(['banned-term']);
  });
});

describe('isBinary', () => {
  it('detects NUL bytes', () => {
    expect(isBinary(Buffer.from('hello'))).toBe(false);
    expect(isBinary(Buffer.from([104, 0, 105]))).toBe(true);
  });
});

describe('maintainer contact', () => {
  it('allows exactly the published maintainer address, nothing else at that domain', async () => {
    const { MAINTAINER_EMAIL } = await import('../src/brand.ts');
    expect(run(`report to ${MAINTAINER_EMAIL}`)).toEqual([]);
    const [local, domain] = MAINTAINER_EMAIL.split('@');
    expect(run(`ping ${local}.other@${domain}`)).toHaveLength(1);
  });
});
