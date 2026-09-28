# Contributing to Task Weaver

Thank you for helping improve Task Weaver. Contributions of code,
documentation, tests, issue reports, and design feedback are welcome.

## Before You Start

- Search existing issues and pull requests before opening a duplicate.
- Discuss substantial behavior, schema, or architecture changes in an issue
  before investing in implementation.
- Never include credentials, private configuration, customer data, or material
  you do not have permission to contribute.

## Development

Use the Node.js version pinned in `.node-version`, pnpm 9.15.0, PostgreSQL 16,
and pgvector. See `README.md` for the local database and configuration setup.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Follow the conventions in `AGENTS.md`. Code, comments, errors, logs, commit
messages, and repository documentation must be written in English.

## Developer Certificate of Origin

This project uses the Developer Certificate of Origin 1.1 instead of a
Contributor License Agreement. Every commit must contain a sign-off certifying
that you have the right to submit the contribution under Apache-2.0.

```bash
git commit --signoff
```

This adds a trailer like:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Use your own identity and an email address you are comfortable recording in
public Git history. If a commit is missing the trailer, amend or rebase it and
push the corrected commit. See `DCO.txt` for the full certification.

## Pull Requests

- Keep each pull request focused on one coherent change.
- Add or update tests for behavior changes.
- Update documentation when public behavior or configuration changes.
- Explain migration, compatibility, and security implications where relevant.
- Confirm that generated files and database migrations are reproducible.
- Complete the pull request checklist and respond to review feedback.

All accepted contributions are made available under the Apache License 2.0.
