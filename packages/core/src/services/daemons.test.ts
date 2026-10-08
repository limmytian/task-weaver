import assert from "node:assert";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { subscribe } from "@task-weaver/realtime";
import {
  executorAvailability,
  activityLog,
  daemonWorkerProgress,
  daemonWorkerProgressHistory,
  daemons,
  projects,
  requirementClaims,
  requirementDependencies,
  requirements,
  taskClaims,
  taskDependencies,
  tasks,
  taskStatusLog,
} from "@task-weaver/db";
import { ValidationError } from "@task-weaver/contracts";
import {
  daemonProgressQuerySchema,
  daemonTimelineQuerySchema,
  registerDaemonSchema,
  reportDaemonProgressSchema,
} from "@task-weaver/contracts";
import {
  claimRequirement,
  heartbeatRequirementClaim,
  releaseRequirement,
} from "./claims";
import {
  addRequirementDependency as addRequirementDependencyService,
  updateRequirement,
} from "./requirements";
import { updateTaskStatus } from "./tasks";
import {
  listWorkerProgress,
  listWorkerProgressHistory,
  reconcileWorkerRun,
  reportWorkerProgress,
} from "./daemon-progress";
import {
  applyMerge,
  applyRequirement,
  applyReview,
  applyTask,
  cleanExpiredDaemons,
  explainRequirementEligibility,
  listOnlineDaemons,
  requestDaemonControl,
  registerDaemon,
  schedulerPriorityRank,
  updateDaemonStatus,
} from "./daemons";

type Row = Record<string, any>;

const projectId = "00000000-0000-4000-8000-000000000001";
const daemonA = "00000000-0000-4000-8000-0000000000a1";
const daemonB = "00000000-0000-4000-8000-0000000000b1";
const reviewerDaemon = "00000000-0000-4000-8000-0000000000c1";
const mergerDaemon = "00000000-0000-4000-8000-0000000000d1";

function collectSqlParams(value: unknown, params: unknown[] = []): unknown[] {
  if (value === null || value === undefined) return params;
  if (value instanceof Date) {
    params.push(value);
    return params;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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
    return params;
  }

  return params;
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
        return sqlText(chunk);
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) && value.every((item) => typeof item === "string")
          ? value.join("")
          : "?";
      }
      return "?";
    })
    .join("");
}

function getLastStringParam(query: unknown): string {
  const value = collectSqlParams(query).filter((param): param is string => typeof param === "string").at(-1);
  assert.ok(value, "expected SQL query to include a string parameter");
  return value;
}

function tableName(table: unknown): string {
  return String((table as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ?? "");
}

class FakeDb {
  requirements = new Map<string, Row>();
  requirementClaims = new Map<string, Row>();
  requirementDependencies: Row[] = [];
  tasks = new Map<string, Row>();
  taskClaims = new Map<string, Row>();
  daemons = new Map<string, Row>();
  projects = new Map<string, Row>();
  taskDependencies: Row[] = [];
  taskStatusLog: Row[] = [];
  activityLog: Row[] = [];
  daemonWorkerProgress = new Map<string, Row>();
  daemonWorkerProgressHistory: Row[] = [];
  executedSqlTexts: string[] = [];
  private idCounter = 1;

  query = {
    requirements: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, requirements);
        const row = id ? this.requirements.get(id) : undefined;
        if (!row) return undefined;
        if (options?.with?.tasks) {
          return {
            ...row,
            tasks: [...this.tasks.values()]
              .filter((task) => task.requirementId === row.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
          };
        }
        return row;
      },
    },
    requirementClaims: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, requirementClaims);
        return id ? this.findRequirementClaim(id) : undefined;
      },
      findMany: async () => {
        const now = new Date();
        return [...this.requirementClaims.values()]
          .filter((claim) => claim.expiresAt > now)
          .map((claim) => ({
            ...claim,
            requirement: this.requirements.get(claim.requirementId),
          }));
      },
    },
    requirementDependencies: {
      findMany: async (options: Row) => {
        const id = this.idFromWhere(options?.where, requirementDependencies);
        return this.requirementDependencies
          .filter((dep) => !id || dep.requirementId === id || dep.dependsOnRequirementId === id)
          .map((dep) => ({
            ...dep,
            requirement: this.requirements.get(dep.requirementId),
            dependsOn: this.requirements.get(dep.dependsOnRequirementId),
          }));
      },
    },
    tasks: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, tasks);
        return id ? this.tasks.get(id) : undefined;
      },
    },
    taskClaims: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, taskClaims);
        return id ? this.findTaskClaim(id) : undefined;
      },
      findMany: async () => [...this.taskClaims.values()],
    },
    taskDependencies: {
      findMany: async (options: Row) => {
        const taskId = this.idFromWhere(options?.where, taskDependencies);
        return this.taskDependencies
          .filter((dep) => !taskId || dep.taskId === taskId)
          .map((dep) => ({
            ...dep,
            dependsOn: this.tasks.get(dep.dependsOnTaskId),
          }));
      },
    },
    daemons: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, daemons);
        return id ? this.daemons.get(id) : undefined;
      },
      findMany: async (options?: Row) => {
        const oneMinuteAgo = new Date(Date.now() - 60_000);
        return [...this.daemons.values()].filter((daemon) =>
          options?.orderBy
            ? daemon.lastHeartbeatAt > oneMinuteAgo && daemon.status !== "offline"
            : daemon.lastHeartbeatAt < oneMinuteAgo && daemon.status !== "offline",
        );
      },
    },
    daemonWorkerProgress: {
      findFirst: async (options: Row) => {
        const params = collectSqlParams(options?.where);
        const daemonId = params.find(
          (value): value is string => typeof value === "string" && this.daemons.has(value),
        );
        const workerIndex = params.find((value): value is number => typeof value === "number");
        return daemonId === undefined || workerIndex === undefined
          ? undefined
          : this.daemonWorkerProgress.get(`${daemonId}:${workerIndex}`);
      },
      findMany: async (options: Row) => {
        const params = collectSqlParams(options?.where);
        const stringParams = params.filter((value): value is string => typeof value === "string");
        const workerIndex = params.find((value): value is number => typeof value === "number");
        return [...this.daemonWorkerProgress.values()]
          .filter((progress) => stringParams.length === 0 || stringParams.every((value) =>
            progress.daemonId === value
            || progress.requirementId === value
            || progress.runId === value,
          ))
          .filter((progress) => workerIndex === undefined || progress.workerIndex === workerIndex)
          .slice(0, options?.limit ?? 50);
      },
    },
    daemonWorkerProgressHistory: {
      findMany: async (options: Row) => {
        const params = collectSqlParams(options?.where);
        const stringParams = params.filter((value): value is string => typeof value === "string");
        const workerIndex = params.find((value): value is number => typeof value === "number");
        return this.daemonWorkerProgressHistory
          .filter((progress) => stringParams.length === 0 || stringParams.every((value) =>
            progress.daemonId === value
            || progress.requirementId === value
            || progress.runId === value,
          ))
          .filter((progress) => workerIndex === undefined || progress.workerIndex === workerIndex)
          .slice(0, options?.limit ?? 50);
      },
    },
    projects: {
      findFirst: async (options: Row) => {
        const id = this.idFromWhere(options?.where, projects);
        return id ? this.projects.get(id) : undefined;
      },
    },
  };

  async transaction<T>(callback: (tx: this) => Promise<T>) {
    return callback(this);
  }

  async execute(query: unknown) {
    const text = sqlText(query);
    this.executedSqlTexts.push(text);
    if (text.includes("FROM requirements") && text.includes("FOR UPDATE")) {
      const id = getLastStringParam(query);
      const requirement = this.requirements.get(id);
      return requirement
        ? [{ ...requirement, project_id: requirement.projectId, branch_name: requirement.branchName }]
        : [];
    }
    if (text.includes("FROM tasks") && text.includes("FOR UPDATE")) {
      const id = getLastStringParam(query);
      const task = this.tasks.get(id);
      return task ? [{ ...this.toTaskSqlRow(task), assignee: task.assignee ?? null }] : [];
    }
    if (text.includes("FROM requirements r") && text.includes("r.status = 'in_review'")) {
      return this.candidateRowsForStatusApply(query, "in_review");
    }
    if (text.includes("FROM requirements r") && text.includes("r.status = 'ready_to_merge'")) {
      return this.candidateRowsForStatusApply(query, "ready_to_merge");
    }
    if (text.includes("FROM tasks t") && text.includes("JOIN requirements r")) {
      return this.candidateRowsForRequirementApply(query);
    }
    if (text.includes("FROM tasks t")) {
      return this.candidateRowsForTaskApply();
    }
    return [];
  }

  select() {
    return {
      from: (table: unknown) => ({
        where: () => { assert.equal(table, executorAvailability); return { limit: async () => [] }; },
        innerJoin: () => ({
          where: (condition: unknown) => {
            if (table !== requirementDependencies) {
              throw new Error(`Unsupported select table ${tableName(table)}`);
            }
            const ids = this.idsFromCondition(condition);
            const requirementId = ids.strings.find((id) => this.requirements.has(id));
            const rows = this.requirementDependencies
              .filter((dep) => !requirementId || dep.requirementId === requirementId)
              .filter((dep) => dep.type === "blocks")
              .map((dep) => this.requirements.get(dep.dependsOnRequirementId))
              .filter((req): req is Row => Boolean(req))
              .filter((req) => req.status !== "done" && req.status !== "cancelled")
              .map((req) => ({ title: req.title, status: req.status }));
            return Promise.resolve(rows);
          },
        }),
      }),
    };
  }

  insert(table: unknown) {
    return {
      values: (values: Row) => {
        if (table === daemonWorkerProgress) {
          const key = `${values.daemonId}:${values.workerIndex}`;
          const existing = this.daemonWorkerProgress.get(key);
          const inserted = {
            id: values.id ?? `00000000-0000-4000-9000-${String(this.idCounter++).padStart(12, "0")}`,
            createdAt: values.createdAt ?? new Date(),
            ...values,
          };
          const result = (row: Row) => ({
            returning: async () => [{ ...row }],
            then: (resolve: (value: Row) => unknown) => Promise.resolve(resolve({ ...row })),
          });
          return {
            ...result(inserted),
            onConflictDoUpdate: ({ set }: { set: Row }) => {
              const row = existing ? Object.assign(existing, set) : inserted;
              this.daemonWorkerProgress.set(key, row);
              return result(row);
            },
          };
        }
        const inserted = this.insertRow(table, values);
        return {
          returning: async () => [inserted],
          then: (resolve: (value: Row) => unknown) => Promise.resolve(resolve(inserted)),
        };
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: Row) => ({
        where: (condition: unknown) => {
          const updated = this.updateRows(table, condition, values);
          return {
            returning: async () => updated,
            then: (resolve: (value: Row[]) => unknown) => Promise.resolve(resolve(updated)),
          };
        },
      }),
    };
  }

  delete(table: unknown) {
    return {
      where: (condition: unknown) => {
        const deleted = this.deleteRows(table, condition);
        return {
          returning: async () => deleted,
          then: (resolve: (value: Row[]) => unknown) => Promise.resolve(resolve(deleted)),
        };
      },
    };
  }

  addRequirement(id: string, values: Partial<Row> = {}) {
    this.requirements.set(id, {
      id,
      projectId,
      title: `Requirement ${id}`,
      description: null,
      status: "approved",
      priority: "medium",
      modelTier: "standard",
      leaseGeneration: 0,
      tags: [],
      branchName: `req/${id}`,
      createdBy: "test",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...values,
    });
  }

  addTask(id: string, requirementId: string, values: Partial<Row> = {}) {
    this.tasks.set(id, {
      id,
      projectId,
      requirementId,
      title: `Task ${id}`,
      description: null,
      status: "todo",
      priority: "medium",
      assignee: null,
      assigneeType: null,
      tags: [],
      branchName: null,
      completedAt: null,
      version: 1,
      createdBy: "test",
      createdAt: new Date(`2026-01-01T00:00:0${this.tasks.size}.000Z`),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...values,
    });
  }

  addDaemon(id: string, values: Partial<Row> = {}) {
    const now = new Date();
    this.daemons.set(id, {
      id,
      name: `Daemon ${id}`,
      status: "idle",
      controlState: "running",
      controlReason: null,
      capabilities: ["codex"],
      activeTaskIds: [],
      activeWorkerStates: [],
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      ...values,
    });
  }

  addProject(id: string, values: Partial<Row> = {}) {
    this.projects.set(id, {
      id,
      name: "Project",
      status: "active",
      ...values,
    });
  }

  private insertRow(table: unknown, values: Row) {
    const now = new Date();
    const row = {
      id: values.id ?? `00000000-0000-4000-9000-${String(this.idCounter++).padStart(12, "0")}`,
      createdAt: values.createdAt ?? now,
      ...values,
    };

    if (table === requirementClaims) this.requirementClaims.set(row.id, row);
    else if (table === taskClaims) this.taskClaims.set(row.id, row);
    else if (table === requirementDependencies) this.requirementDependencies.push(row);
    else if (table === taskStatusLog) this.taskStatusLog.push(row);
    else if (table === activityLog) this.activityLog.push(row);
    else if (table === taskDependencies) this.taskDependencies.push(row);
    else if (table === daemons) this.daemons.set(row.id, row);
    else if (table === daemonWorkerProgressHistory) this.daemonWorkerProgressHistory.push(row);
    else throw new Error(`Unsupported insert table ${tableName(table)}`);

    return row;
  }

  private updateRows(table: unknown, condition: unknown, values: Row) {
    const ids = this.idsFromCondition(condition);
    const conditionText = sqlText(condition);
    let rows = this.rowsForTable(table).filter((row) => this.matchesIds(row, ids));
    const statusFilters = ids.strings.filter((value) =>
      [
        "draft",
        "approved",
        "in_progress",
        "in_review",
        "ready_to_merge",
        "done",
        "cancelled",
        "archived",
        "todo",
      ].includes(value),
    );
    if (statusFilters.length > 0) {
      rows = rows.filter((row) => !row.status || statusFilters.includes(row.status));
    }
    if (
      table === requirements &&
      conditionText.includes("status") &&
      conditionText.includes("draft") &&
      conditionText.includes("approved")
    ) {
      rows = rows.filter((row) => row.status === "draft" || row.status === "approved");
    }
    if (table === requirements && values.status === "in_progress") {
      rows = rows.filter((row) => row.status === "draft" || row.status === "approved");
    }
    for (const row of rows) Object.assign(row, values);
    return rows;
  }

  private deleteRows(table: unknown, condition: unknown) {
    const ids = this.idsFromCondition(condition);
    const now = ids.dates.at(-1) ?? new Date();
    const rows = this.rowsForTable(table).filter((row) => {
      if (!this.matchesIds(row, ids)) return false;
      if (ids.hasDate && row.expiresAt instanceof Date) return row.expiresAt < now;
      if (ids.hasDate && row.updatedAt instanceof Date) return row.updatedAt < now;
      return true;
    });

    if (table === requirementClaims) {
      for (const row of rows) this.requirementClaims.delete(row.id);
    } else if (table === taskClaims) {
      for (const row of rows) this.taskClaims.delete(row.id);
    } else if (table === requirementDependencies) {
      this.requirementDependencies = this.requirementDependencies.filter(
        (row) => !rows.some((deleted) => deleted.id === row.id),
      );
    } else if (table === daemons) {
      for (const row of rows) this.daemons.delete(row.id);
    } else {
      throw new Error(`Unsupported delete table ${tableName(table)}`);
    }

    return rows;
  }

  private rowsForTable(table: unknown) {
    if (table === requirements) return [...this.requirements.values()];
    if (table === requirementClaims) return [...this.requirementClaims.values()];
    if (table === requirementDependencies) return this.requirementDependencies;
    if (table === tasks) return [...this.tasks.values()];
    if (table === taskClaims) return [...this.taskClaims.values()];
    if (table === daemons) return [...this.daemons.values()];
    if (table === daemonWorkerProgress) return [...this.daemonWorkerProgress.values()];
    throw new Error(`Unsupported table ${tableName(table)}`);
  }

  private idsFromCondition(condition: unknown) {
    const params = collectSqlParams(condition);
    return {
      strings: params.filter((param): param is string => typeof param === "string"),
      dates: params.filter((param): param is Date => param instanceof Date),
      hasDate: params.some((param) => param instanceof Date),
    };
  }

  private idFromWhere(where: unknown, table: unknown): string | undefined {
    if (typeof where === "function") {
      const condition = where(table, { eq });
      return this.idFromWhere(condition, table);
    }
    const params = collectSqlParams(where).filter((param): param is string => typeof param === "string");
    return params.at(-1);
  }

  private matchesIds(row: Row, ids: { strings: string[] }) {
    if (ids.strings.length === 0) return true;
    return ids.strings.some(
      (id) =>
        row.id === id ||
        row.taskId === id ||
        row.requirementId === id ||
        row.projectId === id ||
        row.status === id,
    );
  }

  private findRequirementClaim(id: string) {
    return [...this.requirementClaims.values()].find(
      (claim) => claim.id === id || claim.requirementId === id,
    );
  }

  private findTaskClaim(id: string) {
    return [...this.taskClaims.values()].find((claim) => claim.id === id || claim.taskId === id);
  }

  private candidateRowsForRequirementApply(query: unknown) {
    const now = new Date();
    const tierParams = collectSqlParams(query).filter(
      (param): param is string =>
        typeof param === "string" && ["fast", "standard", "strong"].includes(param),
    );
    return [...this.tasks.values()]
      .filter((task) => task.status === "todo")
      .filter((task) => {
        const requirement = this.requirements.get(task.requirementId);
        return requirement && ["approved", "in_progress"].includes(requirement.status);
      })
      .filter((task) => {
        if (tierParams.length === 0) return true;
        const requirement = this.requirements.get(task.requirementId);
        return requirement ? tierParams.includes(requirement.modelTier) : false;
      })
      .filter((task) => !this.hasUnfinishedRequirementBlocker(task.requirementId))
      .filter((task) => !this.hasActiveRequirementClaim(task.requirementId, now))
      .filter((task) => !this.hasActiveTaskClaim(task.id, now))
      .filter((task) => !this.hasUnfinishedBlocker(task.id))
      .sort((a, b) => {
        const reqA = this.requirements.get(a.requirementId)!;
        const reqB = this.requirements.get(b.requirementId)!;
        return (
          requirementPriority(reqA.priority) - requirementPriority(reqB.priority) ||
          taskPriority(a.priority) - taskPriority(b.priority) ||
          a.createdAt.getTime() - b.createdAt.getTime()
        );
      })
      .slice(0, 25)
      .map((task) => {
        const requirement = this.requirements.get(task.requirementId)!;
        return {
          ...this.toTaskSqlRow(task),
          requirement_title: requirement.title,
          requirement_description: requirement.description,
          requirement_status: requirement.status,
          requirement_priority: requirement.priority,
          requirement_model_tier: requirement.modelTier,
          requirement_branch_name: requirement.branchName,
        };
      });
  }

  private candidateRowsForTaskApply() {
    const now = new Date();
    return [...this.tasks.values()]
      .filter((task) => task.status === "todo")
      .filter((task) => {
        const requirement = this.requirements.get(task.requirementId);
        return requirement && ["approved", "in_progress"].includes(requirement.status);
      })
      .filter((task) => !this.hasActiveRequirementClaim(task.requirementId, now))
      .filter((task) => !this.hasActiveTaskClaim(task.id, now))
      .filter((task) => !this.hasUnfinishedBlocker(task.id))
      .map((task) => this.toTaskSqlRow(task));
  }

  private candidateRowsForStatusApply(query: unknown, status: string) {
    const now = new Date();
    const projectParams = collectSqlParams(query).filter(
      (param): param is string => typeof param === "string" && this.projects.has(param),
    );
    return [...this.requirements.values()]
      .filter((requirement) => requirement.status === status)
      .filter((requirement) => projectParams.length === 0 || projectParams.includes(requirement.projectId))
      .filter((requirement) => !this.hasActiveRequirementClaim(requirement.id, now))
      .filter((requirement) => !this.hasUnfinishedRequirementBlocker(requirement.id))
      .sort(
        (a, b) =>
          requirementPriority(a.priority) - requirementPriority(b.priority) ||
          a.updatedAt.getTime() - b.updatedAt.getTime(),
      )
      .slice(0, 25)
      .map((requirement) => ({
        ...requirement,
        project_id: requirement.projectId,
        branch_name: requirement.branchName,
        created_at: requirement.createdAt,
        updated_at: requirement.updatedAt,
      }));
  }

  private hasActiveRequirementClaim(requirementId: string, now: Date) {
    return [...this.requirementClaims.values()].some(
      (claim) => claim.requirementId === requirementId && claim.expiresAt > now,
    );
  }

  private hasActiveTaskClaim(taskId: string, now: Date) {
    return [...this.taskClaims.values()].some(
      (claim) => claim.taskId === taskId && claim.expiresAt > now,
    );
  }

  private hasUnfinishedBlocker(taskId: string) {
    return this.taskDependencies.some((dep) => {
      if (dep.taskId !== taskId || dep.type !== "blocks") return false;
      return this.tasks.get(dep.dependsOnTaskId)?.status !== "done";
    });
  }

  private hasUnfinishedRequirementBlocker(requirementId: string) {
    return this.requirementDependencies.some((dep) => {
      if (dep.requirementId !== requirementId || dep.type !== "blocks") return false;
      const blocker = this.requirements.get(dep.dependsOnRequirementId);
      return blocker && blocker.status !== "done" && blocker.status !== "cancelled";
    });
  }

  private toTaskSqlRow(task: Row) {
    return {
      ...task,
      project_id: task.projectId,
      requirement_id: task.requirementId,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    };
  }
}

function requirementPriority(priority: string) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4;
}

function taskPriority(priority: string) {
  return { urgent: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4;
}

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.addProject(projectId);
});

test("daemon identity migration keeps legacy rows adoptable", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0031_daemon_role_identity.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS "role" .* DEFAULT 'executor' NOT NULL/,
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "actor_id" text,/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "actor_type"/);
  assert.doesNotMatch(migration, /"actor_id" text NOT NULL/);
  assert.doesNotMatch(migration, /"actor_type" .* NOT NULL/);
});

test("repository retry migration persists phase routing and due time", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0033_repository_retry_routing.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "retry_phase" text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "retry_role" text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "resume_operation" text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone/);
  assert.match(
    migration,
    /"retry_role", "next_attempt_at", "delivery_status"/,
  );
});

test("repository retry policy migration makes automatic and manual routing durable", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0034_repository_retry_policy.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "retry_policy" text/);
});

test("worker progress migration separates current state from append-only history", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0035_daemon_worker_progress.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "task_weaver"\."daemon_worker_progress"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "task_weaver"\."daemon_worker_progress_history"/);
  assert.match(migration, /"lease_generation" integer NOT NULL/);
  assert.match(migration, /"run_id" uuid NOT NULL/);
  assert.match(migration, /idx_daemon_worker_progress_worker_unique/);
});

test("worker recovery migration stores workspace and handoff decisions", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0036_daemon_worker_recovery.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /"workspace_state" text DEFAULT 'unknown' NOT NULL/);
  assert.match(migration, /"recovery_disposition" text DEFAULT 'none' NOT NULL/);
  assert.match(migration, /"last_completed_task_id" uuid/);
  assert.match(migration, /"pending_diff_summary" text/);
  assert.match(migration, /"handoff_summary" text/);
});

test("repository operation checkpoint migration preserves retry progress", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0037_repository_operation_checkpoints.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /"operation_checkpoints" jsonb DEFAULT '\{\}'::jsonb NOT NULL/);
});

test("execution slice parallelism migration defaults to strict ordering", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0038_execution_slice_parallelism.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS "allow_parallel" boolean DEFAULT false NOT NULL/,
  );
});

test("daemon control migration persists operator lifecycle state", () => {
  const migration = readFileSync(
    new URL("../../../db/drizzle/0039_daemon_control_state.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /"control_state" text DEFAULT 'running' NOT NULL/);
  assert.match(migration, /"control_reason" text/);
  assert.match(migration, /"control_requested_by_type" "task_weaver"\."actor_type"/);
});

test("worker progress schema requires fenced run and lease identity", () => {
  assert.equal(reportDaemonProgressSchema.safeParse({
    runId: "00000000-0000-4000-8000-000000000101",
    workerIndex: 0,
    requirementId: "00000000-0000-4000-8000-000000000102",
    phase: "executing",
    leaseGeneration: 1,
  }).success, true);
  assert.equal(reportDaemonProgressSchema.safeParse({
    workerIndex: 0,
    requirementId: "00000000-0000-4000-8000-000000000102",
    phase: "executing",
  }).success, false);
  assert.equal(daemonProgressQuerySchema.safeParse({
    daemonId: daemonA,
    workerIndex: "0",
    limit: "25",
  }).success, true);
  assert.equal(daemonProgressQuerySchema.safeParse({ limit: "500" }).success, false);
  assert.equal(daemonTimelineQuerySchema.safeParse({
    requirementId: "00000000-0000-4000-8000-000000000102",
    limit: "100",
  }).success, true);
  assert.equal(daemonTimelineQuerySchema.safeParse({
    requirementId: "00000000-0000-4000-8000-000000000102",
    limit: "500",
  }).success, false);
});

test("fenced progress updates current state and appends immutable history", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-1", "req-1");
  const claim = await claimRequirement(db as any, "req-1", { id: "agent-a", type: "agent" }, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });

  const first = await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-1",
    phase: "executing",
    message: "Implementing progress API",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, { id: "agent-a", type: "agent" });
  const second = await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-1",
    phase: "finalizing",
    message: "Running tests",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, { id: "agent-a", type: "agent" });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.phase, "finalizing");
  assert.deepEqual(db.daemonWorkerProgressHistory.map((event) => event.phase), [
    "executing",
    "finalizing",
  ]);
  await assert.rejects(
    () => reportWorkerProgress(db as any, daemonA, {
      runId: "00000000-0000-4000-8000-000000000999",
      workerIndex: 0,
      requirementId: "req-1",
      currentTaskId: "task-1",
      phase: "executing",
      source: "daemon",
      leaseGeneration: claim.generation,
      details: {},
    }, { id: "agent-a", type: "agent" }),
    ValidationError,
  );
});

test("recovery preserves terminal work and reconciles every active task from durable progress", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-done", "req-1", {
    status: "done",
    completedAt: new Date("2026-01-01T00:05:00.000Z"),
  });
  db.addTask("task-cancelled", "req-1", { status: "cancelled" });
  db.addTask("task-active-1", "req-1", { status: "in_progress" });
  db.addTask("task-active-2", "req-1", { status: "in_progress" });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-active-2",
    phase: "executing",
    message: "Working on the second active task",
    workspaceState: "dirty",
    pendingDiffSummary: "M packages/core/src/recovery.ts",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, actor);

  const result = await reconcileWorkerRun(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    leaseGeneration: claim.generation,
    reason: "Agent process crashed",
    workspaceState: "dirty",
    pendingDiffSummary: "M packages/core/src/recovery.ts",
  }, actor);

  assert.equal(db.tasks.get("task-done")?.status, "done");
  assert.equal(db.tasks.get("task-cancelled")?.status, "cancelled");
  assert.equal(db.tasks.get("task-active-1")?.status, "todo");
  assert.equal(db.tasks.get("task-active-2")?.status, "todo");
  assert.equal(result.authoritativeTaskId, "task-active-2");
  assert.equal(result.multiActive, true);
  assert.equal(result.recoveryDisposition, "resume");
  const progress = db.daemonWorkerProgress.get(`${daemonA}:0`);
  assert.equal(progress?.currentTaskId, "task-active-2");
  assert.equal(progress?.lastCompletedTaskId, "task-done");
  assert.equal(progress?.pendingDiffSummary, "M packages/core/src/recovery.ts");
  assert.equal(progress?.retryCount, 1);
  assert.equal(db.daemonWorkerProgressHistory.at(-1)?.details.multiActive, true);
});

test("conflicted workspace quarantines uncertain work for review", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-active", "req-1", { status: "in_progress" });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });

  const result = await reconcileWorkerRun(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    leaseGeneration: claim.generation,
    reason: "Workspace preflight found merge conflicts",
    workspaceState: "conflicted",
    pendingDiffSummary: "UU packages/core/src/recovery.ts",
  }, actor);

  assert.equal(db.tasks.get("task-active")?.status, "in_review");
  assert.equal(result.recoveryDisposition, "quarantine");
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.phase, "quarantined");
});

test("recovery before a task starts leaves queued work retryable", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-queued", "req-1", { status: "todo" });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-queued",
    phase: "claiming",
    message: "Task selected but not started",
    workspaceState: "clean",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, actor);

  const result = await reconcileWorkerRun(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    leaseGeneration: claim.generation,
    reason: "Worker stopped before status transition",
    workspaceState: "clean",
  }, actor);

  assert.deepEqual(result.recoveredTaskIds, []);
  assert.equal(db.tasks.get("task-queued")?.status, "todo");
  assert.equal(result.recoveryDisposition, "retry");
});

test("finalization recovery never reopens completed tasks", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-done", "req-1", {
    status: "done",
    completedAt: new Date(),
  });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-done",
    phase: "finalizing",
    message: "Publishing completed work",
    workspaceState: "clean",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, actor);

  const result = await reconcileWorkerRun(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    leaseGeneration: claim.generation,
    reason: "Finalization failed",
    workspaceState: "clean",
  }, actor);

  assert.equal(db.tasks.get("task-done")?.status, "done");
  assert.deepEqual(result.recoveredTaskIds, []);
  assert.deepEqual(result.preservedTerminalTaskIds, ["task-done"]);
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.lastCompletedTaskId, "task-done");
});

test("progress inspection returns filtered current state and append-only history", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-1", "req-1");
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  const events: any[] = [];
  const unsubscribe = subscribe((event) => events.push(event));
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-1",
    phase: "executing",
    message: "Inspect this run",
    workspaceState: "clean",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, actor);
  unsubscribe();

  const current = await listWorkerProgress(db as any, {
    daemonId: daemonA,
    requirementId: "req-1",
    runId: claim.id,
    workerIndex: 0,
    limit: 10,
  });
  const history = await listWorkerProgressHistory(db as any, {
    runId: claim.id,
    limit: 10,
  });

  assert.equal(current.length, 1);
  assert.equal(current[0]?.message, "Inspect this run");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.source, "daemon");
  const realtimeEvent = events.find((event) => event.type === "daemon_progress_updated");
  assert.equal(realtimeEvent?.projectId, projectId);
  assert.equal(realtimeEvent?.message, "Inspect this run");
  assert.equal(realtimeEvent?.workspaceState, "clean");
});

test("daemon status uses durable progress instead of the initial heartbeat task", async () => {
  db.addDaemon(daemonA, {
    role: "executor",
    actorId: "agent-a",
    actorType: "agent",
    status: "busy",
    activeWorkerStates: [{
      index: 0,
      status: "running",
      requirementId: "req-1",
      taskId: "task-initial",
    }],
  });
  db.addRequirement("req-1");
  db.addTask("task-initial", "req-1", { status: "done" });
  db.addTask("task-actual", "req-1", { status: "in_progress" });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-1", actor, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  const daemon = db.daemons.get(daemonA)!;
  daemon.activeWorkerStates[0].runId = claim.id;
  daemon.activeWorkerStates[0].leaseGeneration = claim.generation;
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-actual",
    phase: "executing",
    message: "Working on the actual task",
    workspaceState: "dirty",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, actor);

  const online = await listOnlineDaemons(db as any);
  const worker = online[0]?.workerStates[0];
  assert.equal(worker?.taskId, "task-actual");
  assert.equal(worker?.taskTitle, "Task task-actual");
  assert.equal(worker?.progress?.message, "Working on the actual task");
  assert.equal(worker?.progress?.workspaceState, "dirty");
});

test("stale recovery after lease reassignment cannot reopen completed work", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addDaemon(daemonB, { role: "executor", actorId: "agent-b", actorType: "agent" });
  db.addRequirement("req-1");
  db.addTask("task-done", "req-1", { status: "done" });
  db.addTask("task-new", "req-1", { status: "in_progress" });
  const actorA = { id: "agent-a", type: "agent" as const };
  const firstClaim = await claimRequirement(db as any, "req-1", actorA, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  await releaseRequirement(
    db as any,
    "req-1",
    actorA,
    "handoff",
    daemonA,
    firstClaim.generation,
  );
  await claimRequirement(db as any, "req-1", { id: "agent-b", type: "agent" }, 2, {
    daemonId: daemonB,
    workerIndex: 0,
  });

  await assert.rejects(
    () => reconcileWorkerRun(db as any, daemonA, {
      runId: firstClaim.id,
      workerIndex: 0,
      requirementId: "req-1",
      leaseGeneration: firstClaim.generation,
      reason: "Late shutdown recovery",
      workspaceState: "clean",
    }, actorA),
    ValidationError,
  );
  assert.equal(db.tasks.get("task-done")?.status, "done");
  assert.equal(db.tasks.get("task-new")?.status, "in_progress");
});

test("daemon registration validates role capabilities", () => {
  assert.equal(registerDaemonSchema.safeParse({
    name: "executor",
    role: "executor",
    capabilities: [],
    workerCapacity: 1,
  }).success, false);
  assert.equal(registerDaemonSchema.safeParse({
    name: "reviewer",
    role: "reviewer",
    capabilities: ["codex"],
  }).success, false);
  assert.equal(registerDaemonSchema.safeParse({
    name: "merger",
    role: "merger",
    capabilities: ["merge"],
  }).success, true);
});

test("same live daemon registration is idempotent and preserves worker state", async () => {
  const processStartedAt = new Date("2026-01-01T00:00:00.000Z");
  db.addDaemon(daemonA, {
    role: "executor",
    actorId: "agent-a",
    actorType: "agent",
    status: "busy",
    processStartedAt,
    activeTaskIds: ["00000000-0000-4000-8000-000000000101"],
    activeWorkerStates: [{ index: 0, status: "running" }],
  });

  const registered = await registerDaemon(db as any, {
    id: daemonA,
    name: "executor-a",
    role: "executor",
    capabilities: ["codex"],
    host: "host-a",
    processStartedAt: processStartedAt.toISOString(),
    workerCapacity: 2,
  }, { id: "agent-a", type: "agent" });

  assert.equal(registered.status, "busy");
  assert.deepEqual(registered.activeTaskIds, ["00000000-0000-4000-8000-000000000101"]);
  assert.deepEqual(registered.activeWorkerStates, [{ index: 0, status: "running" }]);
  assert.equal(registered.workerCapacity, 2);
  assert.equal(registered.instanceId, daemonA);
  assert.equal(db.activityLog.at(-1)?.entityType, "daemon");
  assert.deepEqual(db.activityLog.at(-1)?.metadata, {
    instanceId: daemonA,
    role: "executor",
    host: "host-a",
    processStartedAt,
    workerCapacity: 2,
    reRegistered: true,
  });
});

test("daemon status events and activity expose role and instance ownership", async () => {
  const processStartedAt = new Date("2026-01-01T00:00:00.000Z");
  db.addDaemon(daemonA, {
    role: "reviewer",
    actorId: "agent-a",
    actorType: "agent",
    host: "host-a",
    processStartedAt,
    workerCapacity: 3,
  });
  const events: Row[] = [];
  const unsubscribe = subscribe((event) => {
    if (event.type === "daemon_status_changed") events.push(event);
  });

  try {
    const updated = await updateDaemonStatus(
      db as any,
      daemonA,
      "busy",
      [],
      [{ index: 0, status: "running" }],
      { id: "agent-a", type: "agent" },
    );

    assert.equal(updated.instanceId, daemonA);
    assert.deepEqual(events.at(-1), {
      type: "daemon_status_changed",
      daemonId: daemonA,
      instanceId: daemonA,
      role: "reviewer",
      actorId: "agent-a",
      actorType: "agent",
      host: "host-a",
      processStartedAt,
      workerCapacity: 3,
      status: "busy",
      controlState: "running",
      controlReason: null,
      activeTaskIds: [],
      activeWorkerStates: [{ index: 0, status: "running" }],
    });
    assert.deepEqual(db.activityLog.at(-1)?.metadata, {
      instanceId: daemonA,
      role: "reviewer",
      from: "idle",
      to: "busy",
      host: "host-a",
      processStartedAt,
      workerCapacity: 3,
    });
  } finally {
    unsubscribe();
  }
});

test("authorized lifecycle controls gate acquisition and drain without interrupting active work", async () => {
  db.addDaemon(daemonA, {
    role: "executor",
    actorId: "agent-a",
    actorType: "agent",
    activeWorkerStates: [{ index: 0, status: "running", requirementId: "req-active" }],
    status: "busy",
  });

  const paused = await requestDaemonControl(
    db as any,
    daemonA,
    "pause",
    "Pause acquisition during maintenance",
    { id: "operator", type: "human" },
  );
  assert.equal(paused.controlState, "paused");
  assert.equal(await applyTask(db as any, daemonA, projectId, { id: "agent-a", type: "agent" }), null);
  assert.equal(db.activityLog.at(-1)?.action, "control_requested");
  // Principal/permission checks live in the verified service factory, not this private state machine.
  const resumedByAgent = await requestDaemonControl(db as any, daemonA, "resume", "Authorized management", { id: "agent-a", type: "agent" });
  assert.equal(resumedByAgent.controlState, "running");
  await requestDaemonControl(db as any, daemonA, "pause", "Continue drain fixture", { id: "operator", type: "human" });

  const draining = await requestDaemonControl(
    db as any,
    daemonA,
    "drain",
    "Drain active workers before deployment",
    { id: "operator", type: "human" },
  );
  assert.equal(draining.controlState, "draining");
  assert.equal((db.daemons.get(daemonA)?.activeWorkerStates as Row[])[0]?.status, "running");

  const drained = await updateDaemonStatus(
    db as any,
    daemonA,
    "idle",
    [],
    [{ index: 0, status: "idle" }],
    { id: "agent-a", type: "agent" },
  );
  assert.equal(drained.controlState, "drained");

  const resumed = await requestDaemonControl(
    db as any,
    daemonA,
    "resume",
    "Deployment complete",
    { id: "operator", type: "human" },
  );
  assert.equal(resumed.controlState, "running");
});

test("live daemon registration rejects actor, role, and process identity changes", async () => {
  const processStartedAt = new Date();
  db.addDaemon(daemonA, {
    role: "executor",
    actorId: "agent-a",
    actorType: "agent",
    processStartedAt,
  });
  const input = {
    id: daemonA,
    name: "executor-a",
    role: "executor" as const,
    capabilities: ["codex"],
    processStartedAt: processStartedAt.toISOString(),
    workerCapacity: 1,
  };

  await assert.rejects(
    () => registerDaemon(db as any, input, { id: "agent-b", type: "agent" }),
    ValidationError,
  );
  await assert.rejects(
    () => registerDaemon(db as any, { ...input, role: "reviewer", capabilities: ["review"] }, {
      id: "agent-a",
      type: "agent",
    }),
    ValidationError,
  );
  await assert.rejects(
    () => registerDaemon(db as any, {
      ...input,
      processStartedAt: new Date(processStartedAt.getTime() + 1_000).toISOString(),
    }, { id: "agent-a", type: "agent" }),
    ValidationError,
  );
});

test("one actor can run three isolated daemon roles concurrently", async () => {
  const actor = { id: "shared-operator", type: "agent" as const };
  const processStartedAt = new Date("2026-07-23T12:00:00.000Z").toISOString();

  const registrations = await Promise.all([
    registerDaemon(db as any, {
      id: daemonA,
      name: "executor",
      role: "executor",
      capabilities: ["codex"],
      processStartedAt,
      workerCapacity: 2,
    }, actor),
    registerDaemon(db as any, {
      id: reviewerDaemon,
      name: "reviewer",
      role: "reviewer",
      capabilities: ["review", "codex"],
      processStartedAt,
      workerCapacity: 1,
    }, actor),
    registerDaemon(db as any, {
      id: mergerDaemon,
      name: "merger",
      role: "merger",
      capabilities: ["merge"],
      processStartedAt,
      workerCapacity: 1,
    }, actor),
  ]);

  assert.deepEqual(
    registrations.map((daemon) => [daemon.instanceId, daemon.role, daemon.actorId]),
    [
      [daemonA, "executor", actor.id],
      [reviewerDaemon, "reviewer", actor.id],
      [mergerDaemon, "merger", actor.id],
    ],
  );
  assert.equal(db.daemons.size, 3);

  db.addRequirement("req-execute", { status: "approved", priority: "critical" });
  db.addRequirement("req-review", { status: "in_review", priority: "critical" });
  db.addRequirement("req-merge", { status: "ready_to_merge", priority: "critical" });
  db.addTask("task-execute", "req-execute");
  db.addTask("task-review", "req-review", { status: "done" });
  db.addTask("task-merge", "req-merge", { status: "done" });

  const [execution, review, merge] = await Promise.all([
    applyRequirement(db as any, daemonA, projectId, 0, undefined, actor),
    applyReview(db as any, reviewerDaemon, projectId, 0, actor),
    applyMerge(db as any, mergerDaemon, projectId, 0, actor),
  ]);

  assert.equal(execution?.requirement?.id, "req-execute");
  assert.equal(review?.requirement?.id, "req-review");
  assert.equal(merge?.requirement?.id, "req-merge");
  assert.deepEqual(
    [...db.requirementClaims.values()]
      .map((claim) => [
        claim.requirementId,
        claim.claimedBy,
        claim.daemonId,
      ])
      .sort(),
    [
      ["req-execute", actor.id, daemonA],
      ["req-merge", actor.id, mergerDaemon],
      ["req-review", actor.id, reviewerDaemon],
    ],
  );

  await assert.rejects(
    () => claimRequirement(
      db as any,
      "req-execute",
      actor,
      2,
      { daemonId: reviewerDaemon },
    ),
    ValidationError,
  );
  await assert.rejects(
    () => heartbeatRequirementClaim(
      db as any,
      "req-execute",
      actor,
      2,
      reviewerDaemon,
    ),
    ValidationError,
  );
  await assert.rejects(
    () => releaseRequirement(
      db as any,
      "req-execute",
      actor,
      "wrong instance",
      reviewerDaemon,
    ),
    ValidationError,
  );
});

test("unbound legacy daemon rows cannot be adopted as a new principal", async () => {
  const legacyId = "00000000-0000-4000-8000-0000000000e1";
  const legacyStartedAt = new Date("2026-01-01T00:00:00.000Z");
  const newStartedAt = new Date("2026-07-23T12:00:00.000Z");
  db.addDaemon(legacyId, {
    role: undefined,
    actorId: undefined,
    actorType: undefined,
    status: "offline",
    capabilities: ["review"],
    activeTaskIds: ["00000000-0000-4000-8000-000000000201"],
    activeWorkerStates: [{ index: 0, status: "failed" }],
    processStartedAt: legacyStartedAt,
    lastHeartbeatAt: new Date(Date.now() - 120_000),
  });

  await assert.rejects(registerDaemon(db as any, {
    id: legacyId, name: "adopted-reviewer", role: "reviewer", capabilities: ["review", "codex"],
    host: "new-host", processStartedAt: newStartedAt.toISOString(), workerCapacity: 2,
  }, { id: "shared-operator", type: "agent" }), ValidationError);
  assert.equal(db.daemons.get(legacyId)?.actorId, undefined);
});

test("work acquisition rejects daemons registered for another role", async () => {
  db.addDaemon(daemonA, { role: "reviewer", actorId: "agent-a" });
  db.addRequirement("req-1");
  db.addTask("task-1", "req-1");

  await assert.rejects(
    () => applyRequirement(db as any, daemonA, projectId, 0),
    ValidationError,
  );
  await assert.rejects(
    () => applyMerge(db as any, daemonA, projectId, 0),
    ValidationError,
  );
  await assert.rejects(
    () => applyReview(db as any, daemonA, projectId, 0, {
      id: "different-actor",
      type: "agent",
    }),
    ValidationError,
  );
});

test("executor acquisition excludes review and merge queues", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a" });
  db.addRequirement("req-review", { status: "in_review" });
  db.addRequirement("req-merge", { status: "ready_to_merge" });
  db.addTask("task-review", "req-review");
  db.addTask("task-merge", "req-merge");

  assert.equal(await applyTask(db as any, daemonA, projectId), null);
  assert.equal(await applyRequirement(db as any, daemonA, projectId, 0), null);

  db.addRequirement("req-execution", { status: "approved" });
  db.addTask("task-execution", "req-execution", { priority: "urgent" });
  const selected = await applyRequirement(db as any, daemonA, projectId, 0);
  assert.equal(selected?.requirement?.id, "req-execution");
  assert.equal(db.requirements.get("req-execution")?.status, "in_progress");
});

test("task status changes advance authoritative worker progress automatically", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-execution", { status: "approved" });
  db.addTask("task-execution", "req-execution", { executionSliceId: null });
  db.addTask("task-next", "req-execution", { executionSliceId: null });

  const selected = await applyRequirement(db as any, daemonA, projectId, 0);
  assert.ok(selected);
  assert.equal(selected.runId, db.requirementClaims.values().next().value?.id);
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.currentTaskId, "task-execution");
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.phase, "executing");

  await updateTaskStatus(
    db as any,
    "task-execution",
    "done",
    { id: "agent-a", type: "agent" },
    "Task implementation completed",
    false,
    { daemonId: daemonA, leaseGeneration: selected.leaseGeneration },
  );

  await updateTaskStatus(
    db as any,
    "task-next",
    "in_progress",
    { id: "agent-a", type: "agent" },
    "Advancing to the next task",
    false,
    { daemonId: daemonA, leaseGeneration: selected.leaseGeneration },
  );

  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.currentTaskId, "task-next");
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.phase, "executing");
  assert.equal(db.daemonWorkerProgress.get(`${daemonA}:0`)?.version, 3);
  assert.deepEqual(db.daemonWorkerProgressHistory.map((event) => event.phase), [
    "executing",
    "task_completed",
    "executing",
  ]);
});

test("daemon acquisition SQL admits due and follow-up retries but blocks manual intervention", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a" });
  db.addRequirement("req-execution", { status: "approved" });
  db.addTask("task-execution", "req-execution");

  await applyRequirement(db as any, daemonA, projectId, 0);

  const candidateSql = db.executedSqlTexts.find(
    (text) => text.includes("FROM tasks t") && text.includes("JOIN requirements r"),
  );
  assert.ok(candidateSql, "expected requirement apply candidate SQL to be executed");
  assert.match(candidateSql, /rr\.retry_policy = 'manual'/);
  assert.match(candidateSql, /rr\.retry_policy = 'automatic'/);
  assert.match(candidateSql, /rr\.next_attempt_at > now\(\)/);
  assert.doesNotMatch(candidateSql, /rr\.retry_policy = 'after_follow_up'/);
});

test("requirement claims renew for the same holder and reject a competing holder", async () => {
  db.addRequirement("req-1");

  const first = await claimRequirement(db as any, "req-1", { id: daemonA, type: "agent" }, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  const renewed = await claimRequirement(db as any, "req-1", { id: daemonA, type: "agent" }, 5, {
    daemonId: daemonA,
    workerIndex: 1,
  });

  assert.equal(renewed.id, first.id);
  assert.equal(renewed.daemonId, daemonA);
  assert.equal(renewed.workerIndex, "1");
  assert.ok(renewed.expiresAt >= first.expiresAt);

  await assert.rejects(
    () => claimRequirement(db as any, "req-1", { id: daemonB, type: "agent" }),
    ValidationError,
  );
});

test("expired requirement leases can be reclaimed by another daemon", async () => {
  db.addRequirement("req-1");
  db.requirementClaims.set("old", {
    id: "old",
    requirementId: "req-1",
    claimedBy: daemonA,
    claimedByType: "agent",
    daemonId: daemonA,
    workerIndex: "0",
    expiresAt: new Date(Date.now() - 10_000),
    heartbeatAt: new Date(Date.now() - 20_000),
    createdAt: new Date(Date.now() - 20_000),
  });

  const claim = await claimRequirement(db as any, "req-1", { id: daemonB, type: "agent" }, 2, {
    daemonId: daemonB,
  });

  assert.equal(claim.claimedBy, daemonB);
  assert.equal([...db.requirementClaims.values()].length, 1);
  assert.equal([...db.requirementClaims.values()][0]!.id, claim.id);
});

test("stale daemon generations cannot heartbeat or release a reclaimed Requirement lease", async () => {
  const actorA = { id: "agent-a", type: "agent" as const };
  const actorB = { id: "agent-b", type: "agent" as const };
  db.addRequirement("req-1");
  db.addTask("task-1", "req-1");

  const first = await claimRequirement(db as any, "req-1", actorA, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  first.expiresAt = new Date(Date.now() - 1_000);

  const second = await claimRequirement(db as any, "req-1", actorB, 2, {
    daemonId: daemonB,
    workerIndex: 0,
  });

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(db.requirements.get("req-1")?.leaseGeneration, 2);
  await assert.rejects(
    () => heartbeatRequirementClaim(db as any, "req-1", actorA, 2, daemonA, first.generation),
    ValidationError,
  );
  await assert.rejects(
    () => releaseRequirement(db as any, "req-1", actorA, undefined, daemonA, first.generation),
    ValidationError,
  );
  await assert.rejects(
    () => updateTaskStatus(
      db as any,
      "task-1",
      "in_progress",
      actorA,
      "stale progress",
      false,
      { daemonId: daemonA, leaseGeneration: first.generation },
    ),
    ValidationError,
  );
  await assert.rejects(
    () => updateRequirement(
      db as any,
      "req-1",
      { status: "in_review", daemonId: daemonA, leaseGeneration: first.generation },
      actorA,
    ),
    ValidationError,
  );
  await assert.rejects(
    () => heartbeatRequirementClaim(db as any, "req-1", actorB, 2, daemonA, second.generation),
    ValidationError,
  );

  const task = await updateTaskStatus(
    db as any,
    "task-1",
    "in_progress",
    actorB,
    "current progress",
    false,
    { daemonId: daemonB, leaseGeneration: second.generation },
  );
  assert.equal(task.status, "in_progress");
  const requirement = await updateRequirement(
    db as any,
    "req-1",
    { status: "in_review", daemonId: daemonB, leaseGeneration: second.generation },
    actorB,
  );
  assert.equal(requirement.status, "in_review");
  const heartbeat = await heartbeatRequirementClaim(
    db as any,
    "req-1",
    actorB,
    2,
    daemonB,
    second.generation,
  );
  assert.equal(heartbeat.id, second.id);
  await releaseRequirement(db as any, "req-1", actorB, undefined, daemonB, second.generation);
  assert.equal(db.requirementClaims.size, 0);
});

test("only the requirement lease holder can heartbeat or release", async () => {
  db.addRequirement("req-1");
  await claimRequirement(db as any, "req-1", { id: daemonA, type: "agent" });

  await assert.rejects(
    () => heartbeatRequirementClaim(db as any, "req-1", { id: daemonB, type: "agent" }),
    ValidationError,
  );
  await assert.rejects(
    () => releaseRequirement(db as any, "req-1", { id: daemonB, type: "agent" }),
    ValidationError,
  );

  const heartbeat = await heartbeatRequirementClaim(db as any, "req-1", {
    id: daemonA,
    type: "agent",
  });
  assert.equal(heartbeat.claimedBy, daemonA);

  await releaseRequirement(db as any, "req-1", { id: daemonA, type: "agent" });
  assert.equal(db.requirementClaims.size, 0);
});

test("distributed requirement apply grants separate daemons separate requirement lanes", async () => {
  db.addDaemon(daemonA);
  db.addDaemon(daemonB);
  db.addRequirement("req-1", { priority: "critical" });
  db.addRequirement("req-2", { priority: "high" });
  db.addTask("task-1", "req-1", { priority: "urgent" });
  db.addTask("task-2", "req-2", { priority: "urgent" });

  const first = await applyRequirement(db as any, daemonA, projectId, 0);
  const second = await applyRequirement(db as any, daemonB, projectId, 0);

  assert.equal(first?.requirement?.id, "req-1");
  assert.equal(first?.task?.id, "task-1");
  assert.equal(second?.requirement?.id, "req-2");
  assert.equal(second?.task?.id, "task-2");
  assert.equal(db.tasks.get("task-1")?.status, "in_progress");
  assert.equal(db.tasks.get("task-2")?.status, "in_progress");
  assert.deepEqual(
    [...db.requirementClaims.values()].map((claim) => [claim.requirementId, claim.claimedBy]).sort(),
    [
      ["req-1", daemonA],
      ["req-2", daemonB],
    ],
  );
});

test("high-contention workers receive unique requirement lanes", async () => {
  const daemonIds = Array.from({ length: 12 }, (_, index) => `daemon-${index}`);
  for (const [index, daemonId] of daemonIds.entries()) {
    db.addDaemon(daemonId);
    db.addRequirement(`req-contention-${index}`, { priority: "high" });
    db.addTask(`task-contention-${index}`, `req-contention-${index}`, { priority: "high" });
  }

  const results = await Promise.all(
    daemonIds.map((daemonId, index) => applyRequirement(db as any, daemonId, projectId, index)),
  );
  const requirementIds = results.map((result) => result?.requirement?.id).filter(Boolean);

  assert.equal(requirementIds.length, 12);
  assert.equal(new Set(requirementIds).size, 12);
  assert.equal([...db.tasks.values()].every((task) => task.status === "in_progress"), true);
});

test("bounded age boosts prevent starvation without outranking the top tier", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");
  assert.equal(schedulerPriorityRank("low", new Date("2026-07-20T00:00:00.000Z"), now), 0);
  assert.equal(schedulerPriorityRank("low", new Date("2026-07-23T00:00:00.000Z"), now), 2);
  assert.equal(schedulerPriorityRank("urgent", new Date("2026-07-25T00:00:00.000Z"), now), 0);
  assert.equal(schedulerPriorityRank("high", new Date("2026-07-25T00:00:00.000Z"), now), 1);
});

test("requirement apply skips capability mismatches and blocked tasks", async () => {
  db.addDaemon(daemonA, { capabilities: ["codex"] });
  db.addRequirement("req-agy", { priority: "critical" });
  db.addRequirement("req-blocked", { priority: "high" });
  db.addRequirement("req-codex", { priority: "medium" });
  db.addTask("task-agy", "req-agy", { tags: ["tool:agy"], priority: "urgent" });
  db.addTask("blocker", "req-blocked", { status: "in_progress" });
  db.addTask("task-blocked", "req-blocked", { priority: "urgent" });
  db.taskDependencies.push({
    id: "dep-1",
    taskId: "task-blocked",
    dependsOnTaskId: "blocker",
    type: "blocks",
    createdAt: new Date(),
  });
  db.addTask("task-codex", "req-codex", { tags: ["tool:codex"], priority: "urgent" });

  const selected = await applyRequirement(db as any, daemonA, projectId, 0);

  assert.equal(selected?.requirement?.id, "req-codex");
  assert.equal(selected?.task?.id, "task-codex");
  assert.equal(db.tasks.get("task-agy")?.status, "todo");
  assert.equal(db.tasks.get("task-blocked")?.status, "todo");
});

test("requirement apply returns the first installed compatible executor", async () => {
  db.addDaemon(daemonA, {
    capabilities: ["agy", "codex", "executor:agy", "executor:codex", "docker"],
  });
  db.addRequirement("req-executor", { priority: "critical" });
  db.addTask("task-executor", "req-executor", {
    tags: ["executor:claude", "executor:codex", "capability:docker"],
    priority: "urgent",
  });

  const selected = await applyRequirement(db as any, daemonA, projectId, 0);

  assert.equal(selected?.task?.id, "task-executor");
  assert.equal(selected?.executorTool, "codex");
});

test("requirement acquisition SQL gates later and unassigned work behind ordered slices", async () => {
  db.addDaemon(daemonA);
  db.addRequirement("req-slices");
  db.addTask("task-slices", "req-slices");

  await applyRequirement(db as any, daemonA, projectId, 0);

  const candidateSql = db.executedSqlTexts.find(
    (text) => text.includes("FROM tasks t") && text.includes("JOIN requirements r"),
  );
  assert.ok(candidateSql);
  assert.match(candidateSql, /es\.allow_parallel = true/);
  assert.match(candidateSql, /earlier_slice\.order_index < es\.order_index/);
  assert.match(candidateSql, /planned_slice\.status NOT IN \('done', 'cancelled'\)/);
  assert.match(candidateSql, /EXTRACT\(EPOCH FROM \(now\(\) - r\.created_at\)\) \/ 86400/);
  assert.match(candidateSql, /EXTRACT\(EPOCH FROM \(now\(\) - t\.created_at\)\) \/ 86400/);
  assert.match(candidateSql, /r\.id ASC/);
  assert.match(candidateSql, /t\.id ASC/);
});

test("eligibility diagnostics normalize scheduler skip reasons", async () => {
  const diagnosticDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    query: {
      daemons: {
        findFirst: async () => ({
          id: daemonA,
          role: "executor",
          capabilities: ["executor:codex"],
          lastHeartbeatAt: new Date(),
        }),
      },
    },
    execute: async () => [
      {
        task_id: "task-dependency",
        requirement_id: "req-dependency",
        task_tags: [],
        candidate_count: "9",
        blocked_dependency: true,
      },
      {
        task_id: "task-capability",
        requirement_id: "req-capability",
        task_tags: ["executor:agy"],
        candidate_count: "9",
      },
      {
        task_id: "task-status",
        requirement_id: "req-status",
        task_tags: [],
        candidate_count: "9",
        blocked_status: true,
      },
      {
        task_id: "task-claim",
        requirement_id: "req-claim",
        task_tags: [],
        candidate_count: "9",
        blocked_claim: true,
      },
      {
        task_id: "task-slice",
        requirement_id: "req-slice",
        task_tags: [],
        candidate_count: "9",
        blocked_slice_order: true,
      },
      {
        task_id: "task-model",
        requirement_id: "req-model",
        task_tags: [],
        candidate_count: "9",
        blocked_model_tier: true,
      },
      {
        task_id: "task-retry",
        requirement_id: "req-retry",
        task_tags: [],
        candidate_count: "9",
        blocked_retry_time: true,
      },
      {
        task_id: "task-policy",
        requirement_id: "req-policy",
        task_tags: [],
        candidate_count: "9",
        blocked_policy: true,
      },
      {
        task_id: "task-runnable",
        requirement_id: "req-runnable",
        task_tags: [],
        candidate_count: "9",
      },
    ],
  };

  const diagnostics = await explainRequirementEligibility(
    diagnosticDb as any,
    daemonA,
    projectId,
    ["standard"],
  );

  assert.equal(diagnostics.candidateCount, 9);
  assert.equal(diagnostics.examinedCount, 9);
  assert.equal(diagnostics.runnableCount, 1);
  assert.equal(diagnostics.selectedCount, 0);
  assert.equal(diagnostics.truncated, false);
  assert.deepEqual(diagnostics.skipCounts, {
    resource_blocked: 0,
    status: 1,
    dependency: 1,
    claim: 1,
    slice_order: 1,
    capability: 1,
    model_tier: 1,
    retry_time: 1,
    policy: 1,
  });
  assert.equal(diagnostics.samples.length, 8);
});

test("requirement apply expands model tier filters as scalar SQL parameters", async () => {
  db.addDaemon(daemonA);
  db.addRequirement("req-fast", { modelTier: "fast", priority: "critical" });
  db.addRequirement("req-strong", { modelTier: "strong", priority: "high" });
  db.addTask("task-fast", "req-fast", { priority: "urgent" });
  db.addTask("task-strong", "req-strong", { priority: "urgent" });

  const selected = await applyRequirement(db as any, daemonA, projectId, 0, ["strong"]);

  assert.equal(selected?.requirement?.id, "req-strong");
  assert.equal(db.tasks.get("task-fast")?.status, "todo");
  const candidateSql = db.executedSqlTexts.find(
    (text) => text.includes("FROM tasks t") && text.includes("JOIN requirements r"),
  );
  assert.ok(candidateSql, "expected requirement apply candidate SQL to be executed");
  assert.match(candidateSql, /COALESCE\(es\.model_tier, r\.model_tier\)::text IN \(/);
  assert.doesNotMatch(candidateSql, /ANY\(/);
});

test("review apply claims in-review requirement lanes", async () => {
  db.addDaemon(daemonA, { role: "reviewer", capabilities: ["codex", "review"] });
  db.addRequirement("req-ready", { status: "in_review", priority: "critical" });
  db.addRequirement("req-active", { status: "in_progress", priority: "high" });
  db.addTask("task-ready", "req-ready", { status: "done" });

  const selected = await applyReview(db as any, daemonA, projectId, 0);

  assert.equal(selected?.requirement?.id, "req-ready");
  assert.equal(selected?.tasks[0]?.id, "task-ready");
  assert.deepEqual(selected?.repositories, []);
  assert.equal(db.requirements.get("req-ready")?.status, "in_review");
  assert.deepEqual(
    [...db.requirementClaims.values()].map((claim) => [claim.requirementId, claim.claimedBy, claim.workerIndex]),
    [["req-ready", daemonA, "0"]],
  );
});

test("merge apply claims ready-to-merge requirement lanes", async () => {
  db.addDaemon(daemonA, { role: "merger", capabilities: ["merge"] });
  db.addRequirement("req-ready", { status: "ready_to_merge", priority: "critical" });
  db.addRequirement("req-review", { status: "in_review", priority: "high" });
  db.addTask("task-ready", "req-ready", { status: "done" });

  const selected = await applyMerge(db as any, daemonA, projectId, 0);

  assert.equal(selected?.requirement?.id, "req-ready");
  assert.equal(selected?.tasks[0]?.id, "task-ready");
  assert.deepEqual(selected?.repositories, []);
  assert.equal(db.requirements.get("req-ready")?.status, "ready_to_merge");
  assert.deepEqual(
    [...db.requirementClaims.values()].map((claim) => [claim.requirementId, claim.claimedBy, claim.workerIndex]),
    [["req-ready", daemonA, "0"]],
  );
});

test("requirement blockers prevent direct claim and daemon apply", async () => {
  db.addDaemon(daemonA);
  db.addRequirement("req-upstream", { status: "in_progress", priority: "critical" });
  db.addRequirement("req-downstream", { priority: "high" });
  db.addRequirement("req-free", { priority: "medium" });
  db.addTask("task-downstream", "req-downstream", { priority: "urgent" });
  db.addTask("task-free", "req-free", { priority: "urgent" });
  db.requirementDependencies.push({
    id: "req-dep-1",
    requirementId: "req-downstream",
    dependsOnRequirementId: "req-upstream",
    type: "blocks",
    createdAt: new Date(),
  });

  await assert.rejects(
    () => claimRequirement(db as any, "req-downstream", { id: daemonA, type: "agent" }),
    ValidationError,
  );

  const selected = await applyRequirement(db as any, daemonA, projectId, 0);
  assert.equal(selected?.requirement?.id, "req-free");
  assert.equal(db.tasks.get("task-downstream")?.status, "todo");
});

test("cancelled upstream requirements unblock downstream requirement apply", async () => {
  db.addDaemon(daemonA);
  db.addRequirement("req-upstream", { status: "cancelled", priority: "critical" });
  db.addRequirement("req-downstream", { priority: "high" });
  db.addTask("task-downstream", "req-downstream", { priority: "urgent" });
  db.requirementDependencies.push({
    id: "req-dep-1",
    requirementId: "req-downstream",
    dependsOnRequirementId: "req-upstream",
    type: "blocks",
    createdAt: new Date(),
  });

  const selected = await applyRequirement(db as any, daemonA, projectId, 0);

  assert.equal(selected?.requirement?.id, "req-downstream");
  assert.equal(db.tasks.get("task-downstream")?.status, "in_progress");
});

test("requirement dependency service rejects cycles", async () => {
  db.addRequirement("req-a");
  db.addRequirement("req-b");

  await addRequirementDependencyService(
    db as any,
    "req-a",
    "req-b",
    "blocks",
    { id: daemonA, type: "agent" },
  );

  await assert.rejects(
    () =>
      addRequirementDependencyService(
        db as any,
        "req-b",
        "req-a",
        "blocks",
        { id: daemonA, type: "agent" },
      ),
    ValidationError,
  );
});

test("expired daemons recover the durable current task without reopening completed work", async () => {
  const staleHeartbeat = new Date(Date.now() - 120_000);
  db.addDaemon(daemonA, {
    actorId: "stable-executor", actorType: "agent",
    status: "busy",
    activeWorkerStates: [{ workerIndex: 0, requirementId: "req-1", taskId: "task-1" }],
    lastHeartbeatAt: staleHeartbeat,
  });
  db.addRequirement("req-1");
  db.addTask("task-1", "req-1", { status: "done", completedAt: new Date() });
  db.addTask("task-2", "req-1", { status: "in_progress" });
  const claim = await claimRequirement(db as any, "req-1", { id: "stable-executor", type: "agent" }, 2, {
    daemonId: daemonA,
    workerIndex: 0,
  });
  await reportWorkerProgress(db as any, daemonA, {
    runId: claim.id,
    workerIndex: 0,
    requirementId: "req-1",
    currentTaskId: "task-2",
    phase: "executing",
    message: "Advanced beyond the completed initial task",
    workspaceState: "clean",
    source: "daemon",
    leaseGeneration: claim.generation,
    details: {},
  }, { id: "stable-executor", type: "agent" });

  await cleanExpiredDaemons(db as any);

  assert.equal(db.daemons.get(daemonA)?.status, "offline");
  assert.deepEqual(db.daemons.get(daemonA)?.activeWorkerStates, []);
  assert.equal(db.requirementClaims.size, 0);
  assert.equal(db.tasks.get("task-1")?.status, "done");
  assert.equal(db.tasks.get("task-2")?.status, "todo");
});


test("resource interruption recovery preserves progress retry budget", async () => {
  db.addDaemon(daemonA, { role: "executor", actorId: "agent-a", actorType: "agent" });
  db.addRequirement("req-resource");
  db.addTask("task-resource", "req-resource", { status: "in_progress" });
  db.addTask("task-preserved", "req-resource", { status: "done" });
  const actor = { id: "agent-a", type: "agent" as const };
  const claim = await claimRequirement(db as any, "req-resource", actor, 2, { daemonId: daemonA, workerIndex: 0 });
  await reportWorkerProgress(db as any, daemonA, { runId: claim.id, workerIndex: 0, requirementId: "req-resource", currentTaskId: "task-resource", phase: "executing", workspaceState: "dirty", source: "daemon", leaseGeneration: claim.generation, details: {} }, actor);
  const result = await reconcileWorkerRun(db as any, daemonA, { runId: claim.id, workerIndex: 0, requirementId: "req-resource", leaseGeneration: claim.generation, resourceInterruption: true, workspaceState: "dirty", reason: "Executor quota interrupted work" }, actor);
  assert.equal(result.progress.retryCount, 0);
  assert.equal(db.tasks.get("task-resource")?.status, "todo");
  assert.equal(db.tasks.get("task-preserved")?.status, "done");
});
