import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "../../src/sdk/event-emitter";
import type { AgentforceEventMap, AgentforceEventName } from "../../src/sdk/types";

class TestEmitter extends TypedEventEmitter {
  emit<E extends AgentforceEventName>(
    event: E,
    ...args: AgentforceEventMap[E] extends void ? [] : [AgentforceEventMap[E]]
  ): void {
    super.emit(event, ...args);
  }
}

describe("TypedEventEmitter", () => {
  it("on() registers a handler that fires on every emit", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.on("connected", handler);

    emitter.emit("connected");
    emitter.emit("connected");

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("once() fires a handler only on the first emit then removes it", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.once("connected", handler);

    emitter.emit("connected");
    emitter.emit("connected");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("once() supports registering multiple handlers for the same event", () => {
    const emitter = new TestEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    emitter.once("connected", handlerA);
    emitter.once("connected", handlerB);

    emitter.emit("connected");

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("passes the payload through to persistent and once handlers", () => {
    const emitter = new TestEmitter();
    const onHandler = vi.fn();
    const onceHandler = vi.fn();
    emitter.on("error", onHandler);
    emitter.once("error", onceHandler);

    const payload = { message: "boom", recoverable: false };
    emitter.emit("error", payload);

    expect(onHandler).toHaveBeenCalledWith(payload);
    expect(onceHandler).toHaveBeenCalledWith(payload);
  });

  it("off(event) removes all handlers for that event only", () => {
    const emitter = new TestEmitter();
    const messageHandler = vi.fn();
    const errorHandler = vi.fn();
    emitter.on("message", messageHandler);
    emitter.once("message", vi.fn());
    emitter.on("error", errorHandler);

    emitter.off("message");
    emitter.emit("message", {
      conversationId: "c1",
      messageId: "m1",
      content: "hi",
      sender: { role: "Agent" },
      timestamp: "now",
    });
    emitter.emit("error", { message: "still works", recoverable: true });

    expect(messageHandler).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
  });

  it("off(event, handler) removes only the specified handler", () => {
    const emitter = new TestEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    emitter.on("connected", handlerA);
    emitter.on("connected", handlerB);

    emitter.off("connected", handlerA);
    emitter.emit("connected");

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("off(event, handler) also removes a matching once handler", () => {
    const emitter = new TestEmitter();
    const handler = vi.fn();
    emitter.once("connected", handler);

    emitter.off("connected", handler);
    emitter.emit("connected");

    expect(handler).not.toHaveBeenCalled();
  });

  it("off() with no arguments clears all handlers for all events", () => {
    const emitter = new TestEmitter();
    const connectedHandler = vi.fn();
    const disconnectedHandler = vi.fn();
    emitter.on("connected", connectedHandler);
    emitter.once("disconnected", disconnectedHandler);

    emitter.off();
    emitter.emit("connected");
    emitter.emit("disconnected", { reason: "test" });

    expect(connectedHandler).not.toHaveBeenCalled();
    expect(disconnectedHandler).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by a handler without affecting other handlers", () => {
    const emitter = new TestEmitter();
    const throwing = vi.fn(() => {
      throw new Error("handler blew up");
    });
    const wellBehaved = vi.fn();
    emitter.on("connected", throwing);
    emitter.on("connected", wellBehaved);

    expect(() => emitter.emit("connected")).not.toThrow();
    expect(wellBehaved).toHaveBeenCalledTimes(1);
  });

  it("swallows errors thrown by a once handler and still removes it", () => {
    const emitter = new TestEmitter();
    const throwing = vi.fn(() => {
      throw new Error("once handler blew up");
    });
    emitter.once("connected", throwing);

    expect(() => emitter.emit("connected")).not.toThrow();
    emitter.emit("connected");

    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
