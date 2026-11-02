// @vitest-environment jsdom
/**
 * renderInto probes: config validation and unmount cleanup. The happy-path
 * agent-redirect / inline renders are covered elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderInto } from "../src/render";
import type { WidgetConfig } from "../src/provider/types";

const BAD_CONFIG: WidgetConfig = {
  scrt2Url: "",
  orgId: "",
  esDeveloperName: "",
};

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("renderInto", () => {
  it("renders a config-error message when inline-mode config is missing SCRT2 fields", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, BAD_CONFIG, host);
    });

    try {
      expect(shadow.querySelector(".iaw-config-error")).not.toBeNull();
      expect(handle!.conversationId).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      handle?.unmount();
    }
  });

  it("exposes a no-op update() on the error handle (safe to call)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, BAD_CONFIG, host);
    });

    expect(() => handle!.update({ ...BAD_CONFIG })).not.toThrow();
    handle?.unmount();
  });

  it("unmount() removes the container and style tag from the shadow root", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const config: WidgetConfig = { ...BAD_CONFIG, mode: "agent-redirect" };

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, config, host);
    });

    expect(shadow.querySelector(".iaw-root")).not.toBeNull();
    expect(shadow.querySelector("style")).not.toBeNull();

    await act(async () => {
      handle!.unmount();
    });

    expect(shadow.querySelector(".iaw-root")).toBeNull();
    expect(shadow.querySelector("style")).toBeNull();
  });

  it("update() re-renders with a new config in agent-redirect mode", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const initial: WidgetConfig = {
      ...BAD_CONFIG,
      mode: "agent-redirect",
      productName: "Original",
    };

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, initial, host);
    });

    const textarea1 = shadow.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea1.placeholder).toBe("Ask me anything about Original");

    await act(async () => {
      handle!.update({ ...initial, productName: "Updated" });
    });

    const textarea2 = shadow.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea2.placeholder).toBe("Ask me anything about Updated");

    handle?.unmount();
  });
});
