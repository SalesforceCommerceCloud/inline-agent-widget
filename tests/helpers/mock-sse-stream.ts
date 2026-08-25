/**
 * Creates a controllable ReadableStream that simulates SSE data arriving in chunks.
 */
export function createMockSSEStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    stream,

    pushEvent(eventType: string, data: string | object) {
      const dataStr = typeof data === "object" ? JSON.stringify(data) : data;
      const frame = `event: ${eventType}\ndata: ${dataStr}\n\n`;
      controller.enqueue(encoder.encode(frame));
    },

    pushRaw(text: string) {
      controller.enqueue(encoder.encode(text));
    },

    pushPing() {
      controller.enqueue(encoder.encode(": ping\n\n"));
    },

    close() {
      controller.close();
    },

    error(err: Error) {
      controller.error(err);
    },
  };
}
