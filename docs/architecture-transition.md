# Unified Task Weaver Architecture Transition

Owner decision: 2026-10-01. Development now focuses on one Task Weaver application.
The CE/Pro edition split and standalone private application implementation are
retired. The old private experiments remain historical evidence; no repository
history, runtime configuration, published tag or release asset is deleted.

The next development version is 0.3.0 because public SDK/default-port/extension
migration exports and the Gateway `./module` export are removed. Gateway
`./runtime` is a first-party integration entry, not a third-party plugin loader.
Shared contracts, business services, the existing Core migration history and
Gateway execution behavior remain. There are five public packages instead of six.
No 0.3.0 release or production upgrade is performed by this cleanup.

Previous 0.2.x releases and their signed bytes remain available as historical
releases. Existing private Pro 0.2.1 consumers are intentionally unsupported by
the new development architecture. There is no automatic schema deletion: retained
experimental Pro data needs a separate explicit data-retention decision.

Legacy `ce-*` release filenames, command aliases, workflow identities and secret
names are retained as technical distribution identifiers to avoid accidentally
breaking signed-release verification and mirror operations. They no longer imply
multiple product editions. The old Pro mainline-canary workflow is removed;
future plugin compatibility work must validate physical isolation and real-host
installation rather than the retired in-process SDK. Public export still uses
`open-source.manifest.json`; private `.env` tracking remains unchanged.

Priority: clean up retired adaptations first, improve ordinary application
functionality when separately requested, and implement the plugin ecosystem only
when explicitly scheduled. No additional foundation-feature requirements are
created by this decision.
