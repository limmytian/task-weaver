# CE Package Releases

The five current packages under `packages/` share one semantic version and one immutable
Git tag, `vMAJOR.MINOR.PATCH`. Applications remain private workspace packages
and are distributed through container images. A release candidate uses a tag
such as `v0.2.0-rc.1`; it never replaces a stable artifact.

## Version policy

- Patch: backward-compatible fixes and documentation corrections.
- Minor: backward-compatible public API, schema, or module contribution changes.
- Major: removed or incompatible public APIs, data migrations that require a
  coordinated upgrade, or changed extension semantics.
- Before `1.0.0`, breaking changes still require a new minor release and an
  explicit migration note. Patch releases remain backward compatible.
- The release notes list public API and database changes. The current and
  previous minor lines receive security fixes; older lines are unsupported.

Conventional Commit subjects (`feat:`, `fix:`, `docs:`, and `BREAKING CHANGE:`)
drive the changelog draft. Maintainers review it against API and migration
diffs before creating a signed release tag. A version cannot be reused, and
registry overwrite or tag movement is prohibited.

## Build from a public export

Run the existing allowlist exporter from the private preparation checkout. The
export directory must be empty. Review and verify the extracted candidate
before making a separate Git repository or release tag. Commit the verified
candidate into that independent public repository before generating release
notes. The private checkout and its history are never used as the public Git
source.

In a verified public export, run:

```bash
pnpm install --frozen-lockfile
pnpm check:module-boundaries
pnpm build
pnpm typecheck
pnpm test
pnpm release:verify
pnpm release:notes 0.2.0
pnpm release:pack-ce 0.2.0
```

The package version in all six source manifests must match the requested
release version. `release:pack-ce` stages only compiled JavaScript, TypeScript
declarations, Core database migrations, the license, and third-party notices.
It emits six tarballs and `release-artifacts/npm/npm-artifacts.json` containing
SHA-256 digests. Workspace dependency references become exact-line semantic
version ranges in the published manifests. Direct publication from a workspace
package is blocked by `prepublishOnly` because its development exports point
at TypeScript source.

Pass the preceding immutable tag as the second argument to `release:notes`
for later releases. The generated notes are a review draft; compare them with
the actual API and migration changes before release approval.

Before upload, install all six tarballs together in an empty project and import
their documented public exports under Node.js. Repeat the build in a clean
checkout of the same tag and compare tarball digests. Any mismatch blocks
publication until its cause is understood. Keep the tarballs, checksums,
dependency inventory, SBOM, and release-gate reports with the release record.

## Publication

The public `CE release` workflow is manually dispatched for an existing
annotated `vMAJOR.MINOR.PATCH` tag. Its `ce-release` environment must require
maintainer approval. The workflow rebuilds and verifies the tag, assembles a
source archive and six npm tarballs, scans local API and Web images, publishes
versioned images to GHCR, signs images and files with GitHub OIDC, and creates
the GitHub release from the signed bundle. Release credentials are provided by
the protected workflow environment, not stored in source.

The private Gitea registry mirror is a separate manual workflow that clones
the same public tag. It requires a repository variable `CE_PACKAGE_OWNER` and
secrets `CE_PACKAGE_TOKEN`, `CE_COSIGN_KEY_B64`, and `CE_COSIGN_PASSWORD`. The
package token needs only package write access to the intended owner. Its npm
and OCI endpoints are derived from the Gitea server URL. Restrict workflow
dispatch and secret access to release maintainers, then compare the public
source and npm checksums before accepting the mirror. Keep the signing public
key and both CI run records with the release record.

Do not dispatch either publication workflow until the license, legal,
third-party, vulnerability, and release decision gates have been approved.

The CE prefix in tooling is a retained legacy distribution identifier, not an
edition boundary. 0.3.0 removes the legacy SDK/default-port/extension exports;
this breaking transition is documented in architecture-transition.md.
