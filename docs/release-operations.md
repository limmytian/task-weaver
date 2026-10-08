# Release Operations

## Ownership and approval

The release maintainer owns the version, reviewed source tag, release notes,
artifact inventory, and final publication decision. A second reviewer checks
license and third-party notices, vulnerability results, public export content,
image and package versions, and the installation rehearsal. The protected
`ce-release` GitHub environment must require approval from a release
maintainer. Registry credentials and signing keys are never committed.

The private preparation repository is never made public or used as the Git
source for a release. Transfer only the verified allowlist export into the
independent public repository. Review the legal/license decision and final
export report before creating a public release tag. A tag is annotated,
versioned as `vMAJOR.MINOR.PATCH`, and never moved. Release candidates use an
`-rc.N` suffix and cannot replace a stable version.

## Candidate gate

Version-specific curated notes in `docs/releases/VERSION.md` are canonical when
present; `release:notes` resolves their documentation links to the exact source
commit. A separate `docs/releases/VERSION.zh-CN.md` is included as
`RELEASE_NOTES.zh-CN.md` in the checksummed/signed bundle. Commit-log generation
remains the fallback for versions without curated notes. Review compatibility and
maintenance requirements in the curated notes before approving the candidate.

1. Freeze the intended public commit and confirm it is the reviewed allowlist
   export. Run the source, secret, license, vulnerability, module boundary,
   version, build, typecheck, test, and deployment checks.
2. Compare the candidate with the preceding release's package exports and
   migration journal. Review explicit breaking removals for the 0.3 transition; the retired
   in-process Pro SDK/canary is not a supported consumer. Future plugins must
   validate the actual isolated host. Rehearse a previous-minor database upgrade
   and restore from a verified backup.
3. Build API and Web images natively for Linux AMD64 and ARM64, scan the exact local candidates,
   and review native license evidence. A scan failure, missing advisory
   database, unknown license, missing notice, or unresolved High/Critical
   finding blocks promotion.
4. Package the reviewed image pair and complete evidence with
   `node scripts/package-ce-binary-candidate.mjs VERSION API_IMAGE WEB_IMAGE`
   from the clean public candidate checkout. Preserve the output as an Actions
   artifact named `ce-binary-candidate` in a trusted run in the public repository.
   Record that run ID with the review. The artifact contains Docker image
   archives, their hashes, the public commit and version, source correspondence,
   license, native replacement, layer, scan, and deployment verification.
   The manual `Prepare CE binary candidate` workflow performs source checks,
   one image build per application, source acquisition and notice verification,
   native replacement controls, layer checks, a fresh advisory scan, and an
   isolated PostgreSQL deployment. It uploads `ce-binary-candidate` only after
   every gate passes. It requires the protected `ce-candidate` environment and
   native Linux AMD64 and ARM64 runners with Cargo, Docker, curl, and tar. The
   workflow aggregates both platform candidates into `ce-binary-candidate` and
   independently loads/verifies each platform in its consumption job. New acquisition hashes
   and the complete evidence require maintainer review before promotion.
5. Record the approval, create the annotated tag, then manually dispatch the
   `CE release` workflow with that version, the reviewed `candidate_run_id`,
   and the previous tag, if any. Test the candidate-producing Actions run before
   the first release; a local image build is insufficient.

The workflow creates a deterministic public source archive, five compiled npm
tarballs, checksums, a CycloneDX source SBOM, provenance and notice files,
vulnerability reports, the corresponding-source archive, digest-pinned OCI
images with signed CycloneDX SBOM and source-provenance attestations, and
Sigstore signatures. It accepts only a successful controlled candidate run
at the tagged public commit, verifies archive hashes and image identities,
recomputes the image-bound binary gate and corresponding-source package hash, and
scans those same images again before pushing. It uses `VERSION-amd64` and
`VERSION-arm64` tags plus a signed `VERSION` multi-platform index.
The producer verifies the full acquired source tree before packaging. Raw
acquisition archives, scratch directories, compilation tools, and replacement
test binaries are omitted from the portable candidate artifact.
The candidate records both the producer's image ID and the archive's canonical
runtime configuration digest, allowing Docker manifest-based and config-based
stores to load the same verified bytes. Neither a tag nor a changed archive
can substitute for those identities.
After the images and release bundle are verified, it publishes a GitHub
Release. The registry mirror is a separate manual workflow that clones the
same public tag and publishes signed packages and images to its own registry.
Compare source commit, package hashes, and image digests across both runs.
Prerelease npm packages use the `next` dist-tag; stable packages use `latest`.
GitHub distributes the five npm tarballs as release assets. Public npm-registry
publication is a separate decision and is not performed by this workflow.

## Verify and retain artifacts

Read `ce-release.json` and verify each listed SHA-256 value before installing
or mirroring an asset. Verify each `.sigstore.json` bundle against the release
workflow identity and GitHub Actions OIDC issuer. Verify OCI signatures by
immutable digest, then compare the registry digest with `api-image.digest` or
`web-image.digest`. Do not treat a movable tag as verification evidence.

Keep the source archive, package tarballs, image digests, SBOMs, signatures,
third-party notices, vulnerability reports, release notes, CI run links, and
approval record for at least 24 months after a minor line reaches end of
support. Export expiring CI logs into the controlled release record. Do not
delete or overwrite a published version as routine cleanup.

## Security and support coordination

Receive vulnerability reports through the private channel in `SECURITY.md`.
Limit issue, branch, CI, and advisory visibility during an embargo. Confirm
affected versions, patch the public source, prepare both supported minor lines
when affected, verify artifacts and upgrades, and publish the advisory with
patched releases. Downstream extensions coordinate their own updates and
disclosures against the same fixed public Core version.

The current and immediately preceding minor lines receive fixes. Announce
planned end of support in release notes at least 30 days before a line leaves
the window when practicable; give the exact final supported patch and upgrade
target. Emergencies may shorten the notice period and must be explained in
the advisory.

If a release fails before publication, keep the draft and evidence private
and repair with a new candidate version. If an immutable artifact is already
public, publish a superseding patch and advisory rather than replacing bytes.
For deployment recovery, stop writes and restore the pre-upgrade PostgreSQL
database and matching skill-data snapshot before restarting the recorded old
image digests. See [CE Install, Upgrade, and Recovery](ce-upgrades.md).
