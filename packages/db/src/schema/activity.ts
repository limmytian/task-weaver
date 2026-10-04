import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type", {
      enum: [
        "project",
        "task",
        "document",
        "embedding_profile",
        "embedding_generation",
        "embedding_job",
        "requirement",
        "schedule",
        "ti_agent_model_config",
        "ti_agent_policy",
        "ti_agent_run",
        "assistant_conversation",
        "assistant_message",
        "assistant_action",
        "skill_package",
        "repository",
        "daemon",
      ],
    }).notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_activity_entity").on(table.entityType, table.entityId),
    index("idx_activity_actor").on(table.actorId),
    index("idx_activity_time").on(table.createdAt),
  ],
);
