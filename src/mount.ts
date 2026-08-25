import { renderInto } from "./render";
import type { WidgetConfig } from "./provider/types";

export interface MountOptions extends WidgetConfig {
  /** The host element to render into. Takes precedence over `elementId`. */
  element?: HTMLElement;
  /** The id of the host element to render into. */
  elementId?: string;
  /**
   * How long (ms) to wait for `elementId` to appear in the DOM before giving
   * up, when the element isn't present at call time. Default: 5000.
   */
  timeout?: number;
}

export interface MountHandle {
  /** Unmount the widget and remove its shadow content. */
  unmount(): void;
}

/**
 * Imperatively mount the widget into a host element. Renders inside an open
 * shadow root on that element for style isolation.
 *
 * If `elementId` is given but not yet in the DOM, a MutationObserver waits for
 * it (up to `timeout` ms).
 */
export function mount(options: MountOptions): MountHandle {
  const { element, elementId, timeout = 5000, ...config } = options;

  let unmounted = false;
  let cleanup: (() => void) | null = null;

  const renderToHost = (host: HTMLElement) => {
    if (unmounted) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const handle = renderInto(shadow, config);
    cleanup = () => handle.unmount();
  };

  const target = element ?? (elementId ? document.getElementById(elementId) : null);

  if (target) {
    renderToHost(target);
  } else if (elementId) {
    const observer = new MutationObserver(() => {
      const found = document.getElementById(elementId);
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        renderToHost(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      observer.disconnect();
      // eslint-disable-next-line no-console
      console.warn(
        `inline-agent-widget: element #${elementId} not found within ${timeout}ms.`,
      );
    }, timeout);

    cleanup = () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  } else {
    // eslint-disable-next-line no-console
    console.warn("inline-agent-widget: mount() requires `element` or `elementId`.");
  }

  return {
    unmount() {
      unmounted = true;
      cleanup?.();
      cleanup = null;
    },
  };
}
