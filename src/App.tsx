import { useCallback, useEffect, useRef } from "react";
import { WidgetProvider } from "./provider/WidgetProvider";
import { InputBar } from "./components/InputBar";
import { QuestionPills } from "./components/QuestionPills";
import { Response } from "./components/Response";
import { SparkleIcon } from "./components/icons";
import { useWidget } from "./provider/context";
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
  const { warmUp, config } = useWidget();
  const widgetRef = useRef<HTMLDivElement>(null);
  const warmedRef = useRef(false);

  const triggerWarmUp = useCallback(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    warmUp();
  }, [warmUp]);

  const preWarm = config.preWarm ?? "off";

  // Viewport trigger: IntersectionObserver at 50% threshold.
  useEffect(() => {
    if (preWarm !== "viewport" && preWarm !== "hover") return;
    const el = widgetRef.current;
    if (!el || warmedRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          triggerWarmUp();
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [preWarm, triggerWarmUp]);

  // Hover trigger: pointerenter on the widget container (desktop only).
  useEffect(() => {
    if (preWarm !== "hover") return;
    const el = widgetRef.current;
    if (!el || warmedRef.current) return;
    const handler = () => triggerWarmUp();
    el.addEventListener("pointerenter", handler, { once: true });
    return () => el.removeEventListener("pointerenter", handler);
  }, [preWarm, triggerWarmUp]);

  return (
    <div className="widget" ref={widgetRef}>
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
