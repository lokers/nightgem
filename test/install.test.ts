import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli.ts';
import type { CliDeps, ExecFn } from '../src/cli-deps.ts';
import {
  COMMAND_NAMES,
  InstallError,
  addMarker,
  inspectManaged,
  installCommands,
  renderCommandTemplate,
  uninstallCommands,
  type InstallInput,
} from '../src/install.ts';
import { realRenderers } from '../src/render.ts';
import { loadProfile } from '../src/userprofile.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = '/opt/node/bin/node';
const BIN = '/opt/nightgem/bin/nightgem.mjs';
const NOW = new Date('2026-10-22T10:00:00Z');

let home: string;
let workspace: string;
let commandsDir: string;
let templatesDir: string;
let env: Record<string, string | undefined>;

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

function input(over: Partial<InstallInput> = {}): InstallInput {
  return {
    home,
    env,
    fs,
    nodePath: NODE,
    binPath: BIN,
    templatesDir,
    starterPath: join(REPO, 'templates', 'profile.starter.jsonc'),
    commandsDir,
    workspace,
    force: false,
    now: () => NOW,
    ...over,
  };
}

const profilePath = (): string => join(home, '.config', 'nightgem', 'profile.jsonc');

/** Minimal frontmatter reader: `key: value` lines between the first two `---` lines. */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter at the top of the file');
  return Object.fromEntries(
    (m[1] as string).split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-install-'));
  workspace = join(home, 'workspace');
  mkdirSync(workspace);
  commandsDir = join(home, 'cmds');
  templatesDir = join(home, 'templates');
  mkdirSync(templatesDir);
  for (const n of COMMAND_NAMES) fs.copyFileSync(join(REPO, 'commands', `${n}.md`), join(templatesDir, `${n}.md`));
  env = {};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('installCommands', () => {
  it('fresh install writes the 3 commands and the profile', () => {
    const r = installCommands(input());
    expect(r.commands.map((c) => [c.name, c.action])).toEqual(COMMAND_NAMES.map((n) => [n, 'created']));
    for (const n of COMMAND_NAMES) expect(statSync(join(commandsDir, `${n}.md`)).isFile()).toBe(true);
    expect(r.profile).toEqual({ path: profilePath(), action: 'created', workspaceRoot: workspace });
    expect(loadProfile({ path: profilePath(), home, env, fs }).profile.workspaceRoot).toBe(workspace);
  });

  it('a second install changes nothing (hashes and mtimes)', () => {
    installCommands(input());
    const files = [...COMMAND_NAMES.map((n) => join(commandsDir, `${n}.md`)), profilePath()];
    const old = new Date('2020-01-01T00:00:00Z');
    for (const f of files) utimesSync(f, old, old);
    const before = files.map((f) => [sha(f), statSync(f).mtimeMs]);
    const r = installCommands(input({ workspace: undefined }));
    expect(r.commands.every((c) => c.action === 'unchanged')).toBe(true);
    expect(r.profile.action).toBe('exists');
    expect(files.map((f) => [sha(f), statSync(f).mtimeMs])).toEqual(before);
  });

  it('upgrades managed files when a template changed', () => {
    installCommands(input());
    const tpl = join(templatesDir, 'nightgem-stop.md');
    writeFileSync(tpl, `${readFileSync(tpl, 'utf8')}\nAn extra rule.\n`);
    const r = installCommands(input({ workspace: undefined }));
    expect(r.commands.map((c) => c.action)).toEqual(['unchanged', 'unchanged', 'updated']);
    const text = readFileSync(join(commandsDir, 'nightgem-stop.md'), 'utf8');
    expect(text).toContain('An extra rule.');
    expect(inspectManaged(text).kind).toBe('intact');
  });

  it('refuses an unmanaged file (nothing is written), and --force backs it up first', () => {
    mkdirSync(commandsDir);
    const mine = join(commandsDir, 'nightgem.md');
    writeFileSync(mine, 'my own command\n');
    let err: unknown;
    try {
      installCommands(input());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('conflict');
    expect((err as InstallError).details).toEqual([mine]);
    expect(readFileSync(mine, 'utf8')).toBe('my own command\n');
    expect(fs.existsSync(join(commandsDir, 'nightgem-status.md'))).toBe(false);
    expect(fs.existsSync(profilePath())).toBe(false);

    const r = installCommands(input({ force: true }));
    expect(r.commands[0]).toMatchObject({ action: 'overwritten', backup: `${mine}.bak` });
    expect(readFileSync(`${mine}.bak`, 'utf8')).toBe('my own command\n');
    expect(inspectManaged(readFileSync(mine, 'utf8')).kind).toBe('intact');
  });

  it('timestamps the backup when a .bak already exists, and treats a hand-edited managed file as a conflict', () => {
    installCommands(input());
    const target = join(commandsDir, 'nightgem-status.md');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\nmy edit\n`);
    expect(inspectManaged(readFileSync(target, 'utf8')).kind).toBe('edited');
    expect(() => installCommands(input({ workspace: undefined }))).toThrow(/edited since install/);
    writeFileSync(`${target}.bak`, 'older backup\n');
    const r = installCommands(input({ workspace: undefined, force: true }));
    const done = r.commands.find((c) => c.name === 'nightgem-status')!;
    expect(done.backup).toBe(`${target}.bak.2026-10-22T10-00-00-000Z`);
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe('older backup\n');
    expect(readFileSync(done.backup!, 'utf8')).toContain('my edit');
  });

  it('renders absolute paths, keeps the frontmatter at the top and the marker right after it', () => {
    installCommands(input());
    for (const n of COMMAND_NAMES) {
      const text = readFileSync(join(commandsDir, `${n}.md`), 'utf8');
      const fm = frontmatter(text);
      expect(fm['description']).toBeTruthy();
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toMatch(/^---\n[\s\S]*?\n---\n<!-- nightgem:managed sha256=[0-9a-f]{64} -->\n/);
      expect(text).not.toMatch(/\{\{/);
      expect(text).toContain(`${NODE} ${BIN}`);
      expect(isAbsolute(NODE) && isAbsolute(BIN)).toBe(true);
    }
    expect(frontmatter(readFileSync(join(commandsDir, 'nightgem.md'), 'utf8'))['agent']).toBe('orchestrator');
  });

  it('puts the marker first when a file has no frontmatter, and hashes the body without the marker line', () => {
    const body = 'just text\n';
    const marked = addMarker(body);
    expect(marked.startsWith('<!-- nightgem:managed sha256=')).toBe(true);
    expect(marked).toBe(`<!-- nightgem:managed sha256=${createHash('sha256').update(body).digest('hex')} -->\n${body}`);
    expect(inspectManaged(marked)).toMatchObject({ kind: 'intact', body });
  });

  it('shell-quotes paths with spaces in the rendered commands', () => {
    expect(renderCommandTemplate('run {{NODE}} {{BIN}}', { NODE: '/a b/node', BIN: '/x/bin.mjs' })).toBe("run '/a b/node' /x/bin.mjs");
    expect(() => renderCommandTemplate('{{OTHER}}', { NODE, BIN })).toThrow(/unknown placeholder/);
  });

  it('the starter profile validates once rendered', () => {
    installCommands(input());
    const loaded = loadProfile({ path: profilePath(), home, env, fs });
    expect(loaded.profile).toMatchObject({ version: 1, tracker: { autoClaim: { enabled: false } }, skills: { exclude: [] }, audit: { bannedTerms: [] } });
    expect(readFileSync(profilePath(), 'utf8')).not.toContain('{{');
  });

  it('honours NIGHTGEM_PROFILE and never overwrites an existing profile', () => {
    const custom = join(home, 'custom.jsonc');
    env = { NIGHTGEM_PROFILE: custom };
    expect(installCommands(input()).profile.path).toBe(custom);
    const before = sha(custom);
    expect(installCommands(input({ workspace: undefined })).profile.action).toBe('exists');
    expect(sha(custom)).toBe(before);
    expect(fs.existsSync(profilePath())).toBe(false);
  });

  it('requires --workspace when no profile exists, and rejects an AD11-bad workspace without writing anything', () => {
    expect(() => installCommands(input({ workspace: undefined }))).toThrow(/--workspace/);
    for (const bad of [home, join(home, 'missing'), '/']) {
      let err: unknown;
      try {
        installCommands(input({ workspace: bad }));
      } catch (e) {
        err = e;
      }
      expect((err as InstallError).code, bad).toBe('invalid-workspace');
      expect((err as InstallError).details.length).toBeGreaterThan(0);
    }
    mkdirSync(join(workspace, '.git'));
    expect(() => installCommands(input())).toThrow(/git work tree/);
    expect(fs.existsSync(commandsDir)).toBe(false);
    expect(fs.existsSync(profilePath())).toBe(false);
  });

  it('does not need --workspace when a profile exists', () => {
    mkdirSync(dirname(profilePath()), { recursive: true });
    writeFileSync(profilePath(), `{ "version": 1, "workspaceRoot": ${JSON.stringify(workspace)} }`);
    expect(installCommands(input({ workspace: undefined })).profile.action).toBe('exists');
  });
});

describe('uninstallCommands', () => {
  it('removes only intact managed files; edited and unmanaged ones and unrelated files keep their hashes', () => {
    installCommands(input());
    const other = join(commandsDir, 'build.md');
    writeFileSync(other, 'someone else\n');
    const status = join(commandsDir, 'nightgem-status.md');
    writeFileSync(status, `${readFileSync(status, 'utf8')}edited\n`);
    const stop = join(commandsDir, 'nightgem-stop.md');
    writeFileSync(stop, 'replaced by hand, no marker\n');
    const keep = [other, status, stop, profilePath()].map((f) => [f, sha(f)]);

    const r = uninstallCommands({ home, fs, commandsDir });
    expect(r.commands.map((c) => [c.name, c.action])).toEqual([
      ['nightgem', 'removed'],
      ['nightgem-status', 'skipped-edited'],
      ['nightgem-stop', 'skipped-unmanaged'],
    ]);
    expect(fs.existsSync(join(commandsDir, 'nightgem.md'))).toBe(false);
    expect(keep.map(([f]) => sha(f as string))).toEqual(keep.map(([, h]) => h));
  });

  it('reports missing files and keeps the profile', () => {
    installCommands(input());
    uninstallCommands({ home, fs, commandsDir });
    const again = uninstallCommands({ home, fs, commandsDir });
    expect(again.commands.every((c) => c.action === 'missing')).toBe(true);
    expect(fs.existsSync(profilePath())).toBe(true);
  });
});

describe('install / uninstall CLI', () => {
  function deps(): CliDeps {
    const never = async (): Promise<never> => {
      throw new Error('not used');
    };
    return {
      home,
      nodePath: NODE,
      orchestratorEntry: '/o/nightgem-orchestrator.mjs',
      model: 'anthropic/claude-opus-5-5',
      uid: 501,
      now: () => NOW,
      resolveRunContext: never,
      resolveWorkspace: never,
      writeRunContext: never,
      readRunContext: never,
      resetStopFlags: never,
      renderers: realRenderers,
      readManifest: never,
      writeManifest: never,
      readControlFlags: never,
      acquireLock: never,
      releaseLock: never,
      lockHolder: never,
      lockIsFree: async () => true,
      buildBaseline: never,
      writeReport: never,
    };
  }
  const exec: ExecFn = async (cmd, args) => {
    if (cmd === 'opencode' && args[0] === '--version') return { stdout: 'opencode v2.0.29\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'not available', exitCode: 1 };
  };

  it('installs, prints the profile path and next steps, then runs doctor without failing the install', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const codes: number[] = [];
    const program = buildProgram({
      deps: deps(),
      exec,
      fs: { exists: () => false },
      io: { out: (l) => void lines.push(l), err: (l) => void errs.push(l) },
      env,
      onExit: (c) => void codes.push(c),
    });
    await program.parseAsync(['install', '--workspace', workspace, '--commands-dir', commandsDir], { from: 'user' });
    const out = lines.join('\n');
    expect(out).toContain(profilePath());
    expect(out).toContain('Next steps');
    expect(out).toContain('Environment check (doctor)');
    expect(codes).toEqual([]);
    expect(fs.existsSync(join(commandsDir, 'nightgem.md'))).toBe(true);

    lines.length = 0;
    await program.parseAsync(['uninstall', '--commands-dir', commandsDir], { from: 'user' });
    expect(lines.filter((l) => l.startsWith('removed'))).toHaveLength(3);
  });

  it('exits 1 with the reason when --workspace is missing', async () => {
    const errs: string[] = [];
    const codes: number[] = [];
    const program = buildProgram({ deps: deps(), exec, io: { out: () => undefined, err: (l) => void errs.push(l) }, env, onExit: (c) => void codes.push(c) });
    await program.parseAsync(['install', '--commands-dir', commandsDir], { from: 'user' });
    expect(codes).toEqual([1]);
    expect(errs.join('\n')).toContain('--workspace');
    expect(fs.existsSync(commandsDir)).toBe(false);
  });
});

describe('command templates', () => {
  const read = (n: string): string => readFileSync(join(REPO, 'commands', `${n}.md`), 'utf8');

  it('have frontmatter at the top and only the NODE/BIN placeholders', () => {
    for (const n of COMMAND_NAMES) {
      const t = read(n);
      expect(frontmatter(t)['description']).toBeTruthy();
      expect([...new Set(t.match(/\{\{\s*[A-Za-z_]+\s*\}\}/g) ?? [])].sort()).toEqual(['{{BIN}}', '{{NODE}}']);
    }
  });

  it('spec phase reads the tracker from the profile and gates auto-claim on the profile', () => {
    const t = read('nightgem');
    for (const needle of ['profile show --json', 'instructionsFile', 'tracker.keyPattern', 'tracker.fetchCommand', '{KEY}', 'tracker.linkedFetchCommand', '{KEYS}', 'tracker.notes', 'tracker.autoClaim.enabled', 'autoClaim.when.status', 'autoClaim.when.unassigned', 'autoClaim.command', 'autoClaim.verifyCommand', 'paste', '## Affected repos', '## Autonomy notes', '## Quality bar', 'CONSTRAINTS.md', 'spec-driven-development', 'Never launch past a hard failure', 'JIRA-123']) {
      expect(t, needle).toContain(needle);
    }
  });
});
