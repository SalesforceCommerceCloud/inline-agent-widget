import { useWidget } from "../provider/context";
import { MAX_PDP_QUESTIONS } from "../provider/pdp-questions";
import { RefreshIcon } from "./icons";

/** Follow-up suggestions (priority) + PDP pills (backfill), capped at MAX_PDP_QUESTIONS.
 * Refresh button cycles through the pool; wraps back to the start when exhausted. */
export function QuestionPills() {
  const { state, dispatch, sendMessage } = useWidget();

  const asked = new Set(state.askedQuestions);
  const dismissed = new Set(state.dismissedQuestions);

  const followUps = state.followUpSuggestions.filter((q) => !asked.has(q) && !dismissed.has(q));
  const followUpSet = new Set(followUps);
  const availablePdp = state.pdpQuestions.filter(
    (q) => !asked.has(q) && !dismissed.has(q) && !followUpSet.has(q),
  );

  const visible = [...followUps, ...availablePdp].slice(0, MAX_PDP_QUESTIONS);
  if (visible.length === 0) return null;

  const busy = state.agentTyping || state.streamingText.length > 0;
  const disabled = !state.connectionReady || busy;

  const fullPool = [
    ...state.followUpSuggestions.filter((q) => !asked.has(q)),
    ...state.pdpQuestions.filter(
      (q) => !asked.has(q) && !new Set(state.followUpSuggestions).has(q),
    ),
  ];
  const showRefresh = state.askedQuestions.length > 0 && fullPool.length > MAX_PDP_QUESTIONS;

  const handleRefresh = () => {
    const totalAvailable = followUps.length + availablePdp.length;
    if (totalAvailable <= visible.length) {
      dispatch({ type: "REFRESH_PILLS", currentlyVisible: [] });
    } else {
      dispatch({ type: "REFRESH_PILLS", currentlyVisible: visible });
    }
  };

  return (
    <ul className="pills" aria-label="Suggested questions">
      {visible.map((q) => (
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
      {showRefresh && (
        <li className="pills-item">
          <button
            className="pill-refresh"
            type="button"
            disabled={disabled}
            aria-label="Show different questions"
            onClick={handleRefresh}
          >
            <RefreshIcon />
          </button>
        </li>
      )}
    </ul>
  );
}
