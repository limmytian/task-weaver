# Partners Gateway reference module

`@task-weaver/partners-gateway` is a source-visible reference implementation of the Task Weaver module contract. Its package root exports the Gateway HTTP client, streaming parser, configuration validators, and run-to-job conversion functions. The `/module` export contributes the worker control routes, a background runner, a scheduled-run event subscriber, and a health check. The `/worker` export contains the durable run executor and recovery loop.

The API application installs this module through `createPartnersGatewayModule(db, env)`. The module owns `/api/v1/pi-agent/worker/status` and `/api/v1/pi-agent/worker/health`; existing `tw pi worker` commands continue to call those endpoints. Run acquisition, progress, retries, terminal completion, and lease recovery use Core's `piAgentService` persistence contract. Gateway HTTP and SSE behavior is tested without a live Gateway or database.

Configuration is validated before the application starts. Set `PARTNERS_GATEWAY_URL` and `PARTNERS_GATEWAY_SERVICE_TOKEN` together to enable the runner. Worker timing and identity settings use the existing `PARTNERS_GATEWAY_WORKER_*` variables. The module configuration contribution marks `serviceToken` as sensitive. Disabled instances retain worker status and health responses for CLI compatibility.
