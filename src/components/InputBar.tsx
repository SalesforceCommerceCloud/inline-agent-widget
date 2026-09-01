import {
  useState,
  useRef,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useWidget } from "../provider/context";

function SendIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

export function InputBar() {
  const { sendMessage, prepareConnection, config, state } = useWidget();
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = state.agentTyping || state.streamingText.length > 0;

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (e.target.value.length > 0) prepareConnection();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length === 0 || busy) return;
    void sendMessage(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (busy) return;
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    if (text.trim().length === 0) return;
    void sendMessage(text);
    setText("");
  };

  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [text]);

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={text}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={config.placeholder ?? "Ask me anything"}
        aria-label="Ask a question"
        disabled={busy}
      />
      <button
        className="composer-send"
        type="submit"
        disabled={text.trim().length === 0 || busy}
        aria-label="Send question"
      >
        <SendIcon />
      </button>
    </form>
  );
}
