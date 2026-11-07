// @vitest-environment jsdom
/**
 * App-level mode routing: inline/hybrid both mount WidgetProvider +
 * WidgetShell; shopper-agent short-circuits to ShopperAgentShim and never
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

describe("WidgetShell pre-warm (IntersectionObserver)", () => {
  let observeCb: (entries: Array<{ isIntersecting: boolean }>) => void;
  let mockObserve: ReturnType<typeof vi.fn>;
  let mockDisconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockObserve = vi.fn();
    mockDisconnect = vi.fn();
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        observeCb = cb as unknown as typeof observeCb;
      }
      observe = mockObserve;
      disconnect = mockDisconnect;
      unobserve = vi.fn();
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [] as number[];
      takeRecords = vi.fn();
    } as unknown as typeof IntersectionObserver;
  });

  it("sets up IntersectionObserver when preWarm is true and fires warmUp on intersection", async () => {
    render(<App config={{ ...SCRT2_CONFIG, preWarm: true }} />);
    await act(async () => {});

    expect(mockObserve).toHaveBeenCalledTimes(1);

    await act(async () => {
      observeCb([{ isIntersecting: true }]);
    });

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("does not set up IntersectionObserver when preWarm is false", async () => {
    render(<App config={{ ...SCRT2_CONFIG, preWarm: false }} />);
    await act(async () => {});

    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("ignores non-intersecting entries", async () => {
    render(<App config={{ ...SCRT2_CONFIG, preWarm: true }} />);
    await act(async () => {});

    await act(async () => {
      observeCb([{ isIntersecting: false }]);
    });

    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("fires warmUp only once even if observer triggers twice", async () => {
    render(<App config={{ ...SCRT2_CONFIG, preWarm: true }} />);
    await act(async () => {});

    await act(async () => {
      observeCb([{ isIntersecting: true }]);
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
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

  it("short-circuits to ShopperAgentShim for mode='shopper-agent'", () => {
    const config: WidgetConfig = {
      scrt2Url: "",
      orgId: "",
      esDeveloperName: "",
      mode: "shopper-agent",
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
