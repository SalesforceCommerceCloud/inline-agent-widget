import { extractMessageSuggestions, extractMessageText, extractTokenText } from "../tokens";
import type { WidgetAction, WidgetState } from "./types";

export const initialWidgetState: WidgetState = {
  status: "idle",
  answer: null,
  streamingText: "",
  agentTyping: false,
  error: null,
  lastQuestion: null,
  pdpQuestions: [],
  followUpSuggestions: [],
  askedQuestions: [],
};

export function widgetReducer(state: WidgetState, action: WidgetAction): WidgetState {
  switch (action.type) {
    case "SET_STATUS":
      // Error is cleared by ASK_QUESTION / RESET_CONVERSATION / explicit
      // SET_ERROR(null), not here — a late "connected" after a failed send
      // would otherwise wipe the toast before the shopper could read it.
      return { ...state, status: action.status };

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

    case "SET_ERROR": {
      if (!action.error) return { ...state, error: null };
      // On a failed send, drop the trailing asked question so the opener pill
      // the shopper clicked re-renders (QuestionPills filters by askedQuestions).
      // Typed text is restored by InputBar on sendMessage() => false.
      const nextAsked =
        action.restoreLastQuestion && state.lastQuestion
          ? state.askedQuestions.filter((q) => q !== state.lastQuestion)
          : state.askedQuestions;
      return {
        ...state,
        error: action.error,
        lastQuestion: null,
        answer: null,
        streamingText: "",
        agentTyping: false,
        askedQuestions: nextAsked,
      };
    }

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
