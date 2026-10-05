/**
 * Welcome-greeting gate.
 *
 * SCRT2 Agent emits an auto-welcome message the moment a conversation is
 * created. `WidgetProvider` already drops that welcome via `hasUserSentRef` +
 * a skip-ticket. The gate here is the second half of that contract: an
 * **awaitable** ticket so `sendMessage` can hold the user POST until the
 * welcome has been resolved — otherwise, on a cold first send (first pill
 * click, or first keystroke-less Send), the agent's REAL answer can arrive
 * first and get eaten as "the welcome" by the handler ("first-click never
 * answers" bug).
 *
 * The gate is a tiny state machine with three states:
 *   • idle         — not pending; `await` returns instantly.
 *   • pending      — ticket open; `await` blocks until `close()` is called.
 *   • pending + waiters — one or more sendMessage awaiters are queued.
 *
 * The gate is intentionally unaware of WHY it closes — WidgetProvider closes
 * it from any definitive signal (welcome dropped, streaming token started,
 * 5s welcome-timeout, SESSION_EXPIRED, remount cleanup). Factored out of
 * `WidgetProvider` so the race-sensitive promise plumbing can be unit-tested
 * without React or the DOM, matching the pattern of `ensure-connected.ts`.
 */

/** The gate's public surface. `pending` is read by the message handler
 *  (skip-ticket check); the methods are called by WidgetProvider. */
export interface WelcomeGate {
  /** True while a welcome is expected and has not yet been resolved. */
  readonly pending: boolean;
  /** Open the gate. Idempotent — reopening a pending gate is a no-op. */
  open(): void;
  /**
   * Close the gate and resolve any queued awaiters. Safe to call when the
   * gate is already closed (no-op, no exception). After close(), any
   * waiter that was blocked observes resolution on its next microtask.
   */
  close(): void;
  /**
   * Resolve when the gate is closed. Returns an already-resolved promise
   * when the gate isn't pending (zero-latency on warm sends). Multiple
   * concurrent awaiters each get their own promise and are all resolved
   * by a single close() call. Named `wait` (not `await`) so caller sites
   * read naturally: `await gate.wait()`.
   */
  wait(): Promise<void>;
}

/**
 * Create a fresh gate in the idle state. Each WidgetProvider instance owns
 * one gate; the gate itself holds no React state and is pure to construct.
 */
export function createWelcomeGate(): WelcomeGate {
  let pending = false;
  let resolvers: Array<() => void> = [];

  return {
    get pending() {
      return pending;
    },
    open() {
      pending = true;
    },
    close() {
      if (!pending && resolvers.length === 0) return;
      pending = false;
      // Snapshot and swap BEFORE invoking so a resolver that synchronously
      // re-queues (unlikely, but cheap to defend) can't see a half-drained
      // list or observe the gate as still-closing.
      const toResolve = resolvers;
      resolvers = [];
      for (const r of toResolve) r();
    },
    wait(): Promise<void> {
      if (!pending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
}
