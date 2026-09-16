import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../src/sdk/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Logger", () => {
  describe("when enabled", () => {
    it("info() logs with the [Agentforce] prefix", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      new Logger(true).info("hello");
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello");
    });

    it("warn() logs with the [Agentforce] prefix", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      new Logger(true).warn("hello");
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello");
    });

    it("error() logs with the [Agentforce] prefix", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      new Logger(true).error("hello");
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello");
    });

    it("debug() logs with the [Agentforce] prefix", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      new Logger(true).debug("hello");
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello");
    });

    it("passes extra args through to console.log", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      new Logger(true).info("hello", { foo: "bar" }, 42);
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello", { foo: "bar" }, 42);
    });

    it("passes extra args through to console.warn", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      new Logger(true).warn("hello", { foo: "bar" }, 42);
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello", { foo: "bar" }, 42);
    });

    it("passes extra args through to console.error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      new Logger(true).error("hello", { foo: "bar" }, 42);
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello", { foo: "bar" }, 42);
    });

    it("passes extra args through to console.debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      new Logger(true).debug("hello", { foo: "bar" }, 42);
      expect(spy).toHaveBeenCalledWith("[Agentforce] hello", { foo: "bar" }, 42);
    });
  });

  describe("when disabled", () => {
    it("info() does not call console.log", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      new Logger(false).info("hello");
      expect(spy).not.toHaveBeenCalled();
    });

    it("warn() does not call console.warn", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      new Logger(false).warn("hello");
      expect(spy).not.toHaveBeenCalled();
    });

    it("error() does not call console.error", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      new Logger(false).error("hello");
      expect(spy).not.toHaveBeenCalled();
    });

    it("debug() does not call console.debug", () => {
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      new Logger(false).debug("hello");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
