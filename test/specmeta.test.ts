import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadSpec, parseSpec } from '../src/specmeta.ts';

let home: string;
let ws: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ng-specmeta-'));
  ws = join(home, 'work');
  for (const r of ['acme-web', 'acme-api', 'alpha']) mkdirSync(join(ws, r, '.git'), { recursive: true });
  mkdirSync(join(ws, 'not-a-repo'), { recursive: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const spec = (status: string, table: string, title = '# Spec: thing JIRA-123 x') =>
  `${title}\n\nStatus: ${status}\nOwner: me\n\n## Affected repos / locations\n\n| Location | Change |\n|---|---|\n${table}\n\n## Next\n| \`alpha\` | ignored |\n`;

const opts = () => ({ home, workspaceRoot: ws });

describe('parseSpec', () => {
  it('parses an approved spec, repos from the first column and the ticket key from the title', () => {
    const meta = parseSpec(
      spec(
        'APPROVED (2026-10-21)',
        [
          '| `acme-web` | change |',
          '| `~/work/acme-api/` (new) | change |',
          `| \`${ws}/alpha/src\` | change |`,
          '| `~/work/not-a-repo/` | change |',
          '| `~/work/missing/` | change |',
          '| `~/.config/opencode/commands/` | change |',
          '| `~/elsewhere/acme-web/` | change |',
          '| `~/work/.specs/<slug>/` | artifacts |',
          '| Target repos (acme-web, …) | run time |',
        ].join('\n'),
      ),
      opts(),
    );
    expect(meta.approved).toBe(true);
    expect(meta.ticketKey).toBe('JIRA-123');
    expect(meta.repos.map((r) => r.name)).toEqual(['acme-web', 'acme-api', 'alpha']);
    expect(meta.repos[0]!.path).toBe(join(ws, 'acme-web'));
  });

  it('has no ticket key when the title has none', () => {
    expect(parseSpec(spec('APPROVED', '| `acme-web` | x |', '# Spec: nothing'), opts()).ticketKey).toBeUndefined();
  });

  it('rejects a spec that is not approved', () => {
    expect(() => parseSpec(spec('DRAFT', '| `acme-web` | x |'), opts())).toThrow(/not approved/);
    expect(() => parseSpec('# t\n\nno status here', opts())).toThrow(/not approved/);
  });

  it('rejects an approved spec without usable repos, naming the configured workspace', () => {
    expect(() => parseSpec(spec('APPROVED', '| `~/work/missing/` | x |'), opts())).toThrow(/No repos found/);
    let msg = '';
    try {
      parseSpec('# t\n\nStatus: APPROVED\n', opts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(ws);
    expect(msg).not.toContain(['~', 'h' + 'tdocs'].join('/'));
  });

  it('supports a --repos override and rejects non-repos', () => {
    const meta = parseSpec('# t\n\nStatus: APPROVED\n', { ...opts(), repoOverride: ['alpha', join(ws, 'acme-web')] });
    expect(meta.repos.map((r) => r.name)).toEqual(['alpha', 'acme-web']);
    expect(() => parseSpec('# t\n\nStatus: APPROVED\n', { ...opts(), repoOverride: ['not-a-repo'] })).toThrow(/not a git repo/);
  });
});

describe('loadSpec', () => {
  it('reads <workspaceRoot>/.specs/<slug>/SPEC.md', () => {
    mkdirSync(join(ws, '.specs', 'demo'), { recursive: true });
    writeFileSync(join(ws, '.specs', 'demo', 'SPEC.md'), spec('APPROVED', '| `acme-api` | x |'));
    const meta = loadSpec('demo', opts());
    expect(meta.approved).toBe(true);
    expect(meta.repos.map((r) => r.name)).toEqual(['acme-api']);
  });

  it('errors when SPEC.md is missing', () => {
    expect(() => loadSpec('nope-nope', opts())).toThrow(/SPEC.md not found/);
  });
});

describe('parseSpec: workspaceRoot and keyPattern', () => {
  it('resolves repos under an explicit workspaceRoot only', () => {
    const other = mkdtempSync(join(tmpdir(), 'ng-specmeta-ws-'));
    try {
      mkdirSync(join(other, 'acme-api', '.git'), { recursive: true });
      const meta = parseSpec(spec('APPROVED', `| \`acme-api\` | x |\n| \`${other}/acme-api/\` | y |`), { home, workspaceRoot: other });
      expect(meta.repos).toEqual([{ name: 'acme-api', path: join(other, 'acme-api') }]);
      expect(() => parseSpec(spec('APPROVED', '| `acme-web` | x |'), { home, workspaceRoot: other })).toThrow(/No repos found/);
      expect(parseSpec('# t\n\nStatus: APPROVED\n', { home, workspaceRoot: other, repoOverride: ['acme-api'] }).repos[0]!.path).toBe(join(other, 'acme-api'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('resolves `~/…` entries only when they fall under the workspace', () => {
    const meta = parseSpec(spec('APPROVED', '| `~/work/acme-api/` | x |'), opts());
    expect(meta.repos.map((r) => r.name)).toEqual(['acme-api']);
    const nested = mkdtempSync(join(tmpdir(), 'ng-specmeta-n-'));
    try {
      mkdirSync(join(nested, 'work', 'ws', 'acme-api', '.git'), { recursive: true });
      const m = parseSpec(spec('APPROVED', '| `~/work/ws/acme-api/` | x |\n| `~/work/other/` | y |'), {
        home: nested,
        workspaceRoot: join(nested, 'work', 'ws'),
      });
      expect(m.repos.map((r) => r.name)).toEqual(['acme-api']);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('keyPattern replaces the default ticket-key pattern (group 1, else the whole match)', () => {
    const table = '| `acme-web` | x |';
    expect(parseSpec(spec('APPROVED', table, '# Spec: thing #42 x'), { ...opts(), keyPattern: /#\d+/ }).ticketKey).toBe('#42');
    expect(parseSpec(spec('APPROVED', table, '# Spec: thing #42 x'), { ...opts(), keyPattern: /#(\d+)/ }).ticketKey).toBe('42');
    expect(parseSpec(spec('APPROVED', table, '# Spec: thing JIRA-123 x'), { ...opts(), keyPattern: /#\d+/ }).ticketKey).toBeUndefined();
    expect(parseSpec(spec('APPROVED', table, '# Spec: thing JIRA-123 x'), opts()).ticketKey).toBe('JIRA-123');
  });
});
