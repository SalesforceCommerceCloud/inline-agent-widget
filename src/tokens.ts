/**
 * Turn the text an agent sends over the wire into something displayable.
 *
 * SCRT2 message + streaming payloads arrive in more than one shape:
 * - Plain-text agents send the text directly.
 * - The "BYON Freeform" agent JSON-encodes its output. A finished message is a
 *   response envelope — `{"response":[{"type":"markdown","data":{"content":"…"}},
 *   {"type":"suggestions","data":{"display_text":[…]}}]}` — and individual
 *   streaming tokens are typed blocks like `{"type":"…","data":{"content":"…"}}`.
 *   Only the text blocks (`markdown`/`text`, i.e. any block exposing a
 *   `data.content` string) are meant to be rendered; `suggestions` and other
 *   control blocks are not.
 *
 * `extractTokenText` (streaming) and `extractMessageText` (final message) share
 * one extraction core but differ in their fallback: a mid-stream token that we
 * can't confidently decode yields nothing (never flash raw JSON — the final
 * `message` event replaces the streamed buffer anyway), whereas a final message
 * we can't decode falls back to the raw string so a genuine reply is never
 * silently dropped.
 */

function looksLikeJson(trimmed: string): boolean {
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/**
 * Walk a parsed agent payload and collect the human-readable text out of it.
 * Returns `null` when there's nothing renderable (e.g. a lone suggestions
 * block), which lets each caller pick its own fallback.
 */
function collectRenderableText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(collectRenderableText)
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    return parts.length ? parts.join("\n\n") : null;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // BYON response envelope: unwrap and render its blocks in order.
    if (Array.isArray(obj.response)) {
      return collectRenderableText(obj.response);
    }

    // A typed block — the displayable text lives in `data.content`.
    // `suggestions` blocks expose `data.display_text` (an array) instead, so
    // they fall through to `null` and are naturally skipped.
    const data = obj.data;
    if (data && typeof data === "object") {
      const content = (data as Record<string, unknown>).content;
      if (typeof content === "string") {
        return content;
      }
    }

    // Some shapes carry the text at the top level.
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;

    return null;
  }

  return null;
}

/**
 * Extract displayable text from a single streaming token. On any ambiguity,
 * prefer returning nothing over flashing raw JSON — the final `message` event
 * replaces the whole streamed buffer (see the SET_ANSWER reducer case), so a
 * briefly lagging preview always self-heals into the correct final text.
 */
export function extractTokenText(token: string): string {
  if (!token) return "";

  const trimmed = token.trim();

  // Plain text is by far the common case, and a chunk that merely starts with a
  // quote shouldn't be treated as JSON. Only decode when it looks like a value.
  if (!looksLikeJson(trimmed)) {
    return token;
  }

  try {
    return collectRenderableText(JSON.parse(trimmed)) ?? "";
  } catch {
    // Not valid JSON after all (e.g. a partial chunk) — treat as plain text.
    return token;
  }
}

/**
 * Extract displayable text from a final message's content. Unlike streaming, a
 * message we can't decode falls back to the raw string so a real reply is never
 * dropped — the alternative (an empty response) is worse than showing the text.
 */
export function extractMessageText(content: string): string {
  if (!content) return "";

  const trimmed = content.trim();

  if (!looksLikeJson(trimmed)) {
    return content;
  }

  try {
    return collectRenderableText(JSON.parse(trimmed)) ?? content;
  } catch {
    return content;
  }
}

import { MAX_PDP_QUESTIONS } from "./provider/pdp-questions";

/**
 * Walk a parsed agent payload and collect follow-up suggestions (`display_text`
 * arrays from `suggestions`-typed blocks). Returns an empty array when there are
 * no suggestions — callers never need to null-check.
 */
function collectSuggestions(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value.flatMap(collectSuggestions);
  }

  const obj = value as Record<string, unknown>;

  if (Array.isArray(obj.response)) {
    return collectSuggestions(obj.response);
  }

  if (obj.type === "suggestions") {
    const data = obj.data as Record<string, unknown> | undefined;
    const texts = data?.display_text;
    if (Array.isArray(texts)) {
      return texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    }
  }

  return [];
}

/**
 * Extract follow-up suggestion strings from a final message's content. Parses
 * the same BYON `{response:[…]}` envelope as `extractMessageText` but pulls
 * `data.display_text` from `suggestions` blocks instead of `data.content` from
 * markdown blocks. Capped at {@link MAX_PDP_QUESTIONS}. Returns `[]`
 * for plain-text agents or when no suggestions are present.
 */
export function extractMessageSuggestions(content: string): string[] {
  if (!content) return [];

  const trimmed = content.trim();
  if (!looksLikeJson(trimmed)) return [];

  try {
    const raw = collectSuggestions(JSON.parse(trimmed));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of raw) {
      const t = s.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= MAX_PDP_QUESTIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}
