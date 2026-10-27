/**
 * ConnectionManager — FSM for the SCRT2 handshake lifecycle.
 *
 * Replaces three previously-ad-hoc refs in WidgetProvider:
 *   - `connectPromiseRef`      → single-flight connect promise (internal)
 *   - `welcomeReceivedRef`     → welcome gate (internal)
 *   - `welcomeWaitersRef`      → waiters awaiting welcome (internal)
 *
 * The handshake has three distinct phases that previously had no explicit
 * name:
 *   1. transport open (SSE)
 *   2. conversation created (first POST to /conversation)
 *   3. welcome received (first Chatbot SSE entry = bot has joined)
 *
 * Only after (3) is the send path safe to post `commerce_agent_context` —
 * SCRT2 drops the payload earlier. Expressing those phases as explicit
 * states (and exposing one awaitable per state) lets sendMessage block on
 * exactly what it needs, and lets the SDK's `connected`/`disconnected`/
 * `SESSION_EXPIRED` events drive transitions without touching provider
 * refs.
 *
 * Pure (no React, no DOM) and unit-testable with a trivial client fake.
 */

import type { ConnectableClient, PromiseHolder, SessionPersistence } from "./ensure-connected";
import { ensureConnected } from "./ensure-connected";

export type ConnectionState =
  // Mounted with a client but no handshake has started yet.
  | "NOT_STARTED"
  // ensureConnected is in flight — token/SSE/conversation handshake running.
  | "TRANSPORT_CONNECTING"
  // SSE stream is open and a conversation exists, but the welcome hasn't
  // arrived yet. sendMessage must wait here before posting context.
  | "CONVERSATION_READY"
  // Welcome received — safe to send with commerce_agent_context.
  | "READY"
  // A handshake attempt failed; the next send will retry fresh.
  | "FAILED";

export interface ConnectionManagerOptions {
  client: ConnectableClient;
  persistence?: SessionPersistence;
  /** Fired once per handshake attempt as it starts (dispatches "connecting"). */
  onHandshakeStart?: () => void;
  /** Fired once the conversation is created (so the provider can mirror the id). */
  onConversationCreated?: () => void;
  /** Fired on every state transition (useful for logging/tests). */
  onStateChange?: (prev: ConnectionState, next: ConnectionState) => void;
}

export class ConnectionManager {
  private readonly client: ConnectableClient;
  private readonly persistence?: SessionPersistence;
  private readonly onHandshakeStart?: () => void;
  private readonly onConversationCreated?: () => void;
  private readonly onStateChange?: (prev: ConnectionState, next: ConnectionState) => void;

  private _state: ConnectionState = "NOT_STARTED";
  // Memoizes the in-flight handshake so concurrent callers share one attempt.
  // Shape-compatible with ensureConnected's PromiseHolder.
  private readonly promiseHolder: PromiseHolder = { current: null };
  private welcomeReceived = false;
  private welcomeWaiters: Array<() => void> = [];

  constructor(opts: ConnectionManagerOptions) {
    this.client = opts.client;
    this.persistence = opts.persistence;
    this.onHandshakeStart = opts.onHandshakeStart;
    this.onConversationCreated = opts.onConversationCreated;
    this.onStateChange = opts.onStateChange;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * True once the first Chatbot SSE entry has landed (= bot joined). Mirrors
   * the previous `welcomeReceivedRef.current` so the provider's SSE handlers
   * can short-circuit after the first fire.
   */
  get hasWelcome(): boolean {
    return this.welcomeReceived;
  }

  /**
   * Signal that the first Chatbot SSE entry has arrived. Idempotent — only
   * the first call flips the gate and drains waiters. Transitions
   * CONVERSATION_READY → READY.
   */
  notifyWelcome(): void {
    if (this.welcomeReceived) return;
    this.welcomeReceived = true;
    const waiters = this.welcomeWaiters;
    this.welcomeWaiters = [];
    for (const resolve of waiters) resolve();
    if (this._state === "CONVERSATION_READY") this.setState("READY");
  }

  /**
   * Run the token/SSE/conversation handshake if it hasn't already succeeded.
   * Shares one attempt across concurrent callers.
   */
  async connect(): Promise<void> {
    if (this._state === "NOT_STARTED" || this._state === "FAILED") {
      this.setState("TRANSPORT_CONNECTING");
    }
    try {
      await ensureConnected(
        this.client,
        this.promiseHolder,
        this.onHandshakeStart,
        this.persistence,
        () => {
          this.onConversationCreated?.();
          if (this._state === "TRANSPORT_CONNECTING") {
            this.setState(this.welcomeReceived ? "READY" : "CONVERSATION_READY");
          }
        },
      );
      // Covers the already-connected case: ensureConnected returns immediately
      // when conversationId is set (e.g. after a persisted-session restore)
      // and does NOT fire onConversationCreated.
      if (this._state === "TRANSPORT_CONNECTING") {
        this.setState(this.welcomeReceived ? "READY" : "CONVERSATION_READY");
      }
    } catch (err) {
      this.setState("FAILED");
      throw err;
    }
  }

  /**
   * Wait for the first Chatbot SSE entry (bot joined). Rejects with
   * `welcome_timeout` if nothing lands in `timeoutMs`.
   */
  waitForWelcome(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.welcomeReceived) {
        resolve();
        return;
      }
      const resolveOnce = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.welcomeWaiters = this.welcomeWaiters.filter((w) => w !== resolveOnce);
        reject(new Error("welcome_timeout"));
      }, timeoutMs);
      this.welcomeWaiters.push(resolveOnce);
    });
  }

  /**
   * Reset to NOT_STARTED. Called by the provider on a failed first send (so
   * the retry mints a fresh session) and on SDK `SESSION_EXPIRED`.
   */
  reset(): void {
    this.promiseHolder.current = null;
    this.welcomeReceived = false;
    this.welcomeWaiters = [];
    this.setState("NOT_STARTED");
  }

  /** Persist the current session via the injected adapter (no-op without one). */
  persistSave(): void {
    this.persistence?.save();
  }

  /** Drain any outstanding welcome waiters without resolving them — teardown. */
  dispose(): void {
    this.welcomeWaiters = [];
  }

  private setState(next: ConnectionState): void {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this.onStateChange?.(prev, next);
  }
}
