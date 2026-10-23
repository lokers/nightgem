## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] `npm run type-check` passes
- [ ] `HOME=$(mktemp -d) npm test` passes
- [ ] The leak test (`test/leaks.test.ts`) passes: no personal paths, company names, real ticket keys, emails or hostnames in tracked files, fixtures or commit messages
- [ ] No test was skipped, deleted or weakened, and no `@ts-ignore` or lint suppression was added to get past a failure
- [ ] **Touches safety-critical files? (needs a maintainer review + probes extended)**
  - [ ] No
  - [ ] Yes: I listed the files below, extended `profile/corpus.txt` and the related tests, and deleted no probe
- [ ] Docs updated (README, `docs/`, `AGENTS.md`, CHANGELOG) if behaviour, commands, environment variables or the safety model changed
- [ ] Commit subjects are conventional and in sentence case (`feat: Add budget ledger`)

## Safety-critical files touched

<!-- List them and say what you tested, or write "none". See the list in CONTRIBUTING.md. -->
