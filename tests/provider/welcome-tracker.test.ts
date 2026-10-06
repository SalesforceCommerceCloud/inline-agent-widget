import { describe, expect, it } from "vitest";
import {
  classifyMessage,
  shouldAppendStreamingToken,
  type TrackerContext,
} from "../../src/provider/welcome-tracker";

/**
 * Unit tests for the welcome-tracker classifier. This is where the
 * welcome-handoff rules live as a pure function — the module exists
 * precisely so this logic is testable without a DOM / React / SDK
 * harness. Each test name describes the exact timing window; two of them
 * are regressions for bugs observed in incognito cold loads.
 */

const base = (over: Partial<TrackerContext> = {}): TrackerContext => ({
  hasUserSent: false,
  welcomeDropped: false,
  gatePending: true,
  ...over,
});

describe("classifyMessage — pre-send (hasUserSent=false)", () => {
  it("drops a Chatbot message while gate is pending and signals wasPending=true", () => {
    // Fast agent: welcome arrives during the gate's window. Caller must
    // close the gate + clear timeout + enable send.
    const v = classifyMessage("chatbot", base({ gatePending: true }));
    expect(v).toEqual({ action: "drop-welcome", wasPending: true });
  });

  it("drops a Chatbot message AFTER the gate has already timed out (wasPending=false)", () => {
    // REGRESSION: this is the window that leaked the welcome as the
    // answer in iteration 2 of the fix. 5s gate timer fires, gate
    // closes, user POST still in flight → welcome arrives → prior code
    // only flipped welcomeDropped when gate.pending was true, missed
    // this case, next (real) answer got dropped as "the welcome".
    const v = classifyMessage("chatbot", base({ gatePending: false }));
    expect(v).toEqual({ action: "drop-welcome", wasPending: false });
  });

  it("ignores a pre-send EndUser echo (defensive — shouldn't happen)", () => {
    const v = classifyMessage("end-user", base());
    expect(v).toEqual({ action: "ignore" });
  });

  it("drops the welcome regardless of welcomeDropped's current value", () => {
    // welcomeDropped is a caller-managed flag; the classifier shouldn't
    // get confused by a stale `true` showing up pre-send (would only
    // happen on a weird restore path, but still — don't crash).
    const v = classifyMessage("chatbot", base({ welcomeDropped: true }));
    expect(v.action).toBe("drop-welcome");
  });
});

describe("classifyMessage — post-send, welcome already dropped", () => {
  it("renders a Chatbot message as the answer", () => {
    const v = classifyMessage(
      "chatbot",
      base({ hasUserSent: true, welcomeDropped: true, gatePending: false }),
    );
    expect(v).toEqual({ action: "render-answer" });
  });

  it("ignores the EndUser echo of the shopper's POST", () => {
    // The user bubble is painted optimistically from ASK_QUESTION; the
    // echo coming back over SSE must not re-render it.
    const v = classifyMessage(
      "end-user",
      base({ hasUserSent: true, welcomeDropped: true, gatePending: false }),
    );
    expect(v).toEqual({ action: "ignore" });
  });
});

describe("classifyMessage — post-send, welcome NOT yet dropped (slow-agent race)", () => {
  it("drops a Chatbot message as the (late) welcome, not the answer", () => {
    // REGRESSION: iteration 1 of the fix. Gate timeout fired → user
    // POST went out → user POST completed → hasUserSent flipped true →
    // welcome landed last. Without the welcomeDropped check, this
    // Chatbot message would be rendered as the answer ("Welcome to
    // NTO!" flashed on screen in the incognito repro).
    const v = classifyMessage(
      "chatbot",
      base({ hasUserSent: true, welcomeDropped: false, gatePending: false }),
    );
    expect(v).toEqual({ action: "drop-welcome", wasPending: false });
  });

  it("ignores the EndUser echo even when the welcome is still pending", () => {
    // Ordering edge case: user POST echoes back BEFORE the welcome
    // message lands. Caller must not treat this as a signal to flip
    // welcomeDropped.
    const v = classifyMessage(
      "end-user",
      base({ hasUserSent: true, welcomeDropped: false, gatePending: false }),
    );
    expect(v).toEqual({ action: "ignore" });
  });
});

describe("shouldAppendStreamingToken", () => {
  it("suppresses pre-send welcome tokens", () => {
    // Agentforce streams the welcome too, not just answers. Pre-send,
    // every token belongs to the welcome. Appending would paint the
    // welcome as the streamingText preview.
    expect(shouldAppendStreamingToken({ hasUserSent: false, welcomeDropped: false })).toBe(false);
  });

  it("suppresses post-send tokens while the welcome is still pending", () => {
    // Slow-agent window: user POST completed but no Chatbot `message`
    // event has flipped welcomeDropped yet. Any tokens arriving here
    // belong to the welcome's own stream — appending would paint the
    // welcome into streamingText and overwrite it on the final
    // welcome `message` only to then overwrite it AGAIN with the real
    // answer. Visible flicker. Caller suppresses.
    expect(shouldAppendStreamingToken({ hasUserSent: true, welcomeDropped: false })).toBe(false);
  });

  it("appends tokens post-send once the welcome has been consumed", () => {
    expect(shouldAppendStreamingToken({ hasUserSent: true, welcomeDropped: true })).toBe(true);
  });

  it("suppresses tokens pre-send even if welcomeDropped is stale-true", () => {
    // Defensive: welcomeDropped true without hasUserSent true is a weird
    // state (would only come from a restore race). Still shouldn't
    // append — nothing to render until the user has engaged.
    expect(shouldAppendStreamingToken({ hasUserSent: false, welcomeDropped: true })).toBe(false);
  });
});
