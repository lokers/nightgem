/**
 * Packaging contract (offline): package.json metadata and the exact set of files `npm pack` would publish.
 * `npm pack --dry-run --ignore-scripts` only lists local files (run with `--offline`, no update check), so it needs no network.
 * `dist/` exists only after `npm run build`, so it is required in the file list only when it is present on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown> & {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
};

const ALLOWLIST = ['bin', 'dist', 'profile', 'prompts', 'commands', 'templates', 'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md'];
/** Top-level entries npm always adds. */
const ALWAYS = ['package.json'];
const REQUIRED = ['bin', 'profile', 'prompts', 'commands', 'templates', 'LICENSE', 'README.md'];
const FORBIDDEN = ['src', 'test', 'docs', 'assets', '.specs', '.github', 'scripts', 'node_modules'];

describe('package.json', () => {
  it('declares the publishing metadata', () => {
    expect(pkg['name']).toBe('nightgem');
    expect(pkg['license']).toBe('MIT');
    expect(pkg['author']).toBe('nightgem contributors');
    expect(pkg['type']).toBe('module');
    expect(pkg['description']).toEqual(expect.any(String));
    expect(pkg['keywords']).toEqual(expect.arrayContaining(['opencode']));
    expect(pkg['repository']).toEqual({ type: 'git', url: 'git+https://github.com/lokers/nightgem.git' });
    expect(String(pkg['homepage'])).toMatch(/^https:\/\/github\.com\/lokers\/nightgem/);
    expect(pkg['bugs']).toEqual({ url: 'https://github.com/lokers/nightgem/issues' });
  });

  it('is not publishable by accident and targets macOS on a supported Node', () => {
    expect(pkg['private']).toBe(true);
    expect(pkg['engines']).toEqual({ node: '>=22.12' });
    expect(pkg['os']).toEqual(['darwin']);
  });

  it('ships an explicit allowlist and no .npmignore', () => {
    expect(pkg.files).toEqual(ALLOWLIST);
    expect(existsSync(join(ROOT, '.npmignore'))).toBe(false);
  });

  it('wires the bin and the build scripts', () => {
    expect(pkg.bin).toEqual({ nightgem: 'bin/nightgem.mjs' });
    expect(pkg.scripts['build']).toBe('tsc -p tsconfig.build.json');
    expect(pkg.scripts['prepack']).toBe('npm run build');
    expect(pkg.scripts['pack:check']).toEqual(expect.any(String));
    for (const s of ['type-check', 'test', 'cli']) expect(pkg.scripts[s]).toEqual(expect.any(String));
  });

  it('keeps tsx a dev dependency (clones only; the installed package runs dist/)', () => {
    expect(pkg.dependencies['tsx']).toBeUndefined();
    expect(pkg.devDependencies['tsx']).toEqual(expect.any(String));
  });

  it('has bins that exist', () => {
    for (const f of ['bin/nightgem.mjs', 'bin/nightgem-orchestrator.mjs']) expect(existsSync(join(ROOT, f))).toBe(true);
  });
});

describe('npm pack --dry-run', () => {
  it('lists only allowlisted top-level entries and the required runtime files', async () => {
    const r = await execa('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
      cwd: ROOT,
      reject: false,
      env: { NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' },
      timeout: 60_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    const tops = new Set(files.map((f) => f.split('/')[0]!));

    const allowed = new Set([...ALLOWLIST, ...ALWAYS]);
    expect([...tops].filter((t) => !allowed.has(t))).toEqual([]);
    for (const bad of FORBIDDEN) expect(tops.has(bad), `${bad} must not be published`).toBe(false);

    const required = existsSync(join(ROOT, 'dist', 'cli.js')) ? [...REQUIRED, 'dist'] : REQUIRED;
    for (const req of required) expect(tops.has(req), `${req} must be published`).toBe(true);
    expect(files).toEqual(expect.arrayContaining(['bin/nightgem.mjs', 'bin/nightgem-orchestrator.mjs', 'profile/guard/package.json']));
    if (tops.has('dist')) expect(files).toEqual(expect.arrayContaining(['dist/cli.js', 'dist/orchestrator-main.js']));

    // no test fixtures, source files or dotfiles slip in under an allowlisted directory
    expect(files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.mts') && !f.endsWith('.d.ts'))).toEqual([]);
    expect(files.filter((f) => f.split('/').some((p) => p.startsWith('.')))).toEqual([]);
  });
});
