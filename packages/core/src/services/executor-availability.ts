import { randomUUID } from "node:crypto";
import { emit } from "@task-weaver/realtime";
import { matchDaemonTaskCapabilities } from "./daemon-capabilities";
import { and, desc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { activityLog, projects, daemons, executorAvailability, executorAvailabilityEvents, type Database } from "@task-weaver/db";
import { executorObservationSchema, executorObservationBlocks, ConflictError, NotFoundError, ValidationError, type Actor, type ExecutorObservation } from "@task-weaver/contracts";

export function availabilityRecheckAt(observation: ExecutorObservation, count: number, now: Date, random = Math.random) {
  if (observation.state === "action_required") return null;
  if (observation.state === "available" || observation.state === "unknown") return new Date(now.getTime() + 60_000);
  const delay = observation.resetAt ? Math.max(15_000, Date.parse(observation.resetAt) - now.getTime())
    : observation.retryAfterSeconds ? observation.retryAfterSeconds * 1000 : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(count, 5));
  return new Date(now.getTime() + Math.min(7 * 86400_000, delay) + Math.floor(random() * 5000));
}
export function effectiveAvailability(observation: ExecutorObservation, now = Date.now()): ExecutorObservation {
  if ((observation.source === "status_query" || observation.state === "available") && Date.parse(observation.staleAt) <= now && observation.state !== "action_required")
    return { ...observation, state: "unknown", reason: "Quota status is stale; refresh is required.", windows: observation.windows.map(window => ({ ...window, remainingPercent: null })) };
  return observation;
}
export async function reportExecutorObservation(db: Database, daemonId: string, raw: ExecutorObservation) {
  const observation = executorObservationSchema.parse(raw);
  const now = new Date();
  if (Date.parse(observation.observedAt) > now.getTime() + 5000 || Date.parse(observation.staleAt) < Date.parse(observation.observedAt)) throw new ValidationError("Invalid observation timestamps");
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
  if (!daemon?.actorId) throw new NotFoundError("Daemon not found");
  const predicate = and(eq(executorAvailability.daemonId, daemonId), eq(executorAvailability.tool, observation.tool));
  const [current] = await db.select().from(executorAvailability).where(predicate).for("update");
  if (current && current.observedAt.getTime() >= Date.parse(observation.observedAt)) return current;
  const duplicate = await db.select().from(executorAvailabilityEvents).where(and(eq(executorAvailabilityEvents.daemonId, daemonId), eq(executorAvailabilityEvents.eventId, observation.eventId))).limit(1);
  if (duplicate.length) return current;
  // Unsupported checks cannot clear a confirmed block; a successful newer process can verify recovery.
  const prior = current?.observation as ExecutorObservation | undefined;
  const confirmedRecovery = observation.state === "available" && ((observation.source === "status_query" && observation.windows.length > 0) || observation.source === "execution_success");
  const next = prior && executorObservationBlocks(prior) && !confirmedRecovery && observation.state === "unknown"
    ? { ...prior, eventId: observation.eventId, observedAt: prior.observedAt, staleAt: prior.staleAt } : observation;
  if (current && (current.profileId !== next.profileId || current.poolId !== next.poolId)) throw new ValidationError("Executor profile binding is immutable; register a new daemon identity for a different profile");
  const count = next.state === "cooling_down" ? (current?.blockCount ?? 0) + 1 : 0;
  const values = { daemonId, actorId: daemon.actorId, tool: next.tool, profileId: next.profileId, poolId: next.poolId,
    observation: next, observedAt: new Date(observation.observedAt), nextCheckAt: availabilityRecheckAt(next, count, now),
    blockCount: count, refreshRequestedAt: null, version: (current?.version ?? 0) + 1 };
  const [saved] = current ? await db.update(executorAvailability).set(values).where(predicate).returning()
    : await db.insert(executorAvailability).values(values).returning();
  await db.insert(executorAvailabilityEvents).values({ daemonId, tool: next.tool, profileId: next.profileId,
    eventId: next.eventId, state: next.state, reason: next.reason, observedAt: new Date(observation.observedAt) });
  if (prior?.state !== next.state) {
    const profiles = await listExecutorProfiles(db, daemonId);
    const configuredTools = (daemon.capabilities ?? []).map(tool => tool.replace(/^executor:/, "")).filter(tool => ["codex", "claude", "agy", "aider", "cursor"].includes(tool));
    const allBlocked = configuredTools.length > 0 && configuredTools.every(tool => profiles.some(profile => profile.tool === tool && profile.blocked));
    emit({ type: "executor_availability_changed", daemonId,
      kind: next.state === "available" && prior ? "recovered" : next.state === "action_required" ? "action_required"
        : next.state === "cooling_down" ? allBlocked ? "all_blocked" : "first_block" : "changed" });
    await db.insert(activityLog).values({ entityType: "daemon", entityId: daemonId, actorId: daemon.actorId, actorType: "agent",
      action: next.state === "available" && prior ? "executor.recovered" : next.state === "action_required" ? "executor.action_required" : "executor.availability_changed",
      metadata: { tool: next.tool, state: next.state, reason: next.reason } });
  }
  return saved;
}
export async function listExecutorProfiles(db: Database, daemonId: string) {
  const rows = await db.select().from(executorAvailability).where(eq(executorAvailability.daemonId, daemonId)).limit(5);
  const daemon = await db.query.daemons.findFirst({ where: eq(daemons.id, daemonId) });
  return Promise.all(rows.map(async row => {
    const own = row.observation as ExecutorObservation;
    // Only explicit same-actor pools share state. Query the newest substantive observation before LIMIT.
    const shared = daemon?.actorId ? (await db.select().from(executorAvailability).where(and(
      eq(executorAvailability.actorId, daemon.actorId), ne(executorAvailability.daemonId, daemonId),
      own.poolId ? eq(executorAvailability.poolId, own.poolId) : and(eq(executorAvailability.profileId, own.profileId), sql`${executorAvailability.poolId} IS NULL`), eq(executorAvailability.tool, own.tool),
      or(sql`${executorAvailability.observation}->>'state' <> 'unknown'`, sql`${executorAvailability.observation}->>'source' = 'manual_resume'`),
    )).orderBy(desc(sql`(${executorAvailability.observation}->>'observedAt')::timestamptz`)).limit(1)).map(p => p.observation as ExecutorObservation) : [];
    const ordered = [own, ...shared].sort((a,b) => Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const newest = ordered.find(item => item.state !== "unknown" || item.source === "manual_resume") ?? ordered[0]!;
    return { ...row, blocked: executorObservationBlocks(newest), observation: effectiveAvailability(newest) };
  }));
}
export async function requestExecutorRefresh(db: Database, daemonId: string, tool: string) {
  const [row] = await db.update(executorAvailability).set({ refreshRequestedAt: new Date() })
    .where(and(eq(executorAvailability.daemonId, daemonId), eq(executorAvailability.tool, tool))).returning();
  if (!row) throw new NotFoundError("Executor profile not found");
  return { requested: true, state: row.observation.state };
}
export async function listExecutorAvailabilityHistory(db: Database, daemonId: string) {
  return db.select().from(executorAvailabilityEvents).where(eq(executorAvailabilityEvents.daemonId,daemonId)).orderBy(desc(executorAvailabilityEvents.observedAt)).limit(50);
}
export async function availableDaemonCapabilities(db: Database, daemonId: string, capabilities: string[]) {
  const profiles = await listExecutorProfiles(db, daemonId);
  const blocked = new Set(profiles.filter(p => p.blocked).map(p => p.tool));
  return capabilities.filter(tool => !blocked.has(tool.replace(/^executor:/, "")));
}

export async function matchAvailableExecutor(db: Database, daemonId: string, capabilities: string[], tags: string[], projectId: string, modelConstraint?: { requestedModel?: unknown; requestedProvider?: unknown }) {
  const preferred = matchDaemonTaskCapabilities(tags, capabilities);
  const eligible = await availableDaemonCapabilities(db, daemonId, capabilities);
  if (!preferred.executorTool || eligible.includes(preferred.executorTool) || eligible.includes(`executor:${preferred.executorTool}`)) return preferred;
  if (modelConstraint?.requestedModel || modelConstraint?.requestedProvider) return { ...preferred, eligible: false, executorTool: null };
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const policy = project?.executorFallbackPolicy;
  const profiles = await listExecutorProfiles(db, daemonId);
  const authorized = policy?.allowPaidApi === false && policy.authenticationMode === "subscription"
    ? profiles.filter(profile => policy.allowedTools.includes(profile.tool) && profile.observation.authenticationMode === "subscription"
      && profile.observation.state === "available").map(profile => profile.tool) : [];
  const fallback = matchDaemonTaskCapabilities(tags, eligible.filter(tool => !["codex", "claude", "agy", "aider", "cursor"].includes(tool.replace(/^executor:/, "")) || authorized.includes(tool.replace(/^executor:/, ""))));
  return fallback.executorTool ? fallback : { ...preferred, eligible: false, executorTool: null };
}

export async function requestExecutorResume(db: Database, daemonId: string, tool: string, input: { expectedVersion: number; reason: string }, actor: Actor) {
  const predicate = and(eq(executorAvailability.daemonId, daemonId), eq(executorAvailability.tool, tool));
  const [row] = await db.select().from(executorAvailability).where(predicate).for("update");
  if (!row) throw new NotFoundError("Executor profile not found");
  if (row.version !== input.expectedVersion) throw new ConflictError("Executor status changed; reload before retrying", row.version);
  const now = new Date();
  const observation = { ...(row.observation as ExecutorObservation), eventId: randomUUID(), source: "manual_resume" as const,
    state: "unknown" as const, failure: null, confidence: "unknown" as const, observedAt: now.toISOString(), staleAt: new Date(now.getTime()+60_000).toISOString(),
    reason: "Operator authorized a bounded retry after correcting executor resources. Availability remains unverified.", windows: [], resetAt: null };
  await db.update(executorAvailability).set({ observation, observedAt: now, nextCheckAt: new Date(now.getTime()+60_000), version: row.version+1 }).where(predicate);
  await db.insert(executorAvailabilityEvents).values({ daemonId, tool, profileId: row.profileId, eventId: observation.eventId, state: "unknown", reason: observation.reason, observedAt: now });
  await db.insert(activityLog).values({ entityType: "daemon", entityId: daemonId, actorId: actor.id, actorType: actor.type, action: "executor.retry_authorized", metadata: { tool, reason: input.reason.slice(0,500) } });
  return { requested: true, state: "unknown" };
}

export async function listExecutorDaemons(db: Database, predicate: SQL = sql`false`) {
  return db.select({ id: daemons.id, name: daemons.name }).from(daemons).where(predicate).orderBy(daemons.name).limit(100);
}
