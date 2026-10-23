/**
 * Entry of the detached orchestrator: `node bin/nightgem-orchestrator.mjs --slug <slug>` (launched by launchd). The slug is the only
 * argument: everything else comes from the frozen `controlDir/run-context.json`.
 * Builds the real dependencies, runs `runOrchestrator` and exits with its exit code (0 only for `completed`).
 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { APP } from './brand.ts';
import { runOrchestrator } from './orchestrator.ts';
import { assertSlug } from './paths.ts';
import { realOrchestratorDeps, RunContextError } from './wiring.ts';

export class UsageError extends Error {}

/** `--slug <slug>` or `--slug=<slug>`; anything else is a usage error. */
export function parseArgs(argv: readonly string[]): { slug: string } {
  let slug: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--slug') {
      slug = argv[++i];
      if (slug === undefined) throw new UsageError('--slug needs a value');
    } else if (a.startsWith('--slug=')) {
      slug = a.slice('--slug='.length);
    } else {
      throw new UsageError(`unexpected argument "${a}"`);
    }
  }
  if (!slug) throw new UsageError('missing --slug <slug>');
  try {
    return { slug: assertSlug(slug) };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export async function main(argv: readonly string[], home: string = homedir()): Promise<number> {
  let slug: string;
  try {
    ({ slug } = parseArgs(argv));
  } catch (err) {
    console.error(`orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`usage: ${APP}-orchestrator.mjs --slug <slug>`);
    return 1;
  }
  let deps;
  try {
    deps = realOrchestratorDeps(slug, home);
  } catch (err) {
    // A missing or invalid run-context.json is a clear failure. Without it the workspace root is unknown, so RUN.json cannot
    // even be located: the code goes to stderr (launchd's StandardErrorPath) and the launcher's status shows the run as dead.
    const code = err instanceof RunContextError ? `${err.code}: ` : '';
    console.error(`orchestrator: ${code}${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const final = await runOrchestrator(deps);
  return final.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
