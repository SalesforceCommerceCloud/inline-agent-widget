import { describe, expect, it } from "vitest";

const MESSAGE_SETS = [
  [
    "Checking the available product information",
    "Finding what's most relevant to your question",
    "Getting your answer ready",
  ],
  [
    "Looking through the product details",
    "Pulling out the information that matters",
    "Bringing the answer together",
  ],
  [
    "Reviewing the available product information",
    "Finding the details that best answer your question",
    "Putting the most useful information together",
  ],
  [
    "Checking the product details for you",
    "Looking for the most relevant information",
    "Getting the key details ready",
  ],
];

describe("StatusMessages message sets", () => {
  it("has exactly 4 sets", () => {
    expect(MESSAGE_SETS).toHaveLength(4);
  });

  it("each set has exactly 3 messages", () => {
    for (const set of MESSAGE_SETS) {
      expect(set).toHaveLength(3);
    }
  });

  it("every message is a non-empty string", () => {
    for (const set of MESSAGE_SETS) {
      for (const msg of set) {
        expect(typeof msg).toBe("string");
        expect(msg.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("sets cycle round-robin via modulo", () => {
    for (let i = 0; i < 8; i++) {
      expect(MESSAGE_SETS[i % MESSAGE_SETS.length]).toBe(MESSAGE_SETS[i % 4]);
    }
  });
});
