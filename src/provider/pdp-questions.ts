/**
 * Parse the `pdp-questions` attribute value into a sanitized list of opener
 * questions. The attribute carries a JSON-encoded array of strings — matching
 * the shape of SCAPI's `c_pdpQuestions` custom attribute, which is itself a
 * JSON-encoded string. Never throws; returns [] for any malformed input so a
 * bad publish upstream never breaks the widget.
 */

/** Cap kept in one place so the custom-element and tests agree. */
export const MAX_PDP_QUESTIONS = 5;

export function parsePdpQuestions(
  raw: string | undefined | null,
  maxCount: number = MAX_PDP_QUESTIONS,
): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of parsed) {
    if (typeof q !== "string") continue;
    const trimmed = q.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxCount) break;
  }
  return out;
}
