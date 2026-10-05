import { useWidget } from "../provider/context";
import { Markdown } from "./Markdown";

export function Response() {
  const { state } = useWidget();

  const showStreaming = state.streamingText.length > 0;
  const showTyping = state.agentTyping && !showStreaming;
  const hasActivity =
    state.error || showTyping || showStreaming || state.answer !== null || state.lastQuestion !== null;

  if (!hasActivity) return null;

  return (
    <div className="slot">
      {/* Right-aligned chat-bubble echo of the shopper's question. Rendered
          for ALL sends (pill or typed) — the bubble is the north-star
          acknowledgement surface and replaces pill highlighting. See the
          Shiseido-Sandbox northstar design: dark pill-shaped bubble above
          the answer card. */}
      {state.lastQuestion !== null && (
        <div className="user-bubble-row">
          <div className="user-bubble">{state.lastQuestion}</div>
        </div>
      )}

      {state.error && (
        <div className="answer" role="status">
          <p className="error">{state.error}</p>
        </div>
      )}

      {showTyping && (
        <div className="answer" role="status" aria-busy="true">
          <div className="typing" aria-label="Agent is thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        </div>
      )}

      {showStreaming && (
        <div className="answer" role="log" aria-live="polite" aria-busy="true">
          <Markdown text={state.streamingText} />
        </div>
      )}

      {!showTyping && !showStreaming && !state.error && state.answer !== null && (
        <div className="answer" role="log" aria-live="polite">
          <Markdown text={state.answer} />
        </div>
      )}
    </div>
  );
}
