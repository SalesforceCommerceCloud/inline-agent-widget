import { describe, expect, it } from "vitest";
import { initialWidgetState, widgetReducer } from "../../src/provider/reducer";
import type { WidgetState } from "../../src/provider/types";

/**
 * Reducer unit tests. Scope: the reducer branches that opener-pills work
 * either added (`SET_PDP_QUESTIONS`) or depends on behaviorally
 * (`RESET_CONVERSATION` must preserve `pdpQuestions`, which is what lets the
 * pills correctly re-appear for the new product on SPA navigation between
 * PDPs). The provider dispatches these transitions from an effect that we
 * can't easily exercise without a DOM test environment, so we lock the
 * contract at the reducer boundary where behavior is a pure function.
 *
 * All other actions are smoke-tested so a future refactor can't silently
 * drop a case or widen scope beyond `state` + the action's own fields.
 */
describe("widgetReducer", () => {
  describe("initial state", () => {
    it("exposes pdpQuestions as an empty array (never undefined)", () => {
      expect(initialWidgetState.pdpQuestions).toEqual([]);
    });

    it("is ready to accept input on mount (connectionReady: true)", () => {
      // Pills consume this flag as `disabled={!state.connectionReady}`. If the
      // initial value flips to false, every PDP mount ships with disabled
      // pills until the first handshake completes — regression target.
      expect(initialWidgetState.connectionReady).toBe(true);
    });

    it("exposes askedQuestions as an empty array (never undefined)", () => {
      // QuestionPills filters pdpQuestions by `!askedQuestions.includes(q)`.
      // Any non-array value here (undefined/null) throws at render.
      expect(initialWidgetState.askedQuestions).toEqual([]);
    });
  });

  describe("SET_PDP_QUESTIONS", () => {
    it("replaces the pdpQuestions array wholesale", () => {
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["old"] };
      const next = widgetReducer(start, {
        type: "SET_PDP_QUESTIONS",
        questions: ["Q1", "Q2", "Q3"],
      });
      expect(next.pdpQuestions).toEqual(["Q1", "Q2", "Q3"]);
    });

    it("accepts an empty array (merchant unpublished the attribute)", () => {
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1", "Q2"] };
      const next = widgetReducer(start, { type: "SET_PDP_QUESTIONS", questions: [] });
      expect(next.pdpQuestions).toEqual([]);
    });

    it("leaves conversation state (lastQuestion, answer, streamingText) untouched", () => {
      // Pills belong to the product; a new list arriving mid-conversation
      // must not blow away an in-flight answer. The effect in WidgetProvider
      // only dispatches this when the list genuinely changes, but even then
      // it must be surgical.
      const start: WidgetState = {
        ...initialWidgetState,
        lastQuestion: "Does it fit a wrist?",
        answer: "Yes it does.",
        streamingText: "pending…",
        agentTyping: true,
      };
      const next = widgetReducer(start, {
        type: "SET_PDP_QUESTIONS",
        questions: ["New Q"],
      });
      expect(next.lastQuestion).toBe("Does it fit a wrist?");
      expect(next.answer).toBe("Yes it does.");
      expect(next.streamingText).toBe("pending…");
      expect(next.agentTyping).toBe(true);
    });
  });

  describe("RESET_CONVERSATION", () => {
    it("preserves pdpQuestions (pills belong to the product, not the conversation)", () => {
      // This is the single most important behavioral guarantee for the SPA
      // navigation flow: the user navigates PDP → PDP, which triggers the
      // provider's history-listener to dispatch RESET_CONVERSATION. If this
      // branch wipes pdpQuestions, pills vanish for the new product until
      // the pdpQuestionsKey effect fires again — causing a visible flicker.
      const start: WidgetState = {
        ...initialWidgetState,
        pdpQuestions: ["Q1", "Q2"],
        lastQuestion: "x",
        answer: "y",
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.pdpQuestions).toEqual(["Q1", "Q2"]);
    });

    it("clears last question, answer, streaming text, typing, and error", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        lastQuestion: "x",
        answer: "y",
        streamingText: "z",
        agentTyping: true,
        error: "oops",
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.lastQuestion).toBeNull();
      expect(next.answer).toBeNull();
      expect(next.streamingText).toBe("");
      expect(next.agentTyping).toBe(false);
      expect(next.error).toBeNull();
    });

    it("clears askedQuestions so the new PDP's shelf is full again", () => {
      // SPA PDP → PDP: pdpQuestions is swapped by the config-watching effect,
      // and askedQuestions must reset so none of the new product's pills are
      // pre-filtered out just because the shopper had asked a similar-looking
      // question on the previous product.
      const start: WidgetState = {
        ...initialWidgetState,
        askedQuestions: ["Q1", "Q2"],
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.askedQuestions).toEqual([]);
    });

    it("leaves status + connectionReady untouched (connection outlives nav)", () => {
      // The SCRT2 session is reused across PDPs — RESET_CONVERSATION is a
      // UI-level reset only, not a session teardown.
      const start: WidgetState = {
        ...initialWidgetState,
        status: "connected",
        connectionReady: true,
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.status).toBe("connected");
      expect(next.connectionReady).toBe(true);
    });
  });

  describe("ASK_QUESTION", () => {
    it("records the question and clears the prior answer/stream/error", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        answer: "old answer",
        streamingText: "old stream",
        error: "old error",
      };
      const next = widgetReducer(start, { type: "ASK_QUESTION", question: "new?" });
      expect(next.lastQuestion).toBe("new?");
      expect(next.answer).toBeNull();
      expect(next.streamingText).toBe("");
      expect(next.error).toBeNull();
    });

    it("leaves pdpQuestions in place (pill click is still an ASK_QUESTION)", () => {
      // Pill click paths through sendMessage → ASK_QUESTION dispatch. If this
      // wipes pdpQuestions, every pill vanishes the instant any one is clicked.
      // Draining is done at the render layer via askedQuestions filtering.
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1", "Q2"] };
      const next = widgetReducer(start, { type: "ASK_QUESTION", question: "Q1" });
      expect(next.pdpQuestions).toEqual(["Q1", "Q2"]);
    });

    it("appends the question to askedQuestions so the pill drains from the shelf", () => {
      // North-star drain: QuestionPills hides a pill once its text appears in
      // askedQuestions. The reducer is the single source of truth for that
      // list — pill component is pure render.
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1", "Q2"] };
      const next = widgetReducer(start, { type: "ASK_QUESTION", question: "Q1" });
      expect(next.askedQuestions).toEqual(["Q1"]);
    });

    it("accumulates asked questions across multiple sends", () => {
      const s1 = widgetReducer(initialWidgetState, { type: "ASK_QUESTION", question: "Q1" });
      const s2 = widgetReducer(s1, { type: "ASK_QUESTION", question: "Q2" });
      const s3 = widgetReducer(s2, { type: "ASK_QUESTION", question: "Q3" });
      expect(s3.askedQuestions).toEqual(["Q1", "Q2", "Q3"]);
    });

    it("dedupes a verbatim re-ask so the array stays bounded", () => {
      // A shopper retyping an identical question (or re-clicking the same pill
      // after a reset) must not grow the list — the filter would still drop
      // the pill correctly, but the array would leak unbounded over long
      // sessions.
      const start: WidgetState = {
        ...initialWidgetState,
        askedQuestions: ["Q1"],
      };
      const next = widgetReducer(start, { type: "ASK_QUESTION", question: "Q1" });
      expect(next.askedQuestions).toEqual(["Q1"]);
      // Same reference — no needless re-allocation.
      expect(next.askedQuestions).toBe(start.askedQuestions);
    });

    it("records typed free-text (even though it won't match any pill)", () => {
      // Recording typed questions is harmless (they won't match a pdpQuestions
      // string) and keeps the reducer branch dead-simple — no special-casing
      // for the origin of the question.
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1"] };
      const next = widgetReducer(start, {
        type: "ASK_QUESTION",
        question: "something freeform",
      });
      expect(next.askedQuestions).toEqual(["something freeform"]);
    });
  });

  describe("SET_CONNECTION_READY", () => {
    it("toggles the readiness gate the pills' disabled binding reads", () => {
      // The pill button renders `disabled={!state.connectionReady}`.
      const start: WidgetState = { ...initialWidgetState, connectionReady: false };
      expect(
        widgetReducer(start, { type: "SET_CONNECTION_READY", ready: true }).connectionReady,
      ).toBe(true);
      expect(
        widgetReducer(initialWidgetState, { type: "SET_CONNECTION_READY", ready: false })
          .connectionReady,
      ).toBe(false);
    });
  });

  describe("SET_ERROR", () => {
    it("clears conversation state when setting an error", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        lastQuestion: "x",
        answer: "y",
        streamingText: "z",
        agentTyping: true,
      };
      const next = widgetReducer(start, { type: "SET_ERROR", error: "boom" });
      expect(next.error).toBe("boom");
      expect(next.lastQuestion).toBeNull();
      expect(next.answer).toBeNull();
      expect(next.streamingText).toBe("");
      expect(next.agentTyping).toBe(false);
    });

    it("does NOT clear conversation state when clearing the error", () => {
      // SET_ERROR with error:null is used to recover from a session reset —
      // it must not blow away a conversation that's actively progressing.
      const start: WidgetState = {
        ...initialWidgetState,
        error: "oops",
        lastQuestion: "x",
        answer: "y",
      };
      const next = widgetReducer(start, { type: "SET_ERROR", error: null });
      expect(next.error).toBeNull();
      expect(next.lastQuestion).toBe("x");
      expect(next.answer).toBe("y");
    });

    it("leaves pdpQuestions untouched regardless of the error payload", () => {
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1"] };
      expect(
        widgetReducer(start, { type: "SET_ERROR", error: "boom" }).pdpQuestions,
      ).toEqual(["Q1"]);
      expect(
        widgetReducer(start, { type: "SET_ERROR", error: null }).pdpQuestions,
      ).toEqual(["Q1"]);
    });
  });

  describe("other actions (smoke)", () => {
    it("SET_STATUS clears a prior error on reconnect", () => {
      const start: WidgetState = { ...initialWidgetState, error: "oops" };
      expect(widgetReducer(start, { type: "SET_STATUS", status: "connected" }).error).toBeNull();
      expect(
        widgetReducer(start, { type: "SET_STATUS", status: "connecting" }).error,
      ).toBeNull();
    });

    it("SET_STATUS leaves a prior error alone on disconnected/reconnecting", () => {
      const start: WidgetState = { ...initialWidgetState, error: "oops" };
      expect(
        widgetReducer(start, { type: "SET_STATUS", status: "disconnected" }).error,
      ).toBe("oops");
      expect(
        widgetReducer(start, { type: "SET_STATUS", status: "reconnecting" }).error,
      ).toBe("oops");
    });

    it("APPEND_STREAMING_TOKEN appends to streamingText", () => {
      const start: WidgetState = { ...initialWidgetState, streamingText: "Hel" };
      // The reducer runs the token through extractTokenText; a plain string
      // token is returned as-is.
      const next = widgetReducer(start, { type: "APPEND_STREAMING_TOKEN", token: "lo" });
      expect(next.streamingText).toBe("Hello");
    });

    it("SET_ANSWER replaces streamingText with the final answer and clears typing", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        streamingText: "partial",
        agentTyping: true,
      };
      const next = widgetReducer(start, { type: "SET_ANSWER", content: "final answer" });
      expect(next.answer).toBe("final answer");
      expect(next.streamingText).toBe("");
      expect(next.agentTyping).toBe(false);
    });

    it("SET_AGENT_TYPING toggles the typing flag", () => {
      expect(
        widgetReducer(initialWidgetState, { type: "SET_AGENT_TYPING", typing: true }).agentTyping,
      ).toBe(true);
      const typing: WidgetState = { ...initialWidgetState, agentTyping: true };
      expect(
        widgetReducer(typing, { type: "SET_AGENT_TYPING", typing: false }).agentTyping,
      ).toBe(false);
    });

    it("returns the same state object for an unknown action (default branch)", () => {
      const start: WidgetState = { ...initialWidgetState, lastQuestion: "x" };
      // Casting is intentional — exercising the exhaustiveness fallback.
      const next = widgetReducer(start, { type: "NOPE" } as unknown as Parameters<
        typeof widgetReducer
      >[1]);
      expect(next).toBe(start);
    });
  });
});
