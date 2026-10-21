import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createWebhookSchema, updateWebhookSchema, listWebhookDeliveriesSchema } from "@task-weaver/contracts";
import { get, post, patch, del } from "../client.js";
import { printJson } from "../output.js";

export function registerWebhooks(program: Command) {
  const hooks = program.command("webhook").description("manage scoped outbound webhooks and durable delivery history");
  hooks.command("list").option("--project <id>").option("--json").action(async options => {
    printJson(await get(`/api/v1/webhooks${options.project ? `?projectId=${encodeURIComponent(options.project)}` : ""}`));
  });
  hooks.command("get <id>").option("--json").action(async id => printJson(await get(`/api/v1/webhooks/${id}`)));
  hooks.command("create").requiredOption("--file <path>", "JSON configuration; the signing secret is returned once").option("--json").action(async options => {
    printJson(await post("/api/v1/webhooks", createWebhookSchema.parse(JSON.parse(await readFile(options.file, "utf8")))));
  });
  hooks.command("update <id>").requiredOption("--file <path>", "JSON configuration patch").option("--json").action(async (id, options) => {
    printJson(await patch(`/api/v1/webhooks/${id}`, updateWebhookSchema.parse(JSON.parse(await readFile(options.file, "utf8")))));
  });
  hooks.command("delete <id>").option("--json").action(async id => printJson(await del(`/api/v1/webhooks/${id}`)));
  hooks.command("test <id>").option("--json").action(async id => printJson(await post(`/api/v1/webhooks/${id}/test`, {})));
  hooks.command("deliveries <id>").option("--status <status>", "pending|success|failed").option("--limit <n>", "page size", "20").option("--offset <n>", "page offset", "0").option("--json").action(async (id, options) => {
    const input = listWebhookDeliveriesSchema.parse({ status: options.status, limit: options.limit, offset: options.offset });
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)]));
    printJson(await get(`/api/v1/webhooks/${id}/deliveries?${query}`));
  });
  hooks.command("attempts <id> <deliveryId>").option("--json").action(async (id, deliveryId) => printJson(await get(`/api/v1/webhooks/${id}/deliveries/${deliveryId}/attempts`)));
  hooks.command("replay <id> <deliveryId>").option("--json").action(async (id, deliveryId) => printJson(await post(`/api/v1/webhooks/${id}/deliveries/${deliveryId}/replay`, {})));
}
