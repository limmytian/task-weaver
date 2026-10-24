# Workspace build reliability

Use `pnpm build`, `pnpm typecheck` and `pnpm lint` from the repository root.
These commands hold one checkout-local coordinator lock across the entire Turbo
invocation, including cache restoration. Turbo still runs independent packages
in parallel inside that coordinator. Another root invocation waits rather than
restoring or removing the same `dist` directory concurrently.

Package `build` and `typecheck` scripts use the same lock when invoked directly,
including `pnpm --filter <package> build`. A live coordinator passes its ownership
to its subprocesses so dependency builds do not deadlock trying to reacquire it.
The context is checked against the lock record and owner process; it is not a
credential or an execution authorization. Turbo passes it through without making
its random value part of cache keys. The build helper sources are cache inputs.

TypeScript builds clean their own output while holding the lock. Successful
builds validate the compiler's complete expected output set, including declaration
files and wildcard-export modules. Root builds validate again after cache restore.
The CE pack CLI holds the same lock and checks all public packages before creating
archives; each staged package is checked again. Missing or empty outputs stop
consumption with an actionable path instead of silently producing a partial
package. To replace a damaged cached output after inspection, use `pnpm build
--force`; cache bypass is a repair step, not the concurrency control mechanism.

Cancellation forwards signals to the managed command and waits for it to close
before releasing ownership. POSIX root commands use a managed process group,
including TERM-to-KILL escalation. Windows uses `taskkill /T /F` for root-tree
cancellation. Platform-specific behavior must be tested on the target platform;
the Windows path is not certified by macOS tests. Permission failures are not
silently treated as successful cleanup.

The ignored `.task-weaver/build.lock/owner.json` records the coordinator PID and
an ownership nonce. A waiter can be cancelled and otherwise times out after ten
minutes. There is deliberately no automatic stale-lock takeover: a dead PID does
not prove its descendants have stopped writing. After an abrupt coordinator kill,
inspect the record and all remaining build processes before manually removing
the stale `build.lock` directory. Do not remove a live owner's lock.

This covers the supplied scripts on one local checkout. Raw `tsc`, raw `turbo`,
custom scripts that ignore the coordinator, detached/unmanaged writers, shared
network filesystems and concurrent Next development/build processes are outside
that guarantee. Use the supported entry points, stop development servers before
production builds, and avoid sharing a checkout between uncoordinated writers.

Run the regression fixtures with:

```bash
node --test scripts/build-reliability.test.mjs
```

The fixtures exercise real competing coordinator processes, nested ownership,
wait cancellation, failure cleanup, dead inherited ownership, missing wildcard
outputs/declarations, and managed-writer cancellation before ownership release.
They do not publish packages or run deployments.
