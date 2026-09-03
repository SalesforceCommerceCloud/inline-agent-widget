import { defineElement } from "./custom-element";

// Auto-register <inline-agent-widget> on import. This is a side effect, so
// package.json intentionally does NOT set "sideEffects": false.
defineElement();

export { defineElement, InlineAgentWidgetElement } from "./custom-element";
export { mount, type MountOptions, type MountHandle } from "./mount";
export type { WidgetConfig } from "./provider/types";

// Re-export the vendored SDK surface for consumers who want direct access.
export {
  AgentforceClient,
  AgentforceClientError,
  AgentforceApiError,
  AgentforceNetworkError,
  AgentforceAuthError,
  type AgentforceClientOptions,
  type AgentforceMessageEvent,
  type AgentforceStreamingTokenEvent,
  type AgentforceErrorEvent,
  type SessionContextTextValue,
  type SessionContextVariable,
} from "./sdk";
