/** Repo-relative fixture directories. Tests import these instead of hard-coding the paths. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORDED_FIXTURES = 'test/fixtures/opencode-2.0.29/recorded';
export const OPENCODE_FIXTURES = 'test/fixtures/opencode-2.0.29';

/** Absolute path of the repo root (this file lives in `test/fixtures/`). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
