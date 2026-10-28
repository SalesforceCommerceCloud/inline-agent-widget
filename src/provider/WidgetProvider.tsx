import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { AgentforceClient } from "../sdk";
import { AgentforceApiError, AgentforceNetworkError } from "../sdk/errors";
import { ConnectionManager } from "./connection-manager";
import { WidgetContext } from "./context";
import type { SessionPersistence } from "./ensure-connected";
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

function isWelcomeTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === "welcome_timeout";
}

function toUserMessage(err: unknown): string {
  if (isMessageTooLong(err)) return "Message exceeds the maximum length of 4,000 characters.";
  if (isWelcomeTimeout(err)) return "Taking longer than expected to connect. Try again.";
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
  // FSM for the SCRT2 handshake lifecycle (NOT_STARTED → TRANSPORT_CONNECTING
  // → CONVERSATION_READY → READY, plus FAILED). Owns the single-flight
  // connect promise and the welcome gate — provider never touches those
  // directly.
  const managerRef = useRef<ConnectionManager | null>(null);
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
  // Latest-callback refs so the ConnectionManager (constructed in the
  // client-mount effect) can call through them without having to re-register
  // when the useCallback identities below change on re-render.
  const onHandshakeStartRef = useRef<(() => void) | null>(null);
  const onConversationCreatedRef = useRef<(() => void) | null>(null);

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
              // conversation's state). Pre-mark the welcome-gate as received
              // for the same reason — bot already joined in the prior session.
              echoCutoffRef.current = "0000-01-01T00:00:00.000Z";
              managerRef.current?.notifyWelcome();
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
    if (!persistence) clearSession(sessionKey);

    // Construct the FSM. onHandshakeStart (status: "connecting", UI-liveness
    // timer) and onConversationCreated (mirror the id to the host ref) are
    // defined further down as useCallbacks; we route them through the ref so
    // this effect doesn't need to re-run when they change identity.
    const manager = new ConnectionManager({
      client,
      persistence: persistence ?? undefined,
      onHandshakeStart: () => onHandshakeStartRef.current?.(),
      onConversationCreated: () => onConversationCreatedRef.current?.(),
    });
    managerRef.current = manager;

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
      // First Chatbot entry on the stream = bot has joined (welcome). The
      // manager flips the gate, drains any waiting send, and transitions
      // CONVERSATION_READY → READY. Subsequent fires are no-ops.
      manager.notifyWelcome();
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
        manager.reset();
        dispatch({ type: "SET_ANSWER", content: "" });
        dispatch({ type: "SET_STATUS", status: "idle" });
        dispatch({ type: "SET_ERROR", error: null });
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
      manager.dispose();
      // Capture BEFORE endConversation() nulls it. NOTE: on a full (non-SPA)
      // page navigation this cleanup does NOT run — the JS context is destroyed
      // — so a persisted session correctly survives to the next page.
      const hadConversation = client.conversationId != null;
      void client.endConversation();
      client.disconnect();
      if (hadConversation) clearSession(sessionKey);
      if (clientRef.current === client) clientRef.current = null;
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [scrt2Url, orgId, esDeveloperName, capabilitiesVersion, enableLogging, persistSession]);

  // Warm up the session (token → SSE → conversation) ahead of the first send —
  // called when the user starts typing, so the network latency is hidden behind
  // their typing time. Idempotent and non-blocking.
  const onHandshakeStart = useCallback(() => {
    dispatch({ type: "SET_STATUS", status: "connecting" });
  }, []);

  const onConversationCreated = useCallback(() => {
    const id = clientRef.current?.conversationId ?? null;
    if (conversationIdRef) conversationIdRef.current = id;
  }, [conversationIdRef]);

  useEffect(() => { onHandshakeStartRef.current = onHandshakeStart; }, [onHandshakeStart]);
  useEffect(() => { onConversationCreatedRef.current = onConversationCreated; }, [onConversationCreated]);

  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    const client = clientRef.current;
    const manager = managerRef.current;
    const trimmed = text.trim();
    if (!client || !manager || !trimmed) return false;

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

    // SCRT2 only forwards commerce_agent_context after the bot joins; posting
    // earlier means SCRT2 falls back to the Flow handler and drops the
    // variables (W-24659747). The manager's welcome gate holds us until the
    // first Chatbot SSE entry.
    const connectAndSend = async (): Promise<void> => {
      await manager.connect();
      if (clientRef.current !== client) throw new Error("unmounted");
      await manager.waitForWelcome(6000);
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
        dispatch({ type: "SET_ERROR", error: toUserMessage(firstErr), restoreLastQuestion: true });
        return false;
      }

      if (enableLogging) {
        // eslint-disable-next-line no-console
        console.warn("[Agentforce] first attempt failed, retrying with fresh session:", firstErr);
      }
      const sessionKey = buildSessionKey(orgId, esDeveloperName);
      // End the SDK's conversation BEFORE resetting the FSM. ensureConnected()
      // keys readiness on client.conversationId; leaving it set means the
      // retry's connect() short-circuits and waits on the same missing welcome.
      try {
        await client.endConversation();
      } catch {
        // ignore — we're about to disconnect anyway
      }
      client.disconnect();
      clearSession(sessionKey);
      echoCutoffRef.current = null;
      pendingChatbotBufferRef.current = [];
      manager.reset();
      if (clientRef.current !== client) return false;

      try {
        await connectAndSend();
      } catch (retryErr) {
        if (enableLogging) {
          // eslint-disable-next-line no-console
          console.error("[Agentforce] retry also failed:", retryErr);
        }
        dispatch({ type: "SET_AGENT_TYPING", typing: false });
        dispatch({ type: "SET_ERROR", error: toUserMessage(retryErr), restoreLastQuestion: true });
        dispatch({ type: "SET_STATUS", status: "disconnected" });
        return false;
      }
    }

    if (clientRef.current !== client) return false;

    manager.persistSave();
    return true;
  }, [enableLogging, orgId, esDeveloperName]);

  const value = useMemo(
    () => ({ state, dispatch, sendMessage, config }),
    [state, sendMessage, config],
  );

  return <WidgetContext.Provider value={value}>{children}</WidgetContext.Provider>;
}
