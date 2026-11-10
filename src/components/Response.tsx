import { useWidget } from "../provider/context";
import { Markdown } from "./Markdown";
import { StatusMessages } from "./StatusMessages";

export function Response() {
  const { state } = useWidget();

  const showStreaming = state.streamingText.length > 0;
  const showStatus = state.agentTyping && !showStreaming && state.answer === null;
  const hasActivity =
    state.error || showStreaming || state.answer !== null || state.lastQuestion !== null || showStatus;

  if (!hasActivity) return null;

  return (
    <div className="slot">
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

      {showStatus && (
        <div className="answer">
          <StatusMessages />
        </div>
      )}

      {showStreaming && (
        <div className="answer" role="log" aria-live="polite" aria-busy="true">
          <Markdown text={state.streamingText} />
        </div>
      )}

      {!showStreaming && !state.error && !showStatus && state.answer !== null && (
        <div className="answer" role="log" aria-live="polite">
          <Markdown text={state.answer} />
        </div>
      )}
    </div>
  );
}
