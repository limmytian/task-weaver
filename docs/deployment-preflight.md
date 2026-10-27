# Paired public-image preflight

`scripts/deployment-preflight.mjs` prepares an operator review from a signed
release bundle and fresh, explicitly supplied deployment/node observations. It
never runs `kubectl`, pulls images on nodes, applies a patch, retries an uncertain
write or rolls back. Running it is not deployment approval. Keep instance-specific
policy, observations and output in the project's controlled deployment record,
not in the source repository. Do not include credentials or environment values.

```bash
node scripts/deployment-preflight.mjs /path/to/signed-bundle policy.json observations.json
```

The local `cosign` prerequisite must already be installed. The CLI verifies the
bundle and both exact public OCI index digests using the canonical release
workflow identity and GitHub OIDC issuer. These verification reads may contact
Sigstore/the registry; the helper does not install tools. Source tests inject
signature-command fixtures and do not contact a real cluster or public registry.

The policy selects the expected `version`, exact 40-character `commit`, and
`identity` equal to
`https://github.com/limmytian/task-weaver/.github/workflows/ce-release.yml@refs/tags/v<VERSION>`.
Only the matching formal, non-rehearsal bundle is accepted. Main-channel images,
private registry mirrors and other signers are outside this helper's current
coverage. It validates the signed checksums for `api-image.digest`,
`web-image.digest`, each application's `*-image.json` and
`*-multiarch-provenance.json`, and checks their source/version/platform agreement.

The observation contract is:

- `schemaVersion: 1` and `observedAt`: timestamp of the deployment snapshots.
- `targets.api` and `targets.web`: explicit `namespace`, `deployment` and actual
  application `container` name. Two separate Deployments are required.
- `deployments`: exported `apps/v1` Deployment objects with UID, resourceVersion,
  actual strategy, containers and init containers. Secrets are not needed.
- `nodes`: the explicitly reviewed intended node set, each with `name` and
  `platform` (`linux/arm64` or `linux/amd64`). The planner cannot infer future
  scheduler placement, autoscaling nodes or drain behavior from this list.
- `receipts`: one observation per node and per API/Web index, with `node`,
  `platform`, exact `image`, signed `childDigest`, `configDigest`, installed
  `version`, `commit`, `observedAt`, `publicPull: true` and `cached: true`.

An authorized operator must obtain receipts after actually pre-pulling both
public images on each intended node and checking the cached runtime identity.
`publicPull` must mean a public/anonymous pull was verified, not merely a private
mirror hit or a successful pull using cached credentials. These JSON observations
are operator evidence, not cryptographic node attestations: review their source
and transport. The helper cannot establish their truth or freshness by contacting
nodes. Missing, duplicate, future or older-than-five-minute observations withhold
patches and return a nonzero CLI exit. Refresh observations after slow preparation.

Even complete evidence produces `mode: offline-evidence-review` and
`liveChangeAuthorized: false`. The review includes the intended pulls and guarded
JSON patches for the selected application containers and init containers that
already use the same application repository. Unrelated database/bootstrap images,
sidecars, workload strategy and configuration are preserved. Recreate reports
possible downtime; RollingUpdate does not imply guaranteed availability.

Before an approved change, re-read live UID/resourceVersion, verify node placement
and receipts again, retain rollback image references and data recovery evidence,
and obtain owner deployment authorization. The proposed patch tests UID,
resourceVersion and every original controlled image before replacing them.
A successful patch is not health, migration or business acceptance.

If a patch response is uncertain, `reconcileDeploymentImages` can classify a
fresh observation as `target_images_observed`, `original_revision_unchanged` or
`conflict_or_unknown`. It does not replay or reverse anything. A matching image
observation does not validate other configuration or health. Rollback still
requires separately verified old images and data/migration compatibility.

```bash
node --test scripts/deployment-preflight.test.mjs
```
