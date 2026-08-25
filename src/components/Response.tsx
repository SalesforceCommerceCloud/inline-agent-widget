import { useWidget } from "../provider/context";
import { Markdown } from "./Markdown";

/**
 * The response region — shown below the input. It displays the agent's answer
 * to the most recent question: a live streamed preview while the reply is in
 * flight, then the final answer. Asking a new question clears it (see the
 * ASK_QUESTION reducer case), so only the current exchange is ever visible.
 */
export function Response() {
  const { state } = useWidget();

  const showStreaming = state.streamingText.length > 0;
  // Only show typing dots before any tokens have streamed in.
  const showTyping = state.agentTyping && !showStreaming;

  if (state.error) {
    return (
      <div className="response" role="status">
        <div className="error">{state.error}</div>
      </div>
    );
  }

  if (showTyping) {
    return (
      <div className="response" role="status" aria-busy="true">
        <div className="typing" aria-label="Agent is thinking">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    );
  }

  if (showStreaming) {
    return (
      <div className="response" role="log" aria-live="polite" aria-busy="true">
        <Markdown text={state.streamingText} />
      </div>
    );
  }

  if (state.answer !== null) {
    return (
      <div className="response" role="log" aria-live="polite">
        <Markdown text={state.answer} />
      </div>
    );
  }

  // Idle: no question asked yet (or answer cleared). Render nothing.
  return null;
}
