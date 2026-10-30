# Run report: demo-feature

## Run

- Slug: `demo-feature`
- Final state: **completed** (phase: report)
- Stop reason: run.complete
- Started: 2026-10-21T20:05:00.000Z
- Ended: 2026-10-21T22:35:30.000Z
- Duration: 2h 30m 30s
- Model: `anthropic/claude-sonnet-5-5`
- Final review: [FINAL_REVIEW.md]({{FIXTURES}}/completed/FINAL_REVIEW.md)
- ⚠ 1 malformed artifact line(s) were skipped

### Phases

| Time | Phase | State |
| --- | --- | --- |
| 2026-10-21T20:05:00.000Z | plan | running |
| 2026-10-21T20:40:00.000Z | plan | done |
| 2026-10-21T20:41:00.000Z | build | running |
| 2026-10-21T22:30:00.000Z | review | done |

## Cost

- Total: **$8.5000**
- Estimated portion: $0.5000
- Budget: $20.0000 (42.5% used)

| Phase | Cost |
| --- | --- |
| plan | $1.5000 |
| build | $6.5000 |
| review | $0.5000 |

> `estimated`: 1 session(s) have an estimated rather than server-reported cost; treat the total as approximate.

## Tasks

| Task | Repo | Branch | Worktree | State | Attempts | Verify (cmd → exit) | Oracle | Blocked reason | Commits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| api | acme-api | `feat/api-endpoint` | `/fake/acme-api/.worktrees/demo-feature/api` | done | 2 | `go build ./...` → 0<br>`go test ./...` → 0 | approved | - | 1111111 feat: Add endpoint<br>2222222 test: Cover endpoint |
| ui | acme-web | `feat/ui-page` | `/fake/acme-web/.worktrees/demo-feature/ui` | done | 1 | `npm run type-check` → 0<br>`npm test` → 0 | approved | - | 3333333 feat: Add page |
| review-fix-1 | acme-web | `fix/review-1` | `/fake/acme-web/.worktrees/demo-feature/review-fix-1` | done | 1 | `npm test` → 0 | approved | - | 6666666 fix: Address review |

Summary: 3 done

## Integration branches

### acme-api

- Branch: `feat/demo-feature-integration`
- Worktree: `/fake/acme-api/.worktrees/demo-feature/_integration`
- Commits:
  - `4444444 merge: api`
  - `1111111 feat: Add endpoint`
- State: done
- Last verify: `go test ./...` → 0
- Oracle: approved

## Needs human attention

### Decisions

- **D-2** (dependency, oracle: approved): Add dependency zod-to-openapi
  - Rationale: Needed for schema export

## Verify by hand

Unknown: `MANUAL_CHECKS.md` is missing (the review phase did not write it), so checks that need a human may exist. Go through the success criteria in `SPEC.md` by hand.

## Safety checks

### Nothing pushed

- ✅ acme-api `feat/api-endpoint`: not on origin
- ✅ acme-web `feat/ui-page`: not on origin
- ✅ acme-api `feat/demo-feature-integration`: not on origin
- ✅ acme-web `fix/review-1`: not on origin

### Main checkouts unchanged

- ✅ acme-api (`/fake/acme-api`): HEAD, branch, status and stashes match baseline
- ✅ acme-web (`/fake/acme-web`): HEAD, branch, status and stashes match baseline

### Suppressions and skipped tests

Added lint or type suppressions and test skips, deleted test files and test files with fewer assertions, found in the diff of each integration branch against its base. A heuristic for the reviewer: it never fails the run.

- ✅ acme-api `feat/demo-feature-integration`: none found (against `master`)

## Narrative

The API landed first; the UI followed.

```md
## not a heading
```

### Caveats

- Pagination is untested.
- Uses `a | b`.

## Next steps

The run never pushes, opens PRs, merges or touches the issue tracker. Review and ship by hand:

1. Review each branch:

```sh
git -C /fake/acme-api/.worktrees/demo-feature/api log --oneline master..HEAD
git -C /fake/acme-api/.worktrees/demo-feature/api diff --stat master...HEAD
git -C /fake/acme-web/.worktrees/demo-feature/ui log --oneline master..HEAD
git -C /fake/acme-web/.worktrees/demo-feature/ui diff --stat master...HEAD
git -C /fake/acme-api/.worktrees/demo-feature/_integration log --oneline master..HEAD
git -C /fake/acme-api/.worktrees/demo-feature/_integration diff --stat master...HEAD
git -C /fake/acme-web/.worktrees/demo-feature/review-fix-1 log --oneline master..HEAD
git -C /fake/acme-web/.worktrees/demo-feature/review-fix-1 diff --stat master...HEAD
```

2. When satisfied, push each branch yourself, e.g.:

```sh
git -C /fake/acme-api/.worktrees/demo-feature/api push -u origin feat/api-endpoint
git -C /fake/acme-web/.worktrees/demo-feature/ui push -u origin feat/ui-page
git -C /fake/acme-api/.worktrees/demo-feature/_integration push -u origin feat/demo-feature-integration
git -C /fake/acme-web/.worktrees/demo-feature/review-fix-1 push -u origin fix/review-1
```

3. Open the PRs manually, following each repo's commit and PR conventions.
