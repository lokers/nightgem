import type { GuardConfig } from './decide.mjs';

export const SECRET_HOME_ROOTS: string[];
export const SECRET_READ_TOOLS: Set<string>;
export function braceExpand(s: string, cap?: number): string[] | null;
export function checkSecretReferences(cmd: string, cfg: GuardConfig): string | null;
export function checkSecretToolInput(tool: string, input: Record<string, unknown>, cfg: GuardConfig): string | null;
export function checkSecretText(text: string, cfg?: Partial<GuardConfig>): string | null;
/** HOME-relative subtree of the opencode config dir that read/grep/glob may enter when it is a skill root. */
export const SKILLS_CARVE_OUT: string;
