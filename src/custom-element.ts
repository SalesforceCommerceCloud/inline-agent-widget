import { renderInto, type RenderHandle } from "./render";
import type { WidgetConfig } from "./provider/types";

const TAG_NAME = "inline-agent-widget";

const OBSERVED = [
  "scrt2-url",
  "org-id",
  "es-developer-name",
  "capabilities-version",
  "placeholder",
  "enable-logging",
  "persist-session",
] as const;

function readConfig(el: HTMLElement): WidgetConfig {
  const attr = (name: string) => el.getAttribute(name)?.trim() || undefined;
  return {
    scrt2Url: attr("scrt2-url") ?? "",
    orgId: attr("org-id") ?? "",
    esDeveloperName: attr("es-developer-name") ?? "",
    capabilitiesVersion: attr("capabilities-version"),
    placeholder: attr("placeholder"),
    enableLogging: el.hasAttribute("enable-logging"),
    persistSession: el.hasAttribute("persist-session"),
  };
}

/**
 * <inline-agent-widget> custom element. Renders the chat UI inside an open
 * shadow root so host-page CSS can't bleed in and the widget's CSS can't leak
 * out. Connection config is read from attributes.
 */
export class InlineAgentWidgetElement extends HTMLElement {
  static get observedAttributes(): readonly string[] {
    return OBSERVED;
  }

  private handle: RenderHandle | null = null;

  connectedCallback(): void {
    if (this.handle) return; // guard against double-mount

    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    this.handle = renderInto(shadow, readConfig(this));
  }

  attributeChangedCallback(): void {
    // Ignore changes until connected (and thus rendered once).
    if (!this.handle) return;
    this.handle.update(readConfig(this));
  }

  disconnectedCallback(): void {
    this.handle?.unmount();
    this.handle = null;
  }
}

/**
 * Register the <inline-agent-widget> custom element. Safe to call multiple
 * times — a duplicate registration is ignored.
 */
export function defineElement(tagName: string = TAG_NAME): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tagName)) return;
  customElements.define(tagName, InlineAgentWidgetElement);
}
