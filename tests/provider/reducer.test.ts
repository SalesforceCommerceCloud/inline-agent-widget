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

    it("exposes askedQuestions as an empty array (never undefined)", () => {
      expect(initialWidgetState.askedQuestions).toEqual([]);
    });

    it("exposes followUpSuggestions as an empty array (never undefined)", () => {
      expect(initialWidgetState.followUpSuggestions).toEqual([]);
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
      const start: WidgetState = {
        ...initialWidgetState,
        askedQuestions: ["Q1", "Q2"],
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.askedQuestions).toEqual([]);
    });

    it("clears followUpSuggestions (they belong to the conversation, not the product)", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        followUpSuggestions: [{ text: "follow-up A" }],
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.followUpSuggestions).toEqual([]);
    });

    it("leaves status untouched (connection outlives nav)", () => {
      // The SCRT2 session is reused across PDPs — RESET_CONVERSATION is a
      // UI-level reset only, not a session teardown.
      const start: WidgetState = {
        ...initialWidgetState,
        status: "connected",
      };
      const next = widgetReducer(start, { type: "RESET_CONVERSATION" });
      expect(next.status).toBe("connected");
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
      const start: WidgetState = { ...initialWidgetState, pdpQuestions: ["Q1"] };
      const next = widgetReducer(start, {
        type: "ASK_QUESTION",
        question: "something freeform",
      });
      expect(next.askedQuestions).toEqual(["something freeform"]);
    });

    it("clears followUpSuggestions so stale suggestions don't linger while the next answer loads", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        followUpSuggestions: [{ text: "follow-up A" }, { text: "follow-up B" }],
      };
      const next = widgetReducer(start, { type: "ASK_QUESTION", question: "new?" });
      expect(next.followUpSuggestions).toEqual([]);
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

    it("leaves askedQuestions untouched when restoreLastQuestion is not set", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        lastQuestion: "Q1",
        askedQuestions: ["Q1"],
      };
      const next = widgetReducer(start, { type: "SET_ERROR", error: "boom" });
      expect(next.askedQuestions).toEqual(["Q1"]);
    });

    it("pops the trailing lastQuestion from askedQuestions when restoreLastQuestion is true", () => {
      // Pill click fails → the clicked pill must re-appear on the shelf.
      // QuestionPills filters by askedQuestions, so dropping Q2 is enough.
      const start: WidgetState = {
        ...initialWidgetState,
        pdpQuestions: ["Q1", "Q2"],
        lastQuestion: "Q2",
        askedQuestions: ["Q1", "Q2"],
      };
      const next = widgetReducer(start, {
        type: "SET_ERROR",
        error: "boom",
        restoreLastQuestion: true,
      });
      expect(next.askedQuestions).toEqual(["Q1"]);
      expect(next.lastQuestion).toBeNull();
    });

    it("restoreLastQuestion is a no-op when lastQuestion is already null", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        askedQuestions: ["Q1"],
        lastQuestion: null,
      };
      const next = widgetReducer(start, {
        type: "SET_ERROR",
        error: "boom",
        restoreLastQuestion: true,
      });
      expect(next.askedQuestions).toEqual(["Q1"]);
    });
  });

  describe("other actions (smoke)", () => {
    it("SET_STATUS never touches a prior error (any status)", () => {
      // A late "connected" firing after a failed send must not wipe the toast
      // before the shopper reads it. Error is cleared by ASK_QUESTION on the
      // next send, by RESET_CONVERSATION, or by an explicit SET_ERROR(null).
      const start: WidgetState = { ...initialWidgetState, error: "oops" };
      for (const status of ["connected", "connecting", "disconnected", "reconnecting", "idle"] as const) {
        expect(widgetReducer(start, { type: "SET_STATUS", status }).error).toBe("oops");
      }
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

    it("SET_ANSWER extracts followUpSuggestions from a BYON envelope", () => {
      const envelope = JSON.stringify({
        response: [
          { type: "markdown", index: 0, data: { content: "The vest is windproof." } },
          {
            type: "suggestions",
            index: 1,
            data: {
              display_text: [
                "Is it suitable for layering?",
                "Does it pack down small for travel?",
              ],
            },
          },
        ],
      });
      const next = widgetReducer(initialWidgetState, { type: "SET_ANSWER", content: envelope });
      expect(next.answer).toBe("The vest is windproof.");
      expect(next.followUpSuggestions).toEqual([
        { text: "Is it suitable for layering?" },
        { text: "Does it pack down small for travel?" },
      ]);
    });

    it("SET_ANSWER sets followUpSuggestions to [] for plain-text answers", () => {
      const start: WidgetState = {
        ...initialWidgetState,
        followUpSuggestions: [{ text: "stale suggestion" }],
      };
      const next = widgetReducer(start, { type: "SET_ANSWER", content: "plain text answer" });
      expect(next.followUpSuggestions).toEqual([]);
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
