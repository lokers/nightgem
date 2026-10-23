import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RESERVED_TOKENS,
  assertSlug,
  assertTaskId,
  assertWithin,
  controlDir,
  integrationWorktree,
  recordedControlDir,
  recordedLaunchdLabel,
  isValidSlug,
  runDir,
  runPaths,
  specsDir,
  taskWorktree,
  worktreeRoot,
  xdgDataHome,
} from '../src/paths.ts';

const HOME = '/Users/test';
const WS = '/Users/test/work';

describe('slug validation', () => {
  it('accepts kebab-case up to 60 chars', () => {
    expect(isValidSlug('my-run-2')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('a'.repeat(60))).toBe(true);
  });
  it('rejects everything else', () => {
    for (const bad of ['', 'A-b', 'a_b', 'a--b', '-a', 'a-', '../x', 'a/b', 'a b', 'a'.repeat(61), '.hidden']) {
      expect(isValidSlug(bad), bad).toBe(false);
      expect(() => assertSlug(bad)).toThrow(/Invalid slug/);
    }
  });
  it('validates task ids', () => {
    expect(assertTaskId('T7a')).toBe('T7a');
    expect(assertTaskId('api-client')).toBe('api-client');
    for (const bad of ['', '_integration', '..', 'a/b', 'a b', '.x']) expect(() => assertTaskId(bad), bad).toThrow();
  });
  it('rejects the standalone words push, gh and ssh in slugs (case-insensitive)', () => {
    for (const bad of ['jira-1-push-notif', 'push', 'gh-fix', 'fix-ssh', 'a-GH-b']) {
      expect(isValidSlug(bad.toLowerCase()), bad).toBe(false);
      expect(() => assertSlug(bad.toLowerCase()), bad).toThrow(/standalone word/);
    }
    expect(() => assertSlug('jira-1-push-notif')).toThrow(/"push".*notif/);
  });
  it('rejects the standalone words push, gh and ssh in task ids (case-insensitive)', () => {
    for (const bad of ['jira-1-push-notif', 'Push', 'gh', 'api-GH-client', 'ssh-keys', 'x-SSH']) {
      expect(() => assertTaskId(bad), bad).toThrow(/standalone word/);
    }
    expect(() => assertTaskId('jira-1-push-notif')).toThrow(/"push"/);
  });
  it('rejects the standalone word stash (the profile glob *git*stash* would fire on the run\'s own paths)', () => {
    expect(RESERVED_TOKENS).toContain('stash');
    for (const bad of ['jira-1-stash-ui', 'stash', 'fix-STASH']) {
      expect(isValidSlug(bad.toLowerCase()), bad).toBe(false);
      expect(() => assertSlug(bad.toLowerCase()), bad).toThrow(/"stash"/);
      expect(() => assertTaskId(bad), bad).toThrow(/"stash"/);
    }
    for (const ok of ['stashing', 'stashed-ui', 'mustash', 'jira-1-hash']) {
      expect(isValidSlug(ok), ok).toBe(true);
      expect(assertTaskId(ok)).toBe(ok);
    }
  });
  it('allows names that only contain those letters inside a longer word', () => {
    for (const ok of ['pushover', 'jira-1-pushover', 'ghost', 'sshd-config', 'high-light', 'publish-ui', 'notif']) {
      expect(isValidSlug(ok), ok).toBe(true);
      expect(assertTaskId(ok)).toBe(ok);
    }
  });
});

describe('directories and artifacts', () => {
  it('resolves specs and run dirs from the workspace root and control dirs from an injected home', () => {
    expect(specsDir('s', WS)).toBe('/Users/test/work/.specs/s');
    expect(runDir('s', WS)).toBe('/Users/test/work/.specs/s/.run');
    expect(controlDir('s', HOME)).toBe('/Users/test/Library/Application Support/nightgem/s');
    expect(xdgDataHome('s', HOME)).toBe('/Users/test/Library/Application Support/nightgem/s/xdg-data');
  });
  it('lists every artifact path', () => {
    const p = runPaths('s', { home: HOME, workspaceRoot: WS });
    const specs = '/Users/test/work/.specs/s';
    expect(p).toMatchObject({
      workspaceRoot: WS,
      controlDir: '/Users/test/Library/Application Support/nightgem/s',
      runContextJson: '/Users/test/Library/Application Support/nightgem/s/run-context.json',
      runJson: `${specs}/.run/RUN.json`,
      costJsonl: `${specs}/.run/cost.jsonl`,
      tasksJsonl: `${specs}/.run/tasks.jsonl`,
      decisionsJsonl: `${specs}/.run/decisions.jsonl`,
      eventsJsonl: `${specs}/.run/events.jsonl`,
      orchestratorLog: `${specs}/.run/orchestrator.log`,
      reportMd: `${specs}/REPORT.md`,
      statusMd: `${specs}/STATUS.md`,
      decisionsMd: `${specs}/DECISIONS.md`,
      planMd: `${specs}/PLAN.md`,
      specMd: `${specs}/SPEC.md`,
    });
  });
  it('rejects bad slugs in every helper', () => {
    expect(() => specsDir('../etc', WS)).toThrow();
    expect(() => runPaths('A', { home: HOME, workspaceRoot: WS })).toThrow();
    expect(() => controlDir('A', HOME)).toThrow();
    expect(() => worktreeRoot('/r', 'a/b')).toThrow();
  });
  it('resolves worktree paths', () => {
    expect(worktreeRoot('/r/acme-api', 's')).toBe('/r/acme-api/.worktrees/s');
    expect(taskWorktree('/r/acme-api', 's', 't1')).toBe('/r/acme-api/.worktrees/s/t1');
    expect(integrationWorktree('/r/acme-api', 's')).toBe('/r/acme-api/.worktrees/s/_integration');
    expect(() => taskWorktree('/r/acme-api', 's', '../x')).toThrow();
  });
});

describe('assertWithin', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ng-paths-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'sub', 'f.txt'), 'x');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, join(root, 'escape-dir'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file'));
    symlinkSync(join(outside, 'not-yet'), join(root, 'dangling'));
    symlinkSync(join(root, 'sub'), join(root, 'inner-link'));
    symlinkSync(root, join(base, 'root-link'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('allows the root, existing and not-yet-existing children', () => {
    expect(assertWithin(root, [root])).toBe(root);
    expect(assertWithin(join(root, 'sub', 'f.txt'), [root])).toBe(join(root, 'sub', 'f.txt'));
    expect(assertWithin(join(root, 'sub', 'new', 'deeper.txt'), [root])).toBe(join(root, 'sub', 'new', 'deeper.txt'));
  });
  it('accepts any of several roots', () => {
    expect(assertWithin(join(outside, 'secret.txt'), [root, outside])).toBe(join(outside, 'secret.txt'));
  });
  it('rejects paths outside the roots, including sibling-prefix dirs', () => {
    expect(() => assertWithin(outside, [root])).toThrow(/outside/);
    expect(() => assertWithin(`${root}-evil/x`, [root])).toThrow(/outside/);
    expect(() => assertWithin('/etc/passwd', [root])).toThrow(/outside/);
  });
  it('rejects .. traversal', () => {
    expect(() => assertWithin(join(root, '..', 'outside', 'secret.txt'), [root])).toThrow(/outside/);
    expect(() => assertWithin(`${root}/sub/../../outside`, [root])).toThrow(/outside/);
    expect(assertWithin(`${root}/sub/../sub/f.txt`, [root])).toBe(join(root, 'sub', 'f.txt'));
  });
  it('rejects symlink escapes (dir, file, nonexistent child, dangling)', () => {
    expect(() => assertWithin(join(root, 'escape-dir'), [root])).toThrow(/outside/);
    expect(() => assertWithin(join(root, 'escape-dir', 'secret.txt'), [root])).toThrow(/outside/);
    expect(() => assertWithin(join(root, 'escape-dir', 'new-file.txt'), [root])).toThrow(/outside/);
    expect(() => assertWithin(join(root, 'escape-file'), [root])).toThrow(/outside/);
    expect(() => assertWithin(join(root, 'dangling'), [root])).toThrow(/outside/);
  });
  it('allows symlinks that stay inside, and symlinked roots', () => {
    expect(assertWithin(join(root, 'inner-link', 'f.txt'), [root])).toBe(join(root, 'sub', 'f.txt'));
    expect(assertWithin(join(base, 'root-link', 'sub', 'f.txt'), [root])).toBe(join(root, 'sub', 'f.txt'));
    expect(assertWithin(join(root, 'sub', 'f.txt'), [join(base, 'root-link')])).toBe(join(root, 'sub', 'f.txt'));
  });
  it('requires at least one root', () => {
    expect(() => assertWithin(root, [])).toThrow();
  });
});

describe('recordedControlDir (AD3)', () => {
  const slug = 'demo-run';
  it('accepts any absolute root that ends in /<slug>', () => {
    const other = `/Users/alice/Library/Application Support/other-tool/${slug}`;
    expect(recordedControlDir({ slug, controlDir: other }, slug)).toBe(other);
    expect(recordedControlDir({ slug, controlDir: controlDir(slug, '/Users/alice') }, slug)).toBe(controlDir(slug, '/Users/alice'));
  });
  it('refuses relative, traversing and mismatched paths', () => {
    expect(() => recordedControlDir({ slug, controlDir: `x/${slug}` }, slug)).toThrow(/not an absolute path/);
    expect(() => recordedControlDir({ slug, controlDir: `/a/../${slug}` }, slug)).toThrow(/not an absolute path/);
    expect(() => recordedControlDir({ slug, controlDir: '/a/other-run' }, slug)).toThrow(/does not end in/);
  });
  it('refuses a manifest whose slug is not the requested one, even when the dir matches the manifest slug', () => {
    expect(() => recordedControlDir({ slug: 'other-run', controlDir: '/a/other-run' }, slug)).toThrow(/records the slug "other-run"/);
  });
});

describe('recordedLaunchdLabel', () => {
  const slug = 'demo-run';
  it.each([`dev.nightgem.${slug}`, `com.example.something.${slug}`, `com.other.tool.${slug}`])('accepts %s', (label) => {
    expect(recordedLaunchdLabel({ slug, launchdLabel: label }, slug)).toBe(label);
  });
  it.each([
    ['traversal', `../x.${slug}`],
    ['slash', `a/b.${slug}`],
    ['space', `a b.${slug}`],
    ['semicolon', `a;rm.${slug}`],
    ['command substitution', `$(id).${slug}`],
    ['backtick', `\`id\`.${slug}`],
    ['double dot', `a..b.${slug}`],
    ['leading dot', `.a.${slug}`],
    ['other slug', 'dev.nightgem.other-run'],
    ['bare slug', slug],
    ['empty', ''],
  ])('refuses a %s label', (_n, label) => {
    expect(() => recordedLaunchdLabel({ slug, launchdLabel: label }, slug)).toThrow(/Refusing run/);
  });
  it('refuses a manifest whose slug is not the requested one', () => {
    expect(() => recordedLaunchdLabel({ slug: 'other-run', launchdLabel: 'dev.nightgem.other-run' }, slug)).toThrow(/records the slug/);
  });
});
