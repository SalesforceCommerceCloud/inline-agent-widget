import { vi } from "vitest";
import { TEST_ACCESS_TOKEN } from "./fixtures";

interface RouteHandler {
  method: string;
  pathPattern: string;
  status: number;
  body: unknown;
}

function createResponse(status: number, body: unknown): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, {
    status,
    statusText: status === 200 ? "OK" : status === 204 ? "No Content" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

export function createMockFetch() {
  const handlers: RouteHandler[] = [];

  const mockFn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || "GET";

      for (const handler of handlers) {
        if (handler.method === method && url.includes(handler.pathPattern)) {
          return createResponse(handler.status, handler.body);
        }
      }

      return createResponse(404, { error: "Not found" });
    },
  );

  function addHandler(method: string, pathPattern: string) {
    return {
      respondWith(status: number, body: unknown) {
        handlers.push({ method, pathPattern, status, body });
      },
    };
  }

  return {
    mock: mockFn,
    handlers,

    onPost(path: string) {
      return addHandler("POST", path);
    },

    onGet(path: string) {
      return addHandler("GET", path);
    },

    onDelete(path: string) {
      return addHandler("DELETE", path);
    },

    respondWithAccessToken(token: string = TEST_ACCESS_TOKEN) {
      handlers.push({
        method: "POST",
        pathPattern: "/iamessage/api/v2/authorization/unauthenticated/access-token",
        status: 200,
        body: { accessToken: token },
      });
    },

    respondWithSSEStream(stream: ReadableStream<Uint8Array>) {
      mockFn.mockImplementation(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          const method = init?.method || "GET";

          if (method === "GET" && url.includes("/eventrouter/v1/sse")) {
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }

          for (const handler of handlers) {
            if (handler.method === method && url.includes(handler.pathPattern)) {
              return createResponse(handler.status, handler.body);
            }
          }

          return createResponse(404, { error: "Not found" });
        },
      );
    },

    install() {
      vi.stubGlobal("fetch", mockFn);
    },

    reset() {
      mockFn.mockClear();
      handlers.length = 0;
    },
  };
}
