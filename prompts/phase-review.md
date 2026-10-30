Phase: review (run `{{slug}}`). Act only within this phase.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}`, `{{planMd}}`, `{{statusMd}}`, `{{decisionsMd}}` and `{{tasksJsonl}}`. List every repo's integration
   branch and worktree (`<repo>/.worktrees/{{slug}}/_integration`).
2. Re-run each repo's full lint, typecheck, test and build in its integration worktree. Do not trust earlier results.
   Check `git -C <repo> status --porcelain` in the integration worktrees, and check that no branch of this run has
   an `origin/<branch>` ref.
3. Ask @oracle for the final review of all integration branches against the SPEC success criteria. Give it the repo paths,
   branch names, the diffs (`git diff <base>...<branch>`), the verify results, `{{decisionsMd}}` and the Verification matrix
   in `{{planMd}}`, plus the list of deep tasks whose task review did not run (their latest TaskEvent has an `oracleVerdict`
   starting with `NONE`) with their review focus, which it must review. It reports each criterion as met, unmet or manual, and checks the repo's `CONSTRAINTS.md` if it has one.
   **Fail closed.** If @oracle returns no verdict (an error, a timeout, an empty answer or one without a verdict), ask once
   more. If the second try also gives no verdict, log a Decision of kind `other` with `needsHumanAttention: true` that says
   the final review did not run. Never substitute your own review for @oracle's, and never read a missing verdict as approval.
4. Save the oracle's review verbatim to `{{specsDir}}/FINAL_REVIEW.md`. If there was no verdict after the retry, write
   `VERDICT: NONE` as its first line, then one line saying why, skip step 5 and carry on from step 6.
5. **Fix rounds: at most {{reviewMaxRounds}} fix rounds.** A round is: fix, re-verify, re-check. Start from the BLOCKER and
   MAJOR findings of the review in step 3 that are fixable.
   - Dispatch the fixes as new tasks (id `review-fix-<n>`, `n` counting up across rounds, TaskEvents with `phase: "review"`).
   - Re-verify on the integration branch (full lint, typecheck, test and build, exit codes recorded).
   - Ask @oracle to re-check only the open BLOCKER and MAJOR findings: give it the list and the new diff, and ask for a
     `VERDICT:` line first. Append its answer verbatim to `{{specsDir}}/FINAL_REVIEW.md` under `## Re-check round <n>`; that
     section starts with a `VERDICT: APPROVE | APPROVE-WITH-FIXES | REJECT` line (one of the three). No verdict: ask once
     more. If the re-check did not run, you write that line yourself as `VERDICT: NONE`, with one line saying why, then stop
     the fix rounds, log a Decision with `needsHumanAttention: true`, and never judge the fixes yourself. The report reads
     every `VERDICT:` line in the file and flags the worst one.
   - Update the list. Stop early as soon as no BLOCKER or MAJOR finding is open. A finding that was not fixed in a round is
     retried at most once, in the next round; after that it stays open and is not retried.
   - Do not start a round past {{reviewMaxRounds}}, or when only findings that are not fixable remain. Whatever remains open
     goes into a Decision with `needsHumanAttention: true`.
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
