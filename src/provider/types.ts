import type { Dispatch } from "react";

/**
 * Connection config for the widget. The anonymous SCRT2 / MIAW path uses only
 * the non-secret public identifiers (`scrt2Url`/`orgId`/`esDeveloperName`) — the
 * same values Salesforce's own embedded messaging snippet uses — so there is
 * nothing confidential to ship to the browser.
 */
export interface WidgetConfig {
  /** SCRT2 instance base URL, e.g. "https://xyz.salesforce-scrt.com". */
  scrt2Url: string;
  /** Salesforce Organization ID. */
  orgId: string;
  /** Embedded Service developer name. */
  esDeveloperName: string;
  /** SCRT2 capabilities version for the access-token request. */
  capabilitiesVersion?: string;
  /** Placeholder text for the message input. */
  placeholder?: string;

  /**
   * PDP product-context (never shown to the user). When set, the widget derives
   * the current product id from the page URL and prepends
   * `"Viewing product details for: <id>"` to the message SENT to the agent.
   *
   * `productIdParam` reads a URL query-string parameter (e.g. `"pid"` for the
   * SFRA `Product-Show` controller). `productIdPattern` is a regex matched
   * against the URL path whose first capture group is the id (e.g.
   * `"/product/([^/?#]+)"` for PWA Kit path routes); it is used when
   * `productIdParam` is absent or does not match. If neither resolves an id, the
   * message is sent unprefixed. See `provider/product-context.ts`.
   */
  productIdParam?: string;
  productIdPattern?: string;

  /** Enable SDK debug logging in the console. */
  enableLogging?: boolean;
  /**
   * Persist the anonymous session (token + conversationId) in `localStorage` so
   * a conversation survives page navigation / reload / browser restart within
   * the same browser. Default **false** (a fresh session per page load).
   *
   * Reuse is bounded solely by the token's own JWT `exp` (the server sets it at
   * mint; typically ~hours). SECURITY: the token is anonymous/unauthenticated
   * (blast radius = the messaging conversation only), but `localStorage` is
   * script-readable and shared across tabs + restarts, so a stored session is
   * reusable for the full token lifetime — on a shared/kiosk device a walk-up
   * user could resume the conversation until the token expires. Prefer leaving
   * this off for shared/kiosk devices. See README.
   */
  persistSession?: boolean;
}

export type ConnectionStatus =
  // Mounted with valid config but no session yet — the token/SSE/conversation
  // handshake is deferred until the user sends their first message. The input
  // is usable in this state.
  | "idle"
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * A single-answer model: the widget shows the input and, below it, the agent's
 * response to the most recent question. Asking a new question replaces the
 * previous answer — there is no accumulating transcript.
 */
export interface WidgetState {
  status: ConnectionStatus;
  /** The current final agent answer, or null before the first reply. */
  answer: string | null;
  /** Live token-by-token preview of the in-flight answer. */
  streamingText: string;
  agentTyping: boolean;
  error: string | null;
  /** The shopper's last question, displayed as a bubble above the answer. */
  lastQuestion: string | null;
  /**
   * `true` when the widget is ready to accept a user message. Goes `false`
   * while a fresh handshake is in progress (waiting for the agent's automatic
   * welcome greeting to arrive and be suppressed), then `true` once the
   * welcome is consumed or a safety timeout fires.
   */
  connectionReady: boolean;
}

export type WidgetAction =
  | { type: "SET_STATUS"; status: ConnectionStatus }
  // The user asked a new question — clear the previous response and show that
  // the agent is working on the next one.
  | { type: "ASK_QUESTION"; question: string }
  | { type: "APPEND_STREAMING_TOKEN"; token: string }
  // The final, authoritative answer content for the current question.
  | { type: "SET_ANSWER"; content: string }
  | { type: "SET_AGENT_TYPING"; typing: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_CONNECTION_READY"; ready: boolean }
  | { type: "RESET_CONVERSATION" };

export interface WidgetContextValue {
  state: WidgetState;
  dispatch: Dispatch<WidgetAction>;
  /**
   * Send a user message. Dispatches immediately, then awaits the SCRT2 handshake
   * (shared with any in-flight warm-up) before posting — so a send fired before
   * the connection is ready is effectively queued. Resolves `true` if the
   * message was sent, `false` if it was a no-op (blank text / no client) or the
   * handshake/send failed (an error is dispatched in that case).
   */
  sendMessage: (text: string) => Promise<boolean>;
  /**
   * Warm up the SCRT2 handshake (token → SSE → conversation) ahead of the first
   * send — call when the user starts typing. Idempotent, non-blocking, and safe
   * to call repeatedly; failures are swallowed (the send will retry/report).
   */
  prepareConnection: () => void;
  config: WidgetConfig;
}
