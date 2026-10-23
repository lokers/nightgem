import type { GuardSafety } from './decide.mjs';

export interface EnvGuardConfig {
  /** false when NIGHTGEM_CONTROL_DIR is unset (every tool blocked). */
  controlDirSet: boolean;
  allowedRoots: string[];
  runPort?: string;
  runWritable?: string[];
  /** Parsed `NIGHTGEM_SAFETY` (skill roots and deny lists). */
  safety?: GuardSafety;
  /** `NIGHTGEM_SAFETY` was set but malformed: every tool is blocked. */
  safetyInvalid?: boolean;
}

/** The env-derived part of the guard config. The caller adds `flags`, `now`, `cwd` and `env`. */
export function configFromEnv(env: Record<string, string | undefined>): EnvGuardConfig;
