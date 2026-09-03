import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionKey,
  clearSession,
  loadSession,
  saveSession,
  type PersistedSession,
} from "../../src/provider/session-store";

/**
 * Build a minimal, unsigned JWT whose payload carries the given `exp` (seconds).
 * Only the middle segment matters — the store base64URL-decodes it to read `exp`.
 * Encoded with **base64url** (the real JWT alphabet: `-`/`_`, no padding) so the
 * decoder is exercised the way production tokens actually arrive. `extra` lets a
 * test inject payload bytes that force `-`/`_` into the encoded segment.
 */
function jwtWithExp(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "anon", exp: expSeconds, ...extra }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

/** A simple in-memory Storage implementation for the node test env. */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

const KEY = buildSessionKey("00DQZ000000TEST", "TestAgent");
const NOW = 1_000_000_000_000; // fixed "now" for deterministic expiry math
const FAR_FUTURE_EXP = Math.floor(NOW / 1000) + 3600; // 1h ahead of NOW

function validData(): PersistedSession {
  return {
    accessToken: jwtWithExp(FAR_FUTURE_EXP),
    conversationId: "conv-abc",
    lastEventId: "evt-42",
  };
}

describe("session-store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a saved session", () => {
    saveSession(KEY, validData(), NOW);
    const loaded = loadSession(KEY, NOW);
    expect(loaded).toMatchObject({
      conversationId: "conv-abc",
      lastEventId: "evt-42",
    });
    expect(loaded?.accessToken).toBeTruthy();
  });

  it("decodes a base64url token payload (contains - and _) — not treated as expired", () => {
    // Regression: real Salesforce JWT payloads contain base64url chars (-/_),
    // which raw atob() rejects → the token was misread as unparseable → expiry 0
    // → wrongly reported "token-expired". Force such chars into the payload and
    // require the (unexpired) session to load. The 0xFB/0xFF byte pairs below
    // encode to sequences containing '-' and '_'.
    const forcesUrlChars = { pad: "ûÿþûÿþ" };
    const token = jwtWithExp(FAR_FUTURE_EXP, forcesUrlChars);
    const seg = token.split(".")[1];
    expect(/[-_]/.test(seg)).toBe(true); // guard: the fixture really exercises the path
    saveSession(KEY, { ...validData(), accessToken: token }, NOW);
    expect(loadSession(KEY, NOW)).not.toBeNull();
  });

  it("namespaces the key by orgId + esDeveloperName", () => {
    expect(buildSessionKey("orgA", "AgentX")).toBe("iaw:sess:orgA:AgentX");
    expect(buildSessionKey("orgA", "AgentX")).not.toBe(buildSessionKey("orgB", "AgentX"));
  });

  it("persists NO transcript/message text — only the minimal fields (+ persistedAt)", () => {
    saveSession(KEY, validData(), NOW);
    const raw = localStorage.getItem(KEY)!;
    const parsed = JSON.parse(raw);
    // Only the minimal session fields plus the idle-TTL timestamp — no transcript.
    expect(Object.keys(parsed).sort()).toEqual(
      ["accessToken", "conversationId", "lastEventId", "persistedAt"].sort(),
    );
    expect(parsed.persistedAt).toBe(NOW);
  });

  it("reuses a session within the 30-min sliding idle TTL", () => {
    saveSession(KEY, validData(), NOW); // persistedAt = NOW, token exp = NOW + 1h
    // 29 minutes later: within the idle window and before the token exp → loads.
    expect(loadSession(KEY, NOW + 29 * 60 * 1000)).not.toBeNull();
  });

  it("rejects (and clears) a session idle past the 30-min TTL, reason 'idle-expired'", () => {
    saveSession(KEY, validData(), NOW); // token exp is 1h out, so exp is NOT the cause
    const reasons: string[] = [];
    // 31 minutes later: token still unexpired, but idle past 30 min → rejected.
    const loaded = loadSession(KEY, NOW + 31 * 60 * 1000, (r) => reasons.push(r));
    expect(loaded).toBeNull();
    expect(reasons).toEqual(["idle-expired"]);
    expect(localStorage.getItem(KEY)).toBeNull(); // proactively cleared
  });

  it("slides the idle window forward on each save", () => {
    saveSession(KEY, validData(), NOW);
    // A save 20 min later re-stamps persistedAt, extending the window.
    saveSession(KEY, validData(), NOW + 20 * 60 * 1000);
    // 45 min from the ORIGINAL save (25 min from the latest) → still within TTL.
    expect(loadSession(KEY, NOW + 45 * 60 * 1000)).not.toBeNull();
  });

  it("rejects (and clears) a session whose JWT has expired", () => {
    const expiredToken = jwtWithExp(Math.floor(NOW / 1000) - 10); // 10s in the past
    saveSession(KEY, { ...validData(), accessToken: expiredToken });
    const loaded = loadSession(KEY, NOW);
    expect(loaded).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull(); // proactively cleared
  });

  it("loads a well-formed blob whose persistedAt is within the TTL", () => {
    // Direct blob (not via saveSession): a fresh persistedAt within the window loads.
    localStorage.setItem(KEY, JSON.stringify({ ...validData(), persistedAt: NOW }));
    expect(loadSession(KEY, NOW)).not.toBeNull();
  });

  it("rejects (and clears) a blob with no persistedAt as 'idle-expired'", () => {
    // e.g. written by a build predating the idle TTL — treated as stale.
    localStorage.setItem(KEY, JSON.stringify(validData())); // no persistedAt
    const reasons: string[] = [];
    expect(loadSession(KEY, NOW, (r) => reasons.push(r))).toBeNull();
    expect(reasons).toEqual(["idle-expired"]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(loadSession(KEY, NOW)).toBeNull();
  });

  it("rejects (and clears) malformed JSON", () => {
    localStorage.setItem(KEY, "{not valid json");
    expect(loadSession(KEY, NOW)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("rejects (and clears) a well-formed-JSON blob of the wrong shape", () => {
    localStorage.setItem(KEY, JSON.stringify({ accessToken: "", conversationId: 5 }));
    expect(loadSession(KEY, NOW)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("clearSession removes the entry", () => {
    saveSession(KEY, validData());
    clearSession(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  describe("when localStorage is unavailable", () => {
    beforeEach(() => {
      vi.unstubAllGlobals(); // remove the memory storage
      vi.stubGlobal("localStorage", undefined);
    });

    it("load/save/clear are silent no-ops (no throw)", () => {
      expect(() => saveSession(KEY, validData())).not.toThrow();
      expect(loadSession(KEY, NOW)).toBeNull();
      expect(() => clearSession(KEY)).not.toThrow();
    });
  });

  describe("when localStorage access throws (e.g. sandboxed / disabled)", () => {
    beforeEach(() => {
      const throwing: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      };
      vi.unstubAllGlobals();
      vi.stubGlobal("localStorage", throwing);
    });

    it("swallows the error and behaves as no-persistence", () => {
      expect(() => saveSession(KEY, validData())).not.toThrow();
      expect(loadSession(KEY, NOW)).toBeNull();
      expect(() => clearSession(KEY)).not.toThrow();
    });
  });
});
