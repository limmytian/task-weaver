import { createHash } from "node:crypto";
import type { tasks } from "@task-weaver/db";

export const PERFORMANCE_SEED = 20261026;
export const PERFORMANCE_TIME = new Date("2026-10-26T00:00:00Z");

export function performanceId(kind: string, index: number) {
  const hex = createHash("sha256").update(`${PERFORMANCE_SEED}:${kind}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Generate only synthetic data; scope aliases make the manifest independent of fresh login UUIDs. */
export function performanceFixture(projectIds: readonly [string, string], creators: readonly [string, string]) {
  const statuses: NonNullable<typeof tasks.$inferInsert.status>[] = [
    ...Array<"todo">(40).fill("todo"), ...Array<"in_progress">(25).fill("in_progress"),
    ...Array<"in_review">(15).fill("in_review"), ...Array<"done">(15).fill("done"),
    ...Array<"cancelled">(5).fill("cancelled"),
  ];
  const time = (index: number) => new Date(PERFORMANCE_TIME.getTime() + index);
  const requirementRows = Array.from({ length: 100 }, (_, i) => ({
    id: performanceId("requirement", i), projectId: projectIds[Math.floor(i / 50)]!,
    title: `Synthetic requirement ${i}`, description: "Synthetic requirement", status: "approved" as const,
    createdBy: creators[Math.floor(i / 50)]!, createdAt: time(i), updatedAt: time(i),
  }));
  const taskRows = Array.from({ length: 1000 }, (_, i) => ({
    id: performanceId("task", i), projectId: projectIds[Math.floor(i / 500)]!,
    requirementId: performanceId("requirement", Math.floor(i / 10)), title: `Synthetic task ${i}`,
    description: "Synthetic task body", status: statuses[i % 100]!, version: 1,
    createdBy: creators[Math.floor(i / 500)]!, createdAt: time(i), updatedAt: time(i),
    completedAt: statuses[i % 100] === "done" ? time(i) : null,
  }));
  const documentRows = Array.from({ length: 100 }, (_, i) => ({
    id: performanceId("document", i), projectId: projectIds[Math.floor(i / 50)]!,
    title: `Synthetic document ${i}`, content: "x".repeat(4096),
    createdBy: creators[Math.floor(i / 50)]!, createdAt: time(i), updatedAt: time(i),
  }));
  const dependencies = Array.from({ length: 200 }, (_, i) => ({
    id: performanceId("dependency", i), taskId: performanceId("task", Math.floor(i / 100) * 500 + i % 100 * 2 + 1),
    dependsOnTaskId: performanceId("task", Math.floor(i / 100) * 500 + i % 100 * 2),
    type: "related" as const, createdAt: time(i),
  }));
  const taskLinks = documentRows.map((d, i) => ({
    id: performanceId("document-task", i), documentId: d.id,
    taskId: performanceId("task", i < 50 ? i : i + 450), createdAt: time(i),
  }));
  const requirementLinks = documentRows.map((d, i) => ({
    id: performanceId("document-requirement", i), documentId: d.id,
    requirementId: performanceId("requirement", i), createdAt: time(i),
  }));
  const tables = { requirementRows, taskRows, documentRows, dependencies, taskLinks, requirementLinks };
  const canonical = JSON.stringify(tables, (key, value: unknown) => {
    if (key === "projectId") return `project-${projectIds.indexOf(value as string)}`;
    if (key === "createdBy") return `actor-${creators.indexOf(value as string)}`;
    return value;
  });
  return { ...tables, hash: createHash("sha256").update(canonical).digest("hex") };
}
