import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { AgentforceClient } from "../sdk";
import { AgentforceApiError, AgentforceNetworkError } from "../sdk/errors";
import { WidgetContext } from "./context";
import { ensureConnected, type SessionPersistence } from "./ensure-connected";
import { initialWidgetState, widgetReducer } from "./reducer";
import { buildSessionKey, clearSession, loadSession, saveSession } from "./session-store";
import type { WidgetConfig } from "./types";
import { resolveProductId, withProductContext } from "./product-context";
import { createWelcomeGate } from "./welcome-gate";

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
  hostElement,
  conversationIdRef,
}: {
  config: WidgetConfig;
  children: ReactNode;
  hostElement?: HTMLElement;
  conversationIdRef?: { current: string | null };
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
  // the handshake starting, re-enable the send button anyway.
  const welcomeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Welcome-greeting gate — SEND-SIDE guard only. `wait()` is awaited by
  // sendMessage so the user POST is held until either the welcome has
  // resolved or the 5s timeout fires, preventing a fast agent's real
  // answer from being eaten as "the welcome" on a cold first send
  // (classic "first-click never answers" bug). On a warm send (no
  // handshake running), `wait()` is a resolved-microtask no-op.
  // RECEIVE-SIDE "is the welcome consumed?" state lives in
  // welcomeDroppedRef below, which outlives the timeout so a slow
  // welcome that arrives post-POST is still correctly identified.
  // Lazily-constructed via a ref so the gate's identity is stable
  // across renders without rebuilding on every mount.
  const welcomeGateRef = useRef(createWelcomeGate());
  // Durable "has the welcome been consumed yet?" flag. The gate above is a
  // SEND-SIDE guard (hold the user POST until the welcome has resolved OR the
  // 5s timeout fires). This flag is a RECEIVE-SIDE guard that outlives the
  // timeout: on a slow Agentforce (>5s to emit the welcome `message`), the
  // gate closes on timeout, the user POST goes out, hasUserSentRef flips true
  // — and then the late welcome `message` arrives. Without this flag, the
  // message handler sees `hasUserSentRef=true` + `gate.pending=false` and
  // falls through to SET_ANSWER, flashing the welcome as if it were the
  // answer (observed in incognito-cold loads). Flipped true the first time
  // we consume any Chatbot `message`, OR pre-set true on a successful
  // tryRestore (no welcome is emitted on restore). Reset to false everywhere
  // a fresh handshake is about to run (new client, SESSION_EXPIRED, retry
  // prelude).
  const welcomeDroppedRef = useRef(false);
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
    pdpQuestions,
  } = config;

  // Keep the reducer's pdpQuestions in sync with the incoming config. Fires on
  // initial mount and whenever the host swaps the list (SPA nav to a different
  // PDP, variant switch that re-fetches the product). The array is
  // JSON.stringify-compared so identity churn doesn't cause a needless dispatch.
  const pdpQuestionsKey = pdpQuestions ? JSON.stringify(pdpQuestions) : "";
  useEffect(() => {
    dispatch({ type: "SET_PDP_QUESTIONS", questions: pdpQuestions ?? [] });
  }, [pdpQuestionsKey]);

  // The URL-based product-context config, held in a ref so the dependency-stable
  // sendMessage callback (deps: []) reads the latest without being recreated —
  // same rationale as hasUserSentRef / persistenceRef above. These fields do NOT
  // affect the connection, so they are deliberately kept out of the client-
  // building effect's deps (exactly like `placeholder`).
  const productContextRef = useRef({ productIdParam, productIdPattern });
  useEffect(() => {
    productContextRef.current = { productIdParam, productIdPattern };
  }, [productIdParam, productIdPattern]);

  // Clear stale question/answer when the user navigates between PDPs via SPA
  // routing. SPA frameworks use pushState/replaceState (no popstate event) and
  // the browser fires popstate on back/forward, so we listen for all three.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let lastProductId = resolveProductId(window.location, { productIdParam, productIdPattern });

    const checkProductChange = () => {
      const currentId = resolveProductId(window.location, { productIdParam, productIdPattern });
      if (currentId !== lastProductId) {
        lastProductId = currentId;
        dispatch({ type: "RESET_CONVERSATION" });
      }
    };

    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    history.pushState = (...args) => { origPushState(...args); checkProductChange(); };
    history.replaceState = (...args) => { origReplaceState(...args); checkProductChange(); };
    window.addEventListener("popstate", checkProductChange);

    return () => {
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      window.removeEventListener("popstate", checkProductChange);
    };
  }, [productIdParam, productIdPattern]);

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
    welcomeGateRef.current.close();
    welcomeDroppedRef.current = false;
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
              // immediately AND pre-mark the welcome as already consumed so
              // the first post-restore Chatbot `message` is treated as a real
              // answer (not dropped as a late welcome).
              welcomeDroppedRef.current = true;
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
      // Agentforce streams the WELCOME message too, not just real answers.
      // Three states to think about:
      //
      //   pre-send (hasUserSentRef=false): welcome tokens. Drop. Keep the
      //     gate pending so the `message` branch below closes it on the
      //     welcome's final `message`.
      //
      //   post-send, welcome not yet dropped: still welcome tokens (slow
      //     agent raced past the 5s timeout). Drop them too — appending
      //     into streamingText would paint the welcome as the answer.
      //
      //   post-send, welcome already dropped: real answer tokens. Append.
      if (!hasUserSentRef.current) return;
      if (!welcomeDroppedRef.current) return;
      welcomeGateRef.current.close();
      dispatch({ type: "APPEND_STREAMING_TOKEN", token: e.token });
    });
    client.on("message", (e) => {
      const isChatbot = e.sender.role !== "EndUser";
      if (!hasUserSentRef.current) {
        // Gate closed — drop everything. If this is the welcome (Chatbot),
        // also resolve the welcome gate, mark the welcome consumed, and
        // enable the send button.
        if (welcomeGateRef.current.pending && isChatbot) {
          if (welcomeTimeoutRef.current) {
            clearTimeout(welcomeTimeoutRef.current);
            welcomeTimeoutRef.current = null;
          }
          welcomeGateRef.current.close();
          welcomeDroppedRef.current = true;
          dispatch({ type: "SET_CONNECTION_READY", ready: true });
        }
        return;
      }
      // Post-send. The EndUser echo passes through untouched. For Chatbot
      // messages, the FIRST one we see is the welcome — regardless of
      // whether the gate is still pending (fast agent, both landed before
      // timeout) or already closed (slow agent, timeout fired and we
      // POSTed, then the welcome arrived late). welcomeDroppedRef is the
      // durable "has the welcome been consumed yet?" flag that outlives
      // the gate's timeout and tells us which Chatbot message is real.
      if (isChatbot && !welcomeDroppedRef.current) {
        welcomeDroppedRef.current = true;
        welcomeGateRef.current.close();
        return;
      }
      dispatch({ type: "SET_ANSWER", content: e.content });
    });
    client.on("session_ready", (e) => {
      if (hostElement) {
        hostElement.dispatchEvent(
          new CustomEvent("iaw:session-ready", {
            detail: {
              conversationId: e.conversationId,
              messagingSessionId: e.messagingSessionId,
            },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
    client.on("error", (e) => {
      if (e.code === "SESSION_EXPIRED") {
        clearSession(sessionKey);
        hasUserSentRef.current = false;
        welcomeGateRef.current.close();
        welcomeDroppedRef.current = false;
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
      if (conversationIdRef) conversationIdRef.current = null;
      if (welcomeTimeoutRef.current) {
        clearTimeout(welcomeTimeoutRef.current);
        welcomeTimeoutRef.current = null;
      }
      // Release any sendMessage() awaiter still blocked on the gate so it can
      // observe the unmount check and bail cleanly (it won't dispatch either
      // way — the clientRef !== client guard in connectAndSend catches it).
      welcomeGateRef.current.close();
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

  // Warm up the session (token → SSE → conversation) ahead of the first send —
  // called when the user starts typing, so the network latency is hidden behind
  // their typing time. Idempotent and non-blocking: ensureConnected short-
  // circuits once a conversation exists or an attempt is in flight, and any
  // warm-up failure is swallowed here (the actual send retries and surfaces the
  // error then). Crucially, the greeting the agent auto-sends on conversation
  // creation arrives during this warm-up window, while hasUserSentRef is still
  // false — so it is dropped by the handlers above before the user ever sends.
  const onHandshakeStart = useCallback(() => {
    dispatch({ type: "SET_STATUS", status: "connecting" });
    dispatch({ type: "SET_CONNECTION_READY", ready: false });
    welcomeGateRef.current.open();
    if (welcomeTimeoutRef.current) clearTimeout(welcomeTimeoutRef.current);
    welcomeTimeoutRef.current = setTimeout(() => {
      welcomeTimeoutRef.current = null;
      // Nothing came in 5s: close the gate (releases any sendMessage() awaiter
      // on the lazy-send path, so the user POST goes out instead of hanging
      // forever) and re-enable the Send button. Any Chatbot message that
      // arrives after this is treated as the real answer (gate no longer
      // pending), which is the right call for a silent agent.
      welcomeGateRef.current.close();
      dispatch({ type: "SET_CONNECTION_READY", ready: true });
    }, 5000);
  }, []);

  const onConversationCreated = useCallback(() => {
    const id = clientRef.current?.conversationId ?? null;
    if (conversationIdRef) conversationIdRef.current = id;
  }, [conversationIdRef]);

  const prepareConnection = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    void ensureConnected(
      client,
      connectPromiseRef,
      onHandshakeStart,
      persistenceRef.current ?? undefined,
      onConversationCreated,
    ).catch(() => {
      // Swallow — surfacing a connect error while the user is merely typing
      // would be noise. sendMessage() will retry and report if it still fails.
    });
  }, [onHandshakeStart, onConversationCreated]);

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
    // Show the typing dots on send INTENT, not on SSE `typing_started`. On a
    // cold first click the handshake takes ~1-2s before any SSE event lands;
    // waiting for `typing_started` leaves the UI frozen that whole time. The
    // dots are the shopper's "I heard you" acknowledgement. They naturally
    // hide once streaming starts (Response.tsx: showTyping = agentTyping &&
    // !showStreaming). Cleared on every error-return path below.
    dispatch({ type: "SET_AGENT_TYPING", typing: true });

    const messageBody =
      withProductContext(
        trimmed,
        typeof window !== "undefined"
          ? resolveProductId(window.location, productContextRef.current)
          : null,
      );

    // connectAndSend handles one attempt: ensure the session is live, wait for
    // the welcome ticket to resolve, then send. On any non-400 failure the SDK
    // tears down the session, so a second call will do a fresh handshake
    // transparently.
    //
    // Why await the welcome gate here: on a cold lazy-send (first click of a
    // pill, or first Send on an untyped InputBar), ensureConnected() opens the
    // gate, then returns. If we POST before the welcome has landed and been
    // dropped by the handler, the agent's REAL answer can arrive first and get
    // eaten as "the welcome" (classic first-click-no-answer bug). Awaiting the
    // gate guarantees we POST only after the welcome has been dropped (fast
    // agent), skipped (streaming started), or timed out (silent agent). On a
    // warm send (handshake already complete, no gate open), the await is a
    // no-op microtask.
    const connectAndSend = async (): Promise<void> => {
      await ensureConnected(
        client,
        connectPromiseRef,
        onHandshakeStart,
        persistenceRef.current ?? undefined,
        onConversationCreated,
      );
      if (clientRef.current !== client) throw new Error("unmounted");
      await welcomeGateRef.current.wait();
      if (clientRef.current !== client) throw new Error("unmounted");
      await client.sendMessage(messageBody);
    };

    try {
      await connectAndSend();
    } catch (firstErr) {
      // 400 = client input problem (message too long) — don't retry.
      if (isMessageTooLong(firstErr)) {
        dispatch({ type: "SET_AGENT_TYPING", typing: false });
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
      welcomeGateRef.current.close();
      welcomeDroppedRef.current = false;
      connectPromiseRef.current = null;

      try {
        await connectAndSend();
      } catch (retryErr) {
        if (enableLogging) {
          // eslint-disable-next-line no-console
          console.error("[Agentforce] retry also failed:", retryErr);
        }
        dispatch({ type: "SET_AGENT_TYPING", typing: false });
        dispatch({ type: "SET_ERROR", error: toUserMessage(retryErr) });
        dispatch({ type: "SET_STATUS", status: "disconnected" });
        return false;
      }
    }

    // Bail if torn down while the send was in flight. No need to clear
    // typing here — the component already unmounted or is remounting; the
    // state will be re-initialized from scratch.
    if (clientRef.current !== client) return false;

    persistenceRef.current?.save();

    // Surface agent output only after the send succeeds. The greeting from
    // createConversation() was dropped while hasUserSentRef was false.
    hasUserSentRef.current = true;

    return true;
  }, [onHandshakeStart, onConversationCreated]);

  const value = useMemo(
    () => ({ state, dispatch, sendMessage, prepareConnection, config }),
    [state, sendMessage, prepareConnection, config],
  );

  return <WidgetContext.Provider value={value}>{children}</WidgetContext.Provider>;
}
