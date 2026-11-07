# PostgreSQL driver patch

The `postgres@3.4.8` patch guards a deferred write after its connection closes
and rejects the pending query. It adapts the fix proposed in
[postgres.js pull request 1209](https://github.com/porsager/postgres/pull/1209),
for the socket error reported in [issue 1208](https://github.com/porsager/postgres/issues/1208).
The driver is distributed under the MIT license. Reassess this patch when the
driver is upgraded; `pnpm test:execution-recovery-postgres` exercises the failure.
