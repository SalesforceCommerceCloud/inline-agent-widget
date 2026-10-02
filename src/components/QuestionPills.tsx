import { useWidget } from "../provider/context";

/**
 * Opener question pills rendered above the input. Sourced from the
 * `pdp-questions` attribute (parsed once in custom-element.ts). Tapping a pill
 * routes through the same `sendMessage` path as typed input: product-context
 * marker, readiness gate, and welcome-suppression all apply uniformly.
 *
 * Lazy-connect contract: we do NOT warm the SCRT2 handshake on hover or focus.
 * The org/realm has a bounded concurrent SCRT2 session cap (~11k), and the
 * floating messaging widget already consumes one session per engaged shopper
 * independently of this widget. A passing cursor over a pill is a bystander
 * signal, not shopper intent, so warming on hover would spin up sessions that
 * sit unused. Instead, we rely on `sendMessage`'s own `ensureConnected` guard:
 * the first click does the handshake inline (~1-2s cold), identical to the
 * send button on a cold InputBar. `disabled={!state.connectionReady}` keeps
 * subsequent clicks gated until the handshake lands.
 *
 * Hidden once the shopper has asked (or the widget is showing an error). On
 * SPA-navigation between PDPs the reducer's `RESET_CONVERSATION` clears
 * `lastQuestion`/`answer`, so the pills naturally re-appear for the new
 * product's list (which the host swaps in via `pdp-questions`).
 */
export function QuestionPills() {
  const { state, sendMessage } = useWidget();

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
          >
            {q}
          </button>
        </li>
      ))}
    </ul>
  );
}
