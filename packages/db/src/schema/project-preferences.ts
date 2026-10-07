import { primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { twSchema } from "./schema";
import { authActors } from "./auth";
import { projects } from "./projects";

/** Personal UI preferences never mutate shared project metadata. */
export const projectPreferences = twSchema.table(
  "project_preferences",
  {
    actorId: uuid("actor_id")
      .notNull()
      .references(() => authActors.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.projectId] })],
);
