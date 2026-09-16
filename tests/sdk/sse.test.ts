import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEReader } from "../../src/sdk/sse";
import { Logger } from "../../src/sdk/logger";
import { createMockSSEStream } from "../helpers/mock-sse-stream";

const URL = "https://example.com/eventrouter/v1/sse";
const HEADERS = { Authorization: "Bearer test-token" };

function createReader(onEvent = vi.fn(), onClose = vi.fn()) {
  const reader = new SSEReader(URL, HEADERS, onEvent, onClose, new Logger(false));
  return { reader, onEvent, onClose };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect()", () => {
  it("is a no-op when already connected", async () => {
    const { stream } = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader } = createReader();
    await reader.connect();
    expect(reader.isConnected).toBe(true);

    await reader.connect();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    reader.disconnect();
  });

  it("throws with the status code when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    vi.stubGlobal("fetch", fetchMock);

    const { reader } = createReader();
    await expect(reader.connect()).rejects.toThrow(/SSE connection failed \(500\)/);
    expect(reader.isConnected).toBe(false);
  });

  it("throws when the response is ok but has no body stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { reader } = createReader();
    await expect(reader.connect()).rejects.toThrow("SSE response has no body stream");
    expect(reader.isConnected).toBe(false);
  });
});

describe("isConnected", () => {
  it("reflects the reading state across connect/disconnect", async () => {
    const { stream } = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader } = createReader();
    expect(reader.isConnected).toBe(false);

    await reader.connect();
    expect(reader.isConnected).toBe(true);

    reader.disconnect();
    expect(reader.isConnected).toBe(false);
  });
});

describe("stream read loop", () => {
  it("does not emit onClose when the stream is intentionally aborted", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onClose } = createReader();
    await reader.connect();

    // Simulate what a real fetch does when its AbortController fires: the
    // body reader rejects with a DOMException named "AbortError".
    reader.disconnect();
    stream.error(new DOMException("The user aborted a request.", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onClose).not.toHaveBeenCalled();
    expect(reader.isConnected).toBe(false);
  });

  it("calls onClose with the error message on a non-abort read error", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onClose } = createReader();
    await reader.connect();

    stream.error(new Error("network dropped"));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(onClose).toHaveBeenCalledWith("network dropped");
    expect(reader.isConnected).toBe(false);
  });

  it("calls onClose with stream_ended when the stream ends naturally", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onClose } = createReader();
    await reader.connect();

    stream.close();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(onClose).toHaveBeenCalledWith("stream_ended");
    expect(reader.isConnected).toBe(false);
  });
});

describe("SSE frame parsing", () => {
  it("parses event/data frames and invokes onEvent", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onEvent } = createReader();
    await reader.connect();

    stream.pushEvent("CONVERSATION_MESSAGE", { hello: "world" });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

    expect(onEvent).toHaveBeenCalledWith("CONVERSATION_MESSAGE", JSON.stringify({ hello: "world" }));

    reader.disconnect();
  });

  it("ignores comment lines (starting with ':')", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onEvent } = createReader();
    await reader.connect();

    stream.pushPing();
    stream.pushEvent("CONVERSATION_MESSAGE", "after-ping");
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

    // Only the real event fired an onEvent call — the ping was ignored.
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("CONVERSATION_MESSAGE", "after-ping");

    reader.disconnect();
  });

  it("normalizes \\r\\n line endings per the SSE spec", async () => {
    const stream = createMockSSEStream();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { reader, onEvent } = createReader();
    await reader.connect();

    stream.pushRaw("event: CONVERSATION_MESSAGE\r\ndata: crlf-data\r\n\r\n");
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());

    expect(onEvent).toHaveBeenCalledWith("CONVERSATION_MESSAGE", "crlf-data");

    reader.disconnect();
  });
});
