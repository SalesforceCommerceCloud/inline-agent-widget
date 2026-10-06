/**
 * Welcome-tracker: pure classifier for incoming Agentforce events.
 *
 * Agentforce auto-emits a "welcome" greeting the instant a conversation is
 * created, before the shopper has sent anything. The widget drops that
 * greeting so an idle PDP never shows unsolicited bot text. The subtle part
 * is that this greeting can arrive in several timing windows relative to
 * the shopper's first POST, and misidentifying it leads to one of two
 * visible bugs:
 *
 *   A) The welcome renders as if it were the answer (welcome leaks).
 *   B) The real answer is dropped as if it were the welcome (answer
 *      swallowed, "first-click never answers").
 *
 * This module answers one question — "what should I do with this message
 * event / streaming token?" — given only pure booleans. All the stateful
 * ref juggling (gate open/close, timeouts) stays in WidgetProvider; this
 * is behavior under test.
 *
 * See WidgetProvider.tsx for the ref wiring and `welcome-gate.ts` for the
 * send-side guard (which holds the user POST until the welcome has
 * resolved — a separate concern from classifying inbound events).
 */

/**
 * Who sent the message. `end-user` is the EndUser echo Agentforce sends
 * back for the user's own POST; `chatbot` is everything else (Agent,
 * Supervisor, Chatbot — any non-EndUser role).
 */
export type SenderKind = "chatbot" | "end-user";

/**
 * The two durable booleans the classifier reads. Both start false; both
 * live as refs in WidgetProvider so handlers see the latest without being
 * re-registered on each render.
 */
export interface TrackerContext {
  /**
   * True once the shopper has successfully sent their first message AND
   * the SDK's sendMessage() has resolved. Flipped by WidgetProvider after
   * `await client.sendMessage(...)` returns. Pre-send, every Chatbot
   * message is the welcome by construction (nothing else can be there).
   */
  hasUserSent: boolean;
  /**
   * True once ANY Chatbot message has been seen and dropped as "the
   * welcome". Durable — outlives the send-side gate's 5s timeout so a
   * late-arriving welcome (slow agent) is still correctly identified.
   */
  welcomeDropped: boolean;
  /**
   * Whether the send-side welcome gate is still pending. Used only to
   * tell callers "you also need to close the gate / enable send here"
   * when consuming the welcome in the pre-send branch. Classifier itself
   * does NOT change its verdict based on this — any Chatbot message
   * pre-send is the welcome regardless of gate state (the gate may have
   * timed out before the welcome landed).
   */
  gatePending: boolean;
}

/**
 * Verdict for a single `message` SSE event.
 *
 * - `drop-welcome` — the message is Agentforce's auto-greeting. Caller
 *   must flip `welcomeDropped` to true and, if `wasPending` is true, also
 *   close the send-side gate + clear its timeout + enable the send button
 *   (the welcome arrived during the gate's window, which is the signal
 *   the handshake completed successfully).
 * - `render-answer` — a Chatbot message after the welcome has been
 *   consumed and the shopper has engaged. Caller dispatches SET_ANSWER.
 * - `ignore` — EndUser echo (pre- or post-send) or any other state we
 *   deliberately don't render.
 */
export type MessageVerdict =
  | { action: "drop-welcome"; wasPending: boolean }
  | { action: "render-answer" }
  | { action: "ignore" };

/**
 * Classify a `message` SSE event. Pure function — same inputs always
 * produce the same output.
 */
export function classifyMessage(
  sender: SenderKind,
  ctx: TrackerContext,
): MessageVerdict {
  const isChatbot = sender === "chatbot";

  if (!ctx.hasUserSent) {
    // Pre-send: ANY Chatbot message is the welcome (the shopper hasn't
    // engaged yet, so nothing else can be here). Must flip welcomeDropped
    // regardless of gate state — the gate may have already timed out, in
    // which case we still need to mark the welcome consumed so a later
    // post-send branch doesn't mistake the real answer for the welcome.
    if (isChatbot) return { action: "drop-welcome", wasPending: ctx.gatePending };
    // Pre-send EndUser echo (shouldn't happen; defensive): ignore.
    return { action: "ignore" };
  }

  // Post-send.
  if (isChatbot && !ctx.welcomeDropped) {
    // Slow-agent window: welcome didn't arrive before the gate timeout
    // closed and the shopper POSTed; it's landing now, after the POST.
    // Drop it. wasPending is false here — if the gate were still pending
    // we'd be in the pre-send branch above (hasUserSent is only flipped
    // after sendMessage() resolves, which it can't have before the gate
    // timed out).
    return { action: "drop-welcome", wasPending: false };
  }
  if (isChatbot) return { action: "render-answer" };
  // EndUser echo post-send: nothing to render; the user bubble was
  // already shown optimistically by ASK_QUESTION.
  return { action: "ignore" };
}

/**
 * Whether an `APPEND_STREAMING_TOKEN` dispatch is safe for the current
 * context. Mirrors the message classifier: tokens before the user has
 * engaged belong to the welcome stream; tokens after the user has engaged
 * but before any welcome `message` has been consumed STILL belong to the
 * welcome stream (slow agent streaming the welcome text while the user
 * POST races ahead). Only tokens post-send + post-welcome are real
 * answer tokens.
 */
export function shouldAppendStreamingToken(
  ctx: Pick<TrackerContext, "hasUserSent" | "welcomeDropped">,
): boolean {
  return ctx.hasUserSent && ctx.welcomeDropped;
}
