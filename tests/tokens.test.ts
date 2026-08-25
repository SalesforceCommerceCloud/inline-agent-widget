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
});
