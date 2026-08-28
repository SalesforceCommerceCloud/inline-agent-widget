import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentforceClient, type AgentforceMessageEvent, type AgentforceStreamingTokenEvent } from "../../src/sdk";
import { createMockFetch } from "../helpers/mock-fetch";
import { createMockSSEStream } from "../helpers/mock-sse-stream";
import {
  createClientOptions,
  TEST_ACCESS_TOKEN,
  TEST_CONVERSATION_ID,
  TEST_ES_NAME,
  TEST_ORG_ID,
} from "../helpers/fixtures";

let mockFetch: ReturnType<typeof createMockFetch>;

beforeEach(() => {
  mockFetch = createMockFetch();
  mockFetch.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connectClient(overrides = {}) {
  const stream = createMockSSEStream();
  mockFetch.respondWithAccessToken();
  mockFetch.respondWithSSEStream(stream.stream);
  const client = new AgentforceClient(createClientOptions(overrides));
  await client.connect();
  return { client, stream };
}

function bodyOf(call: [unknown, RequestInit?] | undefined): Record<string, unknown> {
  if (!call?.[1]?.body) return {};
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

function findCall(pred: (url: string, init?: RequestInit) => boolean) {
  return mockFetch.mock.mock.calls.find(([url, init]) =>
    pred(String(url), init as RequestInit | undefined),
  ) as [string, RequestInit?] | undefined;
}

describe("connect()", () => {
  it("acquires a token then opens the SSE stream and emits connected", async () => {
    const connectedSpy = vi.fn();
    const stream = createMockSSEStream();
    mockFetch.respondWithAccessToken();
    mockFetch.respondWithSSEStream(stream.stream);

    const client = new AgentforceClient(createClientOptions());
    client.on("connected", connectedSpy);
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(connectedSpy).toHaveBeenCalledTimes(1);
    expect(client.accessToken).toBeTruthy();

    const tokenCall = findCall((url, init) => url.includes("access-token") && init?.method === "POST");
    expect(tokenCall).toBeDefined();
    expect(bodyOf(tokenCall)).toMatchObject({
      orgId: TEST_ORG_ID,
      esDeveloperName: TEST_ES_NAME,
      capabilitiesVersion: "66",
      platform: "Web",
    });

    const sseCall = findCall((url, init) => url.includes("/eventrouter/v1/sse") && (init?.method ?? "GET") === "GET");
    expect(sseCall).toBeDefined();
    const sseHeaders = new Headers(sseCall?.[1]?.headers);
    expect(sseHeaders.get("X-Org-Id")).toBe(TEST_ORG_ID);
    expect(sseHeaders.get("Authorization")).toMatch(/^Bearer /);

    client.disconnect();
  });
});

describe("restore()", () => {
  // A syntactically valid JWT with exp in the past (year 2001) → already expired.
  // Payload: {"sub":"x","exp":1000000000}
  const EXPIRED_TOKEN =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwiZXhwIjoxMDAwMDAwMDAwfQ.sig";

  it("opens the SSE stream with the stored token and adopts the conversationId — no mint, no create", async () => {
    const stream = createMockSSEStream();
    mockFetch.respondWithSSEStream(stream.stream);
    const connectedSpy = vi.fn();

    const client = new AgentforceClient(createClientOptions());
    client.on("connected", connectedSpy);

    await client.restore({
      accessToken: TEST_ACCESS_TOKEN,
      conversationId: TEST_CONVERSATION_ID,
      lastEventId: "evt-7",
    });

    expect(client.isConnected).toBe(true);
    expect(client.conversationId).toBe(TEST_CONVERSATION_ID);
    expect(client.lastEventId).toBe("evt-7");
    expect(connectedSpy).toHaveBeenCalledTimes(1);

    // Crucially: NO token-mint POST and NO create-conversation POST were made.
    const tokenCall = findCall((url, init) => url.includes("access-token") && init?.method === "POST");
    expect(tokenCall).toBeUndefined();
    const createCall = findCall(
      (url, init) => url.endsWith("/iamessage/api/v2/conversation") && init?.method === "POST",
    );
    expect(createCall).toBeUndefined();

    // The SSE GET carried the stored token as the Bearer credential.
    const sseCall = findCall((url, init) => url.includes("/eventrouter/v1/sse") && (init?.method ?? "GET") === "GET");
    expect(sseCall).toBeDefined();
    expect(new Headers(sseCall?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${TEST_ACCESS_TOKEN}`,
    );

    client.disconnect();
  });

  it("restores a token whose payload uses base64url chars (-/_) — not misread as expired", async () => {
    // Regression: real Salesforce JWT payloads contain base64url chars (-/_),
    // which raw atob() rejects. getTokenExpiry() would then return 0 and
    // restore() would wrongly throw "token has expired". This token has a
    // far-future exp (year 2100) AND -/_ in its payload segment.
    const URL_CHAR_TOKEN =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVpZC0xMjMiLCJleHAiOjQxMDI0NDQ4MDAsInBhZCI6IsO7w7_DvsO7w7_DviJ9.sig";
    expect(/[-_]/.test(URL_CHAR_TOKEN.split(".")[1])).toBe(true); // guard: really exercises the path

    const stream = createMockSSEStream();
    mockFetch.respondWithSSEStream(stream.stream);
    const client = new AgentforceClient(createClientOptions());

    await client.restore({
      accessToken: URL_CHAR_TOKEN,
      conversationId: TEST_CONVERSATION_ID,
    });

    expect(client.isConnected).toBe(true);
    expect(client.conversationId).toBe(TEST_CONVERSATION_ID);
    // Expiry parsed correctly to a future ms timestamp (not 0 / not expired).
    expect(client.tokenExpiresAt).toBe(4102444800 * 1000);
    client.disconnect();
  });

  it("rejects an expired token without opening the stream (caller mints fresh)", async () => {
    const client = new AgentforceClient(createClientOptions());
    await expect(
      client.restore({ accessToken: EXPIRED_TOKEN, conversationId: TEST_CONVERSATION_ID }),
    ).rejects.toThrow(/expired/i);
    expect(client.isConnected).toBe(false);
    expect(client.conversationId).toBeNull();
  });

  it("rolls back state if opening the SSE stream fails", async () => {
    // SSE endpoint returns 500 → openSSE throws; restore() must not leave a
    // half-restored conversationId (which would fool readiness checks).
    mockFetch.onGet("/eventrouter/v1/sse").respondWith(500, "boom");

    const client = new AgentforceClient(createClientOptions());
    await expect(
      client.restore({ accessToken: TEST_ACCESS_TOKEN, conversationId: TEST_CONVERSATION_ID }),
    ).rejects.toThrow();

    expect(client.isConnected).toBe(false);
    expect(client.conversationId).toBeNull();
    expect(client.accessToken).toBeNull();
  });
});

describe("conversation lifecycle request bodies", () => {
  it("createConversation posts a conversationId, esDeveloperName and routingAttributes", async () => {
    const { client } = await connectClient();
    mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});

    const id = await client.createConversation();

    expect(id).toBeTruthy();
    expect(client.conversationId).toBe(id);

    const call = findCall((url, init) => url.endsWith("/iamessage/api/v2/conversation") && init?.method === "POST");
    expect(bodyOf(call)).toMatchObject({
      conversationId: id,
      esDeveloperName: TEST_ES_NAME,
      routingAttributes: {},
    });

    client.disconnect();
  });

  it("sendMessage posts a StaticContentMessage with the text", async () => {
    const { client } = await connectClient();
    mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});
    await client.createConversation();

    await client.sendMessage("Hello there");

    const call = findCall((url, init) => url.includes("/message") && init?.method === "POST");
    expect(call).toBeDefined();
    const body = bodyOf(call);
    expect(body).toMatchObject({ esDeveloperName: TEST_ES_NAME });
    expect(body.message).toMatchObject({
      messageType: "StaticContentMessage",
      staticContent: { formatType: "Text", text: "Hello there" },
    });
    expect(body).not.toHaveProperty("context");

    client.disconnect();
  });

  it("sendMessage wraps context variables in the SCRT2 v2 SessionContext envelope", async () => {
    const { client } = await connectClient();
    mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});
    await client.createConversation();

    await client.sendMessage("Is this waterproof?", [
      {
        name: "page_context_type",
        value: { valueType: "TextValue", textValue: "pdp_inline" },
      },
      {
        name: "page_context_message",
        value: {
          valueType: "TextValue",
          textValue: "This is the product details page the user is currently looking at",
        },
      },
      {
        name: "page_context_data",
        value: { valueType: "TextValue", textValue: '{"id":"1050633A6D"}' },
      },
    ]);

    const call = findCall((url, init) => url.includes("/message") && init?.method === "POST");
    expect(bodyOf(call)).toEqual({
      message: {
        id: expect.any(String),
        messageType: "StaticContentMessage",
        staticContent: {
          formatType: "Text",
          text: "Is this waterproof?",
        },
      },
      esDeveloperName: TEST_ES_NAME,
      context: [
        {
          entryType: "SessionContext",
          id: expect.any(String),
          sessionContext: {
            contextType: "SessionContextSet",
            contextVariables: [
              {
                name: "page_context_type",
                value: { valueType: "TextValue", textValue: "pdp_inline" },
              },
              {
                name: "page_context_message",
                value: {
                  valueType: "TextValue",
                  textValue:
                    "This is the product details page the user is currently looking at",
                },
              },
              {
                name: "page_context_data",
                value: {
                  valueType: "TextValue",
                  textValue: '{"id":"1050633A6D"}',
                },
              },
            ],
          },
        },
      ],
    });

    client.disconnect();
  });

  it("sendMessage omits the context envelope for an empty variable list", async () => {
    const { client } = await connectClient();
    mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});
    await client.createConversation();

    await client.sendMessage("Hello there", []);

    const call = findCall((url, init) => url.includes("/message") && init?.method === "POST");
    expect(bodyOf(call)).not.toHaveProperty("context");

    client.disconnect();
  });

  it("endConversation issues a DELETE with the esDeveloperName query", async () => {
    const { client } = await connectClient();
    mockFetch.onPost("/iamessage/api/v2/conversation").respondWith(200, {});
    mockFetch.onDelete("/iamessage/api/v2/conversation").respondWith(204, {});
    const id = await client.createConversation();

    await client.endConversation();

    const call = findCall((_url, init) => init?.method === "DELETE");
    expect(call).toBeDefined();
    expect(call?.[0]).toContain(`/iamessage/api/v2/conversation/${id}`);
    expect(call?.[0]).toContain(`esDeveloperName=${TEST_ES_NAME}`);
    expect(client.conversationId).toBeNull();

    client.disconnect();
  });
});

describe("SSE CONVERSATION_MESSAGE handling", () => {
  it("emits a message from abstractMessage.staticContent.text", async () => {
    const { client, stream } = await connectClient();
    const messages: AgentforceMessageEvent[] = [];
    client.on("message", (e) => messages.push(e));

    stream.pushEvent("CONVERSATION_MESSAGE", {
      conversationEntry: {
        identifier: "msg-1",
        sender: { role: "Agent" },
        senderDisplayName: "Agentforce",
        entryPayload: JSON.stringify({
          abstractMessage: { staticContent: { text: "Hello **world**" } },
        }),
      },
    });

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].content).toBe("Hello **world**");
    expect(messages[0].sender.role).toBe("Agent");

    client.disconnect();
  });

  it("falls back to abstractMessage.content.text (object entryPayload)", async () => {
    const { client, stream } = await connectClient();
    const messages: AgentforceMessageEvent[] = [];
    client.on("message", (e) => messages.push(e));

    stream.pushEvent("CONVERSATION_MESSAGE", {
      conversationEntry: {
        identifier: "msg-2",
        sender: { role: "Agent" },
        entryPayload: { abstractMessage: { content: { text: "Fallback text" } } },
      },
    });

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].content).toBe("Fallback text");

    client.disconnect();
  });

  it("suppresses EndUser echo messages", async () => {
    const { client, stream } = await connectClient();
    const messageSpy = vi.fn();
    const streamingSpy = vi.fn();
    client.on("message", messageSpy);
    client.on("streaming_token", streamingSpy);

    stream.pushEvent("CONVERSATION_MESSAGE", {
      conversationEntry: {
        identifier: "echo-1",
        sender: { role: "EndUser" },
        entryPayload: JSON.stringify({
          abstractMessage: { staticContent: { text: "my own message" } },
        }),
      },
    });
    // A trailing agent event we CAN observe, to prove the stream is flowing.
    stream.pushEvent("CONVERSATION_STREAMING_TOKEN", { token: "hi" });

    await vi.waitFor(() => expect(streamingSpy).toHaveBeenCalled());
    expect(messageSpy).not.toHaveBeenCalled();

    client.disconnect();
  });
});

describe("SSE CONVERSATION_STREAMING_TOKEN handling", () => {
  it("emits the token from the nested streamingToken shape with metadata", async () => {
    const { client, stream } = await connectClient();
    const tokens: AgentforceStreamingTokenEvent[] = [];
    client.on("streaming_token", (e) => tokens.push(e));

    stream.pushEvent("CONVERSATION_STREAMING_TOKEN", {
      conversationEntry: {
        entryPayload: JSON.stringify({
          streamingToken: {
            token: { text: "chunk-A" },
            sequenceNumber: 3,
            targetMessageIdentifier: "m-9",
            tokenType: "MessageStreamingToken",
          },
        }),
      },
    });

    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    expect(tokens[0]).toMatchObject({
      token: "chunk-A",
      sequenceNumber: 3,
      targetMessageId: "m-9",
      tokenType: "MessageStreamingToken",
    });

    client.disconnect();
  });

  it("emits the token from the legacy top-level shape", async () => {
    const { client, stream } = await connectClient();
    const tokens: AgentforceStreamingTokenEvent[] = [];
    client.on("streaming_token", (e) => tokens.push(e));

    stream.pushEvent("CONVERSATION_STREAMING_TOKEN", { token: "legacy-chunk" });

    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    expect(tokens[0].token).toBe("legacy-chunk");

    client.disconnect();
  });

  it("does not emit when no token text can be extracted", async () => {
    const { client, stream } = await connectClient();
    const tokenSpy = vi.fn();
    const messageSpy = vi.fn();
    client.on("streaming_token", tokenSpy);
    client.on("message", messageSpy);

    stream.pushEvent("CONVERSATION_STREAMING_TOKEN", {
      conversationEntry: { entryPayload: "{}" },
    });
    stream.pushEvent("CONVERSATION_MESSAGE", {
      conversationEntry: {
        sender: { role: "Agent" },
        entryPayload: JSON.stringify({ abstractMessage: { staticContent: { text: "done" } } }),
      },
    });

    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalled());
    expect(tokenSpy).not.toHaveBeenCalled();

    client.disconnect();
  });
});

describe("auto-reconnect", () => {
  it("emits reconnecting when the SSE stream drops unexpectedly", async () => {
    vi.useFakeTimers();
    const stream = createMockSSEStream();
    mockFetch.respondWithAccessToken();
    mockFetch.respondWithSSEStream(stream.stream);

    const client = new AgentforceClient(createClientOptions());
    const reconnectingSpy = vi.fn();
    const disconnectedSpy = vi.fn();
    client.on("reconnecting", reconnectingSpy);
    client.on("disconnected", disconnectedSpy);

    await client.connect();
    expect(client.isConnected).toBe(true);

    // Server drops the stream (not an intentional client disconnect).
    stream.close();

    // Flush the stream reader's microtask chain (close → onClose →
    // attemptReconnect). "reconnecting" is emitted synchronously, before the
    // backoff setTimeout, so no timer advance is needed.
    for (let i = 0; i < 30; i++) await Promise.resolve();

    expect(disconnectedSpy).toHaveBeenCalledTimes(1);
    expect(reconnectingSpy).toHaveBeenCalledTimes(1);
    expect(reconnectingSpy).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 5 });
    expect(client.isConnected).toBe(false);

    // Clears the pending backoff timer so it can't fire after teardown.
    client.disconnect();
  });
});
