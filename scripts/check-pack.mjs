#!/usr/bin/env node
// Offline check of what `npm pack` would publish: only allowlisted top-level entries, nothing from src/ test/ docs/ assets/ .specs,
// and the required runtime files present. Lists local files only (`--dry-run --ignore-scripts`), so run `npm run build` first.
import { spawnSync } from 'node:child_process';

const ALLOWED = new Set(['bin', 'dist', 'profile', 'prompts', 'commands', 'templates', 'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'package.json']);
const REQUIRED = ['bin/nightgem.mjs', 'bin/nightgem-orchestrator.mjs', 'dist/cli.js', 'dist/orchestrator-main.js', 'profile/guard/package.json', 'LICENSE', 'README.md', 'package.json'];
const FORBIDDEN = ['src', 'test', 'docs', 'assets', '.specs', '.github', 'scripts'];

const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`npm pack failed:\n${r.stderr}`);
  process.exit(1);
}
const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
const problems = [];
for (const f of files) {
  const top = f.split('/')[0];
  if (!ALLOWED.has(top)) problems.push(`not allowlisted: ${f}`);
  if (FORBIDDEN.includes(top)) problems.push(`forbidden: ${f}`);
}
for (const req of REQUIRED) if (!files.includes(req)) problems.push(`missing: ${req}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`pack:check ok (${files.length} files)`);
