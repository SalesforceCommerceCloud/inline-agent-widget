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
const SESSION_READY_TIMEOUT_MS = 20_000; // 20 seconds max wait
const POST_WELCOME_DELAY_MS = 800;

function findCimulateInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("input.cim-widget-search-input");
}

/**
 * Check whether chat content (welcome message or prior messages) has been
 * rendered in the Cimulate widget. Looks for any `.commerce-client-shopper-agent`
 * element that contains meaningful text and isn't part of the search bar.
 */
function hasCimulateMessages(): boolean {
  const elements = document.querySelectorAll(".commerce-client-shopper-agent");
  for (const el of elements) {
    if (el.matches("input, form, button, svg, path")) continue;
    if (el.closest("form")) continue;
    if (el.textContent && el.textContent.trim().length > 10) return true;
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
 * Use a MutationObserver to watch for the welcome message to actually
 * appear in the DOM. Once we see it, wait a short delay for the welcome
 * flow to fully settle, then inject the question.
 *
 * On warm sessions (messages already present), injects immediately.
 */
function waitForSessionThenInject(text: string): void {
  if (hasCimulateMessages()) {
    injectAndSubmit(text);
    return;
  }

  const observer = new MutationObserver(() => {
    if (hasCimulateMessages()) {
      observer.disconnect();
      clearTimeout(timeout);
      setTimeout(() => injectAndSubmit(text), POST_WELCOME_DELAY_MS);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const timeout = setTimeout(() => {
    observer.disconnect();
    injectAndSubmit(text);
  }, SESSION_READY_TIMEOUT_MS);
}

/**
 * Poll for the Cimulate input to appear, then queue the question until
 * the session is fully established (welcome message rendered).
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
