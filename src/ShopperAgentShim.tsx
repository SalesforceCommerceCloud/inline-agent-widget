import {
  useState,
  useRef,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SparkleIcon, SendIcon } from "./components/icons";
import type { WidgetConfig } from "./provider/types";

export const HANDOFF_EVENT = "inline-agent-widget:handoff";

export interface HandoffEventDetail {
  question: string;
  productName?: string;
  source: "pill" | "input";
}

/**
 * Non-conversational shim used in `mode="shopper-agent"`. Paints the same
 * header + pills + input as the inline widget, but every pill click or form
 * submit dispatches a bubbling `inline-agent-widget:handoff` CustomEvent on
 * the host element instead of talking to SCRT2. The host storefront catches
 * the event and opens its main Shopper Agent drawer with the question seeded.
 */
export function ShopperAgentShim({
  config,
  hostElement,
}: {
  config: WidgetConfig;
  hostElement?: HTMLElement;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pills = config.pdpQuestions ?? [];

  const dispatchHandoff = (question: string, source: "pill" | "input") => {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    const target: EventTarget = hostElement ?? window;
    const detail: HandoffEventDetail = {
      question: trimmed,
      productName: config.productName,
      source,
    };
    target.dispatchEvent(
      new CustomEvent<HandoffEventDetail>(HANDOFF_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length === 0) return;
    dispatchHandoff(text, "input");
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    if (text.trim().length === 0) return;
    dispatchHandoff(text, "input");
    setText("");
  };

  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [text]);

  const placeholder =
    config.placeholder ??
    (config.productName
      ? `Ask me anything about ${config.productName}`
      : "Ask me anything");

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

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask a question"
        />
        <button
          className="composer-send"
          type="submit"
          disabled={text.trim().length === 0}
          aria-label="Send question"
        >
          <SendIcon />
        </button>
      </form>

      {pills.length > 0 ? (
        <ul className="pills" aria-label="Suggested questions">
          {pills.map((q) => (
            <li key={q} className="pills-item">
              <button
                className="pill"
                type="button"
                onClick={() => dispatchHandoff(q, "pill")}
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
