/**
 * Lazy SCRT2 handshake helper.
 *
 * The widget defers its network handshake (token → SSE → conversation) until
 * the user sends their first message. `ensureConnected` runs that handshake
 * exactly once and hands back a promise the caller can await before sending.
 *
 * It's factored out of `WidgetProvider` so the run-once / reset-on-failure
 * logic can be unit-tested without React or the DOM.
 */

/** The subset of `AgentforceClient` the handshake needs. */
export interface ConnectableClient {
  readonly isConnected: boolean;
  readonly conversationId: string | null;
  connect(): Promise<void>;
  createConversation(): Promise<string>;
}

/** A mutable single-slot holder — shape-compatible with a React ref. */
export interface PromiseHolder {
  current: Promise<void> | null;
}

/**
 * Optional session-persistence adapter (see `session-store.ts`). When supplied,
 * `ensureConnected` tries to rehydrate a stored session before minting a fresh
 * one, and persists after a fresh handshake. Encapsulating both actions here
 * (rather than threading storage + client internals through) keeps the helper
 * unit-testable with a trivial fake.
 */
export interface SessionPersistence {
  /**
   * Rehydrate a persisted session if one is valid: open SSE with the stored
   * token AND adopt the stored conversationId. Resolves `true` if restored
   * (skip the fresh handshake), `false` if there was nothing to restore or the
   * restore failed (fall back to a fresh handshake). MUST NOT throw.
   */
  tryRestore(): Promise<boolean>;
  /** Persist the client's current session (called after a fresh handshake). */
  save(): void;
}

/**
 * Ensure the client has completed its initial handshake, running it at most
 * once even under concurrent/rapid calls.
 *
 * Readiness is keyed on `conversationId` (not `isConnected`): a conversation
 * only exists once the FULL handshake succeeded, so this
 *   - retries a partial handshake (e.g. `connect()` ok but `createConversation()`
 *     failed), skipping the token refetch when the stream is already open;
 *   - naturally re-establishes a session the SDK gave up on (a `SESSION_EXPIRED`
 *     clears `conversationId`), starting a fresh handshake on the next send;
 *   - does NOT fire during a transient SSE reconnect (the conversation is
 *     preserved), which would otherwise mint a new anonymous identity.
 *
 * @param client  The client to bring online.
 * @param holder  Memoizes the in-flight handshake promise (a React ref). It is
 *                cleared as part of the attempt settling — on failure so the
 *                next call retries, and on success so a later re-establishment
 *                isn't blocked by a stale resolved promise. Because the clear
 *                happens inside the returned promise's own body, any caller that
 *                awaits it is guaranteed to observe `holder.current === null`
 *                afterward (no lagging microtask).
 * @param onStart Invoked once when a new handshake actually begins (e.g. to
 *                dispatch a "connecting" status). Not called on a no-op or when
 *                joining an already in-flight handshake.
 * @param persistence Optional session-persistence adapter. When supplied, a
 *                valid stored session is rehydrated (no token mint / no new
 *                conversation) before falling back to a fresh handshake; a fresh
 *                handshake is persisted via `save()`.
 * @returns A promise that resolves when the client is ready to send, or rejects
 *          if the handshake failed.
 */
export function ensureConnected(
  client: ConnectableClient,
  holder: PromiseHolder,
  onStart?: () => void,
  persistence?: SessionPersistence,
  onConversationCreated?: () => void,
): Promise<void> {
  // Already fully handshaken — nothing to do.
  if (client.conversationId != null) return Promise.resolve();

  // A handshake is already in flight — join it instead of starting another.
  if (holder.current) return holder.current;

  onStart?.();

  // Hold the promise in an object so the `finally` can reference it without a
  // forward self-reference (the async body suspends at its first await, so
  // `attempt.promise` is assigned well before `finally` runs).
  const attempt: { promise: Promise<void> | null } = { promise: null };

  attempt.promise = (async () => {
    try {
      // Try to rehydrate a persisted session first. If it restores, the stream
      // is up and the conversationId is adopted — skip the fresh handshake
      // entirely (no token mint, no new conversation → same anonymous UID).
      if (persistence && !client.isConnected) {
        if (await persistence.tryRestore()) return;
      }
      // Skip connect() if the stream is already up (e.g. retrying after only
      // createConversation() failed) — re-connecting would refetch the token.
      if (!client.isConnected) await client.connect();
      await client.createConversation();
      onConversationCreated?.();
      // Persist the freshly established session so a later page load can restore
      // it. save() reads the client's current token/conversationId/lastEventId.
      persistence?.save();
    } finally {
      // Release the memo as this attempt settles, so the very next call sees a
      // clean slate: retry after failure, or re-establish after the guard-keyed
      // conversationId is cleared by a later expiry. The identity check leaves a
      // newer attempt (e.g. after a config-change remount) untouched. Because
      // this runs inside the returned promise's body, any awaiter observes the
      // cleared holder — no lagging microtask.
      if (holder.current === attempt.promise) holder.current = null;
    }
  })();

  holder.current = attempt.promise;

  return attempt.promise;
}
