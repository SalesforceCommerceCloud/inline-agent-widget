import { extractMessageText, extractTokenText } from "../tokens";
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
        // Record the question so QuestionPills can filter it out of the shelf.
        // Only pill-clicks will match a pdpQuestions entry (string equality);
        // typed free-text questions are recorded too but harmlessly — they
        // don't match any pill. Dedup to keep the array bounded: a shopper
        // retyping a question verbatim shouldn't grow the list.
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
      // previous PDP.
      return {
        ...state,
        lastQuestion: null,
        answer: null,
        streamingText: "",
        agentTyping: false,
        error: null,
        askedQuestions: [],
      };

    case "SET_PDP_QUESTIONS":
      return { ...state, pdpQuestions: action.questions };

    default:
      return state;
  }
}
