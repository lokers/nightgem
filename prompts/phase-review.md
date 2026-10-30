Phase: review (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}`, `{{planMd}}`, `{{statusMd}}`, `{{decisionsMd}}` and `{{tasksJsonl}}`. List every repo's integration
   branch and worktree (`<repo>/.worktrees/{{slug}}/_integration`).
2. Re-run each repo's full lint, typecheck, test and build in its integration worktree. Do not trust earlier results.
   Check `git -C <repo> status --porcelain` in the integration worktrees, and check that no branch of this run has
   an `origin/<branch>` ref.
3. Ask @oracle for the final review of all integration branches against the SPEC success criteria. Give it the repo paths,
   branch names, the diffs (`git diff <base>...<branch>`), the verify results, `{{decisionsMd}}` and the Verification matrix
   in `{{planMd}}`. It reports each criterion as met, unmet or manual.
4. Save the oracle's review verbatim to `{{specsDir}}/FINAL_REVIEW.md`.
5. **At most one fix-up round.** If the review lists BLOCKER or MAJOR findings that are fixable: dispatch the fixes as new
   tasks (id `review-fix-<n>`, TaskEvents with `phase: "review"`), re-verify on the integration branch, then ask @oracle
   to re-check those findings once. Do not start a second round. Whatever remains goes into a Decision with
   `needsHumanAttention: true`.
6. Append a `Decision` of kind `other` with the final verdict. Mirror it to `{{decisionsMd}}`.
7. Write `{{specsDir}}/MANUAL_CHECKS.md`, overwriting any older one: a `- [ ]` checklist for the human, one item per line with
   the exact steps. Include every `manual:` row of the Verification matrix in `{{planMd}}`, every success criterion the final
   review reported `manual` or `unmet`, and anything else the review could not verify (a check that could not run, a repo
   that cannot build in a worktree, behaviour that needs a browser or a device). Nothing to check: write the single line
   `None.`.
8. Append the phase-done TaskEvent for `phase:review`. Then append the `RunComplete` line to
   `{{eventsDir}}/run-complete.json` (summary in plain words, `finalReviewPath` = `{{specsDir}}/FINAL_REVIEW.md`).
   That is your last action. Do it even if some tasks are BLOCKED.

On a resumed run, files named `run-complete-attempt<n>.json` and `FINAL_REVIEW-attempt<n>.md` are the markers of an earlier
attempt. Ignore them. Review the current state of the integration branches and write fresh `FINAL_REVIEW.md` and
`run-complete.json` files.

Never push, open PRs, merge to a default branch, or touch the issue tracker.
