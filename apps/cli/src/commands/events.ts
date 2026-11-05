import { Command } from "commander";
import { get, post } from "../client.js";
import { printJson } from "../output.js";

export function registerEvents(program: Command) {
  const events = program.command("events").description("consume scoped durable events");
  events.command("list").requiredOption("--project <id>").option("--cursor <sequence>", "exclusive cursor", "0").option("--limit <count>", "maximum inspected events", "100").option("--json").action(async o => {
    printJson(await get(`/api/v1/events?${new URLSearchParams({ projectId: o.project, cursor: o.cursor, limit: o.limit })}`));
  });
  events.command("watch").requiredOption("--project <id>").requiredOption("--consumer <name>").option("--interval <seconds>", "polling interval", "10").option("--json").action(async o => {
    const interval = Number(o.interval);
    if (!Number.isFinite(interval) || interval < 1 || interval > 3600) throw new Error("Interval must be between 1 and 3600 seconds");
    let { cursor } = await get<{ cursor: string }>(`/api/v1/events/checkpoint?${new URLSearchParams({ projectId: o.project, consumer: o.consumer })}`);
    for (;;) {
      const batch = await get<{ status: string; cursor: string; events?: unknown[] }>(`/api/v1/events?${new URLSearchParams({ projectId: o.project, cursor, limit: "100" })}`);
      printJson(batch);
      if (batch.status === "expired") throw new Error("Event cursor expired; resynchronize before continuing");
      cursor = batch.cursor;
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
  });
  events.command("cursor").requiredOption("--project <id>").requiredOption("--consumer <name>").option("--json").action(async o => {
    printJson(await get(`/api/v1/events/checkpoint?${new URLSearchParams({ projectId: o.project, consumer: o.consumer })}`));
  });
  events.command("ack").requiredOption("--project <id>").requiredOption("--consumer <name>").requiredOption("--cursor <sequence>").option("--json").action(async o => {
    printJson(await post("/api/v1/events/ack", { projectId: o.project, consumer: o.consumer, cursor: o.cursor }));
  });
}
