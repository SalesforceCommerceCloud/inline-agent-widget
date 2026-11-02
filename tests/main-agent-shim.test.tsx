// @vitest-environment jsdom
/**
 * Main-agent shim probes: when the UMD mounts with mode="main-agent",
 * it must (a) render pills + input without opening a SCRT2 session, and
 * (b) emit an `inline-agent-widget:handoff` CustomEvent on the host element
 * every time a pill is clicked or the form is submitted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MainAgentShim,
  HANDOFF_EVENT,
  type HandoffEventDetail,
} from "../src/MainAgentShim";
import { renderInto } from "../src/render";
import type { WidgetConfig } from "../src/provider/types";

const BASE_CONFIG: WidgetConfig = {
  scrt2Url: "",
  orgId: "",
  esDeveloperName: "",
  mode: "main-agent",
  productName: "Muddier Trucker",
  pdpQuestions: ["Does this fit kids?", "Is it waterproof?"],
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MainAgentShim", () => {
  it("renders pills + input without opening a SCRT2 session", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);

    expect(screen.getByRole("button", { name: "Does this fit kids?" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Is it waterproof?" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Ask a question" })).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("templates the product name into the input placeholder", () => {
    render(<MainAgentShim config={BASE_CONFIG} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" }) as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Ask me anything about Muddier Trucker");
  });

  it("falls back to the generic placeholder when no product name is set", () => {
    render(<MainAgentShim config={{ ...BASE_CONFIG, productName: undefined }} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" }) as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Ask me anything");
  });

  it("honors an explicit placeholder override from config", () => {
    render(
      <MainAgentShim
        config={{ ...BASE_CONFIG, placeholder: "What's on your mind?" }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Ask a question" }) as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("What's on your mind?");
  });

  it("dispatches a handoff event on the host element when a pill is clicked", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handler = vi.fn();
    host.addEventListener(HANDOFF_EVENT, handler as EventListener);

    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Does this fit kids?" }));

    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent<HandoffEventDetail>;
    expect(ev.type).toBe(HANDOFF_EVENT);
    expect(ev.bubbles).toBe(true);
    expect(ev.detail).toEqual({
      question: "Does this fit kids?",
      productName: "Muddier Trucker",
      source: "pill",
    });
  });

  it("dispatches a handoff event with source='input' on form submit", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handler = vi.fn();
    host.addEventListener(HANDOFF_EVENT, handler as EventListener);

    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" });
    fireEvent.change(textarea, { target: { value: "Does it ship to Canada?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(handler).toHaveBeenCalledTimes(1);
    const detail = (handler.mock.calls[0][0] as CustomEvent<HandoffEventDetail>).detail;
    expect(detail.question).toBe("Does it ship to Canada?");
    expect(detail.source).toBe("input");
  });

  it("submits on Enter without shift", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handler = vi.fn();
    host.addEventListener(HANDOFF_EVENT, handler as EventListener);

    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" });
    fireEvent.change(textarea, { target: { value: "Hello?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT submit on Shift+Enter", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handler = vi.fn();
    host.addEventListener(HANDOFF_EVENT, handler as EventListener);

    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" });
    fireEvent.change(textarea, { target: { value: "Hello?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores empty or whitespace-only submissions", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handler = vi.fn();
    host.addEventListener(HANDOFF_EVENT, handler as EventListener);

    render(<MainAgentShim config={BASE_CONFIG} hostElement={host} />);
    const textarea = screen.getByRole("textbox", { name: "Ask a question" });
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("renders no pills section when pdpQuestions is empty", () => {
    render(<MainAgentShim config={{ ...BASE_CONFIG, pdpQuestions: [] }} />);
    expect(screen.queryByRole("list", { name: "Suggested questions" })).toBeNull();
  });

  it("event bubbles out of the shadow root to a document-level listener", async () => {
    // Full UMD renderInto path — shim lives inside a shadow root; composed:true
    // + bubbles:true means the host app's document-level listener should still
    // see the event. This is the real-world storefront integration shape.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const handler = vi.fn();
    document.addEventListener(HANDOFF_EVENT, handler as EventListener);

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, BASE_CONFIG, host);
    });
    try {
      const pill = shadow.querySelector(".pill") as HTMLButtonElement | null;
      expect(pill).not.toBeNull();
      await act(async () => {
        pill!.click();
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const detail = (handler.mock.calls[0][0] as CustomEvent<HandoffEventDetail>).detail;
      expect(detail.question).toBe("Does this fit kids?");
      expect(detail.source).toBe("pill");
    } finally {
      handle?.unmount();
      document.removeEventListener(HANDOFF_EVENT, handler as EventListener);
    }
  });

  it("does NOT fetch anything when mounted via renderInto in main-agent mode", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(shadow, BASE_CONFIG, host);
    });
    try {
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      handle?.unmount();
    }
  });

  it("renderInto skips SCRT2 config validation in main-agent mode", async () => {
    // SCRT2 fields deliberately blank — the old guard would render a
    // "missing required config" error. With mode="main-agent" the shim
    // should render instead.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    let handle: ReturnType<typeof renderInto> | null = null;
    await act(async () => {
      handle = renderInto(
        shadow,
        { ...BASE_CONFIG, scrt2Url: "", orgId: "", esDeveloperName: "" },
        host,
      );
    });
    try {
      expect(shadow.querySelector(".iaw-config-error")).toBeNull();
      expect(shadow.querySelector(".widget-header-title")).not.toBeNull();
    } finally {
      handle?.unmount();
    }
  });
});
