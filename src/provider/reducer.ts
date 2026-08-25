import { extractMessageText, extractTokenText } from "../tokens";
import type { WidgetAction, WidgetState } from "./types";

export const initialWidgetState: WidgetState = {
  // Start idle: the widget is mounted and ready to accept input, but the
  // network handshake is deferred until the user's first message.
  status: "idle",
  answer: null,
  streamingText: "",
  agentTyping: false,
  error: null,
};

export function widgetReducer(state: WidgetState, action: WidgetAction): WidgetState {
  switch (action.type) {
    case "SET_STATUS":
      return {
        ...state,
        status: action.status,
        // Clear a prior error once we're healthy again.
        ...(action.status === "connected" || action.status === "connecting"
          ? { error: null }
          : {}),
      };

    case "ASK_QUESTION":
      // A new question replaces the previous answer. Drop the old response and
      // any leftover streaming buffer so only the current exchange is shown.
      return { ...state, answer: null, streamingText: "", error: null };

    case "APPEND_STREAMING_TOKEN":
      return {
        ...state,
        streamingText: state.streamingText + extractTokenText(action.token),
      };

    case "SET_ANSWER":
      // The final `message` event's content is authoritative — it replaces
      // whatever we streamed, so any token-parsing drift self-heals here. Decode
      // the content (unwrapping a BYON `{response:[…]}` envelope to its markdown)
      // so the response renders text, not raw JSON.
      return {
        ...state,
        answer: extractMessageText(action.content),
        streamingText: "",
        agentTyping: false,
      };

    case "SET_AGENT_TYPING":
      return { ...state, agentTyping: action.typing };

    case "SET_ERROR":
      return { ...state, error: action.error };

    default:
      return state;
  }
}
