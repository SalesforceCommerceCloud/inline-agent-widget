/**
 * Welcome-tracker: position-based classifier for Chatbot SSE entries.
 *
 * Agentforce auto-emits a "welcome" greeting the instant a conversation is
 * created, before the shopper has sent anything. We drop that greeting so
 * an idle PDP never shows unsolicited bot text. The hard part is telling
 * it apart from the real answer when both can arrive in any order.
 *
 * The earlier timing-based classifier (hasUserSent + welcomeDropped +
 * 5s gate) failed on answer-before-welcome: when the handshake took >5s
 * the gate timed out, hasUserSent flipped on sendMessage() resolve, and
 * if the real answer arrived before the welcome it got labelled "late
 * welcome" and dropped — while the actual welcome then rendered as the
 * answer. That's the bug the screenshot captured.
 *
 * This classifier uses a different signal: the EndUser echo's server
 * `transcriptedTimestamp`. SCRT2 emits an EndUser CONVERSATION_MESSAGE
 * for every accepted POST; its server timestamp is a cutoff all other
 * entries can be compared against. Welcome's ts is from conversation-
 * create (before the echo). Answer's ts is from after the POST (after
 * the echo). Server-generated, so no clock skew.
 *
 * Entries that arrive BEFORE the echo cutoff must be buffered — we don't
 * yet know the cutoff. On echo arrival the buffer drains and classifies
 * by timestamp.
 */

/** The two timestamps the classifier needs. Both are server-emitted
 *  ISO-8601 strings; string comparison is correct for ISO-8601 UTC. */
export interface TrackerContext {
  /** The EndUser echo's transcriptedTimestamp, once observed. Null until
   *  SCRT2 echoes the user's POST. All Chatbot entries arriving before
   *  this is set are buffered by the caller. */
  echoTimestamp: string | null;
}

/**
 * Verdict for a Chatbot CONVERSATION_MESSAGE.
 *
 * - `drop-welcome` — entry is at or before the echo cutoff → pre-POST
 *   greeting. Caller must not render it.
 * - `render-answer` — entry is strictly after the echo cutoff → shopper's
 *   answer. Caller dispatches SET_ANSWER.
 * - `buffer` — echo cutoff not yet known. Caller stashes the entry and
 *   replays it through the classifier once echoTimestamp is set.
 */
export type MessageVerdict =
  | { action: "drop-welcome" }
  | { action: "render-answer" }
  | { action: "buffer" };

/**
 * Classify a Chatbot `message` SSE event. Pure function.
 *
 * @param messageTimestamp - The entry's server `transcriptedTimestamp`.
 * @param ctx - Current echo cutoff (null until the EndUser echo lands).
 */
export function classifyMessage(
  messageTimestamp: string,
  ctx: TrackerContext,
): MessageVerdict {
  if (ctx.echoTimestamp === null) return { action: "buffer" };
  // ISO-8601 UTC strings sort lexicographically. Welcome's server-ts is
  // from conversation-create (<= echo); answer's ts is strictly after.
  if (messageTimestamp <= ctx.echoTimestamp) return { action: "drop-welcome" };
  return { action: "render-answer" };
}

/**
 * Whether a streaming token should be appended. Same signal: tokens that
 * stream in before the echo cutoff belong to the welcome; tokens after
 * belong to the answer. Streaming tokens lack their own server-ts, so
 * we proxy via the EndUser echo being observed: once the echo lands, any
 * subsequent streaming token is answer-side by construction (SCRT2
 * delivers entries in server order over the SSE stream).
 */
export function shouldAppendStreamingToken(
  ctx: Pick<TrackerContext, "echoTimestamp">,
): boolean {
  return ctx.echoTimestamp !== null;
}
