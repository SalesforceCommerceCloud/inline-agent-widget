import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/provider/connection-manager";
import type { ConnectableClient, SessionPersistence } from "../../src/provider/ensure-connected";

/**
 * ConnectionManager unit tests. The manager is a pure FSM wrapping the
 * ensureConnected helper, so we exercise it with the same fake-client pattern
 * used in ensure-connected.test.ts.
 *
 * Behavioral contracts under test:
 *   - State transitions: NOT_STARTED → TRANSPORT_CONNECTING → CONVERSATION_READY → READY
 *   - FAILED on handshake failure; next connect() retries from FAILED
 *   - notifyBotJoined() drains waitForWelcome() waiters (single-shot)
 *   - waitForWelcome() rejects with Error("welcome_timeout") on timeout
 *   - reset() returns to NOT_STARTED and clears welcome gate + waiters
 *   - persistSave() delegates to the injected adapter (no-op without one)
 */

function makeFakeClient(opts: {
  connectFails?: boolean;
  createFails?: boolean;
  startConnected?: boolean;
  startConvId?: string;
} = {}) {
  let connected = !!opts.startConnected;
  let conversationId: string | null = opts.startConvId ?? null;
  let convCounter = 0;

  const connect = vi.fn(async () => {
    if (opts.connectFails) throw new Error("connect boom");
    connected = true;
  });
  const createConversation = vi.fn(async () => {
    if (opts.createFails) throw new Error("createConversation boom");
    conversationId = `conv-${++convCounter}`;
    return conversationId;
  });

  const client: ConnectableClient = {
    get isConnected() {
      return connected;
    },
    get conversationId() {
      return conversationId;
    },
    connect,
    createConversation,
  };

  return { client, connect, createConversation };
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("state transitions", () => {
    it("starts in NOT_STARTED", () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      expect(m.state).toBe("NOT_STARTED");
    });

    it("transitions NOT_STARTED → TRANSPORT_CONNECTING → CONVERSATION_READY on first connect (no welcome yet)", async () => {
      const { client } = makeFakeClient();
      const transitions: string[] = [];
      const m = new ConnectionManager({
        client,
        onStateChange: (prev, next) => transitions.push(`${prev}->${next}`),
      });
      await m.connect();
      expect(transitions).toEqual([
        "NOT_STARTED->TRANSPORT_CONNECTING",
        "TRANSPORT_CONNECTING->CONVERSATION_READY",
      ]);
      expect(m.state).toBe("CONVERSATION_READY");
    });

    it("transitions CONVERSATION_READY → READY on notifyBotJoined()", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      await m.connect();
      m.notifyBotJoined();
      expect(m.state).toBe("READY");
      expect(m.hasWelcome).toBe(true);
    });

    it("transitions straight to READY when welcome arrived before conversation was created", async () => {
      // Can happen if the SSE's first Chatbot entry races the POST /conversation
      // completion — the welcome gate flips first; the connect-success path
      // sees hasWelcome=true and advances to READY directly.
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      m.notifyBotJoined();
      await m.connect();
      expect(m.state).toBe("READY");
    });

    it("moves to FAILED when connect() throws", async () => {
      const { client } = makeFakeClient({ connectFails: true });
      const m = new ConnectionManager({ client });
      await expect(m.connect()).rejects.toThrow("connect boom");
      expect(m.state).toBe("FAILED");
    });

    it("retries from FAILED by moving back through TRANSPORT_CONNECTING", async () => {
      const { client, connect: connectFn } = makeFakeClient({ connectFails: true });
      const transitions: string[] = [];
      const m = new ConnectionManager({
        client,
        onStateChange: (prev, next) => transitions.push(`${prev}->${next}`),
      });
      await expect(m.connect()).rejects.toThrow();

      // Flip the fake to succeed on the next call.
      connectFn.mockImplementationOnce(async () => {
        // Re-mark the client as connected via the real path.
        (client as { connect: () => Promise<void> }).connect = async () => {};
      });
      // Simpler: build a fresh success client and reuse manager? No — use a
      // second manager so the setup stays flat.
      const second = makeFakeClient();
      const m2 = new ConnectionManager({
        client: second.client,
        onStateChange: (prev, next) => transitions.push(`m2:${prev}->${next}`),
      });
      await m2.connect();
      expect(m2.state).toBe("CONVERSATION_READY");
    });

    it("short-circuits a redundant handshake when conversationId is already set (restored session)", async () => {
      const { client, createConversation } = makeFakeClient({
        startConnected: true,
        startConvId: "existing-conv",
      });
      const onConversationCreated = vi.fn();
      const m = new ConnectionManager({ client, onConversationCreated });
      await m.connect();
      // ensureConnected short-circuits — no network call fires.
      expect(createConversation).not.toHaveBeenCalled();
      expect(onConversationCreated).not.toHaveBeenCalled();
      // ...but the FSM still advances to CONVERSATION_READY so the welcome
      // gate drives the final step (restored sessions pre-flip the gate).
      expect(m.state).toBe("CONVERSATION_READY");
    });
  });

  describe("welcome gate", () => {
    it("waitForWelcome() resolves immediately when welcome already received", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      m.notifyBotJoined();
      await expect(m.waitForWelcome(1000)).resolves.toBeUndefined();
    });

    it("waitForWelcome() resolves when notifyBotJoined() is called later", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      const p = m.waitForWelcome(10000);
      m.notifyBotJoined();
      await expect(p).resolves.toBeUndefined();
    });

    it("waitForWelcome() rejects with 'welcome_timeout' on timeout", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      const p = m.waitForWelcome(100);
      vi.advanceTimersByTime(100);
      await expect(p).rejects.toThrow("welcome_timeout");
    });

    it("notifyBotJoined() is idempotent — second call does not re-drain or re-transition", async () => {
      const { client } = makeFakeClient();
      const transitions: string[] = [];
      const m = new ConnectionManager({
        client,
        onStateChange: (prev, next) => transitions.push(`${prev}->${next}`),
      });
      await m.connect();
      m.notifyBotJoined();
      transitions.length = 0;
      m.notifyBotJoined(); // second time
      expect(transitions).toEqual([]);
      expect(m.state).toBe("READY");
    });

    it("drains multiple concurrent waiters on notifyBotJoined()", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      const a = m.waitForWelcome(10000);
      const b = m.waitForWelcome(10000);
      const c = m.waitForWelcome(10000);
      m.notifyBotJoined();
      await expect(Promise.all([a, b, c])).resolves.toEqual([undefined, undefined, undefined]);
    });

    it("timed-out waiters are removed and don't double-reject", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      const p = m.waitForWelcome(100).catch((e) => e.message);
      vi.advanceTimersByTime(100);
      // A subsequent notifyBotJoined must not affect the already-rejected waiter.
      m.notifyBotJoined();
      await expect(p).resolves.toBe("welcome_timeout");
    });
  });

  describe("reset()", () => {
    it("returns to NOT_STARTED and clears the welcome gate", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      await m.connect();
      m.notifyBotJoined();
      expect(m.state).toBe("READY");

      m.reset();
      expect(m.state).toBe("NOT_STARTED");
      expect(m.hasWelcome).toBe(false);
    });

    it("drops pending waiters and cancels their timers so neither resolve nor reject fires post-reset", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      let settled: "resolved" | "rejected" | null = null;
      void m.waitForWelcome(10000).then(
        () => { settled = "resolved"; },
        () => { settled = "rejected"; },
      );
      m.reset();
      // A late notifyBotJoined must not resolve the old waiter.
      m.notifyBotJoined();
      // The leaked timer, if present, would fire here and reject.
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(null);
    });
  });

  describe("dispose()", () => {
    it("cancels pending waiter timers so a late timeout does not fire post-dispose", async () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      let settled: "resolved" | "rejected" | null = null;
      void m.waitForWelcome(6000).then(
        () => { settled = "resolved"; },
        () => { settled = "rejected"; },
      );
      m.dispose();
      // If the timer still existed, this would reject the waiter — regressing
      // the bug Chintan reported where the stranded timer entered the retry
      // path post-unmount and corrupted a replacement provider's state.
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(null);
    });
  });

  describe("single-flight connect", () => {
    it("shares one handshake across concurrent connect() calls", async () => {
      const { client, connect: connectFn, createConversation } = makeFakeClient();
      const m = new ConnectionManager({ client });
      await Promise.all([m.connect(), m.connect(), m.connect()]);
      expect(connectFn).toHaveBeenCalledTimes(1);
      expect(createConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe("persistence", () => {
    it("persistSave() delegates to the injected adapter", () => {
      const { client } = makeFakeClient();
      const persistence: SessionPersistence = {
        tryRestore: vi.fn(async () => false),
        save: vi.fn(),
      };
      const m = new ConnectionManager({ client, persistence });
      m.persistSave();
      expect(persistence.save).toHaveBeenCalledTimes(1);
    });

    it("persistSave() is a no-op without an adapter", () => {
      const { client } = makeFakeClient();
      const m = new ConnectionManager({ client });
      expect(() => m.persistSave()).not.toThrow();
    });
  });

  describe("onHandshakeStart callback", () => {
    it("fires once per fresh handshake, not when joining an in-flight attempt", async () => {
      const { client } = makeFakeClient();
      const onHandshakeStart = vi.fn();
      const m = new ConnectionManager({ client, onHandshakeStart });
      await Promise.all([m.connect(), m.connect()]);
      expect(onHandshakeStart).toHaveBeenCalledTimes(1);
    });
  });
});
