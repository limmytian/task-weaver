import type {
  AuthenticationErrorCode,
  AuthorizationErrorCode,
} from "./schemas/auth";

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

export class AuthenticationRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many authentication attempts");
    this.name = "AuthenticationRateLimitError";
  }
}

const chatErrorMessages = {
  chat_encryption_unavailable: "Chat credential encryption is not configured. Ask an administrator to configure the master key.",
  chat_key_required: "Save an API key in your model settings before using Chat. Previous environment references require key re-entry.",
  chat_key_unreadable: "Saved Chat key cannot be decrypted. Restore the encryption key or replace your saved API key.",
  chat_endpoint_invalid: "Use an HTTP or HTTPS base URL without credentials, query parameters or fragments.",
  chat_endpoint_private: "Private model endpoints are not allowed.",
  chat_endpoint_unresolved: "Model endpoint could not be resolved.",
  chat_key_rejected: "Model rejected the API key. Replace it or check provider access.",
  chat_request_failed: "Model request failed. Check the endpoint and model, then try again.",
  chat_response_invalid: "Model response did not include readable content.",
  chat_connection_failed: "Model connection failed or timed out. Check the base URL and try again.",
  chat_model_required: "Choose an enabled default Chat model in your model settings.",
  chat_url_required: "Save a base URL in your model settings.",
  chat_key_review: "Replace or verify the API key in your model settings.",
} as const;
/** Only fixed, reviewed messages cross the transport boundary; provider errors never do. */
export class ChatConfigurationError extends Error {
  constructor(readonly code: keyof typeof chatErrorMessages) {
    super(chatErrorMessages[code]);
    this.name = "ChatConfigurationError";
  }
}
