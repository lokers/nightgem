#!/usr/bin/env node
// The nightgem CLI. Runs in THIS process (no wrapper child), so signals reach the command directly.
//
// Module choice: a checkout (src/ present and tsx resolvable) runs src/ through tsx, registered in-process, so it never
// runs a stale dist/. An installed package (no src/, no tsx) runs the compiled dist/. All paths are absolute and derived
// from the REAL path of this file (npm link symlinks it into a global prefix), never from the cwd. main() is called explicitly: an "is this the entry file" guard does not fire under
// npm's symlinked bins.
//
// `--check` as the only argument loads the module, prints which one it is and exits 0 without running anything.
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APP } from '../profile/guard/brand.mjs';

const ENTRY = 'cli';
const NAME = APP;
// The real path of this file: `npm link` puts a symlink in the global prefix, and src/ or dist/ live next to the real file.
const root = join(dirname(realpathSync(fileURLToPath(import.meta.url))), '..');

async function loadModule() {
  const srcFile = join(root, 'src', `${ENTRY}.ts`);
  if (existsSync(srcFile)) {
    let tsxApi;
    try {
      const require = createRequire(join(root, 'package.json'));
      tsxApi = join(dirname(require.resolve('tsx/package.json')), 'dist', 'esm', 'api', 'index.mjs');
    } catch {
      tsxApi = undefined; // tsx not installed: fall through to dist/
    }
    if (tsxApi) {
      const { register } = await import(pathToFileURL(tsxApi).href);
      register();
      return { mod: await import(pathToFileURL(srcFile).href), kind: 'src (tsx)' };
    }
  }
  const distFile = join(root, 'dist', `${ENTRY}.js`);
  if (!existsSync(distFile)) {
    throw new Error(`no compiled output at ${distFile} and no src/+tsx to run instead: run \`npm run build\``);
  }
  return { mod: await import(pathToFileURL(distFile).href), kind: 'dist' };
}

try {
  const { mod, kind } = await loadModule();
  if (typeof mod.main !== 'function') throw new Error('the entry module does not export main()');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    console.log(`${NAME} entry ok: ${kind}`);
    process.exit(0);
  }
  process.exit(await mod.main(args));
} catch (err) {
  console.error(`${NAME}: failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
