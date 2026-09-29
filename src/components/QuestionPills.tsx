import { useWidget } from "../provider/context";

/**
 * Opener question pills rendered above the input. Sourced from the
 * `pdp-questions` attribute (parsed once in custom-element.ts). Tapping a pill
 * routes through the same `sendMessage` path as typed input — product-context
 * marker, readiness gate, and welcome-suppression all apply uniformly.
 *
 * Hidden once the shopper has asked (or the widget is showing an error). On
 * SPA-navigation between PDPs the reducer's `RESET_CONVERSATION` clears
 * `lastQuestion`/`answer`, so the pills naturally re-appear for the new
 * product's list (which the host swaps in via `pdp-questions`).
 */
export function QuestionPills() {
  const { state, sendMessage, prepareConnection } = useWidget();

  const hasEngaged =
    state.lastQuestion !== null ||
    state.answer !== null ||
    state.streamingText.length > 0 ||
    state.agentTyping ||
    state.error !== null;

  if (hasEngaged || state.pdpQuestions.length === 0) return null;

  const disabled = !state.connectionReady;

  return (
    <ul className="pills" aria-label="Suggested questions">
      {state.pdpQuestions.map((q) => (
        <li key={q} className="pills-item">
          <button
            className="pill"
            type="button"
            disabled={disabled}
            onClick={() => {
              void sendMessage(q);
            }}
            // Warm the SCRT2 handshake behind the user's hover intent — same
            // rationale as InputBar's first-keystroke prepareConnection.
            onMouseEnter={prepareConnection}
            onFocus={prepareConnection}
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}
