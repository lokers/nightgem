// nightgem guard plugin (opencode 2.0.29 v2 plugin shape: { id, setup(ctx) }).
// Loaded through `plugins: [{ package: "<abs dir of this file>" }]` in OPENCODE_CONFIG_CONTENT.
// Blocks by throwing from the `execute.before` hook; the decision logic lives in ./decide.mjs.
//
// Env (set by the orchestrator on the serve process) is documented and mapped in ./config.mjs (`configFromEnv`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENV_PREFIX, GUARD_PACKAGE } from './brand.mjs';
import { configFromEnv } from './config.mjs';
import { CONTROL_FLAGS_FILE, GUARD_PREFIX, decide } from './decide.mjs';

function readFlags(controlDir) {
  if (!controlDir) return null;
  try {
    return JSON.parse(readFileSync(join(controlDir, CONTROL_FLAGS_FILE), 'utf8'));
  } catch {
    return null; // fail closed: decide() blocks every tool when flags are unreadable
  }
}

export default {
  id: GUARD_PACKAGE,
  async setup(ctx) {
    await ctx.tool.hook('execute.before', async (event) => {
      const env = process.env;
      const controlDir = env[`${ENV_PREFIX}CONTROL_DIR`];
      const result = decide(
        { tool: event.tool, input: event.input ?? {}, agent: event.agent, sessionID: event.sessionID },
        {
          ...configFromEnv(env),
          // buildGuardEnv always sets NIGHTGEM_SAFETY: a serve process without it is misconfigured, and a guard that
          // silently fell back to the generic defaults would be weaker than the user's profile asks for
          ...(env[`${ENV_PREFIX}SAFETY`] === undefined ? { safetyInvalid: true } : {}),
          flags: readFlags(controlDir),
          now: Date.now(),
          cwd: process.cwd(),
          env,
        },
      );
      if (result.verdict === 'block') throw new Error(`${GUARD_PREFIX}${result.reason}`);
      if (result.verdict === 'rewrite') event.input = result.input;
    });
  },
};
