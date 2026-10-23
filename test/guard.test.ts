import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_RUN_WRITABLE,
  GUARD_PREFIX,
  HEARTBEAT_MAX_AGE_MS,
  checkShellCommand,
  decide,
  dispatchTargetsOracle,
  gitInvocation,
  isAllowedWritePath,
  rootToRegExp,
  splitHeredocs,
  type GuardConfig,
  type GuardFlags,
} from '../profile/guard/decide.mjs';
import { GUARD_PACKAGE } from '../profile/guard/brand.mjs';
import { configFromEnv } from '../profile/guard/config.mjs';
import guard from '../profile/guard/index.mjs';
import { buildGuardEnv, renderRunConfig } from '../src/profile.ts';
import { evaluate } from './fixtures/profile/fake-run-api.ts';
import { corpusSafety } from './fixtures/profile/corpus-safety.ts';

const NOW = 1_800_000_000_000;
const PORT = '54176';

let base: string;
let vars: Record<string, string>;
let cfg: GuardConfig;

/** The guard-relevant part of the workspace-specific safety inputs (what `NIGHTGEM_SAFETY` carries). */
function guardSafety(home: string, skillRoots?: string[]): NonNullable<GuardConfig['safety']> {
  const s = corpusSafety('/w', home);
  return { skillRoots: skillRoots ?? s.skillRoots, deny: s.deny };
}

/** A provided safety with nothing in it: the generic defaults only. */
const EMPTY_GUARD_SAFETY: NonNullable<GuardConfig['safety']> = { skillRoots: [], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } };

const fresh: GuardFlags = { softStop: false, hardStop: false, heartbeatTs: NOW - 1000 };
const withFlags = (flags: GuardFlags | null, extra: Partial<GuardConfig> = {}): GuardConfig => ({ ...cfg, flags, ...extra });

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ng-guard-')));
  const wt = join(base, 'work', 'repo', '.worktrees', 'my-run', 'T1');
  const spec = join(base, 'work', '.specs', 'my-run');
  const tmp = join(base, 'run-tmp');
  const out = join(base, 'outside');
  const main = join(base, 'work', 'repo');
  for (const d of [wt, join(spec, '.run', '.opencode'), tmp, out, join(main, 'src')]) mkdirSync(d, { recursive: true });
  symlinkSync(out, join(wt, 'linkout'));
  vars = { WORKSPACE: join(base, 'work'), WT: wt, SPEC: spec, TMP: tmp, OUT: out, MAIN: main, LINK: join(wt, 'linkout'), PORT, HOME: join(base, 'home'), XDG: join(base, 'home', 'Library', 'Application Support', 'nightgem', 'my-run', 'xdg-data'), TOOLOUT: join(base, 'home', 'Library', 'Application Support', 'nightgem', 'my-run', 'xdg-data', 'opencode', 'tool-output') };
  cfg = {
    flags: fresh,
    controlDirSet: true,
    allowedRoots: [join(base, 'work', '*', '.worktrees', 'my-run'), spec, tmp],
    now: NOW,
    cwd: wt,
    runPort: PORT,
    safety: guardSafety(join(base, 'home')),
    env: { HOME: join(base, 'home'), TMPDIR: tmp, XDG_DATA_HOME: join(base, 'home', 'Library', 'Application Support', 'nightgem', 'my-run', 'xdg-data') },
  };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function subst(s: string): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

interface CorpusLine {
  expected: 'allow' | 'block' | 'rewrite';
  tool: string;
  payload: string;
  raw: string;
}

function loadCorpus(): CorpusLine[] {
  const text = readFileSync(new URL('./fixtures/profile/guard-corpus.txt', import.meta.url), 'utf8');
  const lines: CorpusLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const m = /^(allow|block|rewrite)\|([a-z_]+)\|(.*)$/.exec(raw);
    if (!m) throw new Error(`bad corpus line: ${raw}`);
    lines.push({ expected: m[1] as CorpusLine['expected'], tool: m[2]!, payload: m[3]!, raw });
  }
  return lines;
}

function inputFor(line: CorpusLine): Record<string, unknown> {
  const payload = subst(line.payload).replace(/\\n/g, '\n');
  switch (line.tool) {
    case 'shell':
      return { command: payload };
    case 'webfetch':
      return line.expected === 'rewrite' ? { url: payload, prompt: 'summarise', format: 'markdown' } : { url: payload };
    case 'read':
      return { filePath: payload };
    case 'apply_patch':
      return { patchText: payload };
    case 'multiedit':
      return { filePath: payload, edits: [] };
    default:
      return { filePath: payload };
  }
}

describe('bypass corpus', () => {
  const corpus = loadCorpus();

  it('has a substantial corpus with all three verdicts', () => {
    expect(corpus.length).toBeGreaterThan(1170);
    expect(new Set(corpus.map((l) => l.expected))).toEqual(new Set(['allow', 'block', 'rewrite']));
  });

  for (const line of loadCorpus()) {
    it(`${line.expected.padEnd(5)} ${line.tool}: ${line.payload.slice(0, 90)}`, () => {
      const result = decide({ tool: line.tool, input: inputFor(line), agent: 'fixer' }, cfg);
      expect(result.verdict, JSON.stringify(result)).toBe(line.expected);
    });
  }
});

describe('bypass corpus: forms of a denied command', () => {
  const blocked = loadCorpus()
    .filter((l) => l.expected === 'block' && l.tool === 'shell')
    .map((l) => l.payload);
  // every spelling the corpus must keep blocking for a denied command (gh); a guard change may not drop one of these forms
  const FORMS: Array<[string, RegExp]> = [
    ['semicolon', /^echo a; gh /],
    ['&&', /^echo a && gh /],
    ['||', /^false \|\| gh /],
    ['pipe', /^echo a \| gh /],
    ['background &', /^echo a & gh /],
    ['newline', /^echo a\\ngh /],
    ['subshell', /^\(gh /],
    ['brace group', /^\{ gh [^;]*; \}$/],
    ['negation', /^! gh /],
    ['if/then', /^if true; then gh /],
    ['then on its own line', /\\nthen\\n\s+gh /],
    ['do body', /^for i in 1 2; do gh /],
    ['do on its own line', /\\ndo\\n\s+gh /],
    ['case body', /^case x in x\) gh /],
    ['leading assignment', /^FOO=1 \/x\/gh /],
    ['env -i', /^env -i gh /],
    ['env -u', /^env -u HOME gh /],
    ['command -p', /^command -p gh /],
    ['builtin', /^builtin gh /],
    ['exec -a', /^exec -a x gh /],
    ['nohup', /^nohup gh /],
    ['time -p', /^time -p gh /],
    ['nice -n', /^nice -n 10 gh /],
    ['timeout -s', /^timeout -s KILL 5 gh /],
    ['stdbuf', /^stdbuf -o0 gh /],
    ['sudo -u', /^sudo -u root gh /],
    ['xargs -I', /xargs -I\{\} gh /],
    ['find -exec', /-exec gh /],
    ['find -execdir', /-execdir gh /],
    ['find -ok', /-ok gh /],
    ['caffeinate', /^caffeinate -i gh /],
    ['arch', /^arch -arm64 gh /],
    ['script', /^script -q \/dev\/null gh /],
    ['./gh', /^\.\/gh /],
    ['../gh', /^\.\.\/gh /],
    ['bin/gh', /^bin\/gh /],
    ['double-quoted absolute path', /^"\/usr\/bin\/gh" /],
    ['doubled slash', /^\/usr\/bin\/\/gh /],
    ['dot segment', /^\/usr\/bin\/\.\/gh /],
    ['tilde path', /^~\/bin\/gh /],
    ['$HOME path', /^\$HOME\/bin\/gh /],
    ['sh -c', /^sh -c 'gh /],
    ['bash -c', /^bash -c 'gh /],
    ['zsh -c', /^zsh -c 'gh /],
    ['eval', /^eval 'gh /],
    ['command substitution', /^echo \$\(gh /],
    ['nested command substitution', /^echo \$\(echo \$\(gh /],
    ['backticks', /^echo `gh /],
    ['process substitution', /^cat <\(gh /],
    ['here-string into a shell', /^sh <<< 'gh /],
    ['heredoc into a shell', /^sh <<'EOF'\\ngh /],
    ['data piped into a shell', /^echo 'gh pr list' \| sh$/],
    ['alias', /^alias g=gh; /],
    ['function definition', /^g\(\) \{ gh /],
    ['cp of the binary', /^cp \/usr\/bin\/gh /],
    ['ln of the binary', /^ln -s \/usr\/bin\/gh /],
    ['python -c', /^python3? -c .*\bgh\b/],
    ['node -e', /^node -e .*\bgh\b/],
    ['perl -e', /^perl -e .*\bgh\b/],
    ['python -c with a path', /^python3? -c .*\/usr\/bin\/gh/],
    ['awk system()', /^awk 'BEGIN \{ system\("gh /],
    ['assignment then $X', /^X=\/usr\/bin\/gh; \$X /],
    ['make variable', /^make GH=/],
    ['git rebase -x', /^git rebase -x .*\bgh\b/],
    ['git submodule foreach', /^git submodule foreach .*\bgh\b/],
    ['npx -c', /^npx -c .*\bgh\b/],
    // the same forms with a path-spelled command: the match follows a `/`, not whitespace (a guard that ignores `gh` after `/` must still block these)
    ['semicolon, path', /^echo a; \/usr\/bin\/gh /],
    ['&&, path', /^echo a && \/usr\/bin\/gh /],
    ['||, path', /^false \|\| \/usr\/bin\/gh /],
    ['pipe, path', /^echo a \| \/usr\/bin\/gh /],
    ['background &, path', /^echo a & \/usr\/bin\/gh /],
    ['newline, path', /^echo a\\n\/usr\/bin\/gh /],
    ['subshell, path', /^\(\/usr\/bin\/gh /],
    ['brace group, path', /^\{ \/usr\/bin\/gh [^;]*; \}$/],
    ['negation, path', /^! \/usr\/bin\/gh /],
    ['if condition, path', /^if \/usr\/bin\/gh [^;]*; then /],
    ['then, path', /^if true; then \/usr\/bin\/gh /],
    ['else, path', /; else \/usr\/bin\/gh /],
    ['while condition, path', /^while \/usr\/bin\/gh [^;]*; do /],
    ['do body, path', /^for i in 1 2; do \/usr\/bin\/gh /],
    ['case body, path', /^case x in x\) \/usr\/bin\/gh /],
    ['then on its own line, path', /\\nthen\\n\s+\/usr\/bin\/gh /],
    ['else on its own line, path', /\\nelse\\n\s+\/usr\/bin\/gh /],
    ['do on its own line, path', /\\ndo\\n\s+\/usr\/bin\/gh /],
    ['case on its own line, path', /\\n\s+a\) \/usr\/bin\/gh /],
    ['time -p, path', /^time -p \/usr\/bin\/gh /],
    ['find -execdir, path', /-execdir \/usr\/bin\/gh /],
    ['find -ok, path', /-ok \/usr\/bin\/gh /],
    ['bash -c, path', /^bash -c '\/usr\/bin\/gh /],
    ['eval, path', /^eval '\/usr\/bin\/gh /],
    ['command substitution, path', /^echo \$\(\/usr\/bin\/gh /],
    ['nested command substitution, path', /^echo \$\(echo \$\(\/usr\/bin\/gh /],
    ['backticks, path', /^echo `\/usr\/bin\/gh /],
    ['process substitution, path', /^cat <\(\/usr\/bin\/gh /],
    ['here-string into a shell, path', /^sh <<< '\/usr\/bin\/gh /],
    ['heredoc into a shell, path', /^sh <<'EOF'\\n\/usr\/bin\/gh /],
    ['data piped into a shell, path', /^echo '\/usr\/bin\/gh pr list' \| sh$/],
    ['source of a process substitution, path', /^source <\(echo '\/usr\/bin\/gh /],
    ['heredoc code body, path', /^python3 - <<'PY'\\n.*\/usr\/bin\/gh /],
    // exec hooks set through `=`
    ['GIT_PAGER=', /^GIT_PAGER=\/usr\/bin\/gh git log$/],
    ['PAGER=', /^PAGER=\/usr\/bin\/gh git log$/],
    ['EDITOR=', /^EDITOR=\/usr\/bin\/gh git commit$/],
    ['GIT_SEQUENCE_EDITOR=', /^GIT_SEQUENCE_EDITOR=\/usr\/bin\/gh git rebase /],
    ['GIT_EXTERNAL_DIFF=', /^GIT_EXTERNAL_DIFF=\/usr\/bin\/gh git diff$/],
    ['git -c core.pager=', /^git -c core\.pager=\/usr\/bin\/gh /],
    ['git -c core.editor=', /^git -c core\.editor=\/usr\/bin\/gh /],
    ['git -c core.fsmonitor=', /^git -c core\.fsmonitor=\/usr\/bin\/gh /],
    ['git -c diff.external=', /^git -c diff\.external=\/usr\/bin\/gh /],
    ['git -c gpg.program=', /^git -c gpg\.program=\/usr\/bin\/gh /],
    ['git difftool --extcmd=', /^git difftool --extcmd=\/usr\/bin\/gh/],
    ['tar --use-compress-program=', /^tar --use-compress-program=\/usr\/bin\/gh /],
    ['make SHELL=', /^make SHELL=\/usr\/bin\/gh/],
    ['SHELL= make', /^SHELL=\/usr\/bin\/gh make$/],
    ['npm --script-shell=', /^npm run x --script-shell=\/usr\/bin\/gh/],
    ['git bisect run, path', /^git bisect run \/usr\/bin\/gh/],
    ['cp of the binary to a relative target', /^cp \/opt\/homebrew\/bin\/gh \.\/x$/],
    // path variants of the wrappers and bodies above (each regex requires `/usr/bin/gh`, so deleting the path probe fails)
    ['env -i, path', /^env -i FOO=1 \/usr\/bin\/gh /],
    ['env -u, path', /^env -u HOME -u PATH \/usr\/bin\/gh /],
    ['command -p, path', /^command -p \/usr\/bin\/gh /],
    ['exec -a, path', /^exec -a x \/usr\/bin\/gh /],
    ['nohup, path', /^nohup \/usr\/bin\/gh /],
    ['nice -n, path', /^nice -n 10 \/usr\/bin\/gh /],
    ['timeout -s, path', /^timeout -s KILL 5 \/usr\/bin\/gh /],
    ['stdbuf, path', /^stdbuf -oL -eL \/usr\/bin\/gh /],
    ['sudo -u, path', /^sudo -u root \/usr\/bin\/gh /],
    ['xargs -I, path', /xargs -I \{\} \/usr\/bin\/gh pr view /],
    ['find -exec, path', /-exec \/usr\/bin\/gh /],
    ['caffeinate, path', /^caffeinate -i \/usr\/bin\/gh /],
    ['arch, path', /^arch -arm64 \/usr\/bin\/gh /],
    ['script, path', /^script -q \/dev\/null \/usr\/bin\/gh /],
    ['sh -c, path', /^sh -c "\/usr\/bin\/gh /],
    ['function body, path', /^g\(\) \{ \/usr\/bin\/gh /],
    ['awk system(), path', /^awk 'BEGIN\{system\("\/usr\/bin\/gh /],
    ['git rebase -x, path', /^git rebase -i -x '\/usr\/bin\/gh /],
    ['git submodule foreach, path', /^git submodule foreach '\/usr\/bin\/gh /],
    ['npx -c, path', /^npx -c '\/usr\/bin\/gh /],
    ['npm_config_script_shell=', /^npm_config_script_shell=gh npm run x$/],
  ];
  it.each(FORMS)('the corpus blocks the %s form', (_name, re) => {
    expect(blocked.some((p) => re.test(p)), String(re)).toBe(true);
  });
  it('blocks each of them today', () => {
    for (const p of blocked.filter((q) => /\bgh\b/.test(q))) expect(decide({ tool: 'shell', input: { command: subst(p).replace(/\\n/g, '\n') }, agent: 'fixer' }, cfg).verdict, p).toBe('block');
  });
});

describe('path and assignment arguments that end in a denied name (#7)', () => {
  const verdict = (command: string, c: GuardConfig = cfg) => decide({ tool: 'shell', input: { command } }, c).verdict;
  // the same under the generic defaults alone and with the workspace-specific inputs (built lazily: `cfg` is set in beforeAll)
  const configs: Array<[string, () => GuardConfig]> = [
    ['workspace-specific inputs', () => cfg],
    ['generic defaults', () => ({ ...cfg, safety: EMPTY_GUARD_SAFETY })],
  ];

  describe.each(configs)('%s', (_name, config) => {
    it.each([
      'ls docs/gh',
      'cat config/ssh',
      'ls infra/docker',
      'ls infra/terraform',
      'ls src/opencode',
      'ls tools/brew',
      'node cli.js --tool=docker',
      'export TMPDIR=/private/var/folders/xx/abcdefghijklmnopqrstuvwxyz0000gn/T/opencode',
      'ls -la /opt/homebrew/bin/gh',
      'cd infra/docker && ls',
      'git log -- docs/gh',
      'git -C tools/brew status',
      'find infra/terraform -name x',
      'grep -r foo src/opencode',
      'ls docs/gh 2>/dev/null',
      'ls docs/gh; ls src/opencode\nls tools/brew',
      'if [ -d docs/gh ]; then ls docs/gh; fi',
      'FOO=/usr/bin/gh ls',
      'python3 x.py --tool=docker',
    ])('allows %j', (command) => {
      expect(verdict(command, config()), command).toBe('allow');
    });

    it.each([
      // the denied command next to the argument, in every spelling
      'ls docs/gh; /usr/bin/gh pr list',
      'ls docs/gh; gh pr list',
      'ls docs/gh && /usr/bin/gh pr list',
      'ls docs/gh | /usr/bin/gh pr list',
      'ls docs/gh\n/usr/bin/gh pr list',
      'ls docs/gh & /usr/bin/gh pr list',
      '(ls docs/gh; /usr/bin/gh pr list)',
      'if ls docs/gh; then /usr/bin/gh pr list; fi',
      // an execution sink on the line
      'ls docs/gh | sh',
      'ls docs/gh | bash -s',
      'ls docs/gh | xargs /usr/bin/gh',
      'ls docs/gh | xargs -I{} /usr/bin/gh {}',
      'find docs/gh -exec /usr/bin/gh {} \\;',
      'find . -execdir /usr/bin/gh {} +',
      'find . -ok /usr/bin/gh {} \\;',
      'X=/usr/bin/gh; $X pr list',
      'X=/usr/bin/gh\n$X pr list',
      'X=docs/gh; ls; ${X} pr list',
      'export TMPDIR=/x/opencode && opencode run x',
      'export TMPDIR=/x/opencode; /usr/local/bin/opencode run x',
      'ls infra/docker; /usr/local/bin/docker ps',
      'cat config/ssh; /usr/bin/ssh host',
      'ls docs/gh <<< x | sh',
      'sh <<< /usr/bin/gh',
      'ls <(/usr/bin/gh pr list)',
      'ls docs/gh `/usr/bin/gh pr list`',
      'ls docs/gh $(/usr/bin/gh pr list)',
      'eval /usr/bin/gh pr list',
      'source /usr/bin/gh',
      '. /usr/bin/gh',
      'awk BEGIN{system(/usr/bin/gh)}',
      'make GH=/usr/bin/gh',
      'npm run x --script-shell=/usr/bin/gh',
      'npx -c /usr/bin/gh',
      'git rebase -x /usr/bin/gh main',
      'git submodule foreach /usr/bin/gh pr list',
      'git bisect run /usr/bin/gh',
      'git -c core.pager=/usr/bin/gh log',
      'git difftool --extcmd=/usr/bin/gh',
      'tar --use-compress-program=/usr/bin/gh -cf x.tar .',
      // exec-hook assignments
      'PAGER=/usr/bin/gh git log',
      'GIT_PAGER=/usr/bin/gh git log',
      'export GIT_PAGER=/usr/bin/gh; git log',
      'export EDITOR=/usr/bin/gh; git commit',
      'VISUAL=/usr/bin/gh git commit',
      'SHELL=/usr/bin/gh make',
      'export npm_config_script_shell=/usr/bin/gh; npm test',
      'export PATH=/x/gh; ls',
      'git log --pager=/usr/bin/gh',
      // wrappers, unknown commands, interpreters
      'sudo /usr/bin/gh pr list',
      'env /usr/bin/gh pr list',
      'command /usr/bin/gh pr list',
      'nohup /usr/bin/gh pr list',
      'setsid /usr/bin/gh pr list',
      'doas /usr/bin/gh pr list',
      'cp /usr/bin/gh x',
      'ln -s /usr/bin/gh x',
      'install /usr/bin/gh x',
      'node /opt/homebrew/bin/codex',
      'node --require=/usr/lib/gh x.js',
      'node x.js --tool=/x/docker',
      'node -e 1 --tool=docker',
      'python3 /usr/bin/gh',
      'python3 -m pty /usr/bin/gh',
      'python3 -c 1 --tool=docker',
      'rg --pre /usr/bin/gh x',
      'git grep -O/usr/bin/gh x',
      'git config core.pager /usr/bin/gh',
      // a script written for a later run, an alias, a function
      'echo /usr/bin/gh pr list > x.sh; chmod +x x.sh; ./x.sh',
      'ls docs/gh > /usr/bin/gh',
      'ls docs/gh >> x.sh',
      'alias g=/usr/bin/gh; g pr list',
      'g() { /usr/bin/gh; }; g',
      // text the relaxation does not read: quotes, expansions, comments
      'ls "docs/gh"',
      "ls 'infra/docker'",
      'ls docs/\\gh',
      'ls $HOME/docs/gh',
      'ls $(echo docs/gh)',
      'ls docs/gh # /usr/bin/gh',
    ])('blocks %j', (command) => {
      expect(verdict(command, config()), command).toBe('block');
    });
  });

  it('keeps blocking the denied command in a heredoc body or an inner string even when the line also has a plain path argument', () => {
    for (const command of [
      "ls docs/gh; sh -c 'ls src/opencode'",
      "ls docs/gh; python3 - <<'PY'\nimport os\nos.system('/usr/bin/gh pr list')\nPY",
      "ls docs/gh; bash <<'EOF'\n/usr/bin/gh pr list\nEOF",
    ]) {
      expect(verdict(command), command).toBe('block');
    }
  });

  it('applies to the main command text only: a denied path inside an inner string is still a command', () => {
    expect(checkShellCommand('sh -c "ls docs/gh"', cfg)).toMatch(/gh is forbidden/);
    expect(checkShellCommand('eval ls docs/gh', cfg)).toMatch(/gh is forbidden/);
    expect(checkShellCommand('ls docs/gh', cfg)).toBeNull();
    expect(checkShellCommand('ls docs/gh', cfg, 1)).toMatch(/gh is forbidden/);
  });
});

describe('secret locations', () => {
  const sh = (command: string, c: GuardConfig = cfg) => decide({ tool: 'shell', input: { command } }, c);

  it('blocks the exact preflight-canary command (cat ~/.config/opencode/opencode.json | head -1)', () => {
    const r = sh('cat ~/.config/opencode/opencode.json | head -1');
    expect(r.verdict).toBe('block');
    expect(checkShellCommand('cat ~/.config/opencode/opencode.json | head -1', cfg)).toMatch(/secret location/);
    // also when the home comes from the process HOME instead of cfg.env
    expect(checkShellCommand('cat ~/.config/opencode/opencode.json | head -1', { ...cfg, env: { HOME: '/Users/someone', TMPDIR: vars.TMP } })).toMatch(/secret location/);
  });
  it('never echoes file contents in the block reason', () => {
    const r = sh('cat ~/.ssh/id_rsa') as { reason: string };
    expect(r.reason.length).toBeLessThan(300);
  });
  it('follows a symlink inside the worktree that points at a secret directory', () => {
    const home = join(base, 'real-home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'x');
    symlinkSync(join(home, '.ssh'), join(vars.WT!, 'sshlink'));
    const c = { ...cfg, env: { HOME: home, TMPDIR: vars.TMP } };
    expect(sh(`cat ${vars.WT}/sshlink/id_rsa`, c).verdict).toBe('block');
    expect(sh('cat sshlink/id_rsa', c).verdict).toBe('block');
    unlinkSync(join(vars.WT!, 'sshlink'));
  });
  it('honours workdir for relative paths', () => {
    const home = join(base, 'home');
    expect(checkShellCommand('cat opencode.json', { ...cfg, workdir: join(home, '.config', 'opencode') })).toMatch(/secret location/);
    expect(checkShellCommand('cat package.json', { ...cfg, workdir: vars.WT })).toBeNull();
  });
  it('rejects oversized brace expansions instead of skipping them', () => {
    expect(checkShellCommand('cat {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}x', cfg)).toMatch(/brace expansion too large/);
  });
  it('plain env with a command, set -e and examples stay allowed; bare env/printenv/export -p/set do not', () => {
    for (const ok of ['env FOO=1 npm test', 'set -e', 'cat .env.example', 'cat .env.defaults']) expect(sh(ok).verdict, ok).toBe('allow');
    for (const bad of ['env', 'printenv', 'export -p', 'set']) expect(sh(bad).verdict, bad).toBe('block');
  });

  it('tool-output stays readable, but a symlink inside it cannot lead to the auth store', () => {
    const out = vars.TOOLOUT!;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'tool_1'), 'x');
    writeFileSync(join(vars.XDG!, 'opencode', 'auth.json'), 'x');
    symlinkSync(join(vars.XDG!, 'opencode', 'auth.json'), join(out, 'tool_link'));
    expect(sh(`cat "${out}/tool_1"`).verdict).toBe('allow');
    expect(sh(`cat "${out}/tool_link"`).verdict).toBe('block');
    expect(decide({ tool: 'read', input: { filePath: join(out, 'tool_1') } }, cfg).verdict).toBe('allow');
    expect(decide({ tool: 'read', input: { filePath: join(out, 'tool_link') } }, cfg).verdict).toBe('block');
    unlinkSync(join(out, 'tool_link'));
  });
  it('without XDG_DATA_HOME nothing below the control dir is exempt', () => {
    const c = { ...cfg, env: { HOME: vars.HOME!, TMPDIR: vars.TMP } };
    expect(sh(`cat "${vars.TOOLOUT}/tool_1"`, c).verdict).toBe('block');
  });

  describe('read / grep / glob tools', () => {
    const tool = (name: string, input: Record<string, unknown>) => decide({ tool: name, input }, cfg).verdict;
    const home = () => vars.HOME!;
    it('blocks secret paths in read.filePath and read.path', () => {
      expect(tool('read', { filePath: `${home()}/.config/opencode/opencode.json` })).toBe('block');
      expect(tool('read', { path: '~/.ssh/id_rsa' })).toBe('block');
      expect(tool('read', { filePath: '~/.config/opencode/opencode.json', offset: 1 })).toBe('block');
      expect(tool('read', { filePath: join(vars.WT!, 'package.json') })).toBe('allow');
    });
    it('blocks grep and glob rooted at, or reaching into, secret locations', () => {
      expect(tool('grep', { pattern: 'sk-', path: '~/.config/opencode' })).toBe('block');
      expect(tool('grep', { pattern: 'sk-', path: '~' })).toBe('block');
      expect(tool('grep', { pattern: 'sk-', path: vars.WT })).toBe('allow');
      expect(tool('grep', { pattern: 'sk-' })).toBe('allow');
      expect(tool('glob', { pattern: '~/.ssh/**' })).toBe('block');
      expect(tool('glob', { pattern: '**/opencode.json', path: '~' })).toBe('block');
      expect(tool('glob', { pattern: '**/*.ts', path: vars.WT })).toBe('allow');
      expect(tool('glob', { pattern: '**/*.ts' })).toBe('allow');
      expect(tool('glob', { pattern: '~/.config/open*/*.json' })).toBe('block');
    });
    it('blocks .env files but not the examples', () => {
      expect(tool('read', { filePath: join(vars.WT!, '.env') })).toBe('block');
      expect(tool('read', { filePath: join(vars.WT!, '.env.example') })).toBe('allow');
      expect(tool('read', { filePath: join(vars.WT!, '.env.defaults') })).toBe('allow');
    });
  });
});

describe('webfetch prompt stripping', () => {
  it('removes prompt and keeps the rest', () => {
    const r = decide({ tool: 'webfetch', input: { url: 'https://x', prompt: 'p', format: 'text' } }, cfg);
    expect(r).toMatchObject({ verdict: 'rewrite', input: { url: 'https://x', format: 'text' } });
    expect((r as { input: Record<string, unknown> }).input).not.toHaveProperty('prompt');
  });
});

describe('stop flags and liveness', () => {
  const read = { tool: 'read', input: { filePath: '/x' } };
  it('allows tools when fresh and no stop', () => {
    expect(decide(read, withFlags(fresh)).verdict).toBe('allow');
  });
  it('hardStop blocks every tool', () => {
    for (const tool of ['read', 'shell', 'edit', 'glob', 'task']) {
      expect(decide({ tool, input: {} }, withFlags({ ...fresh, hardStop: true })).verdict, tool).toBe('block');
    }
  });
  it('a stale heartbeat blocks every tool', () => {
    const stale = { ...fresh, heartbeatTs: NOW - HEARTBEAT_MAX_AGE_MS - 1 };
    expect(decide(read, withFlags(stale)).verdict).toBe('block');
    expect(decide(read, withFlags({ ...fresh, heartbeatTs: NOW - HEARTBEAT_MAX_AGE_MS })).verdict).toBe('allow');
  });
  it('heartbeat 0 (never) blocks', () => {
    expect(decide(read, withFlags({ ...fresh, heartbeatTs: 0 })).verdict).toBe('block');
  });
  it('fails closed on unreadable flags or missing control dir', () => {
    expect(decide(read, withFlags(null)).verdict).toBe('block');
    expect(decide(read, withFlags(fresh, { controlDirSet: false })).verdict).toBe('block');
  });
  it('softStop blocks task/background dispatch but not ordinary work', () => {
    const soft = withFlags({ ...fresh, softStop: true });
    for (const tool of ['task', 'subagent', 'task_revive', 'background_start']) {
      expect(decide({ tool, input: {} }, soft).verdict, tool).toBe('block');
    }
    expect(decide({ tool: 'shell', input: { command: 'ls', background: true } }, soft).verdict).toBe('block');
    expect(decide({ tool: 'shell', input: { command: 'ls' } }, soft).verdict).toBe('allow');
    expect(decide({ tool: 'task_result', input: {} }, soft).verdict).toBe('allow');
    expect(decide({ tool: 'edit', input: { filePath: join(vars.WT!, 'a.ts') } }, soft).verdict).toBe('allow');
  });
  it('softStop still allows dispatch to the oracle (a short final review), and only to the oracle', () => {
    const soft = withFlags({ ...fresh, softStop: true });
    const verdict = (tool: string, input: Record<string, unknown>) => decide({ tool, input }, soft).verdict;
    // the recorded payload shape: { agent, description, prompt, background }
    expect(verdict('task', { agent: 'oracle', description: 'final review', prompt: 'review', background: true })).toBe('allow');
    expect(verdict('task', { agent: 'oracle', description: 'x', prompt: 'y' })).toBe('allow');
    expect(verdict('task', { subagent_type: 'oracle', description: 'x', prompt: 'y' })).toBe('allow');
    expect(verdict('task', { agent: ' @Oracle ' })).toBe('allow');
    expect(verdict('background_start', { agent: 'oracle', prompt: 'y' })).toBe('allow');
    for (const agent of ['fixer', 'explorer', 'librarian', 'designer', 'orchestrator', 'oracle2', 'xoracle', '', 'oracle,fixer']) expect(verdict('task', { agent, prompt: 'x' }), agent).toBe('block');
    // no agent field, or a conflicting second field: blocked
    expect(verdict('task', { description: 'x', prompt: 'y' })).toBe('block');
    expect(verdict('task', { agent: 'oracle', subagent_type: 'fixer' })).toBe('block');
    expect(verdict('task', { agent: ['oracle'] })).toBe('block');
    // continuing an existing session is not a dispatch to a known agent
    for (const tool of ['task_revive', 'task_message', 'task_reply']) expect(verdict(tool, { agent: 'oracle' }), tool).toBe('block');
    // a background shell stays blocked
    expect(decide({ tool: 'shell', input: { command: 'ls', background: true, agent: 'oracle' } }, soft).verdict).toBe('block');
  });
  it('hardStop blocks even an oracle dispatch', () => {
    expect(decide({ tool: 'task', input: { agent: 'oracle' } }, withFlags({ ...fresh, softStop: true, hardStop: true })).verdict).toBe('block');
  });
  it('dispatchTargetsOracle reads agent / subagent_type', () => {
    expect(dispatchTargetsOracle({ agent: 'oracle' })).toBe(true);
    expect(dispatchTargetsOracle({ subagent_type: 'oracle' })).toBe(true);
    expect(dispatchTargetsOracle({})).toBe(false);
    expect(dispatchTargetsOracle({ agent: null })).toBe(false);
  });
  it('without softStop task is allowed', () => {
    expect(decide({ tool: 'task', input: {} }, cfg).verdict).toBe('allow');
  });
});

describe('git invocations', () => {
  it('gitInvocation skips global options to find the subcommand', () => {
    expect(gitInvocation(['status'])).toEqual({ sub: 'status', rest: [] });
    expect(gitInvocation(['-C', 'x', 'stash', 'pop'])).toEqual({ sub: 'stash', rest: ['pop'] });
    expect(gitInvocation(['-c', 'a=b', '--no-pager', '--git-dir', 'g', '--work-tree=w', 'push', 'o'])).toEqual({ sub: 'push', rest: ['o'] });
    expect(gitInvocation(['--git-dir=x', 'fetch'])).toEqual({ sub: 'fetch', rest: [] });
    expect(gitInvocation(['-c', 'alias.s=stash', 's']).sub).toBe('alias-override');
    expect(gitInvocation([]).sub).toBe('');
  });
  it('names the reason: stash and network git get their own messages', () => {
    expect(checkShellCommand('git stash pop', cfg)).toMatch(/git stash is forbidden/);
    expect(checkShellCommand('git -C x fetch origin', cfg)).toBe('git fetch: network git is disabled during runs; the launcher pre-fetched origin');
    expect(checkShellCommand('git pull', cfg)).toMatch(/network git is disabled during runs; the launcher pre-fetched origin/);
    expect(checkShellCommand('git remote update', cfg)).toMatch(/network git is disabled/);
    expect(checkShellCommand('git submodule update --remote', cfg)).toMatch(/network git is disabled/);
    expect(checkShellCommand('git ls-remote origin', cfg)).toMatch(/network git is disabled/);
    expect(checkShellCommand('sh -c "git fetch"', cfg)).toMatch(/network git is disabled/);
  });
  it('paths and branch names that merely contain "push" are not pushes; real pushes still are', () => {
    for (const ok of ['git -C /w/.worktrees/task-1-push-notif/T1 status', 'git checkout feat/push-x', 'git log -- src/push/a.ts', 'ls .worktrees/task-1-push-notif']) expect(checkShellCommand(ok, cfg), ok).toBeNull();
    for (const bad of ['git push', 'git -C /w/.worktrees/task-1-push-notif/T1 push', 'git push origin feat/push-x', 'printf "git push" | sh', 'echo "git push" | bash']) expect(checkShellCommand(bad, cfg), bad).toMatch(/push/);
  });
});

describe('heredocs', () => {
  it('splitHeredocs strips the body of a quoted-delimiter heredoc owned by a data command', () => {
    const r = splitHeredocs("cat >> a.jsonl <<'EOF'\n{\"n\":\"git push\"}\nEOF\necho done");
    expect(r.text).toBe("cat >> a.jsonl <<'EOF'\n\necho done");
    expect(r.bodies).toEqual([{ body: '{"n":"git push"}\n', quoted: true }]);
    expect(splitHeredocs('cat <<"EOF"\nx\nEOF').bodies[0]?.quoted).toBe(true);
    expect(splitHeredocs('cat <<\\EOF\nx\nEOF').bodies[0]?.quoted).toBe(true);
    expect(splitHeredocs('cat <<EOF\nx\nEOF').bodies[0]?.quoted).toBe(false);
  });
  it('<<- strips leading tabs of the terminator only; the delimiter must match exactly otherwise', () => {
    expect(splitHeredocs("cat <<-'EOF'\n\tgit push\n\tEOF\necho ok").bodies).toEqual([{ body: '\tgit push\n', quoted: true }]);
    // ` EOF` and `EOF2` do not terminate a plain heredoc: the later lines are still body
    expect(splitHeredocs("cat <<'EOF'\nx\n EOF\ngit push\nEOF").bodies[0]?.body).toBe('x\n EOF\ngit push\n');
    expect(checkShellCommand("cat <<'EOF'\nx\nEOF2\ngit push\nEOF", cfg)).toBeNull();
    // an unterminated heredoc swallows the rest, as in bash
    expect(splitHeredocs("cat <<'EOF'\ngit push").bodies[0]?.body).toBe('git push');
  });
  it('keeps the body inline (analysed as shell) when a shell/source/xargs/make reads it, or the owner is unknown', () => {
    for (const c of ["bash <<'EOF'\ngit push\nEOF", "sh <<'EOF'\ngit push\nEOF", "cat <<'EOF' | sh\ngit push\nEOF", "cat <<'EOF' | bash -s\ngit push\nEOF", "xargs <<'EOF'\nx\nEOF", "source /dev/stdin <<'EOF'\nx\nEOF", "make -f - <<'EOF'\nx\nEOF", "mytool <<'EOF'\nx\nEOF", "ssh host <<'EOF'\nx\nEOF"]) {
      expect(splitHeredocs(c).bodies, c).toEqual([]);
      expect(splitHeredocs(c).text, c).toBe(c);
    }
    // an UNQUOTED body keeps the old rule: a shell/interpreter anywhere on the command may run it
    for (const c of ["python3 <<EOF\nx\nEOF", "cat <<EOF > s.sh\nx\nEOF\nbash s.sh"]) expect(splitHeredocs(c).bodies, c).toEqual([]);
    expect(checkShellCommand("bash <<'EOF'\ngit push\nEOF", cfg)).toMatch(/push/);
    expect(checkShellCommand("cat <<'EOF' | sh\ngit push\nEOF", cfg)).toMatch(/push/);
  });
  it('a quoted body is data even when a shell/interpreter runs elsewhere on the command; script code gets the textual backstop', () => {
    const w = "cat > s.sh <<'EOF'\nx => y\nEOF\nbash s.sh";
    expect(splitHeredocs(w).bodies).toEqual([{ body: 'x => y\n', quoted: true }]);
    expect(splitHeredocs(w).scanned).toEqual(['x => y\n']);
    expect(splitHeredocs("python3 - <<'PY'\nprint(1)\nPY").bodies).toHaveLength(1);
    expect(splitHeredocs("cat > f <<'EOF'\nx\nEOF").scanned).toEqual([]);
    // what a script would run is still read for the obvious forbidden things
    expect(checkShellCommand("cat > s.sh <<'EOF'\ngit push origin\nEOF\nbash s.sh", cfg)).toMatch(/heredoc body: git push/);
    expect(checkShellCommand("python3 - <<'PY'\nimport subprocess\nsubprocess.run(['git','push'])\nPY", cfg)).toMatch(/heredoc body: git push/);
    expect(checkShellCommand("python3 - <<'PY'\nopen('/Users/x/.ssh/id_rsa')\nPY", cfg)).toMatch(/heredoc body/);
    expect(checkShellCommand("node - <<'JS'\nfetch('http://localhost:54176/api/x')\nJS", cfg)).toMatch(/heredoc body/);
  });
});

describe('heredocs in real multi-line commands (smoke D2)', () => {
  const sh = (command: string) => checkShellCommand(subst(command), cfg);
  const JS_BODY = "import { test } from 'node:test';\nconst f = (a) => a > 1 && a < 5;\ntest('x', () => { assert.strictEqual(`v${f(2)}`, 'true'); });\n";
  it('allows a quoted heredoc after && and ; and newlines, whose body has =>, >, <, backticks, $( and quotes', () => {
    const body = JS_BODY + "const s = \"$(not shell)\" + '`' + `\\``;\nconsole.log(a >> b, c << d);\n";
    for (const cmd of [
      `cd {{WT}} && mkdir -p scripts && cat > test/g.test.js <<'EOF'\n${body}EOF\nCI=1 node --test test/g.test.js`,
      `cd {{WT}}; cat > test/g.test.js <<'EOF'\n${body}EOF`,
      `cd {{WT}}\ncat > test/g.test.js <<'EOF'\n${body}EOF\nnpm test`,
      `cat > {{WT}}/a.js <<"EOF"\n${body}EOF\nnode {{WT}}/a.js`,
      `cat > {{WT}}/a.js <<\\EOF\n${body}EOF\nnode {{WT}}/a.js`,
      `cd {{WT}} && cat >> a.txt <<-'EOF'\n\t${body.replace(/\n/g, '\n\t')}\tEOF\nnode a.js`,
    ]) expect(sh(cmd), cmd).toBeNull();
  });
  it('allows several heredocs in one command, in any order, followed by a node/npm run', () => {
    const cmd = `cd {{WT}} && mkdir scripts && cat > test/a.test.js <<'EOF'\n${JS_BODY}EOF\nCI=1 node --test test/a.test.js >/dev/null 2>&1; echo red $?\nprintf "console.log('hi');\\n" > scripts/a.js\ncat > package.json <<'EOF'\n{ "scripts": { "test": "node --test", "lint": "node -e \\"process.exit(0)\\"" } }\nEOF\ncat > b.js <<'B' && cat > c.js <<'C'\nconst b = () => 1;\nB\nconst c = () => \`\${1}\`;\nC\nCI=1 npm test\ntest "$(node scripts/a.js)" = "hi"; echo d $?\ngit add package.json && git commit -q -m "feat: Add a"; echo commit $?`;
    expect(sh(cmd)).toBeNull();
  });
  it('allows python3 - / node - heredocs after cd &&, with $(, backticks and quotes in the body', () => {
    const py = "p='PLAN.md'\ns=open(p).read()\nrep=[(\"`git diff` x\", \"`test \\\"$(git diff --name-only | sort | tr '\\\\n' ' ')\\\"`\")]\nfor a,b in rep: s=s.replace(a,b)\nopen(p,'w').write(s)\nprint(a > /etc/b, mkdir /etc/z)\n";
    expect(sh(`cd {{SPEC}} && python3 - <<'PY'\n${py}PY`)).toBeNull();
    expect(sh(`cd {{SPEC}} && python3 - <<'PY'\n${py}PY\ngit diff --stat`)).toBeNull();
    expect(sh(`cd {{WT}} && node - <<'JS'\nconst f = (x) => x > 1; console.log(\`\${f(2)}\`);\nJS`)).toBeNull();
    expect(sh(`cd {{WT}} && env FOO=1 python3 -u - <<'PY'\nprint(1 > 0)\nPY`)).toBeNull();
    expect(sh(`python3 <<'PY'\nprint(1 > 0)\nPY`)).toBeNull();
  });
  it('allows run logging: date first, a "$(...)" before the heredoc, JSON body with a backtick, text after the delimiter', () => {
    const json = '{"ts":"2026-10-21T17:50:00Z","id":"greet","summary":"run `npm test` and $(date) => /etc/ok","verify":[{"cmd":"test \\"$(node a.js)\\" = \\"hello\\"","exit":0}]}\n';
    for (const cmd of [
      `cd {{SPEC}}; date -u +%Y-%m-%dT%H:%M:%SZ\ncat >> .run/tasks.jsonl <<'EOF'\n${json}EOF\ntail -1 .run/tasks.jsonl`,
      `cd {{SPEC}} && echo "now: $(date -u)" && cat >> .run/tasks.jsonl <<'EOF'\n${json}EOF`,
      `cd {{SPEC}}\necho \`date\`\ncat >> .run/decisions.jsonl <<'EOF'\n${json}EOF\nnode -e "for(const f of ['decisions.jsonl','tasks.jsonl'])require('fs').readFileSync('.run/'+f,'utf8').trim().split('\\n').forEach(l=>JSON.parse(l))"`,
      `cat >> {{SPEC}}/.run/decisions.jsonl <<'EOF' && echo logged\n${json}EOF`,
      `cat >> {{SPEC}}/.run/decisions.jsonl <<'EOF'; echo logged\n${json}EOF`,
      `cat >> {{SPEC}}/.run/decisions.jsonl <<'EOF' # note\n${json}EOF`,
      `cat <<'EOF' | tee -a {{SPEC}}/.run/decisions.jsonl\n${json}EOF`,
      `cat >> {{SPEC}}/.run/decisions.jsonl <<'EOF'\n${json}EOF\ncat >> {{SPEC}}/.run/tasks.jsonl <<'EOF'\n${json}`, // second one unterminated (truncated)
      `if true; then cat >> {{SPEC}}/.run/tasks.jsonl <<'EOF'\n${json}EOF\nfi`,
      `git -C {{WT}} commit -q -F - <<'EOF'\nfeat: x => y\n\nbody with \`tick\` and $(subst)\nEOF`,
    ]) expect(sh(cmd), cmd).toBeNull();
  });
  it('the redirect target of a data heredoc is still checked against the allowlist', () => {
    const w = 'x => `y` $(z)\n';
    expect(sh(`cat > {{OUT}}/x <<'EOF'\n${w}EOF\nnode a.js`)).toMatch(/outside allowlist/);
    expect(sh(`cd {{WT}} && cat > ../../../outside/x <<'EOF'\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cd {{SPEC}} && cat >> .run/RUN.json <<'EOF'\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cd {{SPEC}} && cat >> .run/cost.jsonl <<'EOF'\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cat >> {{SPEC}}/SPEC.md <<'EOF'\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cat > {{WT}}/ok.js <<'EOF'\n${w}EOF\ncat > {{OUT}}/x <<'EOF'\nb\nEOF`)).toMatch(/outside allowlist/);
    expect(sh(`cat > {{WT}}/ok.js <<'A' && cat > {{OUT}}/x <<'B'\na\nA\nb\nB`)).toMatch(/outside allowlist/);
    expect(sh(`tee {{OUT}}/x <<'EOF'\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cat <<'EOF' > {{OUT}}/x\n${w}EOF`)).toMatch(/outside allowlist/);
    expect(sh(`cat <<'EOF' | tee {{OUT}}/x\n${w}EOF`)).toMatch(/outside allowlist/);
  });
  it('commands around a data heredoc are still checked, before and after, whatever the body holds', () => {
    const w = 'x => `y` $(z)\n';
    for (const [cmd, re] of [
      [`git push\ncat > {{WT}}/a <<'EOF'\n${w}EOF`, /push/],
      [`cd {{WT}} && cat > a <<'EOF'\n${w}EOF\ngit push origin HEAD`, /push/],
      [`cat > {{WT}}/a <<'EOF'\n${w}EOF\ncat ~/.ssh/id_rsa`, /secret location/],
      [`cat > {{WT}}/a <<'EOF'\n${w}EOF\nrm -rf {{OUT}}/x`, /outside allowlist/],
      [`cat > {{WT}}/a <<'EOF' && gh pr list\n${w}EOF`, /gh/],
      [`cat > {{WT}}/a <<'EOF'\nlook in ~/.config/opencode\nEOF`, /heredoc body/],
      [`python3 - <<'PY'\nprint(1)\nPY\ngit stash`, /stash/],
      [`echo "$(date)"\ncat > {{WT}}/a <<'EOF'\n${w}EOF\ngit push`, /push/],
    ] as Array<[string, RegExp]>) expect(sh(cmd), cmd).toMatch(re);
  });
  it('scanner: heredocs resolved before an unscannable region still count; later ones stay inline', () => {
    const early = "cat > {{WT}}/a <<'EOF'\nx => y\nEOF\n";
    expect(splitHeredocs(subst(early) + 'let x=1 <<EOF\ngit push\nEOF').bodies).toHaveLength(1);
    expect(checkShellCommand(subst(early) + 'let x=1 <<EOF\ngit push\nEOF', cfg)).toMatch(/push/);
    // "$(...)" and `...` in double quotes / at top level no longer stop the scan
    expect(splitHeredocs('echo "a $(date) `date`" `date` $(date)\ncat <<\'EOF\'\nx => y\nEOF').bodies).toHaveLength(1);
    expect(splitHeredocs('[[ -f a ]] && cat <<\'EOF\'\nx => y\nEOF').bodies).toHaveLength(1);
    // but a heredoc INSIDE a substitution is never classified
    expect(splitHeredocs('echo "$(cat <<\'EOF\'\nx\nEOF\n)"').bodies).toEqual([]);
  });
  it('gives up (nothing stripped) where it cannot tell whether bash sees a heredoc', () => {
    for (const c of ['echo $((1 <<EOF))\ngit push\nEOF', 'echo ${x:1 <<EOF}\ngit push\nEOF', 'let x=1 <<EOF\ngit push\nEOF', 'cat<<EOF\nx\nEOF', 'echo `cat <<EOF\nx\nEOF`', 'echo "$(cat <<EOF\nx\nEOF\n)"']) {
      expect(splitHeredocs(c).bodies, c).toEqual([]);
    }
    expect(checkShellCommand('echo $((1 <<EOF))\ngit push\nEOF', cfg)).toMatch(/push/);
    expect(checkShellCommand('echo hi # <<EOF\ngit push\nEOF', cfg)).toMatch(/push/);
    expect(checkShellCommand('echo "<<EOF"\ngit push\nEOF', cfg)).toMatch(/push/);
  });
  it('commands after the terminator are still checked', () => {
    expect(checkShellCommand("cat <<'EOF'\nhello\nEOF\ngit push", cfg)).toMatch(/push/);
    expect(checkShellCommand("cat <<'A' <<'B'\nx\nA\ny\nB\ncat ~/.ssh/id_rsa", cfg)).toMatch(/secret location/);
  });
  it('an unquoted body is data only without `$(` and backticks; otherwise the whole body is checked as shell', () => {
    expect(checkShellCommand('cat <<EOF\nplain git push text\nEOF', cfg)).toBeNull();
    expect(splitHeredocs('cat <<EOF\nhello $HOME ${x:-y}\nEOF').bodies).toHaveLength(1);
    expect(splitHeredocs('cat <<EOF\nx $(date) y\nEOF').bodies).toEqual([]);
    expect(splitHeredocs('cat <<EOF\nx `date` y\nEOF').bodies).toEqual([]);
    expect(checkShellCommand('cat <<EOF\n$(git push)\nEOF', cfg)).toMatch(/push/);
    expect(checkShellCommand('cat <<EOF\nx ${a:-$(git stash)} y\nEOF', cfg)).toMatch(/stash/);
    // quotes and `case` patterns inside a substitution are not parsed: the whole body is inspected instead
    expect(checkShellCommand("cat <<EOF\n$(echo ')' ; git push)\nEOF", cfg)).toMatch(/push/);
    expect(checkShellCommand('cat <<EOF\n$(case a in a) git push;; esac)\nEOF', cfg)).toMatch(/push/);
    // quoted: $(...) is literal text
    expect(checkShellCommand("cat <<'EOF'\n$(git push)\nEOF", cfg)).toBeNull();
  });
  it('package managers: only the subcommand position counts, not script arguments', () => {
    for (const ok of ['npm run e2e -- --grep login', 'npm test -- --grep publish', 'pnpm exec playwright test --grep login', 'yarn run e2e login', 'npx playwright test --grep publish', 'npm run publish-docs -- login'])
      expect(checkShellCommand(ok, cfg), ok).toBeNull();
    for (const bad of ['yarn workspace ui publish', 'pnpm --filter ui publish', 'npm -w pkg publish', 'npm --prefix x login', 'npm --prefix run publish', 'npm publish -- --tag x'])
      expect(checkShellCommand(bad, cfg), bad).toMatch(/forbidden/);
  });
  it('a data body that names a secret location is still refused', () => {
    expect(checkShellCommand("cat <<'EOF'\ncat ~/.config/opencode/opencode.json\nEOF", cfg)).toMatch(/heredoc body: references a secret location/);
    expect(checkShellCommand("cat <<'EOF'\nlook in ~/.ssh\nEOF", cfg)).toMatch(/heredoc body/);
    expect(checkShellCommand("cat <<'EOF'\nnotes about the build\nEOF", cfg)).toBeNull();
  });
});

describe('tmp dir outside the control dir (<os.tmpdir()>/nightgem-<slug>)', () => {
  let c: GuardConfig;
  let tmp: string;
  let control: string;
  beforeAll(() => {
    tmp = join(base, 'T', 'nightgem-my-run');
    control = join(vars.HOME!, 'Library', 'Application Support', 'nightgem', 'my-run');
    mkdirSync(tmp, { recursive: true });
    mkdirSync(control, { recursive: true });
    writeFileSync(join(tmp, 'msg'), 'x');
    writeFileSync(join(control, 'password'), 'x');
    c = { ...cfg, allowedRoots: [join(base, 'work', '*', '.worktrees', 'my-run'), vars.SPEC!, tmp], env: { ...cfg.env, TMPDIR: tmp } };
  });
  const sh = (command: string, conf?: GuardConfig) => decide({ tool: 'shell', input: { command } }, conf ?? c).verdict;
  it('allows redirects, git commit -F and reads of files in the tmp dir (literal and via $TMPDIR)', () => {
    expect(sh('echo x > $TMPDIR/x')).toBe('allow');
    expect(sh('echo x > "$TMPDIR/x y"')).toBe('allow');
    expect(sh(`echo x > ${tmp}/x`)).toBe('allow');
    expect(sh('git commit -F $TMPDIR/msg')).toBe('allow');
    expect(sh(`git commit -F ${tmp}/msg`)).toBe('allow');
    expect(sh('cat $TMPDIR/msg')).toBe('allow');
    expect(sh(`cat > ${tmp}/m <<'EOF'\nnote\nEOF`)).toBe('allow');
    expect(decide({ tool: 'read', input: { filePath: join(tmp, 'msg') } }, c).verdict).toBe('allow');
    expect(decide({ tool: 'grep', input: { pattern: 'x', path: tmp } }, c).verdict).toBe('allow');
    expect(decide({ tool: 'glob', input: { pattern: `${tmp}/*` } }, c).verdict).toBe('allow');
    expect(decide({ tool: 'write', input: { filePath: join(tmp, 'new.txt') } }, c).verdict).toBe('allow');
  });
  it('the allowlist comes from the configured roots: without the tmp root the same writes are refused', () => {
    const noTmp = { ...c, allowedRoots: [join(base, 'work', '*', '.worktrees', 'my-run'), vars.SPEC!] };
    expect(sh('echo x > $TMPDIR/x', noTmp)).toBe('block');
    expect(sh(`echo x > ${tmp}/x`, noTmp)).toBe('block');
    expect(decide({ tool: 'write', input: { filePath: join(tmp, 'new.txt') } }, noTmp).verdict).toBe('block');
  });
  it('the control dir stays a secret root, even next to a tmp dir that carries the same product name', () => {
    expect(sh(`cat "${control}/password"`)).toBe('block');
    expect(sh(`echo x > "${control}/x"`)).toBe('block');
    expect(sh(`cp ${tmp}/msg "${control}/control.json"`)).toBe('block');
    expect(decide({ tool: 'read', input: { filePath: join(control, 'password') } }, c).verdict).toBe('block');
    expect(decide({ tool: 'grep', input: { pattern: 'x', path: control } }, c).verdict).toBe('block');
    expect(decide({ tool: 'write', input: { filePath: join(control, 'x') } }, c).verdict).toBe('block');
  });
});

describe('.run dir protection', () => {
  const edit = (name: string, c: GuardConfig) => decide({ tool: 'write', input: { filePath: join(vars.SPEC!, '.run', name) } }, c).verdict;
  it('by default agents may write only tasks.jsonl, decisions.jsonl and run-complete.json', () => {
    expect([...DEFAULT_RUN_WRITABLE]).toEqual(['tasks.jsonl', 'decisions.jsonl', 'run-complete.json']);
    for (const n of DEFAULT_RUN_WRITABLE) expect(edit(n, cfg), n).toBe('allow');
  });
  it('denies RUN.json, cost.jsonl, events.jsonl, orchestrator.log, opencode.json, .opencode/** and anything else', () => {
    for (const n of ['RUN.json', 'cost.jsonl', 'events.jsonl', 'orchestrator.log', 'opencode.json', '.opencode/oh-my-opencode-slim.jsonc', '.opencode/oh-my-opencode-slim/fixer_append.md', 'other.txt', 'x/y.txt', 'tasks.jsonl.bak', 'tasks.jsonl/../RUN.json'])
      expect(edit(n, cfg), n).toBe('block');
  });
  it('also guards shell redirects, tee and mutators on both sides', () => {
    const sh = (command: string) => decide({ tool: 'shell', input: { command } }, cfg).verdict;
    const run = join(vars.SPEC!, '.run');
    expect(sh(`echo x >> ${run}/tasks.jsonl`)).toBe('allow');
    expect(sh(`echo x | tee -a ${run}/decisions.jsonl`)).toBe('allow');
    expect(sh(`echo x > ${run}/run-complete.json`)).toBe('allow');
    expect(sh(`echo x >> ${run}/cost.jsonl`)).toBe('block');
    expect(sh(`echo x > ${run}/RUN.json`)).toBe('block');
    expect(sh(`rm ${run}/events.jsonl`)).toBe('block');
    expect(sh(`cp a ${run}/orchestrator.log`)).toBe('block');
  });
  it('SPEC.md stays denied while the other spec-dir markdown files stay writable', () => {
    const spec = (n: string) => decide({ tool: 'edit', input: { filePath: join(vars.SPEC!, n) } }, cfg).verdict;
    expect(spec('SPEC.md')).toBe('block');
    for (const n of ['PLAN.md', 'STATUS.md', 'DECISIONS.md', 'REPORT.md', 'FINAL_REVIEW.md']) expect(spec(n), n).toBe('allow');
  });
  it('an explicit list narrows or closes the dir; RUN.json/opencode.json can never be listed in', () => {
    expect(edit('decisions.jsonl', { ...cfg, runWritable: ['tasks.jsonl'] })).toBe('block');
    expect(edit('tasks.jsonl', { ...cfg, runWritable: [] })).toBe('block');
    const c = { ...cfg, runWritable: ['RUN.json', 'opencode.json'] };
    expect(edit('RUN.json', c)).toBe('block');
    expect(edit('opencode.json', c)).toBe('block');
  });
  it('isAllowedWritePath honours the runWritable list', () => {
    expect(isAllowedWritePath('/h/.specs/s/.run/tasks.jsonl', ['/h/.specs/s'])).toBe(true);
    expect(isAllowedWritePath('/h/.specs/s/.run/cost.jsonl', ['/h/.specs/s'])).toBe(false);
    expect(isAllowedWritePath('/h/.specs/s/.run/cost.jsonl', ['/h/.specs/s'], ['cost.jsonl'])).toBe(true);
  });
});

describe('write roots', () => {
  it('matches globbed roots per segment', () => {
    const re = rootToRegExp('/h/*/.worktrees/s');
    expect(re.test('/h/repo/.worktrees/s/T1/a.ts')).toBe(true);
    expect(re.test('/h/repo/.worktrees/s')).toBe(true);
    expect(re.test('/h/repo/.worktrees/other/a')).toBe(false);
    expect(re.test('/h/a/b/.worktrees/s/x')).toBe(false);
    expect(re.test('/h/repo/.worktrees/s-evil/x')).toBe(false);
  });
  it('allows safe devices and rejects protected files inside roots', () => {
    expect(isAllowedWritePath('/dev/null', [])).toBe(true);
    expect(isAllowedWritePath('/dev/fd/3', [])).toBe(true);
    expect(isAllowedWritePath('/r/SPEC.md', ['/r'])).toBe(false);
    expect(isAllowedWritePath('/r/a.md', ['/r'])).toBe(true);
  });
  it('blocks every write when no roots are configured', () => {
    expect(checkShellCommand('echo hi > x.txt', { ...cfg, allowedRoots: [] })).toMatch(/no allowed write roots/);
  });
});

describe('plugin entry', () => {
  it('registers an execute.before hook that throws on a blocked call and rewrites webfetch', async () => {
    const dir = mkdtempSync(join(base, 'ctl-'));
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ softStop: false, hardStop: false, heartbeatTs: Date.now() }));
    const saved = { ...process.env };
    process.env.NIGHTGEM_CONTROL_DIR = dir;
    process.env.NIGHTGEM_ALLOWED_WRITE_ROOTS = vars.TMP!;
    process.env.NIGHTGEM_RUN_PORT = PORT;
    process.env.NIGHTGEM_SAFETY = JSON.stringify(EMPTY_GUARD_SAFETY);
    try {
      let hook: ((e: Record<string, unknown>) => Promise<void>) | undefined;
      await guard.setup({
        tool: {
          hook: async (name: string, fn: (e: Record<string, unknown>) => Promise<void>) => {
            expect(name).toBe('execute.before');
            hook = fn;
          },
        },
      });
      expect(guard.id).toBe(GUARD_PACKAGE);
      await expect(hook!({ tool: 'shell', input: { command: 'git push' } })).rejects.toThrow(GUARD_PREFIX);
      await expect(hook!({ tool: 'shell', input: { command: 'ls' } })).resolves.toBeUndefined();
      await expect(hook!({ tool: 'shell', input: { command: 'git stash' } })).rejects.toThrow(/git stash is forbidden/);
      await expect(hook!({ tool: 'shell', input: { command: 'git fetch origin' } })).rejects.toThrow(/network git is disabled during runs; the launcher pre-fetched origin/);
      await expect(hook!({ tool: 'shell', input: { command: 'acli jira workitem view JIRA-1' } })).rejects.toThrow(GUARD_PREFIX);
      await expect(hook!({ tool: 'shell', input: { command: 'cat ~/.config/opencode/opencode.json | head -1' } })).rejects.toThrow(GUARD_PREFIX);
      await expect(hook!({ tool: 'read', input: { filePath: '~/.ssh/id_rsa' } })).rejects.toThrow(GUARD_PREFIX);
      const ev: Record<string, unknown> = { tool: 'webfetch', input: { url: 'https://x', prompt: 'p' } };
      await hook!(ev);
      expect(ev.input).toEqual({ url: 'https://x' });
      writeFileSync(join(dir, 'control.json'), JSON.stringify({ hardStop: true, heartbeatTs: Date.now() }));
      await expect(hook!({ tool: 'read', input: {} })).rejects.toThrow(/hard stop/);
      rmSync(join(dir, 'control.json'));
      await expect(hook!({ tool: 'read', input: {} })).rejects.toThrow(/unreadable/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke run D2: 13 real, legitimate tool calls that the guard / profile refused (fixture extracted from events.jsonl)
// ---------------------------------------------------------------------------
interface SmokeEntry {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  error: string;
  session: string;
  expect: 'allow' | 'deny';
  group: string;
  denyBy?: string;
  note?: string;
}

describe('smoke D2 replay: guard decide() with the real plugin config', () => {
  const fixtureText = readFileSync(new URL('./fixtures/profile/smoke-d2-blocked.json', import.meta.url), 'utf8');
  const entries = JSON.parse(fixtureText) as SmokeEntry[];
  // the recorded run's own workspace (taken from the fixture, whose paths are scrubbed separately)
  const WORKSPACE = /"(\/[^"]*?)\/\.specs\//.exec(fixtureText)![1]!;
  const REAL_HOME = WORKSPACE.slice(0, WORKSPACE.lastIndexOf('/'));
  const SLUG = 'ng-smoke-d';
  const realCfg = (): GuardConfig => {
    const env = buildGuardEnv({ slug: SLUG, workspaceRoot: WORKSPACE, controlDir: '/c', tmpDir: `/tmp/nightgem-${SLUG}`, safety: corpusSafety(WORKSPACE, REAL_HOME) });
    return {
      flags: fresh,
      controlDirSet: true,
      allowedRoots: env.NIGHTGEM_ALLOWED_WRITE_ROOTS!.split(':'),
      runWritable: env.NIGHTGEM_RUN_WRITABLE!.split(':'),
      now: NOW,
      cwd: `${WORKSPACE}/.specs/${SLUG}/.run`,
      runPort: '54176',
      env: { HOME: REAL_HOME, TMPDIR: `/tmp/nightgem-${SLUG}` },
    };
  };

  it('the fixture holds all 13 blocked calls', () => {
    expect(entries).toHaveLength(13);
  });
  for (const e of JSON.parse(readFileSync(new URL('./fixtures/profile/smoke-d2-blocked.json', import.meta.url), 'utf8')) as SmokeEntry[]) {
    if (e.expect !== 'allow') continue;
    it(`#${e.index} ${e.tool} (${e.group}) is allowed`, () => {
      const r = decide({ tool: e.tool, input: e.input }, realCfg());
      expect(r, JSON.stringify(r)).toEqual({ verdict: 'allow' });
    });
  }
});

const STANDALONE_MARKER = '# ---- standalone: generic defaults ----';

describe('standalone section: holds for the generic defaults, the workspace-specific inputs and the skills carve-out', () => {
  const section = loadCorpus().filter((l) => l.raw !== '');
  const text = readFileSync(new URL('./fixtures/profile/guard-corpus.txt', import.meta.url), 'utf8');
  const standalone = new Set(text.slice(text.indexOf(STANDALONE_MARKER)).split('\n').filter((l) => /^(allow|block|rewrite)\|/.test(l)));
  const lines = section.filter((l) => standalone.has(l.raw));
  const skills = (home: string) => join(home, '.config', 'opencode', 'skills');
  const configs: Array<[string, () => GuardConfig]> = [
    ['generic defaults', () => ({ ...cfg, safety: EMPTY_GUARD_SAFETY })],
    ['workspace-specific inputs', () => cfg],
    ['skills carve-out active', () => ({ ...cfg, safety: guardSafety(vars.HOME!, [skills(vars.HOME!)]) })],
    ['carve-out + generic deny lists', () => ({ ...cfg, safety: { skillRoots: [skills(vars.HOME!)], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } } })],
  ];

  it('has a section with both verdicts', () => {
    expect(lines.length).toBeGreaterThan(50);
    expect(new Set(lines.map((l) => l.expected))).toEqual(new Set(['allow', 'block']));
  });
  for (const [name, mk] of configs) {
    for (const line of lines) {
      it(`[${name}] ${line.expected.padEnd(5)} ${line.tool}: ${line.payload.slice(0, 80)}`, () => {
        const result = decide({ tool: line.tool, input: inputFor(line), agent: 'fixer' }, mk());
        expect(result.verdict, JSON.stringify(result)).toBe(line.expected);
      });
    }
  }
});

describe('skills carve-out (AD6): read/grep/glob only, exactly ~/.config/opencode/skills', () => {
  let home: string;
  let skillsDir: string;
  let c: GuardConfig;
  const rd = (tool: string, p: string, conf: GuardConfig = c) => decide({ tool, input: tool === 'glob' ? { pattern: p } : { filePath: p } }, conf).verdict;

  beforeAll(() => {
    home = join(base, 'carve-home');
    skillsDir = join(home, '.config', 'opencode', 'skills');
    mkdirSync(join(skillsDir, 'x'), { recursive: true });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(skillsDir, 'x', 'SKILL.md'), '# x');
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{}');
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'k');
    symlinkSync(join(base, 'outside'), join(skillsDir, 'linkout'));
    symlinkSync(join(home, '.ssh'), join(skillsDir, 'linkssh'));
    symlinkSync(join(home, '.config', 'opencode', 'opencode.json'), join(skillsDir, 'linkcfg'));
    c = { ...cfg, safety: { skillRoots: [skillsDir], deny: { commands: [], shellPatterns: [], secretPaths: [], editPaths: [] } }, env: { HOME: home, TMPDIR: vars.TMP } };
  });

  it('allows reading the skills subtree with the read, grep and glob tools, in every spelling of the home', () => {
    for (const p of [`${skillsDir}/x/SKILL.md`, '~/.config/opencode/skills/x/SKILL.md', '$HOME/.config/opencode/skills/x/SKILL.md', '${HOME}/.config/opencode/skills/x/SKILL.md', skillsDir]) {
      for (const tool of ['read', 'grep']) expect(rd(tool, p), `${tool} ${p}`).toBe('allow');
    }
    expect(rd('glob', `${skillsDir}/**/SKILL.md`)).toBe('allow');
    expect(rd('glob', `${skillsDir}/*/SKILL.md`)).toBe('allow');
  });
  it('without the skills dir among the skill roots nothing is carved out', () => {
    for (const conf of [{ ...c, safety: EMPTY_GUARD_SAFETY }, { ...c, safety: { skillRoots: [join(home, '.agents', 'skills')], deny: c.safety!.deny } }]) {
      expect(rd('read', `${skillsDir}/x/SKILL.md`, conf)).toBe('block');
    }
  });
  it('keeps the rest of the config dir blocked: opencode.json, service.json, siblings, parents, traversal', () => {
    const cfgDir = join(home, '.config', 'opencode');
    for (const p of [`${cfgDir}/opencode.json`, `${cfgDir}/service.json`, `${cfgDir}/skills/../opencode.json`, `${cfgDir}/skills/x/../../opencode.json`, `${cfgDir}/skills-evil/x`, cfgDir, `${cfgDir}/*`, `${cfgDir}/skills/..*/opencode.json`, `${cfgDir}/skills/*/../../opencode.json`]) {
      for (const tool of ['read', 'grep', 'glob']) expect(rd(tool, p), `${tool} ${p}`).toBe('block');
    }
  });
  it('judges a symlink inside the skills dir by its target', () => {
    expect(rd('read', `${skillsDir}/linkout/f.txt`)).toBe('allow');
    expect(rd('read', `${skillsDir}/linkssh/id_rsa`)).toBe('block');
    expect(rd('read', `${skillsDir}/linkcfg`)).toBe('block');
  });
  it('shell commands that mention the subtree stay blocked (documented: the carve-out is for the tools)', () => {
    for (const cmd of [`cat ${skillsDir}/x/SKILL.md`, 'cat ~/.config/opencode/skills/x/SKILL.md', `ls ${skillsDir}`, `cat ${skillsDir}/../opencode.json`]) {
      expect(decide({ tool: 'shell', input: { command: cmd } }, c).verdict, cmd).toBe('block');
    }
  });
  it('a skills dir that is a symlink: its realpath in skillRoots enables the carve-out for the lexical path', () => {
    const h = join(base, 'carve-home2');
    const real = join(base, 'dotfiles-skills');
    mkdirSync(join(h, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(real, 'y'), { recursive: true });
    writeFileSync(join(real, 'y', 'SKILL.md'), '# y');
    symlinkSync(real, join(h, '.config', 'opencode', 'skills'));
    const conf: GuardConfig = { ...c, safety: { skillRoots: [real], deny: c.safety!.deny }, env: { HOME: h, TMPDIR: vars.TMP } };
    expect(rd('read', join(h, '.config', 'opencode', 'skills', 'y', 'SKILL.md'), conf)).toBe('allow');
    expect(rd('read', join(h, '.config', 'opencode', 'opencode.json'), conf)).toBe('block');
  });
});

describe('no safety in the guard config (hand-built configs only)', () => {
  it('means the generic defaults and nothing else; buildGuardEnv always sets NIGHTGEM_SAFETY', () => {
    const bare: GuardConfig = { ...cfg, safety: undefined };
    expect(decide({ tool: 'shell', input: { command: 'glab mr list' } }, bare).verdict).toBe('block');
    expect(decide({ tool: 'edit', input: { filePath: `${vars.WT}/api-spec.yaml` } }, bare).verdict).toBe('allow');
    expect(configFromEnv({ NIGHTGEM_CONTROL_DIR: '/c' }).safety).toBeUndefined();
    const env = buildGuardEnv({ slug: 'my-run', workspaceRoot: '/Users/alice/work', controlDir: '/c', tmpDir: '/tmp/t', safety: corpusSafety('/Users/alice/work', '/Users/alice') });
    expect(env.NIGHTGEM_SAFETY).toBeDefined();
  });
});

describe('skills carve-out: the guard applies the same overlap rule as the profile (parity)', () => {
  const home = '/Users/alice';
  const skills = `${home}/.config/opencode/skills`;
  const mkSafety = (skillRoots: string[], secretPaths: string[]) => ({ workspaceRoot: '/Users/alice/work', skillRoots, disabledSkills: [] as string[], deny: { commands: [], shellPatterns: [], secretPaths, editPaths: [] } });
  const cases: Array<[string, string[], string[]]> = [
    ['plain', [skills], []],
    ['secret path = the skills dir', [skills], ['.config/opencode/skills']],
    ['secret path inside the skills dir', [skills], ['.config/opencode/skills/private']],
    ['unrelated secret path', [skills], ['.corp/token']],
    ['root below the skills dir', [`${skills}/team`], []],
    ['root = $HOME', [home], []],
    ['root = /', ['/'], []],
    ['root = an ancestor (~/.config)', [`${home}/.config`], []],
    ['root inside another secret dir', [`${home}/.ssh/skills`], []],
    ['relative / traversal roots', ['skills', `${skills}/../..`], []],
  ];
  const probes = [`${skills}/x/SKILL.md`, `${skills}/private/x`, `${skills}/team/x`, `${skills}`, `${home}/.config/opencode/opencode.json`, `${home}/.ssh/skills/x`, `${home}/.config/other`];
  for (const [name, roots, secrets] of cases) {
    it(`read verdicts agree with the rendered profile: ${name}`, () => {
      const safety = mkSafety(roots, secrets);
      const perms = renderRunConfig({ slug: 'my-run', home, workspaceRoot: '/Users/alice/work', runDir: '/r', controlDir: '/c', tmpDir: '/tmp/t', model: 'a/b', smallModel: 'a/c', guardDir: '/g', safety }).configContent.permissions;
      const env = buildGuardEnv({ slug: 'my-run', workspaceRoot: '/Users/alice/work', controlDir: '/c', tmpDir: '/tmp/t', safety });
      const g: GuardConfig = { ...cfg, ...configFromEnv(env), flags: fresh, now: NOW, env: { HOME: home, TMPDIR: '/tmp/t' } };
      for (const p of probes) {
        const profileVerdict = evaluate(perms as never, 'read', p) === 'deny' ? 'block' : 'allow';
        const guardVerdict = decide({ tool: 'read', input: { filePath: p } }, g).verdict;
        expect(guardVerdict, `${p} (profile ${profileVerdict})`).toBe(profileVerdict);
      }
    });
  }
});

describe('safety inputs in the guard config', () => {
  const sh = (command: string, conf: GuardConfig) => decide({ tool: 'shell', input: { command } }, conf);
  const wr = (tool: string, filePath: string, conf: GuardConfig) => decide({ tool, input: { filePath } }, conf);
  const deny = { commands: ['deploytool'], shellPatterns: ['internal-sync', '*wipe --all*', 'zap *'], secretPaths: ['.corp/token', '~/.config/corp-vpn/'], editPaths: ['**/openapi.yaml', '**/gen/**', 'vendored/**', '/etc/special'] };
  let conf: GuardConfig;
  beforeAll(() => {
    conf = { ...cfg, safety: { skillRoots: [], deny } };
  });
  const generic = (): GuardConfig => ({ ...cfg, safety: EMPTY_GUARD_SAFETY });

  it('deny.commands are denied wherever the word is a command word, and only with the input', () => {
    for (const cmd of ['deploytool up', 'env deploytool up', 'cd x && deploytool', '/usr/local/bin/deploytool up', 'sh -c "deploytool up"', 'sudo deploytool', "printf 'deploytool' | sh", '(deploytool up)']) {
      expect(sh(cmd, conf).verdict, cmd).toBe('block');
      expect(sh(cmd, generic()).verdict, `generic ${cmd}`).toBe('allow');
    }
    expect(sh('ls src/deploytool-docs', conf).verdict).toBe('allow');
    expect(sh('deploytool up', conf)).toMatchObject({ reason: expect.stringContaining('deploytool') });
  });
  it('deny.commands entries that are not plain command names are ignored by the guard (the renderer rejects them)', () => {
    const odd = { ...cfg, safety: { skillRoots: [], deny: { ...deny, commands: ['a b', '*', '/usr/bin/x', '.*'] } } };
    expect(sh('ls', odd).verdict).toBe('allow');
    expect(sh('echo a b', odd).verdict).toBe('allow');
  });
  it('deny.shellPatterns match as substrings (no wildcard) or opencode globs (anchored, trailing " *" optional)', () => {
    for (const cmd of ['run internal-sync now', 'internal-sync', "sh -c 'internal-sync'", 'wipe --all x', 'echo hi; wipe --all', 'zap now', 'zap']) {
      expect(sh(cmd, conf).verdict, cmd).toBe('block');
      expect(sh(cmd, generic()).verdict, `generic ${cmd}`).toBe('allow');
    }
    for (const cmd of ['ls', 'echo zapper', 'echo sync internal', 'wipe --some']) expect(sh(cmd, conf).verdict, cmd).toBe('allow');
    expect(sh('echo internal-sync', conf)).toMatchObject({ reason: expect.stringContaining('denied shell pattern') });
  });
  it('deny.secretPaths are secret locations for shell commands and the read/grep/glob tools (HOME-relative, any spelling)', () => {
    for (const cmd of ['cat ~/.corp/token', 'cat $HOME/.corp/token', 'cat "${HOME}/.corp/token"', `cat ${vars.HOME}/.corp/token`, 'cat ~/.CORP/Token', 'grep -r x ~/.corp', 'cat ~/.config/corp-vpn/profile.ovpn', "cat ~/.co''rp/token", 'echo ~/.corp/t*']) {
      expect(sh(cmd, conf).verdict, cmd).toBe('block');
    }
    expect(sh('cat ~/.corp/token', generic()).verdict).toBe('allow');
    expect(sh('ls ~/.corp', conf).verdict).toBe('allow'); // naming/listing an ancestor of a secret root is fine
    for (const p of ['~/.corp/token', `${vars.HOME}/.corp/token`, '$HOME/.config/corp-vpn/x']) {
      for (const tool of ['read', 'grep']) expect(wr(tool, p, conf).verdict, `${tool} ${p}`).toBe('block');
      expect(wr('read', p, generic()).verdict).toBe('allow');
    }
    expect(wr('grep', `${vars.HOME}/.corp`, conf).verdict).toBe('block'); // recursive search over a dir that contains a secret
    expect(wr('read', '~/.config/other/x', conf).verdict).toBe('allow');
  });
  it('deny.secretPaths show up in heredoc bodies (text backstop)', () => {
    expect(sh("cat <<'EOF'\ncat ~/.corp/token\nEOF", conf).verdict).toBe('block');
    expect(sh("cat <<'EOF'\ncat ~/.corp/token\nEOF", generic()).verdict).toBe('allow');
  });
  it('deny.editPaths protect writes inside the allowed roots (globs: any depth, trailing /** covers the dir, relative globs match at any depth)', () => {
    const wt = vars.WT!;
    for (const f of [`${wt}/openapi.yaml`, `${wt}/a/b/openapi.yaml`, `${wt}/gen/x.ts`, `${wt}/a/gen/x.ts`, `${wt}/gen`, `${wt}/vendored/x`, `${wt}/a/vendored/b/c`]) {
      for (const tool of ['edit', 'write']) expect(wr(tool, f, conf).verdict, `${tool} ${f}`).toBe('block');
      expect(wr('edit', f, generic()).verdict, `generic ${f}`).toBe('allow');
    }
    for (const f of [`${wt}/openapi.yaml.bak`, `${wt}/src/general.ts`, `${wt}/src/a.ts`, `${wt}/myvendored/x`]) expect(wr('edit', f, conf).verdict, f).toBe('allow');
    expect(sh(`echo x > ${wt}/a/openapi.yaml`, conf).verdict).toBe('block');
    expect(sh(`echo x > ${wt}/a/openapi.yaml`, generic()).verdict).toBe('allow');
    expect(wr('write', `${vars.TMP}/gen/x`, conf).verdict).toBe('block');
  });
  it('isAllowedWritePath takes extra protected patterns', () => {
    expect(isAllowedWritePath(`${vars.WT}/a.ts`, cfg.allowedRoots, undefined, [/a\.ts$/])).toBe(false);
    expect(isAllowedWritePath(`${vars.WT}/a.ts`, cfg.allowedRoots)).toBe(true);
  });
  it('a malformed NIGHTGEM_SAFETY blocks every tool (fail closed)', () => {
    const bad = { ...cfg, ...configFromEnv({ NIGHTGEM_CONTROL_DIR: '/c', NIGHTGEM_SAFETY: '{oops' }) };
    expect(decide({ tool: 'read', input: { filePath: `${vars.WT}/a.ts` } }, { ...bad, allowedRoots: cfg.allowedRoots })).toMatchObject({ verdict: 'block', reason: expect.stringContaining('NIGHTGEM_SAFETY') });
  });
  it('the plugin fails closed when NIGHTGEM_SAFETY is unset (a serve process the renderers did not configure)', async () => {
    const dir = mkdtempSync(join(base, 'ctl3-'));
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ softStop: false, hardStop: false, heartbeatTs: Date.now() }));
    const saved = { ...process.env };
    process.env.NIGHTGEM_CONTROL_DIR = dir;
    process.env.NIGHTGEM_ALLOWED_WRITE_ROOTS = vars.TMP!;
    delete process.env.NIGHTGEM_SAFETY;
    try {
      let hook: ((e: Record<string, unknown>) => Promise<void>) | undefined;
      await guard.setup({ tool: { hook: async (_n: string, fn: (e: Record<string, unknown>) => Promise<void>) => void (hook = fn) } });
      await expect(hook!({ tool: 'shell', input: { command: 'ls' } })).rejects.toThrow(/NIGHTGEM_SAFETY is malformed or missing/);
      await expect(hook!({ tool: 'read', input: { filePath: `${vars.WT}/a.ts` } })).rejects.toThrow(GUARD_PREFIX);
      process.env.NIGHTGEM_SAFETY = JSON.stringify(EMPTY_GUARD_SAFETY);
      await expect(hook!({ tool: 'shell', input: { command: 'ls' } })).resolves.toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
  it('the plugin entry reads NIGHTGEM_SAFETY from the serve env', async () => {
    const dir = mkdtempSync(join(base, 'ctl2-'));
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ softStop: false, hardStop: false, heartbeatTs: Date.now() }));
    const saved = { ...process.env };
    process.env.NIGHTGEM_CONTROL_DIR = dir;
    process.env.NIGHTGEM_ALLOWED_WRITE_ROOTS = vars.TMP!;
    process.env.NIGHTGEM_SAFETY = JSON.stringify({ skillRoots: [], deny });
    try {
      let hook: ((e: Record<string, unknown>) => Promise<void>) | undefined;
      await guard.setup({ tool: { hook: async (_n: string, fn: (e: Record<string, unknown>) => Promise<void>) => void (hook = fn) } });
      await expect(hook!({ tool: 'shell', input: { command: 'deploytool up' } })).rejects.toThrow(GUARD_PREFIX);
      await expect(hook!({ tool: 'shell', input: { command: 'ls' } })).resolves.toBeUndefined();
      process.env.NIGHTGEM_SAFETY = 'garbage';
      await expect(hook!({ tool: 'shell', input: { command: 'ls' } })).rejects.toThrow(/NIGHTGEM_SAFETY/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
  it('workspace-specific inputs: the shell-pattern deny reproduces the old textual deny; the generic defaults do not carry it', () => {
    const word = corpusSafety('/w', vars.HOME!).deny.shellPatterns[0]!.replaceAll('*', '');
    expect(word.length).toBeGreaterThan(3);
    for (const cmd of [`node ~/work/${word}/bin/x.js`, `echo ${word}`, `cd x && ${word} run`]) {
      expect(sh(cmd, cfg).verdict, cmd).toBe('block');
      expect(sh(cmd, generic()).verdict, `generic ${cmd}`).toBe('allow');
    }
  });
});

describe('the twg tracker CLI is denied only when the inputs configure it', () => {
  it('blocks the command and its login dir with the workspace-specific inputs, allows both with the generic defaults', () => {
    const generic: GuardConfig = { ...cfg, safety: EMPTY_GUARD_SAFETY };
    const sh = (command: string, conf: GuardConfig) => decide({ tool: 'shell', input: { command } }, conf);
    for (const cmd of ['twg status', '~/.local/bin/twg x', 'cd x && twg x', 'cat ~/.config/twg/config.json']) {
      expect(sh(cmd, cfg).verdict, cmd).toBe('block');
      expect(sh(cmd, generic).verdict, `generic ${cmd}`).toBe('allow');
    }
  });
});

describe('configFromEnv (the single env -> guard config mapping)', () => {
  it('splits the roots and the writable list, reads the port and the control dir flag', () => {
    expect(
      configFromEnv({ NIGHTGEM_CONTROL_DIR: '/c', NIGHTGEM_ALLOWED_WRITE_ROOTS: '/a/*/x:/b::/t', NIGHTGEM_RUN_PORT: '4242', NIGHTGEM_RUN_WRITABLE: 'tasks.jsonl:decisions.jsonl' }),
    ).toEqual({ controlDirSet: true, allowedRoots: ['/a/*/x', '/b', '/t'], runPort: '4242', runWritable: ['tasks.jsonl', 'decisions.jsonl'] });
  });
  it('leaves port and writable list out when unset; an empty writable list means none; no control dir fails closed', () => {
    expect(configFromEnv({})).toEqual({ controlDirSet: false, allowedRoots: [] });
    expect(configFromEnv({ NIGHTGEM_RUN_WRITABLE: '' }).runWritable).toEqual([]);
  });
  it('matches what buildGuardEnv produces', () => {
    const safety = corpusSafety('/Users/alice/work', '/Users/alice');
    const env = buildGuardEnv({ slug: 'my-run', workspaceRoot: '/Users/alice/work', controlDir: '/c', tmpDir: '/tmp/t', port: 99, safety });
    expect(configFromEnv(env)).toEqual({
      safety: { skillRoots: safety.skillRoots, deny: safety.deny },
      controlDirSet: true,
      allowedRoots: ['/Users/alice/work/*/.worktrees/my-run', '/Users/alice/work/.specs/my-run', '/tmp/t'],
      runPort: '99',
      runWritable: ['tasks.jsonl', 'decisions.jsonl', 'run-complete.json'],
    });
  });
});

describe('guard package identity', () => {
  it('profile/guard/package.json name is GUARD_PACKAGE', () => {
    const pkg = JSON.parse(readFileSync(new URL('../profile/guard/package.json', import.meta.url), 'utf8')) as { name: string };
    expect(pkg.name).toBe(GUARD_PACKAGE);
  });
});
