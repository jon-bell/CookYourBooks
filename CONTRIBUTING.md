# Contributing to CookYourBooks

Thanks for wanting to feed the starter. Small fixes and big ideas are both welcome.

## Ground rules

- **License:** CookYourBooks is AGPL-3.0. By sending a PR you agree your contribution is offered under the same license. If you run a modified copy as a service for other people, the AGPL asks you to share your changes too.
- **Scope:** One concern per PR. A bug fix and a refactor in the same branch are hard to review.
- **Tests:** New behaviour needs a test. The bar is "would this catch the regression", not "100% coverage".

## Getting started

```bash
pnpm install
./.bin/supabase start       # local Postgres + Auth on ports 54421+
pnpm --filter @cookyourbooks/domain test
pnpm typecheck
pnpm --filter @cookyourbooks/web dev
```

See [`CLAUDE.md`](./CLAUDE.md) for the project layout and architectural conventions, and [`PLAN.md`](./PLAN.md) for the feature roadmap.

## Reporting bugs

Open a GitHub issue with:

- What you did
- What you expected
- What actually happened
- Browser/OS (or device) if relevant

A failing test or a minimal repro beats a long description.

## Sending a PR

1. Fork, branch from `main`.
2. Make the change. Keep the diff focused.
3. `pnpm typecheck` and the relevant test suites should pass locally.
4. Describe *why* the change is needed in the PR body — the *what* is in the diff.

## Security

If you think you've found a security issue, please email the maintainer instead of filing a public issue.
