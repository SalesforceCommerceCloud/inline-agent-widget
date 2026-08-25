import { WidgetProvider } from "./provider/WidgetProvider";
import { InputBar } from "./components/InputBar";
import { Response } from "./components/Response";
import type { WidgetConfig } from "./provider/types";

export function App({ config }: { config: WidgetConfig }) {
  return (
    <WidgetProvider config={config}>
      <div className="widget">
        <InputBar />
        <Response />
      </div>
    </WidgetProvider>
  );
}
