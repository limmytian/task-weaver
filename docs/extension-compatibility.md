# Extension Compatibility

Core releases publish six versioned npm packages. Extension consumers install
the released `@task-weaver/contracts` and `@task-weaver/module-sdk` packages
and, when needed, the matching Core and database packages. They must not rely
on workspace source paths or undeclared package exports.

An extension manifest declares its own semantic version and a
`supportedCoreVersion` range. Runtime composition rejects an invalid range,
an unsupported Core version, duplicate capabilities, duplicate routes, and
migration namespace conflicts. A release candidate must test the extension
against both the current supported Core release and the next Core mainline
canary. The two checks use separate installations and exact package versions.

The canary channel uses `MAJOR.MINOR.PATCH-next.COMMIT` versions. Its six
packages are built from one public mainline commit and pin one another to the
same exact canary version. It is for compatibility testing and is not a stable
release. Do not promote a candidate based only on a successful canary build:
compile the consumer, compose its manifest, exercise its API and event paths,
and rehearse its migrations on a restored PostgreSQL database for each target.

`pnpm check:ce-artifacts <previous-tarballs> <next-tarballs>` compares public
export names and requires the previous Core migration journal and SQL files
to remain an unchanged prefix. A removed export or changed historical
migration blocks promotion. This static check does not prove that a changed
TypeScript type or response schema remains compatible; consumer compilation
and integration tests provide that evidence.
