import { Logger } from "./logger";

/**
 * Callback invoked for each parsed SSE event.
 */
export type SSEEventCallback = (eventType: string, data: string) => void;

/**
 * Callback invoked when the SSE stream closes or errors.
 */
export type SSECloseCallback = (reason: string) => void;

/**
 * Fetch-based SSE reader that supports custom Authorization headers.
 *
 * Unlike the browser's built-in EventSource, this implementation uses
 * fetch() with ReadableStream to parse SSE frames, allowing arbitrary
 * request headers (required for Bearer token + X-Org-Id).
 */
export class SSEReader {
  private controller: AbortController | null = null;
  private reading = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onEvent: SSEEventCallback,
    private readonly onClose: SSECloseCallback,
    private readonly logger: Logger,
  ) {}

  /**
   * Open the SSE connection and start reading events.
   * Resolves once the connection is established.
   * Rejects if the initial connection fails.
   */
  async connect(): Promise<void> {
    if (this.reading) {
      this.logger.warn("SSE already connected, ignoring duplicate connect()");
      return;
    }

    this.controller = new AbortController();
    this.reading = true;

    const res = await fetch(this.url, {
      method: "GET",
      headers: {
        ...this.headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      signal: this.controller.signal,
    });

    if (!res.ok) {
      this.reading = false;
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`SSE connection failed (${res.status}): ${detail}`);
    }

    if (!res.body) {
      this.reading = false;
      throw new Error("SSE response has no body stream");
    }

    // Start the read loop (non-blocking — runs in the background)
    this.readStream(res.body);
  }

  /**
   * Disconnect the SSE stream.
   */
  disconnect(): void {
    this.reading = false;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /**
   * Whether the reader is currently connected and reading.
   */
  get isConnected(): boolean {
    return this.reading;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.reading) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Normalize line endings: \r\n -> \n, lone \r -> \n (per SSE spec)
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        // Parse complete SSE frames (delimited by double newline)
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.parseFrame(frame);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Intentional disconnect — not an error
        this.logger.debug("SSE stream aborted (intentional disconnect)");
        return;
      }
      this.logger.error("SSE stream error:", err);
      this.reading = false;
      this.onClose(err instanceof Error ? err.message : "Unknown stream error");
      return;
    } finally {
      reader.releaseLock();
    }

    // Stream ended naturally
    this.reading = false;
    this.logger.info("SSE stream ended");
    this.onClose("stream_ended");
  }

  /**
   * Parse a single SSE frame (text between double-newlines).
   * Handles event:, data:, and : (comment) fields per the SSE spec.
   */
  private parseFrame(frame: string): void {
    let eventType = "message";
    const dataLines: string[] = [];

    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // SSE spec: remove exactly one leading space if present
        const raw = line.slice(5);
        dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
      } else if (line.startsWith(":")) {
        // Comment / ping — ignore
      }
      // Lines without a colon are ignored per SSE spec
    }

    if (dataLines.length === 0) return;

    const data = dataLines.join("\n");
    this.logger.debug(`SSE event: ${eventType}`, data.slice(0, 200));
    this.onEvent(eventType, data);
  }
}
