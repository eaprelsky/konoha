export class KonohaError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = "KONOHA_ERROR", details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends KonohaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", details);
  }
}

export class ValidationError extends KonohaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", details);
  }
}

export class ExternalServiceError extends KonohaError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "EXTERNAL_SERVICE_ERROR", details);
  }
}
