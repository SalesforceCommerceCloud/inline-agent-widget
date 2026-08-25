import { useState, type ChangeEvent, type FormEvent } from "react";
import { useWidget } from "../provider/context";

export function InputBar() {
  const { sendMessage, prepareConnection, config } = useWidget();
  const [text, setText] = useState("");

  // Warm up the connection as soon as the user starts typing, so the token/SSE/
  // conversation handshake runs behind their typing time. prepareConnection is
  // idempotent and non-blocking, so calling it on every change is fine — it only
  // does work on the first call.
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    if (e.target.value.length > 0) prepareConnection();
  };

  // The input is never disabled for connection state. If the handshake hasn't
  // finished yet, sendMessage queues the message onto the in-flight attempt and
  // fires it once ready — so the user is never blocked from typing or sending.
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length === 0) return;
    // Fire-and-forget: clear the field optimistically. sendMessage handles the
    // queue/handshake and dispatches any error itself.
    void sendMessage(text);
    setText("");
  };

  return (
    <form className="input-bar" onSubmit={onSubmit}>
      <input
        className="input"
        type="text"
        value={text}
        onChange={onChange}
        placeholder={config.placeholder ?? "Type a message…"}
        aria-label="Message input"
      />
      <button
        className="send"
        type="submit"
        disabled={text.trim().length === 0}
        aria-label="Send message"
      >
        Send
      </button>
    </form>
  );
}
