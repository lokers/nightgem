/**
 * Leak test (C2b): the generic audit checks (home paths, emails, ticket keys) over every tracked file of this repo must
 * find nothing. Banned terms are NOT part of this test: they live in the developer's local profile
 * (`audit.bannedTerms`, checked by `doctor --audit-repo`), never in the repo.
 */
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { auditRepo } from '../src/audit.ts';
import { REPO_ROOT } from './fixtures/paths.ts';

describe('tracked files carry no personal or company data', () => {
  it('auditRepo with the generic checks only finds 0 hits over git ls-files', async () => {
    const res = await auditRepo({
      dir: REPO_ROOT,
      bannedTerms: [],
      generic: true,
      git: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    });
    expect(res.scanned).toBeGreaterThan(50);
    expect(res.hits.map((h) => `${h.file}:${h.line}:${h.col} ${h.kind} ${h.match}`)).toEqual([]);
  });
});
