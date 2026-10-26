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

const INPUT_POLL_INTERVAL_MS = 200;
const INPUT_POLL_MAX_ATTEMPTS = 15; // 3 seconds
const SESSION_READY_TIMEOUT_MS = 25_000;
const DOM_QUIET_PERIOD_MS = 1500;

function findCimulateInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("input.cim-widget-search-input");
}

/**
 * Check whether actual chat message content exists in the Cimulate widget.
 * Uses > 100 chars to match real messages (welcome message, prior chat) and
 * avoid false positives on widget chrome (titles, labels, tooltips are short).
 */
function hasChatContent(): boolean {
  const elements = document.querySelectorAll(".commerce-client-shopper-agent");
  for (const el of elements) {
    if (el.matches("input, form, button, svg, path")) continue;
    if (el.closest("form")) continue;
    const text = el.textContent?.trim() ?? "";
    if (text.length > 100) return true;
  }
  return false;
}

function injectAndSubmit(text: string): void {
  const input = findCimulateInput();
  if (!input) return;

  input.focus();
  input.select();

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    const nativeSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  setTimeout(() => {
    const sendBtn =
      document.querySelector<HTMLButtonElement>("button.cim-widget-search-button-icon") ??
      input.closest("form")?.querySelector<HTMLButtonElement>("button");

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return;
    }

    const form = input.closest("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return;
    }

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
    );
  }, 150);
}

/**
 * Wait for the Cimulate session to be fully ready before injecting.
 *
 * On cold start the widget goes through: open → session handshake → routing →
 * bot joins → typing indicator → welcome message → typing stops. If we inject
 * before this completes, the message is silently dropped.
 *
 * Strategy:
 *  - Warm session (chat content already present): inject immediately.
 *  - Cold start: MutationObserver watches for chat content (> 100 chars, to
 *    avoid false-positives on widget chrome). Once the welcome message appears,
 *    we wait for the DOM to go quiet (no mutations for DOM_QUIET_PERIOD_MS) so
 *    the full welcome flow settles (typing indicator removed, suggestions
 *    rendered, etc.), then inject.
 */
function waitForSessionThenInject(text: string): void {
  if (hasChatContent()) {
    injectAndSubmit(text);
    return;
  }

  let quietTimer: ReturnType<typeof setTimeout>;
  let contentSeen = false;

  const finish = () => {
    observer.disconnect();
    clearTimeout(hardTimeout);
    clearTimeout(quietTimer);
    injectAndSubmit(text);
  };

  const observer = new MutationObserver(() => {
    if (!contentSeen) {
      contentSeen = hasChatContent();
    }
    if (contentSeen) {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, DOM_QUIET_PERIOD_MS);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const hardTimeout = setTimeout(finish, SESSION_READY_TIMEOUT_MS);
}

/**
 * Poll for the Cimulate input to appear, then queue the question until
 * the session is fully established (welcome message rendered + DOM stable).
 */
function sendToCimulateInput(text: string): void {
  let attempts = 0;

  const tryFind = () => {
    attempts++;
    if (findCimulateInput()) {
      waitForSessionThenInject(text);
      return;
    }
    if (attempts < INPUT_POLL_MAX_ATTEMPTS) {
      setTimeout(tryFind, INPUT_POLL_INTERVAL_MS);
    }
  };

  setTimeout(tryFind, INPUT_POLL_INTERVAL_MS);
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
