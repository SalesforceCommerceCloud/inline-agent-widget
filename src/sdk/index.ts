/**
 * Vendored, trimmed Salesforce SCRT2 (Agentforce MIAW) client.
 *
 * An internal copy — not published as a separate package — carrying only the
 * pieces this widget needs: the core connect → createConversation → sendMessage
 * flow, the four core SSE events, SSE auto-reconnect with exponential backoff,
 * and token auto-refresh on 401.
 */
export { AgentforceClient } from "./client";

export {
  AgentforceClientError,
  AgentforceApiError,
  AgentforceNetworkError,
  AgentforceAuthError,
} from "./errors";

export type {
  AgentforceClientOptions,
  AgentforceClientTuning,
  RequestOptions,
  AgentforceEventName,
  AgentforceEventMap,
  AgentforceEventHandler,
  AgentforceMessageEvent,
  AgentforceStreamingTokenEvent,
  AgentforceTypingEvent,
  AgentforceDisconnectedEvent,
  AgentforceReconnectingEvent,
  AgentforceErrorEvent,
  AgentforceSender,
  AccessTokenRequest,
  AccessTokenResponse,
  CreateConversationRequest,
  SessionContextTextValue,
  SessionContextVariable,
  SessionContextEntry,
  SendMessageRequest,
  SendMessageResponse,
  SendMessageWarning,
  ConversationEntry,
  SSEEventData,
} from "./types";
