// Single source of the env -> guard config mapping, shared by the plugin (index.mjs) and the launch preflight
// (src/wiring.ts `guardConfigFor`). Only the env-derived fields live here; the caller adds `flags`, `now`, `cwd` and `env`.
//
// Env (set by the orchestrator on the serve process):
//   NIGHTGEM_CONTROL_DIR          control dir holding control.json ({softStop,hardStop,heartbeatTs})
//   NIGHTGEM_ALLOWED_WRITE_ROOTS  ":"-separated absolute roots ("*" = one path segment) writes may land in
//   NIGHTGEM_RUN_PORT             (optional) the run server port, shell commands may not mention it
//   NIGHTGEM_RUN_WRITABLE         (optional) ":"-separated file names under .specs/<slug>/.run/ agents may write
//                                       (default tasks.jsonl:decisions.jsonl:run-complete.json; empty string = none)
//   NIGHTGEM_SAFETY               JSON {skillRoots: string[], deny: {commands, shellPatterns, secretPaths, editPaths}}
//                                       (the guard-relevant part of SafetyInputs, see buildGuardEnv in src/profile.ts). Always set by buildGuardEnv. The plugin (index.mjs)
//                                       fails closed when it is unset; configFromEnv alone maps unset to no `safety`. Present but malformed = `safetyInvalid`: the guard blocks every tool (fail closed).

import { ENV_PREFIX } from './brand.mjs';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ controlDirSet: boolean, allowedRoots: string[], runPort?: string, runWritable?: string[], safety?: object, safetyInvalid?: boolean }}
 */
export function configFromEnv(env) {
  const runWritable = env[`${ENV_PREFIX}RUN_WRITABLE`];
  const safety = parseSafety(env[`${ENV_PREFIX}SAFETY`]);
  return {
    controlDirSet: Boolean(env[`${ENV_PREFIX}CONTROL_DIR`]),
    allowedRoots: (env[`${ENV_PREFIX}ALLOWED_WRITE_ROOTS`] ?? '').split(':').filter(Boolean),
    ...(env[`${ENV_PREFIX}RUN_PORT`] === undefined ? {} : { runPort: env[`${ENV_PREFIX}RUN_PORT`] }),
    ...(runWritable === undefined ? {} : { runWritable: runWritable.split(':').filter(Boolean) }),
    ...(safety === undefined ? {} : safety === null ? { safetyInvalid: true } : { safety }),
  };
}

const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** `undefined` when unset, `null` when malformed, otherwise the validated `{skillRoots, deny}`. */
function parseSafety(raw) {
  if (raw === undefined || raw === '') return undefined;
  try {
    const j = JSON.parse(raw);
    const d = j?.deny;
    if (!isStrings(j?.skillRoots) || !d || !['commands', 'shellPatterns', 'secretPaths', 'editPaths'].every((k) => isStrings(d[k]))) return null;
    return {
      skillRoots: j.skillRoots,
      deny: { commands: d.commands, shellPatterns: d.shellPatterns, secretPaths: d.secretPaths, editPaths: d.editPaths },
    };
  } catch {
    return null;
  }
}
