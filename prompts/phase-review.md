Phase: review (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}`, `{{planMd}}`, `{{statusMd}}`, `{{decisionsMd}}` and `{{tasksJsonl}}`. List every repo's integration
   branch and worktree (`<repo>/.worktrees/{{slug}}/_integration`).
2. Re-run each repo's full lint, typecheck, test and build in its integration worktree. Do not trust earlier results.
   Check `git -C <repo> status --porcelain` in the integration worktrees, and check that no branch of this run has
   an `origin/<branch>` ref.
3. Ask @oracle for the final review of all integration branches against the SPEC success criteria. Give it the repo paths,
   branch names, the diffs (`git diff <base>...<branch>`), the verify results and `{{decisionsMd}}`.
4. Save the oracle's review verbatim to `{{specsDir}}/FINAL_REVIEW.md`.
5. **At most one fix-up round.** If the review lists BLOCKER or MAJOR findings that are fixable: dispatch the fixes as new
   tasks (id `review-fix-<n>`, TaskEvents with `phase: "review"`), re-verify on the integration branch, then ask @oracle
   to re-check those findings once. Do not start a second round. Whatever remains goes into a Decision with
   `needsHumanAttention: true`.
6. Append a `Decision` of kind `other` with the final verdict. Mirror it to `{{decisionsMd}}`.
7. Append the phase-done TaskEvent for `phase:review`. Then append the `RunComplete` line to
   `{{eventsDir}}/run-complete.json` (summary in plain words, `finalReviewPath` = `{{specsDir}}/FINAL_REVIEW.md`).
   That is your last action. Do it even if some tasks are BLOCKED.

Never push, open PRs, merge to a default branch, or touch the issue tracker.
