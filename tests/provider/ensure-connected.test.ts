import { describe, expect, it, vi } from "vitest";
import {
  ensureConnected,
  type ConnectableClient,
  type PromiseHolder,
  type SessionPersistence,
} from "../../src/provider/ensure-connected";

/**
 * A fake AgentforceClient that mirrors the real readiness semantics:
 * connect() flips isConnected true, createConversation() sets a conversationId.
 * Either step can be made to reject to exercise the retry paths.
 */
function makeFakeClient(opts: {
  connectFails?: boolean;
  createFails?: boolean;
} = {}) {
  let connected = false;
  let conversationId: string | null = null;
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

  return {
    client,
    connect,
    createConversation,
    // Test hooks to simulate external state changes.
    dropStream: () => {
      connected = false;
    },
    expireSession: () => {
      connected = false;
      conversationId = null;
    },
    clearFailures: () => {
      opts.connectFails = false;
      opts.createFails = false;
    },
    // Simulate a successful restore(): stream up + conversation adopted, WITHOUT
    // going through connect()/createConversation() (no token mint, no new conv).
    simulateRestore: () => {
      connected = true;
      conversationId = "restored-conv";
    },
  };
}

/**
 * A fake SessionPersistence whose tryRestore/save are spies. The inferred
 * return type keeps the Mock methods (for assertions) while remaining
 * structurally assignable to SessionPersistence (for passing to ensureConnected).
 */
function makePersistence(onRestore: () => boolean) {
  const persistence = {
    tryRestore: vi.fn(async () => onRestore()),
    save: vi.fn(),
  };
  return persistence satisfies SessionPersistence;
}

function holder(): PromiseHolder {
  return { current: null };
}

describe("ensureConnected", () => {
  it("runs the handshake once, then short-circuits on later calls", async () => {
    const f = makeFakeClient();
    const h = holder();
    const onStart = vi.fn();

    await ensureConnected(f.client, h, onStart);
    await ensureConnected(f.client, h, onStart);
    await ensureConnected(f.client, h, onStart);

    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.createConversation).toHaveBeenCalledTimes(1);
    // onStart fires only for a real handshake, not the short-circuited calls.
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(f.client.conversationId).toBe("conv-1");
    // The memo is cleared once the attempt settles.
    expect(h.current).toBeNull();
  });

  it("dedupes concurrent first sends onto a single in-flight handshake", async () => {
    const f = makeFakeClient();
    const h = holder();
    const onStart = vi.fn();

    // Fire three before awaiting any — they should share one attempt.
    const [a, b, c] = [
      ensureConnected(f.client, h, onStart),
      ensureConnected(f.client, h, onStart),
      ensureConnected(f.client, h, onStart),
    ];
    // Same joined promise while in flight.
    expect(a).toBe(b);
    expect(b).toBe(c);

    await Promise.all([a, b, c]);

    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.createConversation).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("skips the handshake entirely when a conversation already exists", async () => {
    const f = makeFakeClient();
    const h = holder();
    await ensureConnected(f.client, h); // establish
    f.connect.mockClear();
    f.createConversation.mockClear();

    const onStart = vi.fn();
    await ensureConnected(f.client, h, onStart);

    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createConversation).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("rejects and resets the memo when connect() fails, so the next call retries", async () => {
    const f = makeFakeClient({ connectFails: true });
    const h = holder();

    await expect(ensureConnected(f.client, h)).rejects.toThrow("connect boom");
    // Reset so a retry is possible.
    expect(h.current).toBeNull();

    f.clearFailures();
    await ensureConnected(f.client, h);

    expect(f.connect).toHaveBeenCalledTimes(2); // first failed, second succeeded
    expect(f.client.conversationId).toBe("conv-1");
  });

  it("retries a partial handshake without re-fetching the token", async () => {
    // connect() succeeds but createConversation() fails: the stream is open,
    // so the retry must NOT call connect() again (that would refetch the token).
    const f = makeFakeClient({ createFails: true });
    const h = holder();

    await expect(ensureConnected(f.client, h)).rejects.toThrow("createConversation boom");
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.client.isConnected).toBe(true);
    expect(f.client.conversationId).toBeNull();

    f.clearFailures();
    await ensureConnected(f.client, h);

    // connect() not called again; only createConversation() retried.
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.createConversation).toHaveBeenCalledTimes(2);
    expect(f.client.conversationId).toBe("conv-1");
  });

  it("re-establishes a fresh session after the previous one expired", async () => {
    const f = makeFakeClient();
    const h = holder();
    await ensureConnected(f.client, h);
    expect(f.client.conversationId).toBe("conv-1");

    // SESSION_EXPIRED clears connection + conversation.
    f.expireSession();

    await ensureConnected(f.client, h);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.createConversation).toHaveBeenCalledTimes(2);
    expect(f.client.conversationId).toBe("conv-2");
  });

  it("shares one handshake between a warm-up and a send fired before it resolves", async () => {
    // Models: user types (warm-up) then hits Send before connect resolves. Both
    // must ride the SAME in-flight handshake — the send is queued, not a second
    // connect. We gate connect() on a manual deferred to hold it mid-flight.
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const f = makeFakeClient();
    const slowConnect = vi.spyOn(f.client, "connect").mockImplementation(async () => {
      await gate;
    });
    const h = holder();

    const warm = ensureConnected(f.client, h); // user starts typing
    const send = ensureConnected(f.client, h); // user hits Send before connect resolves
    expect(warm).toBe(send); // queued onto the same attempt

    // Nothing has resolved yet — connect is still in flight.
    expect(f.createConversation).not.toHaveBeenCalled();

    releaseConnect();
    await Promise.all([warm, send]);

    expect(slowConnect).toHaveBeenCalledTimes(1);
    expect(f.createConversation).toHaveBeenCalledTimes(1);
    expect(f.client.conversationId).toBe("conv-1");
  });

  it("does not surface the internal bookkeeping chain as an unhandled rejection", async () => {
    // Regression guard: the internal `.catch().finally()` must swallow so only
    // the returned promise rejects. If a caller ignores the return value, no
    // unhandled rejection should escape.
    const f = makeFakeClient({ connectFails: true });
    const h = holder();

    const p = ensureConnected(f.client, h);
    // Attach a handler so THIS test's assertion doesn't itself trip the detector.
    await expect(p).rejects.toThrow("connect boom");
    // Give microtasks a beat to flush the internal chain.
    await Promise.resolve();
    expect(h.current).toBeNull();
  });

  describe("with session persistence", () => {
    it("restores a valid stored session instead of a fresh handshake", async () => {
      const f = makeFakeClient();
      const h = holder();
      // tryRestore succeeds → flip the client to restored state.
      const persistence = makePersistence(() => {
        f.simulateRestore();
        return true;
      });

      await ensureConnected(f.client, h, undefined, persistence);

      expect(persistence.tryRestore).toHaveBeenCalledTimes(1);
      // No fresh handshake: no token mint (connect) and no new conversation.
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.createConversation).not.toHaveBeenCalled();
      // A restore is not a fresh handshake, so we don't re-save.
      expect(persistence.save).not.toHaveBeenCalled();
      expect(f.client.conversationId).toBe("restored-conv");
    });

    it("falls back to a fresh handshake (and saves) when there's nothing to restore", async () => {
      const f = makeFakeClient();
      const h = holder();
      const persistence = makePersistence(() => false); // no stored session

      await ensureConnected(f.client, h, undefined, persistence);

      expect(persistence.tryRestore).toHaveBeenCalledTimes(1);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.createConversation).toHaveBeenCalledTimes(1);
      // Fresh session persisted for the next page load.
      expect(persistence.save).toHaveBeenCalledTimes(1);
      expect(f.client.conversationId).toBe("conv-1");
    });

    it("does not attempt a restore once the stream is already up (partial retry)", async () => {
      // connect() ok but createConversation() failed: the token is already
      // minted and the stream is open, so a retry must NOT try to restore (that
      // would re-open SSE) — it just retries createConversation().
      const f = makeFakeClient({ createFails: true });
      const h = holder();
      const persistence = makePersistence(() => false);

      await expect(
        ensureConnected(f.client, h, undefined, persistence),
      ).rejects.toThrow("createConversation boom");
      expect(persistence.tryRestore).toHaveBeenCalledTimes(1); // first attempt tried
      expect(f.client.isConnected).toBe(true);

      f.clearFailures();
      await ensureConnected(f.client, h, undefined, persistence);

      // Second attempt: stream already up → no second restore, no re-connect.
      expect(persistence.tryRestore).toHaveBeenCalledTimes(1);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.createConversation).toHaveBeenCalledTimes(2);
      expect(persistence.save).toHaveBeenCalledTimes(1); // only after the eventual success
    });
  });
});
