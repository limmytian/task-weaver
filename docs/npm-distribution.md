# npm CLI distribution

The npm packages are not published yet. Until a release is available, use the
[checkout instructions](../README.md#cli) or the documented binary release.

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

After an authorized release is available, install or run the CLI with:

```bash
npm install --global @task-weaver/cli
# or run a one-off command
npx --package @task-weaver/cli tw --help
```

The `tw` CLI is an API client, not a Task Weaver server. Configure the API and a
scoped Key with `tw auth login --api-url <api-origin>`, then verify access with
`tw auth whoami --json`. The source checkout remains a fallback while npm
publication is unavailable. The declared Node minimum is 20; platform coverage
and the release's verified Node versions should be checked in its evidence.
