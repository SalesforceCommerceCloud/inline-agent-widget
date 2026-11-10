// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_SETS,
  STEP_DURATION_MS,
  StatusMessages,
} from "../../src/components/StatusMessages";

afterEach(cleanup);

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

describe("StatusMessages rendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders thinking dots (3 dot spans)", () => {
    render(<StatusMessages />);
    const dots = document.querySelectorAll(".dot");
    expect(dots).toHaveLength(3);
  });

  it("renders the first message of the selected set initially", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const messageSpan = statusEl.querySelector(".status-message");
    expect(messageSpan).not.toBeNull();
    const text = messageSpan!.textContent!;
    const matchesFirstMessage = MESSAGE_SETS.some((set) => set[0] === text);
    expect(matchesFirstMessage).toBe(true);
  });

  it("advances to the second message after STEP_DURATION_MS", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const firstText = statusEl.querySelector(".status-message")!.textContent!;
    const matchingSet = MESSAGE_SETS.find((set) => set[0] === firstText)!;

    act(() => {
      vi.advanceTimersByTime(STEP_DURATION_MS);
    });

    const secondText = statusEl.querySelector(".status-message")!.textContent!;
    expect(secondText).toBe(matchingSet[1]);
  });

  it("advances to the third message after two steps", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const firstText = statusEl.querySelector(".status-message")!.textContent!;
    const matchingSet = MESSAGE_SETS.find((set) => set[0] === firstText)!;

    act(() => { vi.advanceTimersByTime(STEP_DURATION_MS); });
    act(() => { vi.advanceTimersByTime(STEP_DURATION_MS); });

    const thirdText = statusEl.querySelector(".status-message")!.textContent!;
    expect(thirdText).toBe(matchingSet[2]);
  });

  it("stops cycling after the last message (no more timers)", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const firstText = statusEl.querySelector(".status-message")!.textContent!;
    const matchingSet = MESSAGE_SETS.find((set) => set[0] === firstText)!;

    act(() => { vi.advanceTimersByTime(STEP_DURATION_MS); });
    act(() => { vi.advanceTimersByTime(STEP_DURATION_MS); });
    act(() => { vi.advanceTimersByTime(STEP_DURATION_MS); });

    const finalText = statusEl.querySelector(".status-message")!.textContent!;
    expect(finalText).toBe(matchingSet[2]);
  });

  it("has role=status with aria-live=off", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    expect(statusEl.getAttribute("aria-live")).toBe("off");
  });

  it("updates aria-label as messages cycle", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const firstLabel = statusEl.getAttribute("aria-label")!;
    const matchingSet = MESSAGE_SETS.find((set) => set[0] === firstLabel)!;

    act(() => {
      vi.advanceTimersByTime(STEP_DURATION_MS);
    });

    expect(statusEl.getAttribute("aria-label")).toBe(matchingSet[1]);
  });

  it("marks text spans as aria-hidden", () => {
    render(<StatusMessages />);
    const statusEl = screen.getByRole("status");
    const typingSpan = statusEl.querySelector(".typing");
    const messageSpan = statusEl.querySelector(".status-message");
    expect(typingSpan!.getAttribute("aria-hidden")).toBe("true");
    expect(messageSpan!.getAttribute("aria-hidden")).toBe("true");
  });
});
