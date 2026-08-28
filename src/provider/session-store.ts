/**
 * Persistence for an anonymous SCRT2 session so a conversation survives page
 * navigation / reload within the same browser. Enabled by default; a host can
 * opt out per embed (see `persistSession` in provider/types.ts).
 *
 * SECURITY: the persisted token is an anonymous, unauthenticated JWT — its blast
 * radius if stolen is the messaging conversation only (no user credentials / CRM
 * access). We nonetheless minimize exposure:
 *   - store the MINIMUM (token + conversationId + lastEventId, plus a
 *     `persistedAt` timestamp) — never any transcript text;
 *   - bound reuse by min(the token's own JWT `exp`, a 30-minute SLIDING idle
 *     TTL). `saveSession` re-stamps `persistedAt` after every send, so an
 *     actively used conversation keeps working while an abandoned one becomes
 *     unrestorable 30 min after the last activity;
 *   - proactively delete an expired / idle / malformed entry on load, so a dead
 *     token doesn't linger at a well-known key;
 *   - degrade to a silent no-op when Storage is unavailable (private mode,
 *     disabled, quota) — the widget just behaves as if persistence were off.
 *
 * Backed by `localStorage` (a deliberate product choice for cross-tab + cross-
 * restart continuity; `sessionStorage` would be safer on shared devices — see
 * the README trade-off note). The 30-min idle TTL caps the shared/kiosk walk-up
 * reuse window to 30 min of inactivity; for stricter kiosk use set
 * `persist-session="false"` to disable persistence entirely.
 */

/**
 * The minimal session snapshot we persist. Contains NO message/transcript text.
 * `saveSession` additionally stamps a `persistedAt` epoch-ms timestamp (used for
 * the sliding idle TTL); it is intentionally not part of this caller-facing shape.
 */
export interface PersistedSession {
  accessToken: string;
  conversationId: string;
  lastEventId: string | null;
}

const KEY_PREFIX = "iaw:sess";

/**
 * Sliding idle TTL for a persisted session (epoch-ms window): a stored session is
 * restorable only within 30 minutes of its last write. `saveSession` re-stamps
 * `persistedAt` after every send, so the window resets on each activity.
 */
const SESSION_TTL_MS = 30 * 60 * 1000;

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
 *   - `idle-expired` : Well-formed, unexpired token but idle past the 30-min TTL
 *                      (or missing its `persistedAt` timestamp).
 */
export type LoadRejectReason =
  | "no-storage"
  | "absent"
  | "read-threw"
  | "malformed"
  | "wrong-shape"
  | "token-expired"
  | "idle-expired";

/**
 * Load a persisted session, or null if none is usable. Returns null (and
 * proactively clears the entry) when the stored blob is malformed, the JWT has
 * expired, or it has been idle past the 30-min sliding TTL. Reuse is bounded by
 * min(JWT `exp`, `persistedAt` + SESSION_TTL_MS). `now` is injectable for tests;
 * `onReject` (optional) reports why a load failed for diagnostics — it is never
 * passed the token value.
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

  // The token's own JWT expiry is a hard upper bound on reuse.
  if (tokenExpiryMs(parsed.accessToken) <= now) {
    clearSession(key);
    onReject?.("token-expired");
    return null;
  }

  // Sliding idle TTL: reusable only within SESSION_TTL_MS of the last write.
  // saveSession stamps `persistedAt` (refreshed after every send). A blob with
  // no/invalid `persistedAt` — e.g. written by a build before the TTL existed —
  // is treated as stale. Net reuse bound = min(JWT exp, persistedAt + TTL).
  const persistedAt = (parsed as { persistedAt?: unknown }).persistedAt;
  if (typeof persistedAt !== "number" || now - persistedAt > SESSION_TTL_MS) {
    clearSession(key);
    onReject?.("idle-expired");
    return null;
  }

  return parsed;
}

/**
 * Persist a session. Call after establishing the conversation and after each
 * send, so the latest token/lastEventId is stored AND the sliding idle TTL is
 * refreshed. Stamps `persistedAt` (epoch ms; `now` is injectable for tests).
 * Silently no-ops if storage is unavailable or the write throws (e.g. quota).
 */
export function saveSession(
  key: string,
  data: PersistedSession,
  now: number = Date.now(),
): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(key, JSON.stringify({ ...data, persistedAt: now }));
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
