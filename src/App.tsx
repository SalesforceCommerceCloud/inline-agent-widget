import { WidgetProvider } from "./provider/WidgetProvider";
import { InputBar } from "./components/InputBar";
import { QuestionPills } from "./components/QuestionPills";
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
        {/* North-star layout: InputBar first, then the answer surface
            (user bubble + agent answer), then the pill shelf below the
            answer. The pill shelf drains as the shopper asks questions
            (QuestionPills filters askedQuestions); when exhausted, the
            InputBar carries the shopper forward until Shilpi's follow-up
            pills replace the shelf. */}
        <InputBar />
        <Response />
        <QuestionPills />
      </div>
    </WidgetProvider>
  );
}
