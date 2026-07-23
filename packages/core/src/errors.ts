export type DataCLIErrorCode =
  | "PROMPT_VALIDATION"
  | "CONFIG_VALIDATION"
  | "OUTPUT_CONFLICT"
  | "PROVIDER_FAILURE"
  | "PROVIDER_TIMEOUT"
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_ARGUMENTS"
  | "TURN_LIMIT"
  | "TOOL_CALL_LIMIT"
  | "ENVIRONMENT_FAILURE"
  | "UNSUPPORTED_ENVIRONMENT"
  | "PI_FAILURE"
  | "INVALID_PIPELINE"
  | "JOB_FAILURE"
  | "ABORTED";

export interface DataCLIErrorDetails {
  jobId?: string;
  runId?: string;
  source?: string;
  line?: number;
  workspace?: string;
  partialOutput?: string;
  cause?: unknown;
}

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-or-v1-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = /^(?:api[_-]?key|authorization|credential|secret|access[_-]?token|refresh[_-]?token|id[_-]?token)$/i.test(key)
        ? "[REDACTED]"
        : redactSecrets(child);
    }
    return output;
  }
  return value;
}

export class DataCLIError extends Error {
  readonly code: DataCLIErrorCode;
  readonly details: Omit<DataCLIErrorDetails, "cause">;

  constructor(code: DataCLIErrorCode, message: string, details: DataCLIErrorDetails = {}) {
    super(redactText(message), details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.code = code;
    const { cause, ...safeDetails } = details;
    this.details = redactSecrets(safeDetails) as Omit<DataCLIErrorDetails, "cause">;
  }
}

export class PromptValidationError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("PROMPT_VALIDATION", message, details);
  }
}

export class ConfigurationError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("CONFIG_VALIDATION", message, details);
  }
}

export class OutputConflictError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("OUTPUT_CONFLICT", message, details);
  }
}

export class ProviderError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("PROVIDER_FAILURE", message, details);
  }
}

export class ProviderTimeoutError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("PROVIDER_TIMEOUT", message, details);
  }
}

export class UnknownToolError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("UNKNOWN_TOOL", message, details);
  }
}

export class InvalidToolArgumentsError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("INVALID_TOOL_ARGUMENTS", message, details);
  }
}

export class TurnLimitError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("TURN_LIMIT", message, details);
  }
}

export class ToolCallLimitError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("TOOL_CALL_LIMIT", message, details);
  }
}

export class EnvironmentError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("ENVIRONMENT_FAILURE", message, details);
  }
}

export class UnsupportedEnvironmentError extends DataCLIError {
  constructor(message = "Docker environments are coming soon.", details: DataCLIErrorDetails = {}) {
    super("UNSUPPORTED_ENVIRONMENT", message, details);
  }
}

export class PiError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("PI_FAILURE", message, details);
  }
}

export class InvalidPipelineError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("INVALID_PIPELINE", message, details);
  }
}

export class JobError extends DataCLIError {
  constructor(message: string, details: DataCLIErrorDetails = {}) {
    super("JOB_FAILURE", message, details);
  }
}

export class AbortError extends DataCLIError {
  constructor(message = "Operation aborted.", details: DataCLIErrorDetails = {}) {
    super("ABORTED", message, details);
  }
}

export function attachErrorDetails(error: unknown, details: DataCLIErrorDetails): DataCLIError {
  if (error instanceof DataCLIError) {
    const { cause, ...safeDetails } = details;
    Object.assign(
      error.details,
      redactSecrets(safeDetails) as Omit<DataCLIErrorDetails, "cause">
    );
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new JobError(message, { ...details, cause: error });
}
