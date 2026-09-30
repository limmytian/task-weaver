# Release Gates

Task Weaver release candidates must pass the local release gates before a
maintainer approves publication.

## Run the gates

Use a clean checkout with the pinned Node.js and pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm check:module-boundaries
pnpm release:verify
```

The module boundary command checks package imports, package exports, and static
dependency direction. The release verification command writes deterministic
reports to `release-artifacts/` and checks:

- package license metadata and reviewed license policy exceptions;
- a CycloneDX JSON software bill of materials;
- SHA-256 source provenance and release-artifact inventories;
- secret patterns without printing matched values;
- high and critical vulnerabilities reported by the configured pnpm registry;
- required third-party notice entries.

The license gate also collects the license and attribution files found in the
installed packages into `dependency-license-texts.txt`. Container builds preserve
this file along with the project notices. Inventory each final image separately;
the installed dependency inventory is specific to the runner's platform and is
not a complete inventory of the operating system or traced server bundles.

`SOURCE_DATE_EPOCH` may be set to a Unix timestamp. It defaults to zero so that
generated reports remain byte-for-byte reproducible for identical inputs.

Individual commands are available as `release:licenses`, `release:sbom`,
`release:provenance`, `release:secrets`, and `release:vulnerabilities`.

## Failure policy

Unknown or unapproved license expressions, missing package license metadata,
missing notice entries, detected secret patterns, and unreviewed high or
critical vulnerabilities fail the release. Reviewed exceptions must be narrow,
version bounded, justified, owned, dated, and stored in
`.release/release-policy.json`. License exceptions with a review deadline fail
after that date.

The LGPL exception recorded for the optional prebuilt libvips dependency applies
only to source publication and dependency inventory. It does not approve an npm
tarball or container image. Binary artifacts require filesystem-level license
inspection and confirmation of corresponding-source and relinking obligations.

## Data handling

License, SBOM, provenance, artifact, and secret checks run entirely on the local
runner. The vulnerability gate invokes `pnpm audit`, which sends dependency
names and versions to the audit endpoint configured for the package registry.
It does not send repository files. Run the gate only with an approved registry;
set `TASK_WEAVER_AUDIT_REGISTRY` to require an exact registry origin.

Generated reports are evidence, not source-controlled release inputs. Review and
archive them with the release record. Never bypass a failed gate silently.

## Container images

Only API and Web are first-party release images; all packages and layers inside
those images remain in scope. PostgreSQL is an operator-owned external service.
Optional database examples/compatibility fixtures are not repackaged, published,
or silently certified by Task Weaver. Scan them separately as deployment evidence,
not as a first-party artifact gate or a blanket vulnerability exception.

Install Syft and Grype from their official distributions. Record their versions
and the Grype database status in the release evidence, then inspect locally built
images:

```bash
node scripts/inspect-release-images.mjs task-weaver-api:local task-weaver-web:local
node scripts/inspect-release-images.mjs --platform=linux/arm64 task-weaver-api:local task-weaver-web:local
```

The command reads the local Docker image store, generates an image-specific
CycloneDX SBOM, and compares it with Grype's downloaded advisory database. It
stores image IDs, platforms, sizes, SBOM hashes, and vulnerability reports in
`release-artifacts/images/`. High and critical image findings block a container
release, including findings for which no fix is available. A scanner error or
an unavailable advisory database also blocks the check.

Review the license texts and native components in each final image separately.
The source-publication exception for libvips is not approval to distribute its
binaries.

`--external` writes optional database/deployment findings to `external-images/`
without treating them as first-party artifact approval. Scanner failures still
fail the command. Scanner versions and advisory-database metadata are retained.

Collect final-image license evidence with:

```bash
node scripts/collect-image-license-evidence.mjs --platform=linux/arm64 task-weaver-api:local task-weaver-web:local
```

This inventories OS source-package versions and preserved copyright texts, Node
license text, font/native-addon hashes, and native-library versions. It records
remaining obligations; it never grants binary-distribution approval. The pinned
Sharp/libvips notice is a starting point, not a corresponding-source bundle.
Before publishing binaries, archive exact corresponding source/build inputs,
preserve each applicable license, and review a usable replacement/relinking
procedure. A generic upstream homepage or notice alone is insufficient.

See [Binary Distribution Evidence](binary-distribution.md) for the version-bound
source-bundle/notice pipeline and an isolated modified-library replacement test.
Acquisition and replacement reports are evidence, not publication approval.
