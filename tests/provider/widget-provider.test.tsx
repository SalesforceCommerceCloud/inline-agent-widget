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

  it("Probe 4 (happy path): bot-join → user_echo → streaming tokens → final answer → session_ready drives the full SSE handler surface", async () => {
    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const sessionReadyEvents: Array<CustomEvent<{ messagingSessionId: string }>> = [];
    host.addEventListener("iaw:session-ready", (e) =>
      sessionReadyEvents.push(e as CustomEvent<{ messagingSessionId: string }>),
    );

    render(
      <WidgetProvider config={CONFIG} hostElement={host}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      void latestCtx!.sendMessage("hi");
      await flushMicrotasks(20);
    });

    // Welcome (bot joined). Pre-echo: message handler buffers the entry.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "welcome-1",
          sender: { role: "Chatbot" },
          transcriptedTimestamp: "2026-10-28T20:00:00.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "Hi, I'm your assistant." } },
          }),
        },
      });
      await flushMicrotasks(20);
    });

    // User echo lands → sets cutoff → drains buffer → welcome classifies as drop.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "echo-1",
          sender: { role: "EndUser" },
          transcriptedTimestamp: "2026-10-28T20:00:05.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "hi" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });

    // Typing started — now post-echo so dispatch fires.
    await act(async () => {
      sse.pushEvent("CONVERSATION_TYPING_STARTED_INDICATOR", {
        conversationEntry: { sender: { role: "Agent" } },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.agentTyping).toBe(true);

    // Streaming tokens using the nested shape SCRT2 delivers in prod.
    await act(async () => {
      sse.pushEvent("CONVERSATION_STREAMING_TOKEN", {
        conversationEntry: {
          identifier: "answer-1",
          sender: { role: "Agent" },
          entryPayload: JSON.stringify({
            streamingToken: { token: { text: "Hello " }, sequenceNumber: 1 },
          }),
        },
      });
      sse.pushEvent("CONVERSATION_STREAMING_TOKEN", {
        conversationEntry: {
          identifier: "answer-1",
          sender: { role: "Agent" },
          entryPayload: JSON.stringify({
            streamingToken: { token: { text: "world" }, sequenceNumber: 2 },
          }),
        },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.streamingText).toContain("Hello");

    // Typing stopped.
    await act(async () => {
      sse.pushEvent("CONVERSATION_TYPING_STOPPED_INDICATOR", {
        conversationEntry: { sender: { role: "Agent" } },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.agentTyping).toBe(false);

    // Final answer — post-echo classifies render-answer.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "final-1",
          sender: { role: "Chatbot" },
          transcriptedTimestamp: "2026-10-28T20:00:10.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "Hello, world!" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.answer).toBe("Hello, world!");

    // session_ready → host CustomEvent dispatched.
    await act(async () => {
      sse.pushEvent("CONVERSATION_SESSION_STATUS_CHANGED", {
        conversationEntry: {
          entryPayload: JSON.stringify({ sessionId: "0Mw000000000000TEST" }),
        },
      });
      await flushMicrotasks(10);
    });
    expect(sessionReadyEvents).toHaveLength(1);
    expect(sessionReadyEvents[0].detail.messagingSessionId).toBe("0Mw000000000000TEST");

    document.body.removeChild(host);
  });

  it("Probe 5 (SPA PDP nav): pushState to a different product clears the echo cutoff + buffer and resets the conversation", async () => {
    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    // Start on product A.
    window.history.pushState({}, "", "/product?pid=A1");

    const configWithProduct: WidgetConfig = {
      ...CONFIG,
      productIdParam: "pid",
    };

    render(
      <WidgetProvider config={configWithProduct}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    // Ask a question on PDP A, drive it to final answer, then nav to PDP B.
    await act(async () => {
      void latestCtx!.sendMessage("about A?");
      await flushMicrotasks(20);
    });
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "echo-A",
          sender: { role: "EndUser" },
          transcriptedTimestamp: "2026-10-28T20:00:05.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "about A?" } },
          }),
        },
      });
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "answer-A",
          sender: { role: "Chatbot" },
          transcriptedTimestamp: "2026-10-28T20:00:10.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "Answer for A" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.answer).toBe("Answer for A");
    expect(latestCtx!.state.lastQuestion).toBe("about A?");

    // SPA nav to product B via pushState — provider's patched pushState fires.
    await act(async () => {
      window.history.pushState({}, "", "/product?pid=B2");
      await flushMicrotasks(10);
    });

    // RESET_CONVERSATION cleared the reducer state. The regression-sensitive
    // assertion lives inside the provider (echoCutoffRef nulled + buffer
    // cleared); we validate it indirectly by pushing a late-arriving entry
    // with PDP A's timestamp and confirming it is buffered — not rendered.
    expect(latestCtx!.state.answer).toBe(null);
    expect(latestCtx!.state.lastQuestion).toBe(null);

    // Late PDP-A reply replays on the stream. echoCutoffRef is null, so this
    // path buffers (does not render) — the P2a cross-PDP leak fix.
    await act(async () => {
      sse.pushEvent("CONVERSATION_MESSAGE", {
        conversationEntry: {
          identifier: "late-A",
          sender: { role: "Chatbot" },
          transcriptedTimestamp: "2026-10-28T20:00:12.000Z",
          entryPayload: JSON.stringify({
            abstractMessage: { staticContent: { text: "LATE A reply" } },
          }),
        },
      });
      await flushMicrotasks(10);
    });
    expect(latestCtx!.state.answer).toBe(null);

    window.history.pushState({}, "", "/");
  });

  it("Probe 6 (oversize message): client-side length guard rejects >4000 chars without posting and surfaces a user-facing error", async () => {
    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    render(
      <WidgetProvider config={CONFIG}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await latestCtx!.sendMessage("x".repeat(4001));
    });
    expect(ok).toBe(false);
    expect(latestCtx!.state.error).toMatch(/maximum length/i);
    expect(countCalls(isSendMessage)).toBe(0);
    expect(countCalls(isCreateConversation)).toBe(0);
  });

  it("Probe 7 (persistSession, no stored session): tryRestore returns false, provider falls through to a fresh handshake", async () => {
    // persistSession true but localStorage empty → loadSession returns null,
    // tryRestore returns false, manager.connect falls through to the normal
    // handshake. Exercises the persistence adapter's no-session branch
    // (lines 164-178 + 212 skip of clearSession).
    const sse = createMockSSEStream();
    mockFetch.respondWithSSEStream(sse.stream);

    render(
      <WidgetProvider config={{ ...CONFIG, persistSession: true, enableLogging: true }}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      void latestCtx!.sendMessage("hello");
      await flushMicrotasks(30);
    });

    // Fresh handshake fired: token + SSE + conversation POST all land.
    expect(countCalls(isCreateConversation)).toBe(1);
  });

  it("Probe 8 (persistSession, restore throws): client.restore rejection clears the stored session and starts a fresh handshake", async () => {
    // Pre-seed localStorage with a token whose stored conv-id triggers a 401
    // on the SSE open — client.restore will throw inside openSSE and the
    // persistence catch runs: clearSession + return false. Exercises the
    // restore-catch branch (lines 192-203).
    const sessionKey = buildSessionKey(CONFIG.orgId, CONFIG.esDeveloperName);
    localStorage.setItem(
      sessionKey,
      JSON.stringify({
        accessToken: TEST_ACCESS_TOKEN,
        conversationId: TEST_CONVERSATION_ID,
        lastEventId: null,
      }),
    );

    // Install a fetch mock whose SSE GET returns 401, forcing restore() to
    // throw. Then second attempt (fresh handshake) must succeed via the
    // normal token POST + SSE GET + conversation POST sequence.
    let sseCallCount = 0;
    const sse2 = createMockSSEStream();
    mockFetch.mock.mockImplementation(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method || "GET";
        if (method === "GET" && url.includes("/eventrouter/v1/sse")) {
          sseCallCount += 1;
          if (sseCallCount === 1) {
            return new Response("unauthorized", {
              status: 401,
              headers: { "Content-Type": "text/plain" },
            });
          }
          return new Response(sse2.stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (method === "POST" && url.includes("access-token")) {
          return new Response(JSON.stringify({ accessToken: TEST_ACCESS_TOKEN }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "POST" && url.endsWith("/iamessage/api/v2/conversation")) {
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "DELETE" && url.includes("/conversation")) {
          return new Response("", { status: 204 });
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      },
    );

    render(
      <WidgetProvider config={{ ...CONFIG, persistSession: true, enableLogging: true }}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      void latestCtx!.sendMessage("after-recover");
      await flushMicrotasks(30);
    });

    // Second SSE open succeeded + a fresh conversation was POSTed. The
    // restore-catch cleared the stale session; the fresh handshake's
    // persistSave then stores the new conv-id — so we assert the id changed
    // rather than that storage is empty.
    expect(sseCallCount).toBeGreaterThanOrEqual(2);
    expect(countCalls(isCreateConversation)).toBe(1);
    const stored = JSON.parse(localStorage.getItem(sessionKey) ?? "null");
    expect(stored?.conversationId).not.toBe(TEST_CONVERSATION_ID);
  });

  it("Probe 9 (missing config): empty orgId skips the client-mount effect and sendMessage no-ops", async () => {
    // Covers the early-return guard at line 144.
    const partialConfig: WidgetConfig = { ...CONFIG, orgId: "" };
    render(
      <WidgetProvider config={partialConfig}>
        <Probe />
      </WidgetProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await latestCtx!.sendMessage("hello");
    });
    expect(ok).toBe(false);
    expect(countCalls(isCreateConversation)).toBe(0);
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
