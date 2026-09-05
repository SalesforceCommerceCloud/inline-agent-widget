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
 * Built-in fallback strategies tried in order when no explicit
 * productIdParam / productIdPattern is configured:
 *  1. PWA — path segment after /product/ (e.g. /global/en-GB/product/25686544M?color=BLACKWL)
 *  2. SFRA DOM — data-pid attribute on .product-detail (always present on SFRA PDPs regardless of SEO URL ruleset)
 */
const DEFAULT_STRATEGIES: ProductContextConfig[] = [
  { productIdPattern: "/product/([^/?#]+)" },
];

/**
 * Attempt to resolve a product id using a single strategy config.
 * Returns the id or null.
 */
function tryResolve(
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
      if (captured) return decodeURIComponent(captured);
    } catch {
      // Invalid regex or malformed escape — no id.
    }
  }

  return null;
}

/**
 * Read the product id from the SFRA PDP DOM. The product-detail element always
 * carries a `data-pid` attribute regardless of the site's SEO URL ruleset, so
 * this is more reliable than parsing the URL for SFRA storefronts.
 */
function readPidFromDom(): string | null {
  if (typeof document === "undefined") return null;
  const pid = document.querySelector<HTMLElement>(".product-detail[data-pid]")?.dataset.pid?.trim();
  return pid || null;
}

/**
 * Resolve the current product id from a location per the configured strategy:
 * `productIdParam` (query string) first, then `productIdPattern` (path regex,
 * capture group 1). When neither is configured, falls back to built-in
 * strategies: PWA path pattern (/product/<id>), then SFRA DOM (data-pid).
 * Returns `null` when not found or the pattern is invalid — callers then send
 * the message unprefixed. Never throws.
 */
export function resolveProductId(
  loc: Pick<Location, "search" | "pathname">,
  cfg: ProductContextConfig,
): string | null {
  const { productIdParam, productIdPattern } = cfg;

  const hasExplicitConfig = !!(productIdParam || productIdPattern);

  if (hasExplicitConfig) {
    return tryResolve(loc, cfg);
  }

  for (const strategy of DEFAULT_STRATEGIES) {
    const id = tryResolve(loc, strategy);
    if (id) return id;
  }

  return readPidFromDom();
}

/**
 * Prepend the hidden product-context line to an outgoing message body. When
 * `productId` is `null` this is a no-op and the text is returned unchanged, so
 * the widget keeps working as a general chat off the PDP.
 */
export function withProductContext(text: string, productId: string | null): string {
  return productId ? `${CONTEXT_PREFIX} ${productId}\n\n${text}` : text;
}
