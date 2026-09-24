import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { AgentforceClient } from "../sdk";
import { AgentforceApiError, AgentforceNetworkError } from "../sdk/errors";
import { WidgetContext } from "./context";
import { ensureConnected, type SessionPersistence } from "./ensure-connected";
import { initialWidgetState, widgetReducer } from "./reducer";
import { buildSessionKey, clearSession, loadSession, saveSession } from "./session-store";
import type { WidgetConfig } from "./types";
import { resolveProductId, withProductContext } from "./product-context";

function isMessageTooLong(err: unknown): boolean {
  return (
    err instanceof AgentforceApiError &&
    err.statusCode === 400 &&
    typeof err.responseBody === "string" &&
    err.responseBody.includes("maximum length")
  );
}

function toUserMessage(err: unknown): string {
  if (isMessageTooLong(err)) return "Message exceeds the maximum length of 4,000 characters.";
  if (err instanceof AgentforceNetworkError) return "Unable to reach the server. Please try again.";
  return "Something went wrong. Please try again.";
}

export function WidgetProvider({
  config,
  children,
}: {
  config: WidgetConfig;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(widgetReducer, initialWidgetState);
  const clientRef = useRef<AgentforceClient | null>(null);
  // The agent auto-sends a welcome/greeting the moment a conversation opens. We
  // don't want to surface anything the agent says before the user has actually
  // engaged, so all agent-originated events are gated on this until the first
  // user message is sent. A ref (not state) so the long-lived event handlers
  // read the latest value without needing to re-register.
  const hasUserSentRef = useRef(false);
  // Memoizes the in-flight lazy handshake (token → SSE → conversation) so
  // concurrent first sends share one attempt. Readiness itself is tracked by the
  // client's conversationId (see ensureConnected), not a separate flag.
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  // Safety timeout: if the welcome message hasn't arrived within 5s of
  // createConversation(), re-enable the send button anyway.
  const welcomeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The session-persistence adapter for the current client (null when
  // persistSession is off). Held in a ref so the long-lived handlers/callbacks
  // read the latest without re-registering.
  const persistenceRef = useRef<SessionPersistence | null>(null);

  const {
    scrt2Url,
    orgId,
    esDeveloperName,
    capabilitiesVersion,
    enableLogging,
    persistSession,
    productIdParam,
    productIdPattern,
  } = config;

  // The URL-based product-context config, held in a ref so the dependency-stable
  // sendMessage callback (deps: []) reads the latest without being recreated —
  // same rationale as hasUserSentRef / persistenceRef above. These fields do NOT
  // affect the connection, so they are deliberately kept out of the client-
  // building effect's deps (exactly like `placeholder`).
  const productContextRef = useRef({ productIdParam, productIdPattern });
  useEffect(() => {
    productContextRef.current = { productIdParam, productIdPattern };
  }, [productIdParam, productIdPattern]);

  // Track the current product ID so we can clear stale question/answer when the
  // user navigates between PDPs without unmounting the widget (SPA navigation).
  const prevProductIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const currentProductId =
      typeof window !== "undefined"
        ? resolveProductId(window.location, { productIdParam, productIdPattern })
        : null;
    if (prevProductIdRef.current === undefined) {
      prevProductIdRef.current = currentProductId;
      return;
    }
    if (currentProductId !== prevProductIdRef.current) {
      prevProductIdRef.current = currentProductId;
      dispatch({ type: "RESET_CONVERSATION" });
    }
  });

  // Create the client and register handlers whenever a connection-defining
  // attribute changes. In practice these are set once, before mount. NOTE: we
  // deliberately do NOT connect here — no token is fetched and no stream opens
  // until the user sends their first message (see sendMessage). Constructing the
  // client does no network, so this stays cheap.
  useEffect(() => {
    // Missing config is surfaced by render.tsx; here we simply don't build a
    // client (the sendMessage no-ops).
    if (!scrt2Url || !orgId || !esDeveloperName) return;

    const client = new AgentforceClient({
      baseURL: scrt2Url,
      orgId,
      esDeveloperName,
      options: {
        capabilitiesVersion,
        enableLogging,
      },
    });
    clientRef.current = client;
    // A fresh client has no session yet: suppress agent output and require a
    // new lazy connect on the next send.
    hasUserSentRef.current = false;
    connectPromiseRef.current = null;

    // Build the session-persistence adapter (or null when the feature is off).
    // The key is namespaced by orgId + esDeveloperName so widgets/configs don't
    // collide. tryRestore/save translate between the store and the client;
    // both must never throw (ensureConnected relies on that).
    const sessionKey = buildSessionKey(orgId, esDeveloperName);
    const persistence: SessionPersistence | null = persistSession
      ? {
          async tryRestore() {
            let rejectReason = "";
            const stored = loadSession(sessionKey, undefined, (reason) => {
              rejectReason = reason;
            });
            if (!stored) {
              // Nothing usable to restore: loadSession reports precisely why
              // (absent / wrong-origin, expired, malformed, …). We fall back to a
              // fresh handshake, which mints a new token. Logged (never the token
              // value) so an operator with logging on can tell an expected miss
              // apart from a real bug — and, crucially, distinguish "absent"
              // (e.g. seeded under a different origin/port) from "token-expired".
              if (enableLogging) {
                // eslint-disable-next-line no-console
                console.log(
                  `[Agentforce] persist: no restorable session (reason: ${rejectReason}) — ` +
                    `starting a fresh handshake`,
                );
              }
              return false;
            }
            try {
              await client.restore({
                accessToken: stored.accessToken,
                conversationId: stored.conversationId,
                lastEventId: stored.lastEventId,
              });
              // Restoring re-opens the SSE stream on an EXISTING conversation.
              // Keep hasUserSentRef false so replayed SSE messages (old answer)
              // are suppressed — the user should start with a clean slate. The
              // flag flips to true in sendMessage once they actually ask.
              // No welcome greeting is expected on restore, so enable send
              // immediately.
              dispatch({ type: "SET_CONNECTION_READY", ready: true });
              return true;
            } catch (err) {
              // The stored token was valid by our checks but SSE refused it (or
              // the network failed) — drop it and fall back to a fresh handshake.
              // Distinct from the no-op above: this means restore was ATTEMPTED
              // and failed, which is the signal that reuse isn't working.
              if (enableLogging) {
                // eslint-disable-next-line no-console
                console.warn(
                  `[Agentforce] persist: restore failed ` +
                    `(${err instanceof Error ? err.message : String(err)}) — ` +
                    `clearing stored session, starting a fresh handshake`,
                );
              }
              clearSession(sessionKey);
              return false;
            }
          },
          save() {
            const { accessToken, conversationId, lastEventId } = client;
            if (!accessToken || !conversationId) return;
            saveSession(sessionKey, { accessToken, conversationId, lastEventId });
          },
        }
      : null;
    persistenceRef.current = persistence;
    // Stale entry from a previous run when the feature is off: proactively clear
    // it so a dead token doesn't linger at a known key.
    if (!persistence) clearSession(sessionKey);

    // Register handlers now so no events are missed once we do connect.
    client.on("connected", () => dispatch({ type: "SET_STATUS", status: "connected" }));
    client.on("disconnected", () => dispatch({ type: "SET_STATUS", status: "disconnected" }));
    client.on("reconnecting", () => dispatch({ type: "SET_STATUS", status: "reconnecting" }));
    // The four handlers below carry agent output. Ignore them until the user
    // has sent a message — this drops the agent's automatic welcome greeting
    // (and any typing indicator / streamed tokens that precede it) that the
    // agent emits when the conversation is created on first send.
    client.on("typing_started", () => {
      if (hasUserSentRef.current) dispatch({ type: "SET_AGENT_TYPING", typing: true });
    });
    client.on("typing_stopped", () => {
      if (hasUserSentRef.current) dispatch({ type: "SET_AGENT_TYPING", typing: false });
    });
    client.on("streaming_token", (e) => {
      if (hasUserSentRef.current) dispatch({ type: "APPEND_STREAMING_TOKEN", token: e.token });
    });
    client.on("message", (e) => {
      if (!hasUserSentRef.current) {
        // This is the welcome greeting — drop it and enable the send button.
        if (welcomeTimeoutRef.current) {
          clearTimeout(welcomeTimeoutRef.current);
          welcomeTimeoutRef.current = null;
        }
        dispatch({ type: "SET_CONNECTION_READY", ready: true });
        return;
      }
      dispatch({ type: "SET_ANSWER", content: e.content });
    });
    client.on("error", (e) => {
      if (e.code === "SESSION_EXPIRED") {
        clearSession(sessionKey);
        hasUserSentRef.current = false;
        connectPromiseRef.current = null;
        dispatch({ type: "SET_ANSWER", content: "" });
        dispatch({ type: "SET_STATUS", status: "idle" });
        dispatch({ type: "SET_ERROR", error: null });
        dispatch({ type: "SET_CONNECTION_READY", ready: true });
        return;
      }
      dispatch({ type: "SET_ERROR", error: "Something went wrong. Please try again." });
      if (e.recoverable === false) clearSession(sessionKey);
    });

    return () => {
      client.off();
      if (welcomeTimeoutRef.current) {
        clearTimeout(welcomeTimeoutRef.current);
        welcomeTimeoutRef.current = null;
      }
      // Capture BEFORE endConversation() nulls it. NOTE: on a full (non-SPA)
      // page navigation this cleanup does NOT run — the JS context is destroyed
      // — so a persisted session correctly survives to the next page. This only
      // runs on a genuine unmount or a config-change remount.
      const hadConversation = client.conversationId != null;
      void client.endConversation();
      client.disconnect();
      // We deliberately ended an active conversation → the persisted token now
      // points at a dead conversation, so drop it. Guarding on hadConversation
      // avoids wiping a stored-but-not-yet-restored session during a lazy /
      // StrictMode remount where no conversation exists yet.
      if (hadConversation) clearSession(sessionKey);
      if (clientRef.current === client) clientRef.current = null;
      if (persistenceRef.current === persistence) persistenceRef.current = null;
    };
  }, [scrt2Url, orgId, esDeveloperName, capabilitiesVersion, enableLogging, persistSession]);

  const onConversationCreated = useCallback(() => {
    dispatch({ type: "SET_CONNECTION_READY", ready: false });
    if (welcomeTimeoutRef.current) clearTimeout(welcomeTimeoutRef.current);
    welcomeTimeoutRef.current = setTimeout(() => {
      welcomeTimeoutRef.current = null;
      dispatch({ type: "SET_CONNECTION_READY", ready: true });
    }, 5000);
  }, []);

  // Warm up the session (token → SSE → conversation) ahead of the first send —
  // called when the user starts typing, so the network latency is hidden behind
  // their typing time. Idempotent and non-blocking: ensureConnected short-
  // circuits once a conversation exists or an attempt is in flight, and any
  // warm-up failure is swallowed here (the actual send retries and surfaces the
  // error then). Crucially, the greeting the agent auto-sends on conversation
  // creation arrives during this warm-up window, while hasUserSentRef is still
  // false — so it is dropped by the handlers above before the user ever sends.
  const prepareConnection = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    void ensureConnected(
      client,
      connectPromiseRef,
      () => dispatch({ type: "SET_STATUS", status: "connecting" }),
      persistenceRef.current ?? undefined,
      onConversationCreated,
    ).catch(() => {
      // Swallow — surfacing a connect error while the user is merely typing
      // would be noise. sendMessage() will retry and report if it still fails.
    });
  }, [onConversationCreated]);

  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    const client = clientRef.current;
    const trimmed = text.trim();
    if (!client || !trimmed) return false;

    if (trimmed.length > 4000) {
      dispatch({ type: "SET_ERROR", error: "Message exceeds the maximum length of 4,000 characters." });
      return false;
    }

    // Clear the previous answer immediately so the UI reacts to the send even if
    // the handshake is still warming up (the message is effectively queued).
    dispatch({ type: "ASK_QUESTION", question: trimmed });

    const messageBody =
      withProductContext(
        trimmed,
        typeof window !== "undefined"
          ? resolveProductId(window.location, productContextRef.current)
          : null,
      );

    // connectAndSend handles one attempt: ensure the session is live, then send.
    // On any non-400 failure the SDK tears down the session, so a second call
    // will do a fresh handshake transparently.
    const connectAndSend = async (): Promise<void> => {
      await ensureConnected(
        client,
        connectPromiseRef,
        () => dispatch({ type: "SET_STATUS", status: "connecting" }),
        persistenceRef.current ?? undefined,
        onConversationCreated,
      );
      if (clientRef.current !== client) throw new Error("unmounted");
      await client.sendMessage(messageBody);
    };

    try {
      await connectAndSend();
    } catch (firstErr) {
      // 400 = client input problem (message too long) — don't retry.
      if (isMessageTooLong(firstErr)) {
        dispatch({ type: "SET_ERROR", error: toUserMessage(firstErr) });
        return false;
      }

      // Any other failure: the SDK already tore down the session. Clear
      // persisted state and retry once with a completely fresh session.
      if (enableLogging) {
        // eslint-disable-next-line no-console
        console.warn("[Agentforce] first attempt failed, retrying with fresh session:", firstErr);
      }
      const sessionKey = buildSessionKey(orgId, esDeveloperName);
      clearSession(sessionKey);
      hasUserSentRef.current = false;
      connectPromiseRef.current = null;

      try {
        await connectAndSend();
      } catch (retryErr) {
        if (enableLogging) {
          // eslint-disable-next-line no-console
          console.error("[Agentforce] retry also failed:", retryErr);
        }
        dispatch({ type: "SET_ERROR", error: toUserMessage(retryErr) });
        dispatch({ type: "SET_STATUS", status: "disconnected" });
        return false;
      }
    }

    // Bail if torn down while the send was in flight.
    if (clientRef.current !== client) return false;

    persistenceRef.current?.save();

    // Surface agent output only after the send succeeds. The greeting from
    // createConversation() was dropped while hasUserSentRef was false.
    hasUserSentRef.current = true;

    return true;
  }, [onConversationCreated]);

  const value = useMemo(
    () => ({ state, dispatch, sendMessage, prepareConnection, config }),
    [state, sendMessage, prepareConnection, config],
  );

  return <WidgetContext.Provider value={value}>{children}</WidgetContext.Provider>;
}
