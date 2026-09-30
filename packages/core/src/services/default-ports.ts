import { randomUUID } from "node:crypto";
import type {
  AccessDecision,
  AuditEvent,
  AuditPort,
  AuthorizationPort,
  EntitlementPort,
  IdentityPort,
  IdentityRequest,
  IdentityResult,
  MeteringEvent,
  MeteringPort,
  NotificationMessage,
  NotificationPort,
  NotificationResult,
  SecretRequest,
  SecretStorePort,
  TaskWeaverRuntimePorts,
} from "@task-weaver/module-sdk/ports";

const ENV_SECRET_REFERENCE = /^env:([A-Z_][A-Z0-9_]*)$/i;

export class SecretReferenceError extends Error {
  readonly code = "secret_reference_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SecretReferenceError";
  }
}

export class SingleInstanceIdentityPort implements IdentityPort {
  resolveIdentity(request: IdentityRequest): IdentityResult {
    if (request.existingActor) {
      return {
        actor: request.existingActor,
        authenticated: true,
        authenticationMethod: "existing",
      };
    }

    const id = request.headers["x-actor-id"] || "anonymous";
    const type = request.headers["x-actor-type"] === "agent" ? "agent" : "human";
    return {
      actor: { id, type },
      authenticated: id !== "anonymous",
      authenticationMethod: id === "anonymous" ? "anonymous" : "trusted-header",
    };
  }
}

export class AllowAllAuthorizationPort implements AuthorizationPort {
  authorize(): AccessDecision {
    return { allowed: true, policy: "single-instance-default" };
  }
}

export class AllowAllEntitlementPort implements EntitlementPort {
  checkEntitlement(): AccessDecision {
    return { allowed: true, policy: "core-capabilities-default" };
  }
}

export class EnvironmentSecretStorePort implements SecretStorePort {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  resolveSecret(request: SecretRequest): string {
    const environmentName = ENV_SECRET_REFERENCE.exec(request.reference)?.[1];
    if (!environmentName) {
      throw new SecretReferenceError("Secret references must use the 'env:VARIABLE_NAME' format");
    }
    const value = this.environment[environmentName];
    if (!value) {
      throw new SecretReferenceError(`Secret reference '${request.reference}' is not available`);
    }
    return value;
  }
}

class BoundedBuffer<T> {
  private readonly values: T[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Port buffer limit must be a positive integer");
    }
  }

  add(value: T): void {
    this.values.push(value);
    if (this.values.length > this.limit) this.values.shift();
  }

  snapshot(): readonly T[] {
    return [...this.values];
  }
}

export class BufferedAuditPort implements AuditPort {
  private readonly buffer: BoundedBuffer<AuditEvent>;

  constructor(limit = 1_000) {
    this.buffer = new BoundedBuffer(limit);
  }

  record(event: AuditEvent): void {
    this.buffer.add(structuredClone(event));
  }

  events(): readonly AuditEvent[] {
    return this.buffer.snapshot();
  }
}

export interface LocalNotificationRecord {
  id: string;
  message: NotificationMessage;
  acceptedAt: string;
}

export class LocalNotificationPort implements NotificationPort {
  private readonly buffer: BoundedBuffer<LocalNotificationRecord>;

  constructor(limit = 1_000) {
    this.buffer = new BoundedBuffer(limit);
  }

  send(message: NotificationMessage): NotificationResult {
    const id = randomUUID();
    this.buffer.add({ id, message: structuredClone(message), acceptedAt: new Date().toISOString() });
    return { accepted: true, messageId: id };
  }

  messages(): readonly LocalNotificationRecord[] {
    return this.buffer.snapshot();
  }
}

export class InMemoryMeteringPort implements MeteringPort {
  private readonly buffer: BoundedBuffer<MeteringEvent>;

  constructor(limit = 10_000) {
    this.buffer = new BoundedBuffer(limit);
  }

  recordUsage(event: MeteringEvent): void {
    if (!Number.isFinite(event.quantity) || event.quantity < 0) {
      throw new Error("Metering quantity must be a finite non-negative number");
    }
    this.buffer.add(structuredClone(event));
  }

  events(): readonly MeteringEvent[] {
    return this.buffer.snapshot();
  }

  total(metric: string): number {
    return this.buffer.snapshot()
      .filter((event) => event.metric === metric)
      .reduce((sum, event) => sum + event.quantity, 0);
  }
}

export interface DefaultRuntimePortsOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  auditLimit?: number;
  notificationLimit?: number;
  meteringLimit?: number;
}

export function createDefaultRuntimePorts(
  options: DefaultRuntimePortsOptions = {},
): TaskWeaverRuntimePorts {
  return {
    identity: new SingleInstanceIdentityPort(),
    authorization: new AllowAllAuthorizationPort(),
    entitlements: new AllowAllEntitlementPort(),
    audit: new BufferedAuditPort(options.auditLimit),
    secrets: new EnvironmentSecretStorePort(options.environment),
    notifications: new LocalNotificationPort(options.notificationLimit),
    metering: new InMemoryMeteringPort(options.meteringLimit),
  };
}
