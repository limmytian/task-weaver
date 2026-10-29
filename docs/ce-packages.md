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
: "${RELEASE_VERSION:?Set the reviewed release version}"
pnpm release:notes "$RELEASE_VERSION"
pnpm release:pack-ce "$RELEASE_VERSION"
```

The package version in all public package manifests must match the requested
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
maintainer approval. The workflow verifies the tag, assembles a source archive
and five npm tarballs, and loads the reviewed binary candidate for that exact
commit and version. It scans the candidate images, publishes versioned images
to GHCR, signs images and files with GitHub OIDC, and creates the GitHub release
from the signed bundle. Release credentials are provided by the protected
workflow environment, not stored in source. Tarballs in a release bundle do not
by themselves mean that packages have been published to npm.

Do not dispatch the publication workflow until the license, legal,
third-party, vulnerability, and release decision gates have been approved.

The CE prefix in tooling is a retained legacy distribution identifier, not an
edition boundary. 0.3.0 removes the legacy SDK/default-port/extension exports;
this breaking transition is documented in architecture-transition.md.
