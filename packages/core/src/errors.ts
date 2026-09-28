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
