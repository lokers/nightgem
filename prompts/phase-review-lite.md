Phase: review, lite (run `{{slug}}`). Act only within this phase. This is the soft-stop final review: stay under 10 minutes.

No human is present. Do not ask questions. Decide and log.

1. Read `{{specMd}}`, `{{statusMd}}`, `{{decisionsMd}}` and `{{tasksJsonl}}` (the latest line per id wins). List every repo's
   integration branch and worktree (`<repo>/.worktrees/{{slug}}/_integration`). Skip `{{planMd}}` except its Verification matrix.
2. Dispatch **exactly one** @oracle review of the integration branches against the SPEC success criteria, asking it to report each criterion as met, unmet or manual. Give it the repo
   paths, branch names, the diffs (`git diff origin/<default>...<branch>`, or the local default if there is no `origin`),
   the last verify results from `{{tasksJsonl}}` and `{{decisionsMd}}`. Say what was wound down and which tasks are
   unfinished. Do not re-run builds or tests.
3. **No fix-ups and no new tasks.** Do not dispatch @fixer or @designer. Whatever is wrong or unfinished goes into a Decision
   of kind `other` with `needsHumanAttention: true`, mirrored to `{{decisionsMd}}`.
4. Save the oracle's review verbatim to `{{specsDir}}/FINAL_REVIEW.md`.
5. Write `{{specsDir}}/MANUAL_CHECKS.md`, overwriting any older one: a `- [ ]` checklist for the human, one item per line with
   the exact steps. Include every `manual:` row of the Verification matrix in `{{planMd}}` (read just that section), the
   success criteria of tasks that were not finished, and anything the review could not verify. Nothing to check: write the
   single line `None.`.
6. Append the phase-done TaskEvent for `phase:review` (`id: "phase:review"`, `state: "done"`, `phase: "review"`, `repo: "_run"`,
   `branch: "-"`, `worktree: "{{specsDir}}"`) to `{{tasksJsonl}}`. Then append the `RunComplete` line to
   `{{eventsDir}}/run-complete.json` (summary in plain words, `finalReviewPath` = `{{specsDir}}/FINAL_REVIEW.md`).
   That is your last action. Do it even if the oracle did not answer: say so in `FINAL_REVIEW.md`.

On a resumed run, files named `run-complete-attempt<n>.json` and `FINAL_REVIEW-attempt<n>.md` are the markers of an earlier
attempt. Ignore them and write fresh `FINAL_REVIEW.md` and `run-complete.json` files.

Append log lines with a quoted-delimiter heredoc (`cat >> {{tasksJsonl}} <<'EOF'`) or the write tool, never `echo "..."`.
Never use `git stash` or network git. Never push, open PRs, merge to a default branch, or touch the issue tracker.
