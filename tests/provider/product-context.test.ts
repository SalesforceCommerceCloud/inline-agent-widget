import { describe, expect, it } from "vitest";
import { resolveProductId, withProductContext } from "../../src/provider/product-context";

describe("resolveProductId", () => {
  it("reads the id from the configured query-string param (SFRA Product-Show shape)", () => {
    expect(
      resolveProductId(
        {
          search: "?pid=25752986M&foo=bar",
          pathname: "/on/demandware.store/Sites-RefArch-Site/en_US/Product-Show",
        },
        { productIdParam: "pid" },
      ),
    ).toBe("25752986M");
  });

  it("reads the id from the path via the pattern's first capture group (PWA shape)", () => {
    expect(
      resolveProductId(
        { search: "", pathname: "/en-US/product/25752986M" },
        { productIdPattern: "/product/([^/?#]+)" },
      ),
    ).toBe("25752986M");
  });

  it("prefers the query param over the path pattern when both resolve", () => {
    expect(
      resolveProductId(
        { search: "?pid=FROM_PARAM", pathname: "/product/FROM_PATH" },
        { productIdParam: "pid", productIdPattern: "/product/([^/?#]+)" },
      ),
    ).toBe("FROM_PARAM");
  });

  it("falls back to the pattern when the param is configured but absent from the URL", () => {
    expect(
      resolveProductId(
        { search: "?other=x", pathname: "/product/FROM_PATH" },
        { productIdParam: "pid", productIdPattern: "/product/([^/?#]+)" },
      ),
    ).toBe("FROM_PATH");
  });

  it("uses default PWA fallback (/product/<id>) when neither strategy is configured", () => {
    expect(
      resolveProductId(
        { search: "?color=BLACKWL", pathname: "/global/en-GB/product/25686544M" },
        {},
      ),
    ).toBe("25686544M");
  });

  it("uses default SFRA fallback (/name.html) when no config and no /product/ in path", () => {
    expect(
      resolveProductId(
        { search: "?lang=en_US", pathname: "/s/RefArch/black-flat-front-wool-suit/25686544M.html" },
        {},
      ),
    ).toBe("25686544M");
  });

  it("returns null when neither strategy is configured and no defaults match", () => {
    expect(resolveProductId({ search: "?foo=bar", pathname: "/category/tops" }, {})).toBeNull();
  });

  it("returns null when the param is present but empty", () => {
    expect(
      resolveProductId({ search: "?pid=", pathname: "/x" }, { productIdParam: "pid" }),
    ).toBeNull();
  });

  it("returns null when the pattern does not match the path", () => {
    expect(
      resolveProductId(
        { search: "", pathname: "/category/tops" },
        { productIdPattern: "/product/([^/?#]+)" },
      ),
    ).toBeNull();
  });

  it("returns null (does not throw) for an invalid regex pattern", () => {
    const args = [
      { search: "", pathname: "/product/X" },
      { productIdPattern: "(" },
    ] as const;
    expect(() => resolveProductId(...args)).not.toThrow();
    expect(resolveProductId(...args)).toBeNull();
  });

  it("decodes a percent-encoded path segment", () => {
    expect(
      resolveProductId(
        { search: "", pathname: "/product/ab%20cd" },
        { productIdPattern: "/product/([^/?#]+)" },
      ),
    ).toBe("ab cd");
  });

  it("returns null (does not throw) when the matched segment is a malformed %-escape", () => {
    const args = [
      { search: "", pathname: "/product/%E0%A4%A" },
      { productIdPattern: "/product/([^/?#]+)" },
    ] as const;
    expect(() => resolveProductId(...args)).not.toThrow();
    expect(resolveProductId(...args)).toBeNull();
  });
});

describe("withProductContext", () => {
  it("prepends the exact hidden line and a blank line before the query", () => {
    expect(withProductContext("is this waterproof?", "25752986M")).toBe(
      "Viewing product details for: 25752986M\n\nis this waterproof?",
    );
  });

  it("returns the text unchanged when there is no product id", () => {
    expect(withProductContext("hello", null)).toBe("hello");
  });
});
