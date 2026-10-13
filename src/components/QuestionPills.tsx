import { useWidget } from "../provider/context";
import { MAX_PDP_QUESTIONS } from "../provider/pdp-questions";
import { RefreshIcon } from "./icons";

/**
 * Question pills rendered BELOW the Response (north-star layout:
 * InputBar → user bubble → answer → pills + refresh). Two sources, merged:
 *
 * 1. **Follow-up suggestions** (priority) — extracted from the agent's latest
 *    response. These fill the shelf first.
 *
 * 2. **Static PDP pills** (backfill) — sourced from the `pdp-questions`
 *    attribute. Fill remaining slots up to `MAX_PDP_QUESTIONS` when follow-ups
 *    alone don't reach the cap.
 *
 * Both sources are filtered by `askedQuestions` and `dismissedQuestions`, and
 * the total is capped at `MAX_PDP_QUESTIONS`. A circular refresh button
 * ("Show different questions") appears when there are more PDP pills available
 * beyond the current visible set. Clicking it dismisses the current pills and
 * backfills from the remaining pool.
 */
export function QuestionPills() {
  const { state, dispatch, sendMessage } = useWidget();

  const excluded = new Set([...state.askedQuestions, ...state.dismissedQuestions]);
  const followUps = state.followUpSuggestions.filter((q) => !excluded.has(q));

  const followUpSet = new Set(followUps);
  const availablePdp = state.pdpQuestions.filter((q) => !excluded.has(q) && !followUpSet.has(q));

  const visible = [...followUps, ...availablePdp].slice(0, MAX_PDP_QUESTIONS);
  if (visible.length === 0) return null;

  const busy = state.agentTyping || state.streamingText.length > 0;
  const disabled = !state.connectionReady || busy;

  // Show refresh when there are more PDP pills beyond what's currently visible.
  const totalAvailable = followUps.length + availablePdp.length;
  const hasMore = totalAvailable > visible.length;

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
      {hasMore && (
        <li className="pills-item">
          <button
            className="pill-refresh"
            type="button"
            disabled={disabled}
            aria-label="Show different questions"
            onClick={() => {
              dispatch({ type: "REFRESH_PILLS", currentlyVisible: visible });
            }}
          >
            <RefreshIcon />
          </button>
        </li>
      )}
    </ul>
  );
}
