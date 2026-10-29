import { describe, expect, it } from "vitest";
import { extractMessageSuggestions, extractMessageText, extractTokenText } from "../src/tokens";

describe("extractTokenText", () => {
  it("returns plain text unchanged", () => {
    expect(extractTokenText("Hello world")).toBe("Hello world");
  });

  it("returns an empty string for an empty token", () => {
    expect(extractTokenText("")).toBe("");
  });

  it("extracts data.content from a BYON-Freeform JSON block", () => {
    const block = JSON.stringify({ type: "text", index: 0, data: { content: "streamed piece" } });
    expect(extractTokenText(block)).toBe("streamed piece");
  });

  it("returns an empty string for an unrecognized JSON object rather than raw JSON", () => {
    const block = JSON.stringify({ type: "tool_call", index: 1, data: { id: "abc" } });
    expect(extractTokenText(block)).toBe("");
  });

  it("returns a JSON-encoded string's value", () => {
    expect(extractTokenText('"just a quoted string"')).toBe('"just a quoted string"');
  });

  it("treats markdown that merely starts with a brace-like char as plain text", () => {
    expect(extractTokenText("- a list item")).toBe("- a list item");
    expect(extractTokenText("{ not valid json")).toBe("{ not valid json");
  });

  it("unwraps a BYON {response:[…]} envelope, keeping markdown and dropping suggestions", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "markdown", index: 0, data: { content: "Here is your **answer**." } },
        { type: "suggestions", index: 7, data: { display_text: ["A", "B"] } },
      ],
    });
    expect(extractTokenText(envelope)).toBe("Here is your **answer**.");
  });

  it("returns an empty string for a JSON-encoded number (not renderable)", () => {
    // A bare number like "42" doesn't look like JSON (no braces/brackets) and is
    // returned as plain text before JSON.parse ever runs. Wrapping it in an array
    // is what actually routes it through JSON.parse into collectRenderableText,
    // where a number falls through every branch to the final `return null`.
    expect(extractTokenText("[42]")).toBe("");
  });

  it("extracts a JSON-encoded plain string's value", () => {
    // Likewise, a bare quoted string fails the JSON-look-alike check and is
    // returned verbatim (quotes included). Wrapping it in an array forces
    // JSON.parse, so collectRenderableText hits the plain-string branch directly.
    expect(extractTokenText('["hello"]')).toBe("hello");
  });

  it("falls back to the raw string when JSON-like text fails to parse", () => {
    const block = '{"type": "markdown",}'; // brace-matched but a trailing comma makes it invalid JSON
    expect(extractTokenText(block)).toBe(block);
  });

  it("extracts a top-level content field", () => {
    expect(extractTokenText('{"content":"direct text"}')).toBe("direct text");
  });

  it("extracts a top-level text field", () => {
    expect(extractTokenText('{"text":"direct text"}')).toBe("direct text");
  });
});

describe("extractMessageText", () => {
  it("returns plain text unchanged", () => {
    expect(extractMessageText("Hello world")).toBe("Hello world");
  });

  it("returns an empty string for empty content", () => {
    expect(extractMessageText("")).toBe("");
  });

  it("unwraps a BYON {response:[…]} envelope to its markdown block", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "markdown", index: 0, data: { content: "I'm your Assistant.\n\nHow can I help?" } },
        { type: "suggestions", index: 7, data: { display_text: ["Find a product"] } },
      ],
    });
    expect(extractMessageText(envelope)).toBe("I'm your Assistant.\n\nHow can I help?");
  });

  it("joins multiple text blocks in order", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "markdown", index: 0, data: { content: "First." } },
        { type: "text", index: 1, data: { content: "Second." } },
      ],
    });
    expect(extractMessageText(envelope)).toBe("First.\n\nSecond.");
  });

  it("falls back to the raw string when a JSON object has no renderable text", () => {
    // Unlike streaming, a final message we can't decode is shown verbatim
    // rather than dropped — an empty bubble would be worse.
    const block = JSON.stringify({ type: "tool_call", data: { id: "abc" } });
    expect(extractMessageText(block)).toBe(block);
  });

  it("falls back to the raw string on invalid JSON", () => {
    expect(extractMessageText("{ not valid json")).toBe("{ not valid json");
  });

  it("falls back to the raw string for a JSON-encoded number (unlike streaming, which drops it)", () => {
    // A final message we can't confidently render falls back to the raw text
    // instead of returning "" — an empty bubble would be worse than the raw JSON.
    expect(extractMessageText("[42]")).toBe("[42]");
  });

  it("falls back to the raw string when JSON-like text fails to parse", () => {
    const block = '{"type": "markdown",}'; // brace-matched but a trailing comma makes it invalid JSON
    expect(extractMessageText(block)).toBe(block);
  });
});

describe("extractMessageSuggestions", () => {
  it("extracts display_text from a suggestions block in a BYON envelope", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "markdown", index: 0, data: { content: "Here is your **answer**." } },
        {
          type: "suggestions",
          index: 1,
          data: {
            display_text: [
              "Is it suitable for layering?",
              "Does it pack down small for travel?",
              "How warm is the 800-fill down?",
            ],
          },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "Is it suitable for layering?" },
      { text: "Does it pack down small for travel?" },
      { text: "How warm is the 800-fill down?" },
    ]);
  });

  it("returns an empty array for plain text content", () => {
    expect(extractMessageSuggestions("Hello world")).toEqual([]);
  });

  it("returns an empty array for empty content", () => {
    expect(extractMessageSuggestions("")).toEqual([]);
  });

  it("returns an empty array when the envelope has no suggestions block", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "markdown", index: 0, data: { content: "Just text." } },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([]);
  });

  it("deduplicates suggestions", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: { display_text: ["A", "B", "A", "C", "B"] },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "A" }, { text: "B" }, { text: "C" },
    ]);
  });

  it("caps at MAX_PDP_QUESTIONS (5)", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: { display_text: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"] },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toHaveLength(5);
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "Q1" }, { text: "Q2" }, { text: "Q3" }, { text: "Q4" }, { text: "Q5" },
    ]);
  });

  it("skips empty and whitespace-only strings", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: { display_text: ["A", "", "  ", "B"] },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(extractMessageSuggestions('{"type": "suggestions",}')).toEqual([]);
  });

  it("collects suggestions from multiple suggestions blocks", () => {
    const envelope = JSON.stringify({
      response: [
        { type: "suggestions", index: 0, data: { display_text: ["A", "B"] } },
        { type: "markdown", index: 1, data: { content: "text" } },
        { type: "suggestions", index: 2, data: { display_text: ["C", "D"] } },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "A" }, { text: "B" }, { text: "C" }, { text: "D" },
    ]);
  });

  it("prefers items array over display_text when present", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: {
            display_text: ["Is it true to size?", "Best shoe for trails?"],
            items: [
              { text: "Is it true to size?", answerable_by: "inline_pdp" },
              { text: "Best shoe for trails?", answerable_by: "main_agent" },
            ],
          },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "Is it true to size?", answerable_by: "inline_pdp" },
      { text: "Best shoe for trails?", answerable_by: "main_agent" },
    ]);
  });

  it("items without answerable_by omit the field", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: {
            items: [
              { text: "Plain chip" },
              { text: "Another plain chip" },
            ],
          },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "Plain chip" },
      { text: "Another plain chip" },
    ]);
  });

  it("items with mixed answerable_by preserve each value", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: {
            items: [
              { text: "Care instructions?", answerable_by: "inline_pdp" },
              { text: "No metadata" },
              { text: "Show me similar", answerable_by: "main_agent" },
            ],
          },
        },
      ],
    });
    const result = extractMessageSuggestions(envelope);
    expect(result).toEqual([
      { text: "Care instructions?", answerable_by: "inline_pdp" },
      { text: "No metadata" },
      { text: "Show me similar", answerable_by: "main_agent" },
    ]);
  });

  it("ignores invalid answerable_by values", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: {
            items: [
              { text: "Valid", answerable_by: "inline_pdp" },
              { text: "Bad value", answerable_by: "unknown_target" },
            ],
          },
        },
      ],
    });
    const result = extractMessageSuggestions(envelope);
    expect(result[0].answerable_by).toBe("inline_pdp");
    expect(result[1].answerable_by).toBeUndefined();
  });

  it("skips items with empty or missing text", () => {
    const envelope = JSON.stringify({
      response: [
        {
          type: "suggestions",
          index: 0,
          data: {
            items: [
              { text: "Good", answerable_by: "inline_pdp" },
              { text: "" },
              { text: "  " },
              { answerable_by: "main_agent" },
              { text: "Also good" },
            ],
          },
        },
      ],
    });
    expect(extractMessageSuggestions(envelope)).toEqual([
      { text: "Good", answerable_by: "inline_pdp" },
      { text: "Also good" },
    ]);
  });
});
