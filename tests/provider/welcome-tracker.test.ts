import { describe, expect, it } from "vitest";
import {
  classifyMessage,
  shouldAppendStreamingToken,
  type TrackerContext,
} from "../../src/provider/welcome-tracker";

/**
 * Unit tests for the position-based welcome classifier. Server timestamps
 * (ISO-8601 UTC) are compared as strings — the test fixtures reflect that
 * ordering explicitly.
 */

const BEFORE = "2026-10-08T18:00:00.000Z";
const CUTOFF = "2026-10-08T18:00:05.000Z";
const AFTER  = "2026-10-08T18:00:10.000Z";

describe("classifyMessage — echo cutoff not yet known", () => {
  it("buffers any Chatbot message when echoTimestamp is null", () => {
    const ctx: TrackerContext = { echoTimestamp: null };
    expect(classifyMessage(BEFORE, ctx)).toEqual({ action: "buffer" });
    expect(classifyMessage(AFTER, ctx)).toEqual({ action: "buffer" });
  });
});

describe("classifyMessage — echo cutoff observed", () => {
  const ctx: TrackerContext = { echoTimestamp: CUTOFF };

  it("drops a Chatbot message whose timestamp precedes the echo (welcome)", () => {
    expect(classifyMessage(BEFORE, ctx)).toEqual({ action: "drop-welcome" });
  });

  it("drops a Chatbot message whose timestamp equals the echo (edge case)", () => {
    // Server-emitted welcome and echo won't actually collide to the ms, but
    // guard the boundary anyway. Equal → welcome (strictly-after is the
    // answer condition).
    expect(classifyMessage(CUTOFF, ctx)).toEqual({ action: "drop-welcome" });
  });

  it("renders a Chatbot message whose timestamp follows the echo (answer)", () => {
    expect(classifyMessage(AFTER, ctx)).toEqual({ action: "render-answer" });
  });

  it("REGRESSION — answer-before-welcome: late welcome is still dropped by timestamp, not by order", () => {
    // The bug: fast agent answered before its own welcome landed. Timing
    // classifier mis-labelled the first chatbot message as "late welcome"
    // (true answer) and the second as the real answer (actual welcome,
    // which then rendered as the response). Position classifier doesn't
    // care about SSE arrival order — only server timestamps.
    //
    // Simulated stream order: answer arrives first (AFTER cutoff), welcome
    // arrives second (BEFORE cutoff). Both get classified correctly.
    expect(classifyMessage(AFTER, ctx)).toEqual({ action: "render-answer" });
    expect(classifyMessage(BEFORE, ctx)).toEqual({ action: "drop-welcome" });
  });
});

describe("shouldAppendStreamingToken", () => {
  it("suppresses tokens before the echo cutoff is observed", () => {
    // Pre-echo tokens belong to the welcome's own stream; appending would
    // paint the welcome into streamingText.
    expect(shouldAppendStreamingToken({ echoTimestamp: null })).toBe(false);
  });

  it("appends tokens once the echo cutoff is observed", () => {
    // SCRT2 delivers entries in server order over the SSE stream, so any
    // streaming token arriving after the echo belongs to the answer.
    expect(shouldAppendStreamingToken({ echoTimestamp: CUTOFF })).toBe(true);
  });
});
