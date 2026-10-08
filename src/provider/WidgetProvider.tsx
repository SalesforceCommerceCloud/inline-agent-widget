import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { AgentforceClient } from "../sdk";
import { AgentforceApiError, AgentforceNetworkError } from "../sdk/errors";
import { WidgetContext } from "./context";
import { ensureConnected, type SessionPersistence } from "./ensure-connected";
import { initialWidgetState, widgetReducer } from "./reducer";
import { buildSessionKey, clearSession, loadSession, saveSession } from "./session-store";
import type { WidgetConfig } from "./types";
import { buildPdpInlineContext, resolveProductId } from "./product-context";
import { classifyMessage, shouldAppendStreamingToken } from "./welcome-tracker";

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

/** Buffered pre-echo Chatbot entry: we don't yet know the echo cutoff,
 *  so we stash the message content + its server timestamp and replay
 *  them through the classifier once user_echo lands. */
interface BufferedMessage {
  content: string;
  timestamp: string;
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
  // Memoizes the in-flight lazy handshake (token → SSE → conversation) so
  // concurrent first sends share one attempt. Readiness itself is tracked by the
  // client's conversationId (see ensureConnected), not a separate flag.
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  // Server-authoritative cutoff: the EndUser echo's transcriptedTimestamp.
  // Any Chatbot entry with ts <= cutoff is the pre-POST welcome; strictly
  // after is the answer. Null until the first echo lands. Reset wherever a
  // fresh handshake is about to run.
  const echoCutoffRef = useRef<string | null>(null);
  // Chatbot entries that arrived before the echo cutoff was known. Replayed
  // through the classifier once echoCutoffRef is set. On a restored session
  // we pre-mark the cutoff as a sentinel ("beginning of time") so replayed
  // historical entries render as answers rather than being buffered.
  const pendingChatbotBufferRef = useRef<BufferedMessage[]>([]);
  // Safety timeout: if nothing has unblocked the input within 5s of the
  // handshake starting, re-enable Send anyway. This is a UI-liveness
  // concern only — correctness of welcome-vs-answer is handled by the
  // echo cutoff above and does not depend on this firing.
  const uiReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // sendMessage callback (deps: []) reads the latest without being recreated.
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
    // Fresh client: no echo observed yet, buffer empty.
    echoCutoffRef.current = null;
    pendingChatbotBufferRef.current = [];
    connectPromiseRef.current = null;

    // Build the session-persistence adapter (or null when the feature is off).
    const sessionKey = buildSessionKey(orgId, esDeveloperName);
    const persistence: SessionPersistence | null = persistSession
      ? {
          async tryRestore() {
            let rejectReason = "";
            const stored = loadSession(sessionKey, undefined, (reason) => {
              rejectReason = reason;
            });
            if (!stored) {
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
              // Restoring re-opens the SSE stream on an EXISTING conversation —
              // no welcome will be emitted. Pre-set the cutoff to a sentinel
              // in the past so any replayed historical Chatbot entry sorts
              // AFTER it and renders as an answer (which matches the restored
              // conversation's state).
              echoCutoffRef.current = "0000-01-01T00:00:00.000Z";
              dispatch({ type: "SET_CONNECTION_READY", ready: true });
              return true;
            } catch (err) {
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
    if (!persistence) clearSession(sessionKey);

    // Register handlers now so no events are missed once we do connect.
    client.on("connected", () => dispatch({ type: "SET_STATUS", status: "connected" }));
    client.on("disconnected", () => dispatch({ type: "SET_STATUS", status: "disconnected" }));
    client.on("reconnecting", () => dispatch({ type: "SET_STATUS", status: "reconnecting" }));
    client.on("typing_started", () => {
      // Only surface typing dots once the shopper has engaged (echo observed).
      // Pre-echo typing is the agent composing the welcome, which we hide.
      if (echoCutoffRef.current !== null) dispatch({ type: "SET_AGENT_TYPING", typing: true });
    });
    client.on("typing_stopped", () => {
      if (echoCutoffRef.current !== null) dispatch({ type: "SET_AGENT_TYPING", typing: false });
    });
    // Streaming tokens: once the echo lands, SCRT2 delivers entries in server
    // order over the SSE stream, so any subsequent streaming token belongs to
    // the answer. Pre-echo tokens are the welcome being streamed — ignore.
    // Behavior lives in welcome-tracker.ts (pure, unit-tested).
    client.on("streaming_token", (e) => {
      if (!shouldAppendStreamingToken({ echoTimestamp: echoCutoffRef.current })) return;
      dispatch({ type: "APPEND_STREAMING_TOKEN", token: e.token });
    });
    client.on("user_echo", (e) => {
      // Server-authoritative cutoff for welcome-vs-answer. Set it, then drain
      // anything we buffered pre-echo through the same classifier.
      echoCutoffRef.current = e.timestamp;
      if (uiReadyTimeoutRef.current) {
        clearTimeout(uiReadyTimeoutRef.current);
        uiReadyTimeoutRef.current = null;
      }
      dispatch({ type: "SET_CONNECTION_READY", ready: true });

      const buffered = pendingChatbotBufferRef.current;
      pendingChatbotBufferRef.current = [];
      for (const m of buffered) {
        const verdict = classifyMessage(m.timestamp, { echoTimestamp: e.timestamp });
        if (verdict.action === "render-answer") {
          dispatch({ type: "SET_ANSWER", content: m.content });
        }
        // drop-welcome and (unreachable here) buffer: do nothing.
      }
    });
    client.on("message", (e) => {
      // EndUser echoes come through user_echo now; this handler sees only
      // Chatbot (Agent / Supervisor / Chatbot role) entries.
      if (echoCutoffRef.current === null) {
        pendingChatbotBufferRef.current.push({ content: e.content, timestamp: e.timestamp });
        return;
      }
      const verdict = classifyMessage(e.timestamp, { echoTimestamp: echoCutoffRef.current });
      if (verdict.action === "render-answer") {
        dispatch({ type: "SET_ANSWER", content: e.content });
      }
      // drop-welcome: ignore. buffer: not reachable (cutoff is set).
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
        echoCutoffRef.current = null;
        pendingChatbotBufferRef.current = [];
        connectPromiseRef.current = null;
        dispatch({ type: "SET_ANSWER", content: "" });
        dispatch({ type: "SET_STATUS", status: "idle" });
        dispatch({ type: "SET_ERROR", error: null });
        dispatch({ type: "SET_CONNECTION_READY", ready: true });
        return;
      }
      if (e.recoverable === false) {
        clearSession(sessionKey);
        dispatch({ type: "SET_ERROR", error: "Something went wrong. Please try again." });
      } else if (enableLogging) {
        // eslint-disable-next-line no-console
        console.warn(`[Agentforce] recoverable error (${e.code}) — SDK will retry silently`);
      }
    });

    return () => {
      client.off();
      if (conversationIdRef) conversationIdRef.current = null;
      if (uiReadyTimeoutRef.current) {
        clearTimeout(uiReadyTimeoutRef.current);
        uiReadyTimeoutRef.current = null;
      }
      // Capture BEFORE endConversation() nulls it. NOTE: on a full (non-SPA)
      // page navigation this cleanup does NOT run — the JS context is destroyed
      // — so a persisted session correctly survives to the next page.
      const hadConversation = client.conversationId != null;
      void client.endConversation();
      client.disconnect();
      if (hadConversation) clearSession(sessionKey);
      if (clientRef.current === client) clientRef.current = null;
      if (persistenceRef.current === persistence) persistenceRef.current = null;
    };
  }, [scrt2Url, orgId, esDeveloperName, capabilitiesVersion, enableLogging, persistSession]);

  // Warm up the session (token → SSE → conversation) ahead of the first send —
  // called when the user starts typing, so the network latency is hidden behind
  // their typing time. Idempotent and non-blocking.
  const onHandshakeStart = useCallback(() => {
    dispatch({ type: "SET_STATUS", status: "connecting" });
    dispatch({ type: "SET_CONNECTION_READY", ready: false });
    if (uiReadyTimeoutRef.current) clearTimeout(uiReadyTimeoutRef.current);
    uiReadyTimeoutRef.current = setTimeout(() => {
      // UI-liveness fallback only. The echo cutoff is still null; any
      // Chatbot entry that lands before the eventual echo (if any) is
      // still buffered and will be classified correctly on arrival.
      uiReadyTimeoutRef.current = null;
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

    dispatch({ type: "ASK_QUESTION", question: trimmed });
    // Show typing on send INTENT so the UI acknowledges the click even while
    // the handshake is warming up. Hides naturally once streaming starts
    // (Response.tsx: showTyping = agentTyping && !showStreaming). Cleared on
    // every error-return path below.
    dispatch({ type: "SET_AGENT_TYPING", typing: true });

    // Resolve the product id from the current URL immediately before each send.
    // The agent resets these external variables after every turn, so PDP context
    // must be attached to every applicable message. Off a PDP, context is
    // omitted and the widget retains its general-chat behavior.
    const productId =
      typeof window !== "undefined"
        ? resolveProductId(window.location, productContextRef.current)
        : null;

    // One attempt: ensure the session is live, then send. Pre-echo Chatbot
    // entries buffer in the SSE handler; the user_echo event (triggered by
    // this POST being accepted) drains the buffer with the correct cutoff.
    // No send-side gate needed — correctness is on the receive side.
    const connectAndSend = async (): Promise<void> => {
      await ensureConnected(
        client,
        connectPromiseRef,
        onHandshakeStart,
        persistenceRef.current ?? undefined,
        onConversationCreated,
      );
      if (clientRef.current !== client) throw new Error("unmounted");
      await client.sendMessage(
        trimmed,
        productId ? buildPdpInlineContext(productId) : undefined,
      );
    };

    try {
      await connectAndSend();
    } catch (firstErr) {
      if (isMessageTooLong(firstErr)) {
        dispatch({ type: "SET_AGENT_TYPING", typing: false });
        dispatch({ type: "SET_ERROR", error: toUserMessage(firstErr) });
        return false;
      }

      if (enableLogging) {
        // eslint-disable-next-line no-console
        console.warn("[Agentforce] first attempt failed, retrying with fresh session:", firstErr);
      }
      const sessionKey = buildSessionKey(orgId, esDeveloperName);
      clearSession(sessionKey);
      echoCutoffRef.current = null;
      pendingChatbotBufferRef.current = [];
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

    if (clientRef.current !== client) return false;

    persistenceRef.current?.save();
    return true;
  }, [onHandshakeStart, onConversationCreated]);

  const value = useMemo(
    () => ({ state, dispatch, sendMessage, prepareConnection, config }),
    [state, sendMessage, prepareConnection, config],
  );

  return <WidgetContext.Provider value={value}>{children}</WidgetContext.Provider>;
}
