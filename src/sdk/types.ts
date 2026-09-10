/**
 * Configuration + event + SCRT2 request/response shapes for {@link AgentforceClient}.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Configuration options for the AgentforceClient.
 */
export interface AgentforceClientOptions {
  /** SCRT2 instance base URL (e.g. "https://xyz.salesforce-scrt.com") */
  baseURL: string;

  /** Salesforce Organization ID */
  orgId: string;

  /** Embedded Service developer name */
  esDeveloperName: string;

  /** Optional tuning parameters */
  options?: AgentforceClientTuning;
}

export interface AgentforceClientTuning {
  /** Maximum retries for failed REST requests (default: 3) */
  maxRetries?: number;

  /** Request timeout in milliseconds (default: 15000) */
  timeout?: number;

  /** Maximum SSE reconnection attempts before giving up (default: 5) */
  maxReconnectAttempts?: number;

  /** Base delay in ms for exponential backoff reconnection (default: 2000) */
  reconnectDelay?: number;

  /** Enable SDK debug logging (default: false) */
  enableLogging?: boolean;

  /** Platform identifier sent with token requests (default: "Web") */
  platform?: string;

  /** SCRT2 capabilities version for the access-token request. */
  capabilitiesVersion: string;
}

/**
 * Per-request options that can override client-level defaults.
 */
export interface RequestOptions {
  /** Override the default timeout for this request (ms) */
  timeout?: number;

  /** Additional headers for this request */
  headers?: Record<string, string>;

  /** Override the AbortSignal for this request */
  signal?: AbortSignal;
}

// ─── Events ────────────────────────────────────────────────────────────────────

/**
 * All event names the client can emit.
 */
export type AgentforceEventName =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "message"
  | "streaming_token"
  | "typing_started"
  | "typing_stopped"
  | "error";

/**
 * Payload for 'message' events.
 * Emitted when a complete CONVERSATION_MESSAGE arrives from the agent.
 */
export interface AgentforceMessageEvent {
  conversationId: string;
  messageId: string;
  content: string;
  sender: AgentforceSender;
  timestamp: string;
  /** The raw entryPayload object, in case consumers need to inspect it */
  raw?: unknown;
}

/**
 * Payload for 'streaming_token' events.
 * Emitted for each CONVERSATION_STREAMING_TOKEN chunk.
 *
 * SCRT2 delivers the token content nested under
 * `conversationEntry.entryPayload.streamingToken`. The `token` string is the
 * chunk text (for the "BYON Freeform" agent this is a JSON-encoded response
 * block: `{"type","index","data"}`). The ordering/targeting fields below are
 * optional and let consumers order chunks and associate them with the final
 * message; they are omitted when the payload arrives in the legacy top-level
 * `token`/`text` shape.
 */
export interface AgentforceStreamingTokenEvent {
  conversationId: string;
  token: string;
  /** Stream ordering within the turn (SCRT2 `streamingToken.sequenceNumber`). */
  sequenceNumber?: number;
  /**
   * Identifier of the final message this chunk contributes to
   * (SCRT2 `streamingToken.targetMessageIdentifier`). Useful for multi-message
   * turns.
   */
  targetMessageId?: string;
  /** Token classification, e.g. "MessageStreamingToken". */
  tokenType?: string;
}

/**
 * Payload for 'typing_started' and 'typing_stopped' events.
 */
export interface AgentforceTypingEvent {
  conversationId: string;
  participant?: AgentforceSender;
}

/**
 * Payload for 'disconnected' events.
 */
export interface AgentforceDisconnectedEvent {
  reason: string;
}

/**
 * Payload for 'reconnecting' events.
 */
export interface AgentforceReconnectingEvent {
  attempt: number;
  maxAttempts: number;
}

/**
 * Payload for 'error' events.
 */
export interface AgentforceErrorEvent {
  code?: string;
  message: string;
  recoverable: boolean;
}

/**
 * Sender identity from conversation entries.
 */
export interface AgentforceSender {
  role: string;
  name?: string;
}

/**
 * Maps event names to their payload types.
 */
export interface AgentforceEventMap {
  connected: void;
  disconnected: AgentforceDisconnectedEvent;
  reconnecting: AgentforceReconnectingEvent;
  message: AgentforceMessageEvent;
  streaming_token: AgentforceStreamingTokenEvent;
  typing_started: AgentforceTypingEvent;
  typing_stopped: AgentforceTypingEvent;
  error: AgentforceErrorEvent;
}

/**
 * Typed event handler for a specific event name.
 */
export type AgentforceEventHandler<E extends AgentforceEventName> =
  AgentforceEventMap[E] extends void
    ? () => void
    : (payload: AgentforceEventMap[E]) => void;

// ─── SCRT2 REST request/response shapes ─────────────────────────────────────────

export interface AccessTokenRequest {
  orgId: string;
  esDeveloperName: string;
  capabilitiesVersion: string;
  platform: string;
}

export interface AccessTokenResponse {
  accessToken: string;
  lastEventId?: string;
  context?: unknown;
}

export interface CreateConversationRequest {
  conversationId: string;
  esDeveloperName: string;
  routingAttributes?: Record<string, string>;
}

export interface SendMessageRequest {
  message: {
    id: string;
    messageType: "StaticContentMessage";
    staticContent: {
      formatType: "Text";
      text: string;
    };
  };
  esDeveloperName: string;
}

/**
 * The conversationEntry envelope received in most SSE events.
 */
export interface ConversationEntry {
  identifier?: string;
  entryType?: string;
  entryPayload?: string | Record<string, unknown>;
  sender?: {
    role?: string;
    subject?: string;
    appType?: string;
  };
  senderDisplayName?: string;
  transcriptedTimestamp?: string;
}

/**
 * Generic SSE event data wrapper.
 */
export interface SSEEventData {
  conversationId?: string;
  conversationEntry?: ConversationEntry;
  token?: string;
  text?: string;
  [key: string]: unknown;
}
