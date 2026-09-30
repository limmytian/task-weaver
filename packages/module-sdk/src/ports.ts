import type { Actor } from "@task-weaver/contracts";

export type PortResult<T> = T | Promise<T>;

export interface IdentityRequest {
  headers: Readonly<Record<string, string | undefined>>;
  existingActor?: Actor;
}

export interface IdentityResult {
  actor: Actor;
  authenticated: boolean;
  authenticationMethod: string;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface IdentityPort {
  resolveIdentity(request: IdentityRequest): PortResult<IdentityResult>;
}

export interface AccessResource {
  type: string;
  id?: string;
  projectId?: string;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationRequest {
  actor: Actor;
  permission: string;
  resource?: AccessResource;
  context?: Readonly<Record<string, unknown>>;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  policy?: string;
}

export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): PortResult<AccessDecision>;
}

export interface EntitlementRequest {
  actor: Actor;
  capability: string;
  scope?: AccessResource;
  context?: Readonly<Record<string, unknown>>;
}

export interface EntitlementPort {
  checkEntitlement(request: EntitlementRequest): PortResult<AccessDecision>;
}

export interface AuditEvent {
  action: string;
  actor: Actor;
  occurredAt: string;
  outcome: "allowed" | "denied" | "error" | "success";
  resource?: AccessResource;
  requestId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditPort {
  record(event: AuditEvent): PortResult<void>;
}

export interface SecretRequest {
  reference: string;
  purpose: string;
  actor?: Actor;
}

export interface SecretStorePort {
  resolveSecret(request: SecretRequest): PortResult<string>;
}

export interface NotificationMessage {
  topic: string;
  title: string;
  body: string;
  recipients?: readonly string[];
  severity?: "info" | "warning" | "error";
  metadata?: Readonly<Record<string, unknown>>;
}

export interface NotificationResult {
  accepted: boolean;
  messageId?: string;
  reason?: string;
}

export interface NotificationPort {
  send(message: NotificationMessage): PortResult<NotificationResult>;
}

export interface MeteringEvent {
  metric: string;
  quantity: number;
  occurredAt: string;
  actor?: Actor;
  resource?: AccessResource;
  dimensions?: Readonly<Record<string, string>>;
}

export interface MeteringPort {
  recordUsage(event: MeteringEvent): PortResult<void>;
}

export interface TaskWeaverRuntimePorts {
  identity: IdentityPort;
  authorization: AuthorizationPort;
  entitlements: EntitlementPort;
  audit: AuditPort;
  secrets: SecretStorePort;
  notifications: NotificationPort;
  metering: MeteringPort;
}

export class AuthorizationDeniedError extends Error {
  readonly code = "authorization_denied";
  readonly status = 403;

  constructor(
    message: string,
    public readonly decision: AccessDecision,
  ) {
    super(message);
    this.name = "AuthorizationDeniedError";
  }
}

export class EntitlementDeniedError extends Error {
  readonly code = "entitlement_denied";
  readonly status = 403;

  constructor(
    message: string,
    public readonly decision: AccessDecision,
  ) {
    super(message);
    this.name = "EntitlementDeniedError";
  }
}

export interface AccessEnforcementRequest {
  authorization: AuthorizationRequest;
  entitlement?: Omit<EntitlementRequest, "actor">;
}

export async function enforceAccess(
  ports: Pick<TaskWeaverRuntimePorts, "authorization" | "entitlements" | "audit">,
  request: AccessEnforcementRequest,
): Promise<void> {
  const authorization = await ports.authorization.authorize(request.authorization);
  if (!authorization.allowed) {
    await ports.audit.record({
      action: request.authorization.permission,
      actor: request.authorization.actor,
      occurredAt: new Date().toISOString(),
      outcome: "denied",
      resource: request.authorization.resource,
      metadata: { reason: authorization.reason, policy: authorization.policy },
    });
    throw new AuthorizationDeniedError(
      authorization.reason ?? `Permission '${request.authorization.permission}' is denied`,
      authorization,
    );
  }

  if (request.entitlement) {
    const entitlement = await ports.entitlements.checkEntitlement({
      ...request.entitlement,
      actor: request.authorization.actor,
    });
    if (!entitlement.allowed) {
      await ports.audit.record({
        action: `entitlement:${request.entitlement.capability}`,
        actor: request.authorization.actor,
        occurredAt: new Date().toISOString(),
        outcome: "denied",
        resource: request.entitlement.scope,
        metadata: { reason: entitlement.reason, policy: entitlement.policy },
      });
      throw new EntitlementDeniedError(
        entitlement.reason ?? `Capability '${request.entitlement.capability}' is not available`,
        entitlement,
      );
    }
  }
}
