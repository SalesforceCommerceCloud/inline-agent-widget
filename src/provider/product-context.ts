import type { SessionContextVariable } from "../sdk";

/**
 * PDP context for outgoing messages.
 *
 * The product id is resolved fresh at send time and passed through SCRT2's
 * per-turn session-context API. The shopper's text stays unchanged.
 */

/** URL-extraction strategy (a subset of {@link WidgetConfig}). */
export interface ProductContextConfig {
  /** Query-string parameter to read the product id from (e.g. "pid"). */
  productIdParam?: string;
  /** Regex matched against the URL path; capture group 1 is the product id. */
  productIdPattern?: string;
}

const PDP_INLINE_CONTEXT_MESSAGE =
  "This is the product details page the user is currently looking at";

/**
 * Built-in fallback strategies for SFCC storefronts, tried in order when no
 * explicit productIdParam / productIdPattern is configured:
 *  1. PWA — path segment after /product/ (e.g. /global/en-GB/product/25686544M?color=BLACKWL)
 *  2. SFRA — last path segment before .html (e.g. /s/RefArch/name/25686544M.html)
 */
const DEFAULT_STRATEGIES: ProductContextConfig[] = [
  { productIdPattern: "/product/([^/?#]+)" },
  { productIdPattern: "/([^/]+)\\.html" },
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
 * Resolve the current product id from a location per the configured strategy:
 * `productIdParam` (query string) first, then `productIdPattern` (path regex,
 * capture group 1). When neither is configured, falls back to built-in
 * strategies for PWA (/product/<id>) and SFRA (/name.html) URL patterns.
 * Returns `null` when not found or the pattern is invalid — callers then send
 * the message without PDP context. Never throws.
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

  return null;
}

/** Build the three external variables expected by the inline PDP agent. */
export function buildPdpInlineContext(productId: string): SessionContextVariable[] {
  return [
    {
      name: "page_context_type",
      value: { valueType: "TextValue", textValue: "pdp_inline" },
    },
    {
      name: "page_context_message",
      value: {
        valueType: "TextValue",
        textValue: PDP_INLINE_CONTEXT_MESSAGE,
      },
    },
    {
      name: "page_context_data",
      value: {
        valueType: "TextValue",
        textValue: JSON.stringify({ id: productId }),
      },
    },
  ];
}
