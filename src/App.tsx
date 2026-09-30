import { WidgetProvider } from "./provider/WidgetProvider";
import { InputBar } from "./components/InputBar";
import { Response } from "./components/Response";
import { SparkleIcon } from "./components/icons";
import type { WidgetConfig } from "./provider/types";

export function App({
  config,
  hostElement,
  conversationIdRef,
}: {
  config: WidgetConfig;
  hostElement?: HTMLElement;
  conversationIdRef?: { current: string | null };
}) {
  return (
    <WidgetProvider config={config} hostElement={hostElement} conversationIdRef={conversationIdRef}>
      <div className="widget">
        <header className="widget-header">
          <div className="widget-header-brand">
            <span className="header-icon-wrap">
              <SparkleIcon />
            </span>
            <h2 className="widget-header-title">Ask Assistant</h2>
          </div>
          <span className="widget-badge">New</span>
        </header>
        <InputBar />
        <Response />
      </div>
    </WidgetProvider>
  );
}
