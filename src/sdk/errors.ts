/**
 * Base error class for all Agentforce SDK errors.
 */
export class AgentforceClientError extends Error {
  readonly type: "api" | "network" | "auth" | "unknown";

  constructor(
    message: string,
    type: "api" | "network" | "auth" | "unknown" = "unknown",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentforceClientError";
    this.type = type;
  }
}

/**
 * Error from SCRT2 REST API responses (non-2xx status codes).
 */
export class AgentforceApiError extends AgentforceClientError {
  readonly statusCode: number;
  readonly responseBody: unknown;

  constructor(
    message: string,
    statusCode: number,
    responseBody?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, "api", options);
    this.name = "AgentforceApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/**
 * Network-level error (fetch failures, timeouts).
 */
export class AgentforceNetworkError extends AgentforceClientError {
  readonly attemptsMade: number;

  constructor(message: string, attemptsMade: number = 1, options?: ErrorOptions) {
    super(message, "network", options);
    this.name = "AgentforceNetworkError";
    this.attemptsMade = attemptsMade;
  }
}

/**
 * Authentication error (401, token failure).
 */
export class AgentforceAuthError extends AgentforceClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "auth", options);
    this.name = "AgentforceAuthError";
  }
}
