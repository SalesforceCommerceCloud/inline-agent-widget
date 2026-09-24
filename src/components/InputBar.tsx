import {
  useState,
  useRef,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useWidget } from "../provider/context";
import { SendIcon } from "./icons";

export function InputBar() {
  const { sendMessage, prepareConnection, config, state } = useWidget();
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = state.agentTyping || state.streamingText.length > 0;
  const notReady = !state.connectionReady;

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    if (e.target.value.length > 0) prepareConnection();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length === 0 || busy || notReady) return;
    void sendMessage(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (busy || notReady) return;
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
        disabled={text.trim().length === 0 || busy || notReady}
        aria-label="Send question"
      >
        <SendIcon />
      </button>
    </form>
  );
}
