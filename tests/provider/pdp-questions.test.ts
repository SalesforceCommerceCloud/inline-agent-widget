import { describe, expect, it } from "vitest";
import { MAX_PDP_QUESTIONS, parsePdpQuestions } from "../../src/provider/pdp-questions";

describe("parsePdpQuestions", () => {
  it("parses a JSON-encoded array of strings (SCAPI c_pdpQuestions shape)", () => {
    const raw =
      '["What does SmartTrack do?", "Does it track sleep automatically?", "Tell me about the reminders to move."]';
    expect(parsePdpQuestions(raw)).toEqual([
      "What does SmartTrack do?",
      "Does it track sleep automatically?",
      "Tell me about the reminders to move.",
    ]);
  });

  it("returns [] for empty / null / undefined input", () => {
    expect(parsePdpQuestions(undefined)).toEqual([]);
    expect(parsePdpQuestions(null)).toEqual([]);
    expect(parsePdpQuestions("")).toEqual([]);
  });

  it("returns [] (does not throw) for non-JSON input", () => {
    expect(() => parsePdpQuestions("not-json")).not.toThrow();
    expect(parsePdpQuestions("not-json")).toEqual([]);
  });

  it("returns [] when the JSON parses to something other than an array", () => {
    expect(parsePdpQuestions('"just a string"')).toEqual([]);
    expect(parsePdpQuestions('{"q":"x"}')).toEqual([]);
    expect(parsePdpQuestions("42")).toEqual([]);
    expect(parsePdpQuestions("null")).toEqual([]);
  });

  it("drops non-string entries", () => {
    expect(parsePdpQuestions('["ok", 42, null, {"q":"x"}, "also ok"]')).toEqual([
      "ok",
      "also ok",
    ]);
  });

  it("trims whitespace and drops entries that become empty after trim", () => {
    expect(parsePdpQuestions('["  padded  ", "   ", "", "kept"]')).toEqual([
      "padded",
      "kept",
    ]);
  });

  it("dedupes preserving first-seen order (after trim)", () => {
    expect(parsePdpQuestions('["A", "B", "A", "  A  ", "C"]')).toEqual(["A", "B", "C"]);
  });

  it("caps the returned list at MAX_PDP_QUESTIONS (5)", () => {
    const raw = JSON.stringify(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
    const out = parsePdpQuestions(raw);
    expect(out).toHaveLength(MAX_PDP_QUESTIONS);
    expect(out).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
  });

  it("respects an explicit maxCount override", () => {
    expect(parsePdpQuestions('["A", "B", "C", "D"]', 2)).toEqual(["A", "B"]);
  });

  it("returns [] for an empty array", () => {
    expect(parsePdpQuestions("[]")).toEqual([]);
  });
});
