// Single source of every name this tool owns (app, env prefix, launchd label, install marker, directories, commands).
// Plain ESM so the guard plugin (loaded by OpenCode, no build step) and `src/brand.ts` share it. Change a name here only.

export const APP = 'nightgem';
export const ENV_PREFIX = 'NIGHTGEM_';
export const LABEL_PREFIX = 'dev.nightgem.';
export const MARKER = 'nightgem:managed';
export const CONFIG_DIR_NAME = 'nightgem';
export const CONTROL_DIR_NAME = 'nightgem';
export const TMP_PREFIX = 'nightgem-';
export const COMMANDS = Object.freeze({ main: 'nightgem', status: 'nightgem-status', stop: 'nightgem-stop', retro: 'nightgem-retro' });
export const GUARD_PACKAGE = 'nightgem-guard';
/** The project's public contact (security reports, code of conduct). The leak audit allows exactly this address. */
export const MAINTAINER_EMAIL = 'lokers@gmail.com';
