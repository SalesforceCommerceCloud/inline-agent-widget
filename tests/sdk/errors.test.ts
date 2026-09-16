import { describe, expect, it } from "vitest";
import {
  AgentforceApiError,
  AgentforceAuthError,
  AgentforceClientError,
  AgentforceNetworkError,
} from "../../src/sdk/errors";

describe("AgentforceClientError", () => {
  it("sets name, message, and type", () => {
    const error = new AgentforceClientError("boom", "auth");

    expect(error.name).toBe("AgentforceClientError");
    expect(error.message).toBe("boom");
    expect(error.type).toBe("auth");
    expect(error).toBeInstanceOf(Error);
  });

  it("defaults type to unknown", () => {
    const error = new AgentforceClientError("boom");

    expect(error.type).toBe("unknown");
  });
});

describe("AgentforceApiError", () => {
  it("sets name, type, statusCode, and responseBody", () => {
    const responseBody = { error: "bad request" };
    const error = new AgentforceApiError("request failed", 400, responseBody);

    expect(error.name).toBe("AgentforceApiError");
    expect(error.type).toBe("api");
    expect(error.statusCode).toBe(400);
    expect(error.responseBody).toBe(responseBody);
    expect(error.message).toBe("request failed");
  });

  it("allows responseBody to be omitted", () => {
    const error = new AgentforceApiError("request failed", 500);

    expect(error.responseBody).toBeUndefined();
  });

  it("is an instance of AgentforceClientError and Error", () => {
    const error = new AgentforceApiError("request failed", 404);

    expect(error).toBeInstanceOf(AgentforceApiError);
    expect(error).toBeInstanceOf(AgentforceClientError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("AgentforceNetworkError", () => {
  it("sets name, type, and attemptsMade", () => {
    const error = new AgentforceNetworkError("network down", 3);

    expect(error.name).toBe("AgentforceNetworkError");
    expect(error.type).toBe("network");
    expect(error.attemptsMade).toBe(3);
  });

  it("defaults attemptsMade to 1", () => {
    const error = new AgentforceNetworkError("network down");

    expect(error.attemptsMade).toBe(1);
  });

  it("is an instance of AgentforceClientError", () => {
    const error = new AgentforceNetworkError("network down");

    expect(error).toBeInstanceOf(AgentforceClientError);
  });
});

describe("AgentforceAuthError", () => {
  it("sets name and type", () => {
    const error = new AgentforceAuthError("unauthorized");

    expect(error.name).toBe("AgentforceAuthError");
    expect(error.type).toBe("auth");
    expect(error.message).toBe("unauthorized");
  });

  it("is an instance of AgentforceClientError", () => {
    const error = new AgentforceAuthError("unauthorized");

    expect(error).toBeInstanceOf(AgentforceClientError);
  });
});

describe("error cause chaining", () => {
  it("propagates cause via ErrorOptions for AgentforceClientError", () => {
    const cause = new Error("root cause");
    const error = new AgentforceClientError("wrapped", "unknown", { cause });

    expect(error.cause).toBe(cause);
  });

  it("propagates cause via ErrorOptions for AgentforceApiError", () => {
    const cause = new Error("fetch failed");
    const error = new AgentforceApiError("api failed", 502, undefined, { cause });

    expect(error.cause).toBe(cause);
  });

  it("propagates cause via ErrorOptions for AgentforceNetworkError", () => {
    const cause = new Error("timeout");
    const error = new AgentforceNetworkError("network failed", 2, { cause });

    expect(error.cause).toBe(cause);
  });

  it("propagates cause via ErrorOptions for AgentforceAuthError", () => {
    const cause = new Error("token expired");
    const error = new AgentforceAuthError("auth failed", { cause });

    expect(error.cause).toBe(cause);
  });
});
