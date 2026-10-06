import { describe, expect, it } from "vitest";
import { createWelcomeGate } from "../../src/provider/welcome-gate";

describe("createWelcomeGate", () => {
  describe("initial state", () => {
    it("starts in the idle state (pending === false)", () => {
      const gate = createWelcomeGate();
      expect(gate.pending).toBe(false);
    });

    it("wait() on an idle gate resolves on the next microtask", async () => {
      const gate = createWelcomeGate();
      // The promise is already-resolved — one `await` turn is enough. If this
      // were a hanging Promise, Vitest's default-5s test timeout would catch
      // it; using Promise.race against a flushed microtask guard makes the
      // "instant" claim explicit instead.
      let resolved = false;
      await Promise.race([
        gate.wait().then(() => {
          resolved = true;
        }),
        Promise.resolve(),
      ]);
      // Yield once more so the then() has committed.
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  describe("open() → close()", () => {
    it("open() flips pending to true", () => {
      const gate = createWelcomeGate();
      gate.open();
      expect(gate.pending).toBe(true);
    });

    it("open() is idempotent — a second open() while already pending is a no-op", () => {
      const gate = createWelcomeGate();
      gate.open();
      gate.open();
      expect(gate.pending).toBe(true);
    });

    it("close() flips pending back to false", () => {
      const gate = createWelcomeGate();
      gate.open();
      gate.close();
      expect(gate.pending).toBe(false);
    });

    it("close() on an already-closed gate is a safe no-op (no throw)", () => {
      const gate = createWelcomeGate();
      expect(() => gate.close()).not.toThrow();
      gate.open();
      gate.close();
      expect(() => gate.close()).not.toThrow();
      expect(gate.pending).toBe(false);
    });
  });

  describe("wait() while pending", () => {
    it("blocks a single waiter until close() is called", async () => {
      const gate = createWelcomeGate();
      gate.open();

      let resolved = false;
      const waiter = gate.wait().then(() => {
        resolved = true;
      });

      // Flush a few microtask turns to prove the promise hasn't resolved.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      gate.close();
      await waiter;
      expect(resolved).toBe(true);
    });

    it("resolves ALL concurrent waiters with a single close()", async () => {
      const gate = createWelcomeGate();
      gate.open();

      const w1 = gate.wait();
      const w2 = gate.wait();
      const w3 = gate.wait();

      gate.close();
      await Promise.all([w1, w2, w3]);
      // If any waiter failed to resolve, Promise.all would hang and Vitest
      // would time out — the assertion is simply reaching this line.
      expect(gate.pending).toBe(false);
    });

    it("after close(), a NEW wait() resolves immediately (gate re-enters idle)", async () => {
      const gate = createWelcomeGate();
      gate.open();
      gate.close();

      let resolved = false;
      await gate.wait().then(() => {
        resolved = true;
      });
      expect(resolved).toBe(true);
    });

    it("supports a second open/close cycle without leaking resolvers", async () => {
      const gate = createWelcomeGate();

      // First cycle.
      gate.open();
      const first = gate.wait();
      gate.close();
      await first;

      // Second cycle — fresh waiter should block until the second close(),
      // not resolve prematurely because of a stale resolver from cycle one.
      gate.open();
      let secondResolved = false;
      const second = gate.wait().then(() => {
        secondResolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      gate.close();
      await second;
      expect(secondResolved).toBe(true);
    });
  });

  describe("sendMessage race (the bug this gate exists to prevent)", () => {
    // The actual scenario: sendMessage() calls gate.wait() after
    // ensureConnected returns. The welcome handler calls gate.close() when
    // the Chatbot welcome is dropped. If the real answer races ahead of the
    // welcome, the handler will NOT see pending=false and will fall through
    // to SET_ANSWER instead of being eaten as "the welcome".
    //
    // These two tests encode that contract: close() happens-before wait()
    // resolution; `pending` is observable to the handler between open() and
    // close().

    it("handler sees pending=true while sendMessage is waiting", async () => {
      const gate = createWelcomeGate();
      gate.open();

      // sendMessage awaits in the background.
      let sendProceeded = false;
      const sendPath = gate.wait().then(() => {
        sendProceeded = true;
      });

      // Message handler fires on each incoming event and checks pending.
      // While the gate is open, pending is true → handler eats this event.
      const handlerSawPending = gate.pending;
      expect(handlerSawPending).toBe(true);
      expect(sendProceeded).toBe(false);

      // Welcome arrives → handler closes the gate.
      gate.close();
      await sendPath;

      // Now any further message is treated as the real answer.
      expect(gate.pending).toBe(false);
      expect(sendProceeded).toBe(true);
    });

    it("warm send (gate never opened) does not stall", async () => {
      const gate = createWelcomeGate();
      // sendMessage on a warm connection — ensureConnected short-circuits,
      // never calls gate.open(). wait() must resolve on the next microtask.
      const start = Date.now();
      await gate.wait();
      // 50ms is a generous ceiling for a resolved-microtask promise even on
      // a slow CI runner; the real duration is sub-millisecond.
      expect(Date.now() - start).toBeLessThan(50);
    });
  });
});
