# Binary Distribution Evidence

The Apache-2.0 project license does not replace licenses of packaged runtime,
operating-system, font, or native-library components. Source-publication checks
do not approve container distribution. Only API/Web are first-party images;
PostgreSQL remains an externally configured operator responsibility.

## Assemble Corresponding Source

Use the exact final image IDs and platform, not a different dependency installation:

```bash
node scripts/collect-image-license-evidence.mjs --platform=linux/arm64 task-weaver-api:local task-weaver-web:local
node scripts/prepare-binary-sources.mjs release-artifacts/binary-licenses
node scripts/assemble-binary-sources.mjs release-artifacts/binary-sources/source-plan.json --acquire
node scripts/vendor-binary-rust-sources.mjs release-artifacts/binary-sources/source-lock.json
node scripts/assemble-binary-sources.mjs release-artifacts/binary-sources/rust-source-plan.json
node scripts/verify-librsvg-lock.mjs release-artifacts/binary-sources/source-lock.json
node scripts/extract-binary-licenses.mjs release-artifacts/binary-sources/verified-source-lock.json
node scripts/supplement-binary-license-plan.mjs release-artifacts/binary-sources/verified-source-lock.json
node scripts/assemble-binary-sources.mjs release-artifacts/binary-sources/supplemental-source-plan.json --acquire
node scripts/extract-binary-licenses.mjs release-artifacts/binary-sources/source-lock.json
node scripts/add-rust-runtime-inputs.mjs release-artifacts/binary-sources/source-lock.json release-artifacts/binary-licenses
node scripts/assemble-binary-sources.mjs release-artifacts/binary-sources/rust-runtime-source-plan.json --acquire
node scripts/vendor-binary-rust-sources.mjs release-artifacts/binary-sources/source-lock.json --runtime-dependencies
node scripts/assemble-binary-sources.mjs release-artifacts/binary-sources/rust-runtime-dependencies-source-plan.json
node scripts/verify-librsvg-lock.mjs release-artifacts/binary-sources/source-lock.json
node scripts/extract-binary-licenses.mjs release-artifacts/binary-sources/verified-source-lock.json
node scripts/assemble-runtime-notices.mjs release-artifacts/binary-sources/verified-source-lock.json
node scripts/verify-binary-source-evidence.mjs release-artifacts/binary-sources/source-lock.json release-artifacts/binary-licenses release-artifacts/native-replacement/verification.json
node scripts/package-binary-source-evidence.mjs release-artifacts/binary-sources/source-lock.json
```

The preparation tool is deliberately restricted to the reviewed Node 24.21.0,
Alpine, Sharp 0.35.5, and sharp-libvips 1.3.4 baseline. Version or source-commit
drift requires another review, not an automatic fallback. It preserves Alpine
recipes and their local patches/configuration at the installed source commit,
checks recipe package versions against APK metadata, and validates SHA-512 and
Git blob checksums. Native build recipes and patches come from the exact tagged
upstream recipe commit. Node source uses the upstream release checksum.

Acquisition computes SHA-256 where upstream metadata does not provide one. Such
first-acquisition values must be reviewed and retained as a release input. Later
runs use that lock without `--acquire` and fail on missing/mismatched hashes.
The tools do not source APKBUILD shell code or execute downloaded build scripts.
Downloads go only to generated local evidence; no repository/image is uploaded.

The Rust vendor step archives every checksum-locked registry crate from the
librsvg release Cargo.lock, including optional/unused sources. Its coverage is
not automatically proof of the upstream post-edit build lock. The offline lock
verification replays the tagged recipe's feature removals and checks that every
post-edit dependency remains covered by the archived source superset. It uses
an isolated Cargo home and does not execute build scripts. It also verifies that
the subsequent native patch does not alter Cargo inputs. This is dependency
coverage evidence, not a full native rebuild or byte-for-byte reproducibility.
Never substitute a binary npm archive for corresponding source.

The verifier also resolves conservative normal/build dependency graphs for
`librsvg-c --all-features` on both GNU and musl Linux ARM64. Cargo resolution
still needs metadata for the complete source superset, so the delivery retains
all crate source/metadata, but removes non-target native archives/objects and
native test fixtures. Local vendor checksums are regenerated while the original
registry package checksums remain recorded. Both offline graphs must replay
unchanged against this source-only vendor. The sidecar supplies `rust-vendor/`,
not raw crate archives containing those omitted native payloads. Configure Cargo's
`source.crates-io.replace-with` to a directory source pointing at `rust-vendor`.
Graph replay does not execute build scripts or establish full rebuild success.

The native object embeds a Rust compiler commit in standard-library source paths.
The runtime-input tool requires the reviewed exact commit and dated official
channel manifest, obtains its standard-library sources, and extracts the
binary-distribution `COPYRIGHT-library.html` notice. The documentation archive is
an acquisition container only; it is not delivered as corresponding source.
Only its required notice content enters the notice bundle. The official source
package already vendors its separately locked registry dependencies; the runtime
dependency step records their exact checksums explicitly and also retains registry
acquisition provenance. Standard-library GNU/musl normal/build graphs replay
against the sanitized delivery. Non-Linux WASI native artifacts are removed from
the source package and its affected local checksums are regenerated. The raw
`rust-src` archive is acquisition-only; the corresponding source is delivered
as regular files under `rust-standard-library/source/`. This is additional
runtime coverage, not a claim that Cargo.lock covers Rust's standard library.

`assemble-runtime-notices.mjs` records explicit handling for recipe-only Alpine
MIT declarations and Rust crates outside both conservative Linux graphs. It
preserves publisher-provided source/license/author declarations and standard
license texts without inventing copyright holders. Aggregated display text uses
LF line endings; original-byte license files and hashes remain in the sidecar.
The complete generated bundle is retained as
`THIRD_PARTY_LICENSES/runtime-source-NOTICES.txt`, with its SHA-256 and runtime
versions pinned in `.release/binary-notice-baseline.json`. Both Dockerfiles copy
that bundle and baseline into the final image. Refresh these generated files
only after source/notice review; any baseline drift must fail inspection.

After rebuilding images with the reviewed notice bundle, recollect their license
evidence. `rebind-binary-source-images.mjs` may reuse an existing acquired source
lock only after exact runtime/OS/native version and native-object hash checks.
Rerun notice handling, replacement and source verification for the new identities.
Never carry a previous image's test result forward as a new passing result.

Final images copy a cleaned root filesystem into a scratch stage, preventing
removed package managers from remaining in distributed base layers. Check every
delivered layer, not just the merged filesystem:

```bash
node scripts/verify-runtime-layers.mjs task-weaver-api:local linux/arm64
node scripts/verify-runtime-layers.mjs task-weaver-web:local linux/arm64
node scripts/inspect-release-images.mjs --platform=linux/arm64 task-weaver-api:local task-weaver-web:local
```

Run the replacement test below before the evidence verifier. The verifier checks
source and extracted-text hashes, exact image identities, OS/native versions,
offline Rust-lock coverage, and replacement controls. It reports unresolved
archive notices separately and never grants distribution approval. Cargo, curl,
tar, and Docker are required; the replacement fixture downloads compiler tools
only inside its disposable container. Do not run concurrent bundle writers.

License extraction preserves regular text members from locked archives in a
fresh scratch directory, without following archive links or accepting traversal,
ownership, or executable-source instructions. Review extracted copyright and
license texts, notices, patent terms, runtime exceptions, and recipe-only
components. Common license texts supplement, not replace, upstream attribution.
For crate archives lacking notices, the supplemental step looks up root license
files at the commit recorded in that archive's published VCS metadata. It does
not invent copyright holders, substitute a current default branch, or resolve
archives without an exact commit automatically. Review those remaining gaps.
The packaging step creates a hashed candidate source/notices sidecar containing
only manifest-selected inputs and reports. Its POSIX archive ordering, ownership,
permissions, and timestamps are deterministic. It does not include scratch trees,
database backups, replacement binaries, or local credentials. Packaging does not
resolve missing notices or approve delivery conditions.

## Verify User Replacement

The Web image dynamically loads a shared libvips object. Its bundled dependencies
are statically combined into that object; this does not eliminate their licensing
or corresponding-source requirements. A user may replace the whole compatible
shared object, including a modified build, through an ordinary container mount.
No signature check, license check, or other application restriction prevents it.
Task Weaver imposes no prohibition on reverse engineering required to debug
modifications to its LGPL-covered components.

Run the isolated test with the actual local Web image:

```bash
node scripts/verify-native-replacement.mjs task-weaver-web:local linux/arm64
```

The fixture copies the existing library, changes its SONAME, and builds a
user-modified wrapper with an observable constructor and a forwarded public
function. It mounts the modified object and its dependency into the same library
directory, then checks that the marker is observed and PNG encode/read still
works under the image's non-root user, read-only filesystem, and no network.
A missing-library control must fail. Original/replacement/fixture hashes and the
image ID are recorded. Compilation tools remain in a disposable test container,
not the distributed application image.

This proves the application's replacement mechanism, **not** a complete rebuild
of the upstream static native bundle or legal approval. For a real modified
library, rebuild from the complete reviewed sources/patches/build instructions,
retain the same required ABI/SONAME, and ship all replacement dependencies in a
directory readable by the container user. Mount that directory onto the exact
native-library directory reported in `verification.json`; paths change when the
dependency/platform changes. A wrapper fixture is not a production artifact.

## Release Checklist

Before distributing API/Web binaries, verify all of the following against the
final image IDs:

- Every retained OS origin/version/source commit is covered by source and
  complete distribution patches/configuration.
- Every native bundled library and any Rust dependencies have exact source,
  applicable notices/license texts, and usable build inputs.
- The corresponding-source bundle and license-text bundle are hashed, retained,
  and made available under the required delivery conditions together with the
  binaries. A mutable homepage link is not the delivery plan.
- Node, font, OS, native, patent, and GCC runtime-exception terms are preserved
  and reviewed. Recipe-only copyright/notice coverage is explicitly resolved.
- Actual user replacement passes and the applicable LGPL distribution conditions
  are satisfied. No source-only policy exception approves these binaries.
- The final artifact's SBOM, source/provenance/secret checks, vulnerability gate,
  deployment checks, architecture scope, and owner publication checkpoint pass.

Generated evidence intentionally records `distributionApproved: false`. Only a
completed, reviewed release checklist and the owner's publication checkpoint can
approve publication. Do not treat successful acquisition or a replacement test
as blanket permission to publish.

## Independent AMD64 and ARM64 candidates

Future candidates run on native `ubuntu-24.04` (AMD64) and
`ubuntu-24.04-arm` (ARM64) runners. Each platform separately passes source,
license, native replacement, source-only Rust coverage, vulnerability, and
fresh-install gates. `merge-ce-binary-candidates.mjs` aggregates both candidates
only when their version and public source commit match. Each platform retains
its image archive, configuration digest, corresponding source and verification
reports. A missing or mismatched platform blocks aggregation.

Publication loads these archives without rebuilding. Platform manifests receive
separate signatures, SBOM attestations and source provenance. The unified OCI
index receives a signature and provenance binding both reviewed child digests;
a single platform SBOM is never presented as evidence for the entire index.
Immutable version and platform tags are checked before registry writes.

The published v0.3.0 images remain ARM64 only. Adding this pipeline does not
retroactively change an existing tag or certify AMD64 artifacts. A future
release must complete both native candidate gates and independent consumption
verification before advertising multi-architecture support. Production upgrades
remain an operator decision.

## Installed build identification

The candidate builder passes its exact public commit as `TW_BUILD_COMMIT` to
both image builds. An operator building an image manually should also supply
`--build-arg TW_BUILD_COMMIT=<full-source-commit>`; missing metadata remains
explicitly unknown. The version page identifies the Web build. REST metadata
identifies the API build separately. Set `TW_VERSION_CHECK_ENABLED=false` on
each service to disable manual outbound release checks for offline deployments.

A passing aggregate is followed by separate native consumption jobs. These
fresh runners download and load the reviewed archives, verify configuration
identity, initialize disposable PostgreSQL, exercise API create/read operations
and check both running build commits. Publication requires the entire controlled
workflow to succeed and validates the two consumption receipts against the
candidate configuration digests. Receipt checks fail closed on source, CPU,
configuration or installation drift.
