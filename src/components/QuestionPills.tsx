import { useWidget } from "../provider/context";
import type { SuggestionItem } from "../provider/types";

/**
 * Open the storefront's main shopper-agent chat and send the question into it.
 *
 * Detection order matches the PWA Kit's `openShopperAgentWidget()`:
 *  1. Commerce Client (Cimulate) — open the panel via `toggleWidgetOpen`
 *  2. MIAW (Salesforce Embedded Messaging) — `launchChat` then `sendTextMessage`
 *
 * For MIAW, `sendTextMessage` requires the conversation to be open, so we
 * launch first, wait briefly for the conversation-opened event, then send.
 * For Cimulate, no public send-message API exists yet — the CustomEvent
 * carries the question so the host page can forward it when the SDK adds one.
 */

type AnyRecord = Record<string, unknown>;

const CIMULATE_INPUT_POLL_INTERVAL_MS = 200;
const CIMULATE_INPUT_POLL_MAX_ATTEMPTS = 15; // 3 seconds total

/**
 * Find the Cimulate widget's search input. The widget renders directly into the
 * document body (NOT inside #commerce-client-messaging-widget), so we search
 * the full document for its `.cim-widget-search-input`.
 */
function findCimulateInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("input.cim-widget-search-input");
}

/**
 * Set a React-controlled input's value in a way React actually sees.
 * React tracks value via an internal setter; plain `el.value = x` is
 * ignored. We call the native setter then dispatch an `input` event.
 */
function setNativeInputValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const nativeSetter =
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Poll for the Cimulate input to appear (the widget may still be rendering
 * after `toggleWidgetOpen`), then type the question and submit.
 */
function sendToCimulateInput(text: string): void {
  let attempts = 0;

  const tryInject = () => {
    attempts++;
    const input = findCimulateInput();

    if (input) {
      input.focus();
      setNativeInputValue(input, text);

      // Find and click the Cimulate send button, falling back to Enter.
      const sendBtn =
        document.querySelector<HTMLButtonElement>("button.cim-widget-search-button-icon") ??
        input.closest("form")?.querySelector<HTMLButtonElement>("button");

      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      }
      return;
    }

    if (attempts < CIMULATE_INPUT_POLL_MAX_ATTEMPTS) {
      setTimeout(tryInject, CIMULATE_INPUT_POLL_INTERVAL_MS);
    }
  };

  // Give the panel a moment to open before polling.
  setTimeout(tryInject, CIMULATE_INPUT_POLL_INTERVAL_MS);
}

function openAndSendToShopperAgent(text: string): boolean {
  if (typeof window === "undefined") return false;

  try {
    const w = window as AnyRecord;

    // Commerce Client (Cimulate widget) — open panel + inject question
    const cimulate = w.CimulateMessaging as AnyRecord | undefined;
    const components = (cimulate?.eventHandlers as AnyRecord)
      ?.components as AnyRecord | undefined;
    if (typeof components?.toggleWidgetOpen === "function") {
      (components.toggleWidgetOpen as (show: boolean) => void)(true);
      sendToCimulateInput(text);
      return true;
    }

    // MIAW (Salesforce Embedded Messaging) — open + send
    const bootstrap = w.embeddedservice_bootstrap as AnyRecord | undefined;
    const utilAPI = bootstrap?.utilAPI as AnyRecord | undefined;
    if (typeof utilAPI?.launchChat === "function") {
      const launch = utilAPI.launchChat as () => Promise<string>;
      const send = utilAPI.sendTextMessage as ((msg: string) => Promise<void>) | undefined;

      void launch().then(() => {
        if (typeof send === "function") {
          setTimeout(() => void send(text), 500);
        }
      }).catch(() => {
        if (typeof send === "function") {
          setTimeout(() => void send(text), 500);
        }
      });
      return true;
    }
  } catch {
    // Widget not available — the CustomEvent is the fallback.
  }

  return false;
}

/**
 * Hand off a `main_agent` question to the storefront's full shopper-agent chat.
 * Opens the chat panel and sends the question where possible (MIAW), then
 * emits a `iaw:main-agent-redirect` CustomEvent so the host page can also
 * react (e.g. forward to Cimulate when its send API is available).
 */
function emitMainAgentRedirect(text: string, hostElement?: HTMLElement | null) {
  openAndSendToShopperAgent(text);

  const target = hostElement ?? document;
  target.dispatchEvent(
    new CustomEvent("iaw:main-agent-redirect", {
      detail: { question: text },
      bubbles: true,
      composed: true,
    }),
  );
}

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

  const busy = state.agentTyping || state.streamingText.length > 0;
  const disabled = !state.connectionReady || busy;

  const hostElement =
    typeof document !== "undefined"
      ? document.querySelector("inline-agent-widget")
      : null;

  return (
    <ul className="pills" aria-label="Suggested questions">
      {pills.map((pill) => (
        <li key={pill.text} className="pills-item">
          <button
            className={`pill${pill.answerable_by === "main_agent" ? " pill--main-agent" : ""}`}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (pill.answerable_by === "main_agent") {
                emitMainAgentRedirect(pill.text, hostElement);
              } else {
                void sendMessage(pill.text);
              }
            }}
          >
            {pill.text}
          </button>
        </li>
      ))}
    </ul>
  );
}
