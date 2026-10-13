import { extractMessageSuggestions, extractMessageText, extractTokenText } from "../tokens";
import type { WidgetAction, WidgetState } from "./types";

export const initialWidgetState: WidgetState = {
  status: "idle",
  answer: null,
  streamingText: "",
  agentTyping: false,
  error: null,
  lastQuestion: null,
  connectionReady: true,
  pdpQuestions: [],
  followUpSuggestions: [],
  dismissedQuestions: [],
  askedQuestions: [],
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
      return {
        ...state,
        answer: null,
        streamingText: "",
        error: null,
        lastQuestion: action.question,
        followUpSuggestions: [],
        askedQuestions: state.askedQuestions.includes(action.question)
          ? state.askedQuestions
          : [...state.askedQuestions, action.question],
      };

    case "APPEND_STREAMING_TOKEN":
      return {
        ...state,
        streamingText: state.streamingText + extractTokenText(action.token),
      };

    case "SET_ANSWER":
      // The final `message` event's content is authoritative — it replaces
      // whatever we streamed, so any token-parsing drift self-heals here. Decode
      // the content (unwrapping a BYON `{response:[…]}` envelope to its markdown)
      // so the response renders text, not raw JSON. Also extract follow-up
      // suggestions from the same envelope — they replace the static pill shelf.
      return {
        ...state,
        answer: extractMessageText(action.content),
        followUpSuggestions: extractMessageSuggestions(action.content),
        dismissedQuestions: [],
        streamingText: "",
        agentTyping: false,
      };

    case "SET_AGENT_TYPING":
      return { ...state, agentTyping: action.typing };

    case "SET_ERROR":
      return {
        ...state,
        error: action.error,
        ...(action.error ? { lastQuestion: null, answer: null, streamingText: "", agentTyping: false } : {}),
      };

    case "SET_CONNECTION_READY":
      return { ...state, connectionReady: action.ready };

    case "RESET_CONVERSATION":
      // Pills belong to the product, not the conversation — leave pdpQuestions
      // in place. When the effect that watches config.pdpQuestions runs for the
      // new product it will dispatch SET_PDP_QUESTIONS with the new list.
      // askedQuestions IS cleared: a shopper arriving at a new PDP should see
      // that product's full pill shelf, regardless of what they asked on the
      // previous PDP. Follow-up suggestions are conversation-scoped, so cleared.
      return {
        ...state,
        lastQuestion: null,
        answer: null,
        streamingText: "",
        agentTyping: false,
        error: null,
        followUpSuggestions: [],
        dismissedQuestions: [],
        askedQuestions: [],
      };

    case "SET_PDP_QUESTIONS":
      return { ...state, pdpQuestions: action.questions };

    case "REFRESH_PILLS":
      return {
        ...state,
        followUpSuggestions: [],
        dismissedQuestions: [...state.dismissedQuestions, ...action.currentlyVisible],
      };

    default:
      return state;
  }
}
