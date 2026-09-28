# Truss practices

House rules for anyone (human or agent) working in this repo.

## Coding

- pnpm, never npm.
- Typecheck before claiming done: `pnpm -r run lint`.
- Build must stay green: `pnpm -r run build`.
- Every feature, fix, and behavior change ships with tests in the same
  commit. No exceptions for "small" changes; small bugs are still bugs.
  `pnpm test` must pass before pushing.
- Tests live in `apps/server/test/` (node:test + tsx, temp TRUSS_DATA_DIR via
  `freshServer`) and `apps/web/test/` (pure helpers + store reducers). Follow
  the existing files' pattern.
- Regressions get a regression test first, then the fix.
- Plain human language in docs and comments. No em dashes in user-facing
  copy, no AI jargon.

## Posting

- File todos for anything the user must verify by hand; label them `verify`.
- Post one report per research task. No chatter.
