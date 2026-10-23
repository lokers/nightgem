/**
 * Export script test: `scripts/export-public.sh` builds a fresh single-commit repo from the tracked files of a
 * ref. Offline, temp dirs only. The scanners are never run for real (`--skip-scans`) or are faked on a private PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixtures/paths.ts';

const SCRIPT = join(REPO_ROOT, 'scripts', 'export-public.sh');
const NAME = 'Alice Example';
const EMAIL = 'alice@example.com';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ng-export-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() }).trim();
}

function runExport(args: string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  const res = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A PATH holding only the tools the script needs, plus optional fake scanners. */
function limitedPath(dir: string, scanners: string[]): string {
  mkdirSync(dir, { recursive: true });
  for (const tool of ['git', 'tar', 'bash', 'dirname', 'basename', 'ls', 'mkdir', 'wc', 'tr', 'cat', 'env', 'sort', 'comm']) {
    const found = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(found, join(dir, tool));
  }
  for (const s of scanners) {
    const p = join(dir, s);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

let source: string;

beforeAll(() => {
  source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Bob Original');
  git(source, 'config', 'user.email', 'bob@example.com');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'feat: first');
  mkdirSync(join(source, 'sub'));
  writeFileSync(join(source, 'sub', 'b.txt'), 'two\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'feat: second');
  // a hook that would fail any commit made in the source repo, and an untracked file
  const hook = join(source, '.git', 'hooks', 'pre-commit');
  mkdirSync(join(source, '.git', 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho "hook ran" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(source, 'untracked.txt'), 'secret\n');
});

describe('export-public.sh', () => {
  it('exports tracked files as one commit with the given identity and no remote', () => {
    const dest = join(root, 'out-ok');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans']);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('--skip-scans');
    expect(res.stdout).toContain('No remote was added');
    expect(res.stdout).toMatch(/Files:\s+2 \(matches the 2 tracked files of HEAD\)/);

    expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(dest, 'branch', '--show-current')).toBe('main');
    expect(git(dest, 'log', '--format=%an <%ae> | %cn <%ce> | %s')).toBe(`${NAME} <${EMAIL}> | ${NAME} <${EMAIL}> | Initial commit`);
    expect(res.stdout).toContain(git(dest, 'rev-parse', 'HEAD'));
    expect(git(dest, 'remote')).toBe('');
    expect(git(dest, 'ls-files').split('\n').sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(existsSync(join(dest, 'untracked.txt'))).toBe(false);
    expect(res.stderr).not.toContain('hook ran');
  });

  it('ignores hostile global hooks, templates and signing config', () => {
    const hooks = join(root, 'hostile-hooks');
    const tpl = join(root, 'hostile-tpl', 'hooks');
    mkdirSync(hooks, { recursive: true });
    mkdirSync(tpl, { recursive: true });
    for (const d of [hooks, tpl]) {
      writeFileSync(join(d, 'pre-commit'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(d, 'pre-commit'), 0o755);
    }
    const cfg = join(root, 'hostile.gitconfig');
    writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${join(root, 'hostile-tpl')}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n[user]\n\tname = Mallory\n\temail = mallory@example.com\n`);
    const dest = join(root, 'out-hostile');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans'], cleanEnv({ GIT_CONFIG_GLOBAL: cfg }));
    expect(res.code).toBe(0);
    expect(git(dest, 'log', '--format=%an <%ae> | %cn <%ce>')).toBe(`${NAME} <${EMAIL}> | ${NAME} <${EMAIL}>`);
  });

  it('exports tracked files that a global excludes file or a tracked .gitignore would ignore', () => {
    const src = join(root, 'source-ignored');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    git(src, 'config', 'user.name', 'Bob Original');
    git(src, 'config', 'user.email', 'bob@example.com');
    git(src, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(src, 'kept.txt'), 'one\n');
    writeFileSync(join(src, 'notes.log'), 'tracked although *.log is ignored globally\n');
    writeFileSync(join(src, 'forced.tmp'), 'tracked although the .gitignore below matches it\n');
    writeFileSync(join(src, '.gitignore'), '*.tmp\n');
    git(src, 'add', '-A');
    git(src, 'add', '-f', 'forced.tmp');
    git(src, 'commit', '-q', '-m', 'feat: files');
    expect(git(src, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'forced.tmp', 'kept.txt', 'notes.log']);

    const excludes = join(root, 'global-ignore');
    writeFileSync(excludes, '*.log\n');
    const cfg = join(root, 'excludes.gitconfig');
    writeFileSync(cfg, `[core]\n\texcludesFile = ${excludes}\n`);
    const dest = join(root, 'out-ignored');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', src, '--skip-scans'], cleanEnv({ GIT_CONFIG_GLOBAL: cfg }));
    expect(res.code, res.stderr).toBe(0);
    expect(git(dest, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'forced.tmp', 'kept.txt', 'notes.log']);
    expect(res.stdout).toMatch(/Files:\s+4 \(matches the 4 tracked files of HEAD\)/);
  });

  it('honours --message and creates missing parent dirs', () => {
    const dest = join(root, 'deep', 'er', 'out-msg');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--message', 'Custom message', '--source', source, '--ref', 'HEAD~1', '--skip-scans']);
    expect(res.code).toBe(0);
    expect(git(dest, 'log', '--format=%s')).toBe('Custom message');
    expect(git(dest, 'ls-files')).toBe('a.txt');
  });

  it('accepts an existing empty dest', () => {
    const dest = join(root, 'out-empty');
    mkdirSync(dest);
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans']);
    expect(res.code).toBe(0);
  });

  it('refuses a non-empty dest and leaves it untouched', () => {
    const dest = join(root, 'out-full');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep.txt'), 'x');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('not empty');
    expect(existsSync(join(dest, '.git'))).toBe(false);
  });

  it('refuses a dest inside the source work tree', () => {
    const dest = join(source, 'nested-export');
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('inside the source work tree');
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a dest that is the source itself', () => {
    const res = runExport(['--dest', source, '--name', NAME, '--email', EMAIL, '--source', source, '--skip-scans']);
    expect(res.code).not.toBe(0);
  });

  it('exits 2 on missing or unknown arguments, and 1 on a bad source or ref', () => {
    expect(runExport(['--name', NAME, '--email', EMAIL]).code).toBe(2);
    expect(runExport(['--dest', join(root, 'x1'), '--email', EMAIL, '--source', source]).code).toBe(2);
    expect(runExport(['--dest', join(root, 'x2'), '--name', NAME, '--email', EMAIL, '--bogus']).code).toBe(2);
    expect(runExport(['--dest', join(root, 'x3'), '--name', NAME, '--email', EMAIL, '--source', root, '--skip-scans']).code).toBe(1);
    expect(runExport(['--dest', join(root, 'x4'), '--name', NAME, '--email', EMAIL, '--source', source, '--ref', 'nope', '--skip-scans']).code).toBe(1);
  });

  it('fails with an install hint when gitleaks and trufflehog are both missing', () => {
    const dest = join(root, 'out-noscan');
    const bin = limitedPath(join(root, 'bin-none'), []);
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source], cleanEnv({ PATH: bin }));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('brew install gitleaks trufflehog');
    expect(res.stderr).toContain('gitleaks');
    expect(res.stderr).toContain('trufflehog');
    expect(existsSync(dest)).toBe(false);
  });

  it('fails when only trufflehog is missing', () => {
    const dest = join(root, 'out-notruffle');
    const bin = limitedPath(join(root, 'bin-gl'), ['gitleaks']);
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source], cleanEnv({ PATH: bin }));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('brew install gitleaks trufflehog');
    expect(res.stderr).toContain('trufflehog');
  });

  it('fails when only gitleaks is missing', () => {
    const dest = join(root, 'out-nogl');
    const bin = limitedPath(join(root, 'bin-th'), ['trufflehog']);
    const res = runExport(['--dest', dest, '--name', NAME, '--email', EMAIL, '--source', source], cleanEnv({ PATH: bin }));
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('brew install gitleaks trufflehog');
    expect(res.stderr).toContain('gitleaks');
  });

  it('runs both scanners (faked) on the exported tree before committing, and stops on a finding', () => {
    const okBin = limitedPath(join(root, 'bin-both'), ['gitleaks', 'trufflehog']);
    const ok = join(root, 'out-scanned');
    const res = runExport(['--dest', ok, '--name', NAME, '--email', EMAIL, '--source', source], cleanEnv({ PATH: okBin }));
    expect(res.code).toBe(0);
    expect(git(ok, 'rev-list', '--count', 'HEAD')).toBe('1');

    const failBin = limitedPath(join(root, 'bin-fail'), ['trufflehog']);
    writeFileSync(join(failBin, 'gitleaks'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(failBin, 'gitleaks'), 0o755);
    const bad = join(root, 'out-finding');
    const res2 = runExport(['--dest', bad, '--name', NAME, '--email', EMAIL, '--source', source], cleanEnv({ PATH: failBin }));
    expect(res2.code).not.toBe(0);
    expect(res2.stderr).toContain('gitleaks reported findings');
    expect(existsSync(join(bad, '.git'))).toBe(false);
  });
});
