import { describe, expect, it } from "vitest";
import { extractMessageText, extractTokenText } from "../src/tokens";

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
