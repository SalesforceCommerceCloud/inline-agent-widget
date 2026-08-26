/**
 * Hidden product-context prefix for outgoing messages.
 *
 * The widget is placed only on the Product Detail Page. When configured, it
 * derives the current product id from the page URL and prepends a short context
 * line to the message SENT to the agent — this is never shown in the UI (the
 * widget has no transcript and never renders outgoing text), so the agent can
 * answer about the product on screen without the shopper naming it.
 *
 * Both functions are pure (no DOM/React access) — the caller passes in
 * `window.location` — which keeps them trivially unit-testable and lets the
 * product id be resolved fresh at send time.
 */

/** URL-extraction strategy (a subset of {@link WidgetConfig}). */
export interface ProductContextConfig {
  /** Query-string parameter to read the product id from (e.g. "pid"). */
  productIdParam?: string;
  /** Regex matched against the URL path; capture group 1 is the product id. */
  productIdPattern?: string;
}

/** Fixed wording of the hidden context line (kept in one place). */
const CONTEXT_PREFIX = "Viewing product details for:";

/**
 * Resolve the current product id from a location per the configured strategy:
 * `productIdParam` (query string) first, then `productIdPattern` (path regex,
 * capture group 1). Returns `null` when unconfigured, not found, or the pattern
 * is an invalid regex — callers then send the message unprefixed. Never throws.
 */
export function resolveProductId(
  loc: Pick<Location, "search" | "pathname">,
  cfg: ProductContextConfig,
): string | null {
  const { productIdParam, productIdPattern } = cfg;

  if (productIdParam) {
    try {
      const id = new URLSearchParams(loc.search).get(productIdParam)?.trim();
      if (id) return id;
    } catch {
      // Malformed search string — fall through to the pattern strategy.
    }
  }

  if (productIdPattern) {
    try {
      const captured = new RegExp(productIdPattern).exec(loc.pathname)?.[1]?.trim();
      // decodeURIComponent can throw on a malformed %-escape; the catch handles it.
      if (captured) return decodeURIComponent(captured);
    } catch {
      // Invalid regex or malformed escape — no id, send unprefixed.
    }
  }

  return null;
}

/**
 * Prepend the hidden product-context line to an outgoing message body. When
 * `productId` is `null` this is a no-op and the text is returned unchanged, so
 * the widget keeps working as a general chat off the PDP.
 */
export function withProductContext(text: string, productId: string | null): string {
  return productId ? `${CONTEXT_PREFIX} ${productId}\n\n${text}` : text;
}
