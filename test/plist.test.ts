import { describe, expect, it } from 'vitest';

import { LABEL_PREFIX, buildJobEnv, buildProgramArgs, launchdLabel, renderPlist } from '../src/plist.ts';

const input = {
  label: launchdLabel('my-slug'),
  programArgs: buildProgramArgs({ nodePath: '/n/bin/node', orchestratorEntry: '/o/entry.mjs', slug: 'my-slug' }),
  env: { PATH: '/a:/b', HOME: '/home/x', WEIRD: 'a&b<c>' },
  stdout: '/ctl/out.log',
  stderr: '/ctl/err.log',
  workingDir: '/run/dir',
};

describe('renderPlist', () => {
  const xml = renderPlist(input);

  it('has the proven launchd settings', () => {
    expect(xml).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>AbandonProcessGroup</key>\n  <false/>');
    expect(xml).toContain('<key>ProcessType</key>\n  <string>Interactive</string>');
    expect(xml).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('uses the neutral dev.nightgem label and caffeinate program args', () => {
    expect(xml).toContain('<string>dev.nightgem.my-slug</string>');
    const args = ['/usr/bin/caffeinate', '-ims', '/n/bin/node', '/o/entry.mjs', '--slug', 'my-slug'];
    expect(input.programArgs).toEqual(args);
    const block = args.map((a) => `<string>${a}</string>`).join('\n    ');
    expect(xml).toContain(block);
  });

  it('carries paths, env and escapes XML', () => {
    expect(xml).toContain('<key>WorkingDirectory</key>\n  <string>/run/dir</string>');
    expect(xml).toContain('<key>StandardOutPath</key>\n  <string>/ctl/out.log</string>');
    expect(xml).toContain('<key>StandardErrorPath</key>\n  <string>/ctl/err.log</string>');
    expect(xml).toContain('<key>PATH</key>\n    <string>/a:/b</string>');
    expect(xml).toContain('a&amp;b&lt;c&gt;');
  });
});

describe('launchdLabel', () => {
  it('is dev.nightgem.<slug>', () => {
    expect(LABEL_PREFIX).toBe('dev.nightgem.');
    expect(launchdLabel('a-b')).toBe('dev.nightgem.a-b');
  });
});

describe('buildJobEnv', () => {
  const env = buildJobEnv({
    parentEnv: {
      HOME: '/ignored',
      USER: 'me',
      OPENCODE_SERVER_PASSWORD: 'leak',
      OPENCODE_CONFIG_CONTENT: '{}',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: '1',
      SSH_AUTH_SOCK: '/sock',
    },
    home: '/home/me',
    nodePath: '/n/bin/node',
    opencodePath: '/opt/homebrew/bin/opencode',
    gitPath: '/usr/bin/git',
  });

  it('strips inherited OPENCODE_* except the background-subagents flag', () => {
    expect(Object.keys(env).filter((k) => k.startsWith('OPENCODE_'))).toEqual(['OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS']);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.HOME).toBe('/home/me');
    expect(env.USER).toBe('me');
  });

  it('puts absolute node, opencode and git dirs on PATH, without ~/.local/bin', () => {
    const parts = env.PATH!.split(':');
    expect(parts.slice(0, 3)).toEqual(['/n/bin', '/opt/homebrew/bin', '/usr/bin']);
    expect(env.PATH).not.toContain('.local/bin');
    expect(new Set(parts).size).toBe(parts.length);
  });

  it('adds ~/go/bin (go-installed verify tools) but never ~/.local/bin', () => {
    const parts = env.PATH!.split(':');
    expect(parts).toContain('/home/me/go/bin');
    expect(parts).not.toContain('/home/me/.local/bin');
    expect(parts.indexOf('/home/me/go/bin')).toBeGreaterThan(parts.indexOf('/usr/bin'));
  });

  it('omits the flag when not inherited', () => {
    const e = buildJobEnv({ parentEnv: {}, home: '/h', nodePath: '/n/node', opencodePath: '/o/opencode', gitPath: '/g/git' });
    expect(e.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBeUndefined();
  });
});
