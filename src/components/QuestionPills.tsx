import { useWidget } from "../provider/context";
import { HANDOFF_EVENT, type HandoffEventDetail } from "../ShopperAgentShim";
import type { SuggestionItem } from "../provider/types";

/** Show follow-up suggestions after a question, or PDP pills before any question is asked. */
export function QuestionPills() {
  const { state, sendMessage, config } = useWidget();

  const asked = new Set(state.askedQuestions);
  const hasAsked = state.askedQuestions.length > 0;

  const pills: SuggestionItem[] = hasAsked
    ? state.followUpSuggestions.filter((q) => !asked.has(q.text))
    : state.pdpQuestions
        .filter((q) => !asked.has(q))
        .map((q) => ({ text: q }));

  if (pills.length === 0) return null;

  const disabled = state.agentTyping || state.streamingText.length > 0;
  const isHybrid = config.mode === "hybrid";

  const hostElement =
    isHybrid && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>("inline-agent-widget")
      : null;

  const dispatchHandoff = (question: string) => {
    const target: EventTarget = hostElement ?? window;
    const detail: HandoffEventDetail = {
      question,
      productName: config.productName,
      source: "pill",
    };
    target.dispatchEvent(
      new CustomEvent<HandoffEventDetail>(HANDOFF_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  };

  return (
    <ul className="pills" aria-label="Suggested questions">
      {pills.map((pill) => {
        const isMainAgent = isHybrid && pill.answerable_by === "shopper-agent";
        return (
          <li key={pill.text} className="pills-item">
            <button
              className={`pill${isMainAgent ? " pill--main-agent" : ""}`}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (isMainAgent) {
                  dispatchHandoff(pill.text);
                } else {
                  void sendMessage(pill.text);
                }
              }}
            >
              {pill.text}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
