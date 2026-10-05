import type { AuthenticationErrorCode, AuthorizationErrorCode } from "./schemas/auth";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  public currentVersion: number;

  constructor(message: string, currentVersion: number) {
    super(message);
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}
/** Transport adapters must keep internal credential failure details out of public messages. */
export class AuthenticationError extends Error {
  readonly code: AuthenticationErrorCode;

  constructor(code: AuthenticationErrorCode = "authentication_required") {
    super("Authentication required");
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;

  constructor(code: AuthorizationErrorCode = "permission_denied") {
    super("Access denied");
    this.name = "AuthorizationError";
    this.code = code;
  }
}
