import { createRoot, type Root } from "react-dom/client";
import styles from "./styles.css?inline";
import { App } from "./App";
import type { WidgetConfig } from "./provider/types";

export interface RenderHandle {
  /** Re-render with an updated config (e.g. after an attribute change). */
  update(config: WidgetConfig): void;
  /** Unmount React and clean up. */
  unmount(): void;
}

const REQUIRED_MESSAGE_SCRT2 =
  "inline-agent-widget: missing required config. " +
  "Provide scrt2-url, org-id, and es-developer-name.";

/**
 * Validate the connection config. Returns an error message to render, or null
 * when the required fields are present.
 */
function missingConfigMessage(config: WidgetConfig): string | null {
  const ok = config.scrt2Url && config.orgId && config.esDeveloperName;
  return ok ? null : REQUIRED_MESSAGE_SCRT2;
}

/**
 * Inject the widget stylesheet into a shadow root and mount the React app.
 * The stylesheet ships as an inlined string (styles.css?inline), so nothing is
 * ever added to document.head — the widget stays isolated inside its shadow
 * root.
 */
export function renderInto(shadowRoot: ShadowRoot, config: WidgetConfig): RenderHandle {
  const style = document.createElement("style");
  style.textContent = styles;
  shadowRoot.appendChild(style);

  const container = document.createElement("div");
  container.className = "iaw-root";
  shadowRoot.appendChild(container);

  const configError = missingConfigMessage(config);
  if (configError) {
    container.replaceChildren();
    const err = document.createElement("div");
    err.className = "iaw-config-error";
    err.textContent = configError;
    container.appendChild(err);
    // eslint-disable-next-line no-console
    console.warn(configError);
    return {
      update: () => {},
      unmount: () => {
        container.remove();
        style.remove();
      },
    };
  }

  const root: Root = createRoot(container);
  root.render(<App config={config} />);

  return {
    update(next: WidgetConfig) {
      root.render(<App config={next} />);
    },
    unmount() {
      root.unmount();
      container.remove();
      style.remove();
    },
  };
}
