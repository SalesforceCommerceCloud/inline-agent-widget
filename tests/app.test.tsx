// @vitest-environment jsdom
/**
 * App-level mode routing: inline/hybrid both mount WidgetProvider +
 * WidgetShell; agent-redirect short-circuits to AgentRedirectShim and never
 * mounts the provider (so no SCRT2 handshake fires).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { App } from "../src/App";
import type { WidgetConfig } from "../src/provider/types";

const SCRT2_CONFIG: WidgetConfig = {
  scrt2Url: "https://test.salesforce-scrt.com",
  orgId: "00DQZ000000TEST",
  esDeveloperName: "TestAgent",
  pdpQuestions: ["q1"],
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Hang every fetch so the provider's lazy session-start never resolves —
  // we only need the DOM shape, not a round-trip.
  fetchSpy = vi.fn().mockImplementation(() => new Promise(() => {}));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("App mode routing", () => {
  it("renders WidgetShell for mode='inline' (default)", async () => {
    const { container } = render(<App config={SCRT2_CONFIG} />);
    expect(container.querySelector(".composer")).not.toBeNull();
    expect(container.querySelector(".widget-header-title")?.textContent).toBe("Ask Assistant");
    await act(async () => {});
  });

  it("renders WidgetShell for mode='hybrid' (reserved — falls back to inline)", async () => {
    const { container } = render(<App config={{ ...SCRT2_CONFIG, mode: "hybrid" }} />);
    expect(container.querySelector(".composer")).not.toBeNull();
    await act(async () => {});
  });

  it("short-circuits to AgentRedirectShim for mode='agent-redirect'", () => {
    const config: WidgetConfig = {
      scrt2Url: "",
      orgId: "",
      esDeveloperName: "",
      mode: "agent-redirect",
      pdpQuestions: ["foo?"],
      productName: "Test Product",
    };

    const { container } = render(<App config={config} />);
    expect(container.querySelector(".widget-header-title")?.textContent).toBe("Ask Assistant");
    expect(container.querySelector(".composer")).not.toBeNull();
    expect(container.querySelectorAll(".pill")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
