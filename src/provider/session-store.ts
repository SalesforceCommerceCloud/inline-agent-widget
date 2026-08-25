/**
 * Opt-in persistence for an anonymous SCRT2 session so a conversation survives
 * page navigation / reload within the same browser.
 *
 * SECURITY (see the plan's security analysis): the persisted token is an
 * anonymous, unauthenticated JWT — its blast radius if stolen is the messaging
 * conversation only (no user credentials / CRM access). We nonetheless minimize
 * exposure:
 *   - store the MINIMUM (token + conversationId + lastEventId) — never any
 *     transcript text;
 *   - reuse is bounded solely by the token's own JWT `exp` (the server sets it
 *     at mint; we can't lengthen it, only honor it — a fresh token would be a
 *     new anonymous UID and 403 on the existing conversation anyway);
 *   - proactively delete an expired / malformed entry on load, so a dead token
 *     doesn't linger at a well-known key;
 *   - degrade to a silent no-op when Storage is unavailable (private mode,
 *     disabled, quota) — the widget just behaves as if persistence were off.
 *
 * Backed by `localStorage` (a deliberate product choice for cross-tab + cross-
 * restart continuity; `sessionStorage` would be safer on shared devices — see
 * the README trade-off note). NOTE: with the idle max-age removed, a stored
 * session is reusable for the FULL token lifetime — on a shared/kiosk device
 * that widens the walk-up reuse window to the token's `exp`. The README calls
 * this out; prefer leaving persistence off for kiosk deployments.
 */

/** The minimal session snapshot we persist. Contains NO message/transcript text. */
export interface PersistedSession {
  accessToken: string;
  conversationId: string;
  lastEventId: string | null;
}

const KEY_PREFIX = "iaw:sess";

/**
 * Namespaced storage key. Scoping by orgId + esDeveloperName keeps multiple
 * widgets (or a config change) from colliding on one blob.
 */
export function buildSessionKey(orgId: string, esDeveloperName: string): string {
  return `${KEY_PREFIX}:${orgId}:${esDeveloperName}`;
}

/**
 * Resolve the storage backend, or null if it's unavailable/unusable. Accessing
 * `localStorage` can throw (sandboxed iframe, disabled storage), so this is
 * guarded and treated as "no persistence".
 */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Parse a JWT's `exp` claim as epoch ms. Returns 0 (i.e. "already expired") if
 * the token can't be parsed — mirrors the SDK's `getTokenExpiry`, duplicated
 * here so the store validates independently of the client.
 */
function tokenExpiryMs(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const decoded = JSON.parse(base64UrlDecode(payload));
    return (decoded.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/**
 * Decode a base64URL string (the JWT segment alphabet: `-`/`_` instead of
 * `+`/`/`, and padding stripped). `atob` only accepts standard base64 and
 * THROWS on `-`/`_`, so a real Salesforce token — whose payload routinely
 * contains those chars — would otherwise fail to parse and be wrongly treated
 * as expired. Translate the alphabet and restore padding before `atob`.
 */
function base64UrlDecode(segment: string): string {
  let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = b64.length % 4;
  if (remainder) b64 += "=".repeat(4 - remainder);
  return atob(b64);
}

/**
 * Type guard: does the parsed blob have the shape we persist? Tolerates extra
 * properties (e.g. a legacy `persistedAt` from an older build) so a session
 * stored before the idle-TTL was removed still rehydrates.
 */
function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    typeof v.conversationId === "string" &&
    v.conversationId.length > 0 &&
    (v.lastEventId === null || typeof v.lastEventId === "string")
  );
}

/**
 * Why a load returned null. Surfaced (optionally) so the provider can log a
 * precise reason — "no session" spans several very different causes and
 * conflating them turns a normal cache-miss into a phantom bug hunt.
 *   - `no-storage`   : Storage backend unavailable (private mode / disabled).
 *   - `absent`       : No entry at this key (nothing stored, or wrong origin).
 *   - `read-threw`   : getItem() threw (sandboxed / access denied).
 *   - `malformed`    : Entry present but not valid JSON.
 *   - `wrong-shape`  : Valid JSON but missing/!typed required fields.
 *   - `token-expired`: Well-formed session whose JWT `exp` has passed.
 */
export type LoadRejectReason =
  | "no-storage"
  | "absent"
  | "read-threw"
  | "malformed"
  | "wrong-shape"
  | "token-expired";

/**
 * Load a persisted session, or null if none is usable. Returns null (and
 * proactively clears the entry) when the stored blob is malformed or the JWT
 * has expired. Reuse is bounded solely by the token's `exp`. `now` is
 * injectable for tests; `onReject` (optional) reports why a load failed for
 * diagnostics — it is never passed the token value.
 */
export function loadSession(
  key: string,
  now: number = Date.now(),
  onReject?: (reason: LoadRejectReason) => void,
): PersistedSession | null {
  const storage = getStorage();
  if (!storage) {
    onReject?.("no-storage");
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    onReject?.("read-threw");
    return null;
  }
  if (!raw) {
    onReject?.("absent");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSession(key); // corrupt entry — don't leave it lying around
    onReject?.("malformed");
    return null;
  }

  if (!isPersistedSession(parsed)) {
    clearSession(key);
    onReject?.("wrong-shape");
    return null;
  }

  // The token's own JWT expiry is the sole reuse bound.
  if (tokenExpiryMs(parsed.accessToken) <= now) {
    clearSession(key);
    onReject?.("token-expired");
    return null;
  }

  return parsed;
}

/**
 * Persist a session. Call after establishing the conversation (and, harmlessly,
 * after sends) so the latest token/lastEventId is stored. Silently no-ops if
 * storage is unavailable or the write throws (e.g. quota).
 */
export function saveSession(key: string, data: PersistedSession): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(key, JSON.stringify(data));
  } catch {
    // Quota / disabled — persistence is best-effort; ignore.
  }
}

/** Remove a persisted session. Safe to call when none exists or storage is unavailable. */
export function clearSession(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}
