import { describe, expect, it } from "vitest";
import { MESSAGE_SETS, STEP_DURATION_MS } from "../../src/components/StatusMessages";

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

  it("step duration is 1500ms", () => {
    expect(STEP_DURATION_MS).toBe(1500);
  });
});
