import assert from "node:assert";
import { test } from "node:test";
import {
  activityLog,
  projects,
  requirementClaims,
} from "@task-weaver/db";
import { deleteProject, updateProject } from "./projects";

type Row = Record<string, any>;

function collectSqlParams(value: unknown, params: unknown[] = []): unknown[] {
  if (value === null || value === undefined) return params;
  if (typeof value === "string") {
    params.push(value);
    return params;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSqlParams(item, params);
    return params;
  }
  if (typeof value !== "object") return params;

  const maybeChunk = value as { value?: unknown; queryChunks?: unknown[] };
  if (maybeChunk.queryChunks) {
    collectSqlParams(maybeChunk.queryChunks, params);
    return params;
  }
  if ("value" in maybeChunk) {
    const chunkValue = maybeChunk.value;
    if (Array.isArray(chunkValue) && chunkValue.every((item) => typeof item === "string")) {
      return params;
    }
    collectSqlParams(chunkValue, params);
  }
  return params;
}

class FakeProjectDb {
  projects = new Map<string, Row>();
  requirements = new Map<string, Row>();
  requirementClaims = new Map<string, Row>();
  activityLog: Row[] = [];

  query = {
    projects: {
      findFirst: async (options: Row) => {
        const id = collectSqlParams(options?.where).find((param): param is string => typeof param === "string");
        return id ? this.projects.get(id) : undefined;
      },
    },
  };

  delete(table: unknown) {
    return {
      where: (condition: unknown) => {
        const ids = collectSqlParams(condition).filter((param): param is string => typeof param === "string");
        if (table === requirementClaims) {
          const projectId = ids.at(-1);
          const reqIds = [...this.requirements.values()]
            .filter((requirement) => requirement.projectId === projectId)
            .map((requirement) => requirement.id);
          for (const claim of [...this.requirementClaims.values()]) {
            if (reqIds.includes(claim.requirementId)) this.requirementClaims.delete(claim.id);
          }
        } else if (table === projects) {
          const projectId = ids.at(-1);
          if (projectId) this.projects.delete(projectId);
        } else {
          throw new Error("Unsupported delete table");
        }
        return Promise.resolve([]);
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: Row) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            if (table !== projects) throw new Error("Unsupported update table");
            const projectId = collectSqlParams(condition)
              .filter((param): param is string => typeof param === "string")
              .at(-1);
            const project = projectId ? this.projects.get(projectId) : undefined;
            if (!project) return [];
            Object.assign(project, values);
            return [project];
          },
        }),
      }),
    };
  }

  insert(table: unknown) {
    return {
      values: (value: Row) => {
        if (table !== activityLog) throw new Error("Unsupported insert table");
        this.activityLog.push(value);
        return Promise.resolve();
      },
    };
  }
}

test("deleteProject removes requirement claims scoped to that project", async () => {
  const db = new FakeProjectDb();
  db.projects.set("project-a", { id: "project-a", name: "Project A" });
  db.projects.set("project-b", { id: "project-b", name: "Project B" });
  db.requirements.set("req-a", { id: "req-a", projectId: "project-a" });
  db.requirements.set("req-b", { id: "req-b", projectId: "project-b" });
  db.requirementClaims.set("claim-a", { id: "claim-a", requirementId: "req-a" });
  db.requirementClaims.set("claim-b", { id: "claim-b", requirementId: "req-b" });

  const result = await deleteProject(db as any, "project-a", { id: "tester", type: "agent" });

  assert.deepEqual(result, { id: "project-a" });
  assert.equal(db.projects.has("project-a"), false);
  assert.equal(db.projects.has("project-b"), true);
  assert.equal(db.requirementClaims.has("claim-a"), false);
  assert.equal(db.requirementClaims.has("claim-b"), true);
  assert.equal(db.activityLog[0]?.entityId, "project-a");
});

test("updateProject archive removes requirement claims scoped to that project", async () => {
  const db = new FakeProjectDb();
  db.projects.set("project-a", { id: "project-a", name: "Project A", status: "active" });
  db.projects.set("project-b", { id: "project-b", name: "Project B", status: "active" });
  db.requirements.set("req-a", { id: "req-a", projectId: "project-a" });
  db.requirements.set("req-b", { id: "req-b", projectId: "project-b" });
  db.requirementClaims.set("claim-a", { id: "claim-a", requirementId: "req-a" });
  db.requirementClaims.set("claim-b", { id: "claim-b", requirementId: "req-b" });

  const updated = await updateProject(
    db as any,
    "project-a",
    { status: "archived" },
    { id: "tester", type: "agent" },
  );

  assert.equal(updated.status, "archived");
  assert.equal(db.requirementClaims.has("claim-a"), false);
  assert.equal(db.requirementClaims.has("claim-b"), true);
  assert.equal(db.activityLog[0]?.action, "updated");
});
