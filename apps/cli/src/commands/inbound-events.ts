import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { createInboundSourceSchema, updateInboundSourceSchema } from "@task-weaver/contracts";
import { get, post, patch, del } from "../client.js";
import { printJson } from "../output.js";

export function registerInboundEvents(program: Command) {
  const source = program.command("inbound").description("manage authenticated event sources and durable action history");
  source.command("list").requiredOption("--project <id>").option("--json").action(async options => printJson(await get(`/api/v1/inbound/sources?projectId=${encodeURIComponent(options.project)}`)));
  source.command("create").requiredOption("--file <path>", "bounded source/rule JSON; returns signing secret once").option("--json").action(async options => {
    printJson(await post("/api/v1/inbound/sources", createInboundSourceSchema.parse(JSON.parse(await readFile(options.file, "utf8")))));
  });
  source.command("update <id>").requiredOption("--file <path>", "source patch JSON").option("--json").action(async (id, options) => {
    printJson(await patch(`/api/v1/inbound/sources/${id}`, updateInboundSourceSchema.parse(JSON.parse(await readFile(options.file, "utf8")))));
  });
  source.command("delete <id>").option("--json").action(async id => printJson(await del(`/api/v1/inbound/sources/${id}`)));
  source.command("events <id>").option("--json").action(async id => printJson(await get(`/api/v1/inbound/sources/${id}/events`)));
  source.command("actions <id> <eventId>").option("--json").action(async (id, eventId) => printJson(await get(`/api/v1/inbound/sources/${id}/events/${eventId}/actions`)));
  source.command("retry <id> <eventId>").option("--json").action(async (id, eventId) => printJson(await post(`/api/v1/inbound/sources/${id}/events/${eventId}/retry`, {})));
}
