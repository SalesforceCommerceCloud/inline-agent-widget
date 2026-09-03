import { useEffect } from "react";
import { WidgetProvider } from "./provider/WidgetProvider";
import { InputBar } from "./components/InputBar";
import { Response } from "./components/Response";
import { SparkleIcon } from "./components/icons";
import { useWidget } from "./provider/context";
import type { WidgetConfig } from "./provider/types";

function WidgetContent() {
  const { prepareConnection } = useWidget();

  useEffect(() => {
    prepareConnection();
  }, [prepareConnection]);

  return (
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
  );
}

export function App({ config }: { config: WidgetConfig }) {
  return (
    <WidgetProvider config={config}>
      <WidgetContent />
    </WidgetProvider>
  );
}
