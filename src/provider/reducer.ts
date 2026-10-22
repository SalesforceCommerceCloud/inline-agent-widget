import { extractMessageSuggestions, extractMessageText, extractTokenText } from "../tokens";
import type { SuggestionItem, WidgetAction, WidgetState } from "./types";

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
      return {
        ...state,
        answer: extractMessageText(action.content),
        followUpSuggestions: extractMessageSuggestions(action.content),
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
      // pdpQuestions left in place — they belong to the product, not the conversation.
      return {
        ...state,
        lastQuestion: null,
        answer: null,
        streamingText: "",
        agentTyping: false,
        error: null,
        followUpSuggestions: [],
        askedQuestions: [],
      };

    case "SET_PDP_QUESTIONS":
      return { ...state, pdpQuestions: action.questions };

    default:
      return state;
  }
}
