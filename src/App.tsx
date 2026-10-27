import { useEffect, useRef } from "react";
import { WidgetProvider } from "./provider/WidgetProvider";
import { useWidget } from "./provider/context";
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
      <WidgetShell />
    </WidgetProvider>
  );
}

function WidgetShell() {
  const { prepareConnection } = useWidget();
  const rootRef = useRef<HTMLDivElement>(null);

  // Primary trigger: pre-warm the SCRT2 handshake when the widget scrolls into
  // view. Modality-agnostic (works for scrollers, screen readers, keyboard).
  // Fires once per mount; pointer/focus handlers on pills + InputBar accelerate
  // the escalation to conversation-create for interacting shoppers.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let fired = false;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || fired) continue;
          fired = true;
          prepareConnection();
          io.disconnect();
          return;
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [prepareConnection]);

  return (
    <div className="widget" ref={rootRef}>
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
      <QuestionPills />
    </div>
  );
}
