/**
 * macOS only (#7): the run env makes every temp path the agent shell uses writable, with NO sandbox rule outside the run tmp dir.
 * Each case runs a real shell under `sandbox-exec` with the profile `prepareRunServer` writes and the env it builds
 * (shim dir first on PATH, TMPDIR, TMPPREFIX).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SafetyInputs } from '../src/contracts.ts';
import { SANDBOX_EXEC } from '../src/sandbox.ts';
import { prepareRunServer, type PreparedRunServer } from '../src/server.ts';

const isDarwin = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const safetyFor = (workspaceRoot: string): SafetyInputs => ({ workspaceRoot, skillRoots: [], disabledSkills: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } });

/** The per-user temp dir (`confstr`), the one BSD mktemp uses when it is not told otherwise. */
function userTmp(): string {
  const r = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  return realpathSync(r.stdout.trim());
}

const RAND = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!isDarwin)('sandbox temp paths (darwin, sandbox-exec)', () => {
  let base: string;
  let home: string;
  let prep: PreparedRunServer;
  let canApply = false;
  let worktree: string;
  const leftovers: string[] = [];

  // Default cwd is the (unwritable) home. bash 3.2 puts a here-document in the cwd when it can write there; there is NO sandbox rule
  // for its other location (/private/var/tmp), so the heredoc cases pass a writable cwd, as real runs have (run dir, worktree).
  const sh = (shell: string, script: string, cwd: string = home): { status: number | null; out: string; err: string } => {
    const r = spawnSync(SANDBOX_EXEC, ['-f', prep.sandboxProfilePath!, shell, '-c', script], { env: prep.env, cwd, encoding: 'utf8', timeout: 30_000 });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };

  beforeAll(async () => {
    base = mkdtempSync(join(userTmp(), 'ng-t2-'));
    home = realpathSync(base);
    worktree = join(home, 'workspace', 'acme-api', '.worktrees', 't2');
    mkdirSync(worktree, { recursive: true });
    prep = await prepareRunServer({
      slug: 't2-darwin',
      home,
      workspaceRoot: join(home, 'workspace'),
      safety: safetyFor(join(home, 'workspace')),
      model: 'a/b',
      smallModel: 'a/c',
      opencodeBin: '/bin/oc',
      sandbox: true,
      port: 45999,
      tmpDir: join(userTmp(), `nightgem-t2-${RAND}`),
      baseEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    leftovers.push(prep.tmpDir);
    // a sandbox-exec started inside another sandbox cannot apply a profile: then there is nothing to test here
    canApply = spawnSync(SANDBOX_EXEC, ['-f', prep.sandboxProfilePath!, '/usr/bin/true']).status === 0;
  });

  afterAll(() => {
    for (const p of [...leftovers, base]) if (p) rmSync(p, { recursive: true, force: true });
    // only reached if a refusal above regressed: leave nothing behind in the shared dirs
    for (const f of [`/tmp/nightgem-t2-${RAND}`, ...['other', 'd', 'mv', 'ln', 'lns'].map((n) => `/private/var/tmp/${n}-${RAND}`)]) rmSync(f, { recursive: true, force: true });
    for (const f of readdirSync('/private/var/tmp').filter((n) => n.startsWith('sh-thd-123') && n.includes(RAND.replace(/\D/g, '')))) rmSync(`/private/var/tmp/${f}`, { force: true });
    spawnSync('/usr/bin/xattr', ['-d', 'com.nightgem.t2', '/private/var/tmp']);
  });

  it('the env has the shim first on PATH and TMPDIR/TMPPREFIX in the run tmp dir', () => {
    expect(prep.env.PATH?.split(':')[0]).toBe(join(home, 'Library', 'Application Support', 'nightgem', 't2-darwin', 'bin'));
    expect(prep.env.TMPDIR).toBe(prep.tmpDir);
    expect(prep.env.TMPPREFIX).toBe(join(prep.tmpDir, 'zsh'));
  });

  // zsh heredocs go to $TMPPREFIX, so any cwd works; bash 3.2 and sh need a writable cwd (see the refused case below)
  const writableCwds = (): Array<[string, string]> => [
    ['the run tmp dir', prep.tmpDir],
    ['a fake worktree inside the workspace', worktree],
  ];

  it('/bin/zsh: a heredoc append into a file under the run tmp dir works, from any cwd', (ctx) => {
    if (!canApply) ctx.skip();
    const r = sh('/bin/zsh', `cat >> "$TMPDIR/h-zsh.txt" <<EOF\nhello\nEOF\ncat >> "$TMPDIR/h-zsh.txt" <<'EOF'\nworld $HOME\nEOF`);
    expect({ status: r.status, err: r.err }).toEqual({ status: 0, err: '' });
    expect(readFileSync(join(prep.tmpDir, 'h-zsh.txt'), 'utf8')).toBe('hello\nworld $HOME\n');
  });

  for (const shell of ['/bin/bash', '/bin/sh']) {
    for (const [label] of [['the run tmp dir'], ['a fake worktree inside the workspace']] as const) {
      it(`${shell}: a heredoc works from a writable cwd (${label})`, (ctx) => {
        if (!canApply) ctx.skip();
        const cwd = writableCwds().find(([l]) => l === label)![1];
        const name = `h-${shell.slice(5)}-${label.length}.txt`;
        const r = sh(shell, `cat >> "$TMPDIR/${name}" <<EOF\nhello\nEOF\ncat >> "$TMPDIR/${name}" <<'EOF'\nworld $HOME\nEOF`, cwd);
        expect({ status: r.status, err: r.err }).toEqual({ status: 0, err: '' });
        expect(readFileSync(join(prep.tmpDir, name), 'utf8')).toBe('hello\nworld $HOME\n');
        expect(readdirSync(cwd).filter((f) => f.startsWith('sh-thd'))).toEqual([]);
      });
    }
  }

  it('a heredoc in a script run by bash works from a writable cwd', (ctx) => {
    if (!canApply) ctx.skip();
    writeFileSync(join(prep.tmpDir, 'script.sh'), 'cat <<EOF > "$TMPDIR/from-script.txt"\nhi\nEOF\n');
    const r = sh('/bin/zsh', `/bin/bash "$TMPDIR/script.sh"`, worktree);
    expect({ status: r.status, err: r.err }).toEqual({ status: 0, err: '' });
    expect(readFileSync(join(prep.tmpDir, 'from-script.txt'), 'utf8')).toBe('hi\n');
  });

  it('known limit: a bash or sh heredoc from an UNWRITABLE cwd is refused (there is no rule for /private/var/tmp)', (ctx) => {
    if (!canApply) ctx.skip();
    for (const shell of ['/bin/bash', '/bin/sh']) {
      for (const cwd of ['/', home]) {
        const r = sh(shell, `cat > "$TMPDIR/limit.txt" <<EOF\nx\nEOF`, cwd);
        expect({ shell, cwd, ok: r.status === 0 }).toEqual({ shell, cwd, ok: false });
        expect(r.err).toMatch(/here document/);
      }
    }
    // the shell may have created the empty redirect target, but never got the here-document into it
    expect(readFileSync(join(prep.tmpDir, 'limit.txt'), 'utf8')).toBe('');
  });

  it('a bare mktemp resolves to the shim and creates a file and a directory under the run tmp dir; a $TMPDIR template works too', (ctx) => {
    if (!canApply) ctx.skip();
    const shim = join(home, 'Library', 'Application Support', 'nightgem', 't2-darwin', 'bin', 'mktemp');
    expect(sh('/bin/zsh', 'command -v mktemp').out.trim()).toBe(shim);
    expect(sh('/bin/bash', 'command -v mktemp').out.trim()).toBe(shim);
    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
      const f = sh(shell, 'f=$(mktemp) && echo x > "$f" && echo "$f"');
      expect({ shell, status: f.status, err: f.err }).toEqual({ shell, status: 0, err: '' });
      expect(f.out.trim().startsWith(`${prep.tmpDir}/`)).toBe(true);
      expect(readFileSync(f.out.trim(), 'utf8')).toBe('x\n');
    }
    const d = sh('/bin/zsh', 'd=$(mktemp -d) && echo x > "$d/f" && echo "$d"');
    expect({ status: d.status, err: d.err }).toEqual({ status: 0, err: '' });
    expect(d.out.trim().startsWith(`${prep.tmpDir}/`)).toBe(true);
    expect(statSync(d.out.trim()).isDirectory()).toBe(true);
    const t = sh('/bin/zsh', 'f=$(mktemp "$TMPDIR/x.XXXXXX") && echo x > "$f" && echo "$f"');
    expect({ status: t.status, err: t.err }).toEqual({ status: 0, err: '' });
    expect(t.out.trim().startsWith(`${prep.tmpDir}/x.`)).toBe(true);
    const named = sh('/bin/zsh', 'f=$(mktemp -t prefix) && echo x > "$f" && echo "$f"');
    expect({ status: named.status, err: named.err }).toEqual({ status: 0, err: '' });
    expect(named.out.trim().startsWith(`${prep.tmpDir}/prefix.`)).toBe(true);
  });

  describe('everything else stays refused', () => {
    const VT = '/private/var/tmp';
    const refused: Array<[string, string, string?]> = [
      ['echo x > /tmp', `echo x > /tmp/nightgem-t2-${RAND}`, `/tmp/nightgem-t2-${RAND}`],
      ['echo x > /private/var/tmp/other', `echo x > ${VT}/other-${RAND}`, `${VT}/other-${RAND}`],
      ['echo x > /private/var/tmp/sh-thd-123 (no rule for the bash heredoc name any more)', `echo x > ${VT}/sh-thd-123${RAND.replace(/\D/g, '')}`, `${VT}/sh-thd-123${RAND.replace(/\D/g, '')}`],
      ['mkdir /private/var/tmp/d', `mkdir ${VT}/d-${RAND}`, `${VT}/d-${RAND}`],
      ['touch /private/var/tmp (its times)', `touch ${VT}`],
      ['xattr -w on /private/var/tmp', `xattr -w com.nightgem.t2 x ${VT}`],
      ['mv into /private/var/tmp', `echo x > "$TMPDIR/mv-src" && mv "$TMPDIR/mv-src" ${VT}/mv-${RAND}`, `${VT}/mv-${RAND}`],
      ['ln into /private/var/tmp', `echo x > "$TMPDIR/ln-src" && ln "$TMPDIR/ln-src" ${VT}/ln-${RAND}`, `${VT}/ln-${RAND}`],
      ['ln -s into /private/var/tmp', `echo x > "$TMPDIR/lns-src" && ln -s "$TMPDIR/lns-src" ${VT}/lns-${RAND}`, `${VT}/lns-${RAND}`],
    ];
    for (const [name, script, path] of refused) {
      it(name, (ctx) => {
        if (!canApply) ctx.skip();
        const r = sh('/bin/zsh', script, worktree);
        expect(r.status).not.toBe(0);
        if (path) {
          let exists = true;
          try {
            lstatSync(path);
          } catch {
            exists = false;
          }
          expect(exists).toBe(false);
        }
      });
    }

    it('echo x > <per-user tmp>/outside', (ctx) => {
      if (!canApply) ctx.skip();
      const outside = join(userTmp(), `outside-${RAND}`);
      leftovers.push(outside);
      const r = sh('/bin/zsh', `echo x > '${outside}'`);
      expect(r.status).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
    });

    it('the real mktemp by absolute path still cannot use the per-user temp dir', (ctx) => {
      if (!canApply) ctx.skip();
      expect(sh('/bin/zsh', '/usr/bin/mktemp').status).not.toBe(0);
    });

    it('writing to, replacing or removing the shim copy', (ctx) => {
      if (!canApply) ctx.skip();
      const shim = join(home, 'Library', 'Application Support', 'nightgem', 't2-darwin', 'bin', 'mktemp');
      const before = readFileSync(shim, 'utf8');
      for (const script of [`echo '#!/bin/sh' > '${shim}'`, `echo x >> '${shim}'`, `rm -f '${shim}'`, `chmod 755 '${shim}'`, `echo x > '${shim}.new' && mv '${shim}.new' '${shim}'`]) {
        expect(sh('/bin/zsh', script).status, script).not.toBe(0);
      }
      expect(readFileSync(shim, 'utf8')).toBe(before);
      expect(statSync(shim).mode & 0o777).toBe(0o555);
    });
  });
});
