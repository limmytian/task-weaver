# npm CLI distribution

Install the published CLI from the public npm registry (Node.js 20 or newer).
A source checkout is only needed for development.

```bash
npm install --global @task-weaver/cli
tw --version
tw auth login --api-url http://localhost:3001
tw auth whoami --json
```

Replace the API origin with your instance URL and enter a scoped Key through the
hidden prompt. The CLI is an API client; API/Web container images are distributed
separately. There is no dedicated CLI container image.

To pin an immutable release, append `@<version>` to the package name. To update,
repeat the installation command. For a one-off command:

```bash
npx --package @task-weaver/cli tw --help
```

## Release workflow

A release candidate consists of `@task-weaver/cli` and its five shared runtime
packages. The release pipeline builds the package set with
`pnpm release:pack-cli <version> <output-directory>`. The CLI manifest and every
internal dependency use the selected release version; prereleases use exact
internal versions. The staged CLI includes compiled code and license notices,
not workspace source, tests, maps, or build logs.

`pnpm release:publish-cli <version> <output-directory> --dry-run` checks the
inventory, archive checksums, package identities, dependency order and registry
conflicts, then runs npm's publish dry-run. This does not establish registry
ownership or publish packages. It selects `next` for prereleases and `latest` for
stable versions.

The manual `npm-cli-release.yml` workflow prepares the artifacts and defaults to
no publication. Its optional publishing job requires the exact `v<version>` tag,
a GitHub-hosted runner and the `npm-release` environment. Before enabling a
real publication, protect that environment with the owner's required approval,
configure npm trusted publishing for each package with this exact workflow and
repository, and separately authorize the release. npm trusted-publisher setup
can expire if its first successful publish is delayed; configure it when the
release is ready. An unpublished package staged on npm creates a public
placeholder, so staging also requires publication authorization.

The source checkout and documented binary distribution remain alternatives.
The declared Node minimum is 20; platform coverage and the release's verified
Node versions should be checked in its evidence.
