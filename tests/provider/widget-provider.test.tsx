// @vitest-environment jsdom
/**
 * Provider-level regression probes for the three bugs human review caught on
 * PR #24: P1 welcome-timeout retry reuses stalled session, P2a restored
 * session renders stale answer, P2b dispose/reset leaks welcome timer.
 *
 * Each probe mounts the ACTUAL WidgetProvider against a mocked fetch + SSE
 * stream and asserts observable behavior (network sequence / rendered DOM).
 * Each probe fails on the pre-fix provider and passes on the current head —
 * that's the regression contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { WidgetProvider } from "../../src/provider/WidgetProvider";
import { useWidget } from "../../src/provider/context";
import { buildSessionKey } from "../../src/provider/session-store";
import type { WidgetConfig, WidgetContextValue } from "../../src/provider/types";
import { createMockFetch } from "../helpers/mock-fetch";
import { createMockSSEStream } from "../helpers/mock-sse-stream";
import { TEST_ACCESS_TOKEN, TEST_CONVERSATION_ID } from "../helpers/fixtures";

const CONFIG: WidgetConfig = {
  scrt2Url: "https://test.salesforce-scrt.com",
  orgId: "00DQZ000000TEST",
  esDeveloperName: "TestAgent",
  enableLogging: false,
};

let mockFetch: ReturnType<typeof createMockFetch>;
let latestCtx: WidgetContextValue | null = null;

function Probe() {
  const ctx = useWidget();
  useEffect(() => {
    latestCtx = ctx;
  });
  return (
    <>
      {ctx.state.lastQuestion ? <div data-testid="q">{ctx.state.lastQuestion}</div> : null}
      {ctx.state.answer ? <div data-testid="a">{ctx.state.answer}</div> : null}
      {ctx.state.error ? <div data-testid="err">{ctx.state.error}</div> : null}
      <div data-testid="status">{ctx.state.status}</div>
    </>
  );
}

// Count fetches by predicate — single source of truth for every assertion.
function countCalls(pred: (url: string, init?: RequestInit) => boolean): number {
  return mockFetch.mock.mock.calls.filter(([url, init]) =>
    pred(String(url), init as RequestInit | undefined),
  ).length;
}

const isCreateConversation = (url: string, init?: RequestInit) =>
  url.endsWith("/iamessage/api/v2/conversation") && (init?.method ?? "GET") === "POST";

const isDeleteConversation = (url: string, init?: RequestInit) =>
  url.includes("/iamessage/api/v2/conversation/") && init?.method === "DELETE";

const isSendMessage = (url: string, init?: RequestInit) =>
  /\/conversation\/[^/]+\/message/.test(url) && init?.method === "POST";

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  mockFetch = createMockFetch();
  mockFetch.install();
  // Order matters: mock-fetch does first-match-wins on url.includes(pattern).
  // Send is a POST on /conversation/<id>/message — register with /message
  // first so it doesn't get caught by the broader /conversation pattern.
  mockFetch.onPost("/message").respondWith(200, {});
  mockFetch.onPost("access-token").respondWith(200, { accessToken: TEST_ACCESS_TOKEN });
  mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});
  mockFetch.onDelete("/conversation").respondWith(204, "");
  latestCtx = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("WidgetProvider — provider-level regression probes", () => {
  it("Probe 1 (P1): welcome-timeout retry tears down the stalled conversation (DELETE conv-1) and creates a fresh one (second POST /conversation)", async () => {
    // Fresh SSE stream for the first attempt — we never push a Chatbot entry
    // on it, so manager.waitForWelcome(6000) must time out.
    const sse1 = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse1.stream);

    render(
      <WidgetProvider config={CONFIG}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      void latestCtx!.sendMessage("hello");
      // Give the first attempt its handshake microtasks (token POST, SSE GET,
      // POST /conversation) before advancing to the welcome timeout.
      await flushMicrotasks(20);
    });

    const createPostsAfterFirst = countCalls(isCreateConversation);
    expect(createPostsAfterFirst).toBe(1); // conv-1 minted

    // Swap in a second SSE stream so the retry's openSSE() returns a fresh,
    // non-pre-closed reader.
    const sse2 = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse2.stream);

    // Fire welcome timeout #1 → provider's retry catch runs: endConversation
    // (DELETE), disconnect, clearSession, manager.reset, then connect+createConversation again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks(30);
    });

    // The retry's waitForWelcome schedules a second 6s timer. Fire it too so
    // the test terminates (we don't need the retry to succeed — we only need
    // the pre-retry teardown + fresh conversation POST to have fired).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks(30);
    });

    const deleteCount = countCalls(isDeleteConversation);
    const createCount = countCalls(isCreateConversation);

    // Regression signals — pre-fix behavior was deleteCount=0, createCount=1.
    expect(deleteCount).toBeGreaterThanOrEqual(1); // conv-1 explicitly torn down
    expect(createCount).toBe(2); // conv-1 + fresh conv-2
    // No message was sent in either attempt (both welcome timeouts) — the
    // observable "zero messages sent" from Chintan's reproduction.
    expect(countCalls(isSendMessage)).toBe(0);
  });

  it("Probe 2 (P2a): restored session does not render a historical Chatbot entry as the answer to a new question", async () => {
    // Pre-seed localStorage with a restorable session (valid future-exp token).
    const sessionKey = buildSessionKey(CONFIG.orgId, CONFIG.esDeveloperName);
    localStorage.setItem(
      sessionKey,
      JSON.stringify({
        accessToken: TEST_ACCESS_TOKEN,
        conversationId: TEST_CONVERSATION_ID,
        lastEventId: null,
      }),
    );

    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    render(
      <WidgetProvider config={{ ...CONFIG, persistSession: true }}>
        <Probe />
      </WidgetProvider>,
    );

    // Fire the send. The provider calls manager.connect() which tryRestore()s
    // (opens SSE with stored token, adopts conv id, flips bot-join gate).
    await act(async () => {
      void latestCtx!.sendMessage("new question");
      await flushMicrotasks(30);
    });

    // Push a HISTORICAL Chatbot entry on the SSE — stale server-side timestamp
    // (hours before the new question). On the pre-fix code this classifies as
    // render-answer against the year-0000 sentinel. On the fix it stays
    // buffered until this turn's user_echo lands.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "stale-answer",
          sender: { role: "Chatbot" },
          transcriptedTimestamp: "2026-10-28T10:00:00.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "STALE historical answer" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });

    // Now the shopper's own user_echo lands — strictly after the stale entry.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "echo-1",
          sender: { role: "EndUser" },
          transcriptedTimestamp: "2026-10-28T20:00:00.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "new question" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });

    // Regression signal: no answer bubble. Pre-fix code would have rendered
    // "STALE historical answer" under the new question.
    expect(latestCtx!.state.answer).toBe(null);
    expect(latestCtx!.state.lastQuestion).toBe("new question");
  });

  it("Probe 3 (P2b): unmount while waitForWelcome is pending fires no welcome_timeout, no retry handshake, no state mutation on the dead provider", async () => {
    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    const isAccessToken = (url: string, init?: RequestInit) =>
      url.includes("access-token") && init?.method === "POST";
    const isSSE = (url: string, init?: RequestInit) =>
      url.includes("/eventrouter/v1/sse") && (init?.method ?? "GET") === "GET";

    const r = render(
      <WidgetProvider config={CONFIG}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      void latestCtx!.sendMessage("hello");
      await flushMicrotasks(20);
    });

    // Baseline: exactly one of each handshake call fired.
    const tokenBefore = countCalls(isAccessToken);
    const sseBefore = countCalls(isSSE);
    const createBefore = countCalls(isCreateConversation);
    expect(tokenBefore).toBe(1);
    expect(sseBefore).toBe(1);
    expect(createBefore).toBe(1);

    r.unmount();

    // Advance well past the welcome timeout. Pre-fix: the stranded timer
    // fires → waitForWelcome rejects → retry path runs connect+create → one
    // more token POST + one more SSE GET + one more conversation POST land.
    // With the fix, dispose() cancels the timer and none of those run.
    // Unmount side effects (DELETE + disconnect) are expected and not asserted.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
      await flushMicrotasks(30);
    });

    expect(countCalls(isAccessToken)).toBe(tokenBefore);
    expect(countCalls(isSSE)).toBe(sseBefore);
    expect(countCalls(isCreateConversation)).toBe(createBefore);
    // Status on the dead provider never flips to disconnected — the retry
    // catch's dispatch would have mutated it.
    expect(latestCtx!.state.status).not.toBe("disconnected");
  });
});
