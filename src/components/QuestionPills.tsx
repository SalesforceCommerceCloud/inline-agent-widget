import { useWidget } from "../provider/context";

/** Show follow-up suggestions after a question, or PDP pills before any question is asked. */
export function QuestionPills() {
  const { state, sendMessage, prepareConnection } = useWidget();

  const asked = new Set(state.askedQuestions);
  const hasAsked = state.askedQuestions.length > 0;

  const pills = hasAsked
    ? state.followUpSuggestions.filter((q) => !asked.has(q))
    : state.pdpQuestions.filter((q) => !asked.has(q));

  if (pills.length === 0) return null;

  const busy = state.agentTyping || state.streamingText.length > 0;
  const disabled = !state.connectionReady || busy;

  return (
    <ul className="pills" aria-label="Suggested questions">
      {pills.map((q) => (
        <li key={q} className="pills-item">
          <button
            className="pill"
            type="button"
            disabled={disabled}
            onPointerDown={prepareConnection}
            onFocus={prepareConnection}
            onTouchStart={prepareConnection}
            onClick={() => {
              void sendMessage(q);
            }}
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}
