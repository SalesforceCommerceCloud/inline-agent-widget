import { TypedEventEmitter } from "./event-emitter";
import { SSEReader } from "./sse";
import {
  AgentforceApiError,
  AgentforceAuthError,
  AgentforceClientError,
  AgentforceNetworkError,
} from "./errors";
import { Logger } from "./logger";
import type {
  AgentforceClientOptions,
  AgentforceClientTuning,
  AccessTokenRequest,
  AccessTokenResponse,
  CreateConversationRequest,
  SendMessageRequest,
  SSEEventData,
  ConversationEntry,
  RequestOptions,
} from "./types";

/**
 * AgentforceClient
 *
 * A lightweight TypeScript client for Salesforce SCRT2 Messaging APIs.
 * Handles token management, conversation lifecycle, and real-time SSE events.
 *
 * @example
 * ```ts
 * const client = new AgentforceClient({
 *   baseURL: 'https://xyz.salesforce-scrt.com',
 *   orgId: '00DQZ...',
 *   esDeveloperName: 'Agentforce',
 * });
 *
 * client.on('message', (event) => console.log(event.content));
 * client.on('streaming_token', (event) => process.stdout.write(event.token));
 *
 * await client.connect();
 * await client.createConversation();
 * await client.sendMessage('Hello!');
 * ```
 */
export class AgentforceClient extends TypedEventEmitter {
  // ─── Configuration ──────────────────────────────────────────────────────────
  private readonly baseURL: string;
  private readonly orgId: string;
  private readonly esDeveloperName: string;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly platform: string;
  private readonly logger: Logger;

  // ─── State ──────────────────────────────────────────────────────────────────
  private _accessToken: string | null = null;
  private _tokenExpiresAt: number = 0; // epoch ms
  private _conversationId: string | null = null;
  private _lastEventId: string | null = null;
  private _isConnected = false;
  private sseReader: SSEReader | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  constructor({ baseURL, orgId, esDeveloperName, options = {} }: AgentforceClientOptions) {
    super();

    this.baseURL = baseURL.replace(/\/+$/, "");
    this.orgId = orgId;
    this.esDeveloperName = esDeveloperName;

    const tuning: Required<AgentforceClientTuning> = {
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeout ?? 15000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      reconnectDelay: options.reconnectDelay ?? 2000,
      enableLogging: options.enableLogging ?? false,
      platform: options.platform ?? "Web",
    };

    this.maxRetries = tuning.maxRetries;
    this.timeout = tuning.timeout;
    this.maxReconnectAttempts = tuning.maxReconnectAttempts;
    this.reconnectDelay = tuning.reconnectDelay;
    this.platform = tuning.platform;
    this.logger = new Logger(tuning.enableLogging);

    this.logger.info(`Client initialized for ${this.baseURL}`);
  }

  // ─── Public Accessors ───────────────────────────────────────────────────────

  /** Whether the SSE stream is currently connected. */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /** The current conversation ID, or null if no conversation is active. */
  get conversationId(): string | null {
    return this._conversationId;
  }

  /** The current access token, or null if not yet authenticated. */
  get accessToken(): string | null {
    return this._accessToken;
  }

  /** Expiry of the current access token as epoch ms (0 if none / unparseable). */
  get tokenExpiresAt(): number {
    return this._tokenExpiresAt;
  }

  /**
   * The last SSE event id seen for this session, or null. Surfaced so a
   * persistence layer can store it and (optionally) resume the stream on
   * rehydrate. Currently sourced from the access-token response's
   * `lastEventId`.
   */
  get lastEventId(): string | null {
    return this._lastEventId;
  }

  // ─── Lifecycle Methods ──────────────────────────────────────────────────────

  /**
   * Acquire an access token and open the SSE event stream.
   * Must be called before createConversation() or sendMessage().
   */
  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    this.logger.info("Connecting...");

    this._accessToken = await this.fetchAccessToken();
    this.logger.info("Access token acquired");

    await this.openSSE();
  }

  /**
   * Re-establish a previously persisted session WITHOUT minting a new token or
   * creating a new conversation. Sets the token + conversation identity from the
   * stored values and opens the SSE stream with the existing token — preserving
   * the anonymous UID so the same conversation continues.
   *
   * Refuses to restore an already-expired token (a fresh token = new UID = 403
   * on the existing conversation), so callers should fall back to connect() +
   * createConversation() on rejection.
   *
   * @param session The persisted session: the access token, its conversation
   *                id, and optionally the last seen SSE event id.
   * @throws AgentforceAuthError if the token is missing or already expired.
   */
  async restore(session: {
    accessToken: string;
    conversationId: string;
    lastEventId?: string | null;
  }): Promise<void> {
    if (!session.accessToken || !session.conversationId) {
      throw new AgentforceAuthError("Cannot restore: missing accessToken or conversationId");
    }

    const expiresAt = this.getTokenExpiry(session.accessToken);
    if (expiresAt <= Date.now()) {
      throw new AgentforceAuthError("Cannot restore: access token has expired");
    }

    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    // Snapshot so we can roll back if openSSE() fails — restore() must be atomic.
    // Otherwise a half-restored state (conversationId set, stream down) would
    // make conversationId-keyed readiness checks think we're connected.
    const prev = {
      accessToken: this._accessToken,
      tokenExpiresAt: this._tokenExpiresAt,
      conversationId: this._conversationId,
      lastEventId: this._lastEventId,
    };

    this._accessToken = session.accessToken;
    this._tokenExpiresAt = expiresAt;
    this._conversationId = session.conversationId;
    if (session.lastEventId) this._lastEventId = session.lastEventId;

    this.logger.info(`Restoring session for conversation ${session.conversationId}`);
    try {
      await this.openSSE();
    } catch (err) {
      this._accessToken = prev.accessToken;
      this._tokenExpiresAt = prev.tokenExpiresAt;
      this._conversationId = prev.conversationId;
      this._lastEventId = prev.lastEventId;
      throw err;
    }
  }

  /**
   * Close the SSE stream and clean up.
   * Does NOT end the conversation — call endConversation() first if needed.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    this.closeSSE();
    this._isConnected = false;
    this.logger.info("Disconnected");
  }

  /**
   * Resets the reconnect counter and attempts to re-establish the SSE stream
   * using the existing access token (preserving the anonymous identity and
   * conversation ownership).
   *
   * If the access token has expired, a `SESSION_EXPIRED` error event will be
   * emitted.
   */
  reconnect(): void {
    if (this._isConnected) return;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.attemptReconnect();
  }

  /**
   * Create a new conversation.
   * The SSE stream must be connected first (call connect()).
   *
   * @param routingAttributes - Optional routing attributes for the conversation.
   * @returns The generated conversation ID.
   */
  async createConversation(routingAttributes?: Record<string, string>): Promise<string> {
    this.assertConnected();

    const id = crypto.randomUUID();
    const body: CreateConversationRequest = {
      conversationId: id,
      esDeveloperName: this.esDeveloperName,
      routingAttributes: routingAttributes ?? {},
    };

    await this.executeRequest("POST", "/iamessage/api/v2/conversation", body);

    this._conversationId = id;
    this.logger.info(`Conversation created: ${id}`);
    return id;
  }

  /**
   * Send a text message in the current conversation.
   *
   * @param text - The message text to send.
   */
  async sendMessage(text: string): Promise<void> {
    this.assertConnected();
    if (!this._conversationId) {
      throw new AgentforceClientError(
        "No active conversation. Call createConversation() first.",
        "unknown",
      );
    }

    const msgId = crypto.randomUUID();
    const body: SendMessageRequest = {
      message: {
        id: msgId,
        messageType: "StaticContentMessage",
        staticContent: { formatType: "Text", text },
      },
      esDeveloperName: this.esDeveloperName,
    };

    await this.executeRequest(
      "POST",
      `/iamessage/api/v2/conversation/${this._conversationId}/message`,
      body,
    );

    this.logger.debug(`Message sent: ${msgId}`);
  }

  /**
   * End the current conversation.
   * This is a best-effort operation — errors are swallowed.
   */
  async endConversation(): Promise<void> {
    if (!this._conversationId || !this._accessToken) return;

    const convId = this._conversationId;
    this._conversationId = null;

    try {
      await this.executeRequest(
        "DELETE",
        `/iamessage/api/v2/conversation/${convId}?esDeveloperName=${encodeURIComponent(this.esDeveloperName)}`,
      );
      this.logger.info(`Conversation ended: ${convId}`);
    } catch (err) {
      this.logger.warn(
        `Failed to end conversation (best effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── SSE Management ─────────────────────────────────────────────────────────

  private async openSSE(): Promise<void> {
    this.closeSSE();

    const url = `${this.baseURL}/eventrouter/v1/sse`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._accessToken}`,
      "X-Org-Id": this.orgId,
    };

    this.sseReader = new SSEReader(
      url,
      headers,
      (eventType, data) => this.handleSSEEvent(eventType, data),
      (reason) => this.handleSSEClose(reason),
      this.logger,
    );

    await this.sseReader.connect();
    this._isConnected = true;
    this.emit("connected");
    this.logger.info("SSE stream connected");
  }

  private closeSSE(): void {
    if (this.sseReader) {
      this.sseReader.disconnect();
      this.sseReader = null;
    }
  }

  private handleSSEClose(reason: string): void {
    this._isConnected = false;
    this.emit("disconnected", { reason });

    if (!this.intentionalDisconnect) {
      this.attemptReconnect();
    }
  }

  // ─── Reconnection ──────────────────────────────────────────────────────────

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached.`);
      this.emit("error", {
        code: "MAX_RECONNECT",
        message: `Failed to reconnect after ${this.maxReconnectAttempts} attempts`,
        recoverable: false,
      });
      return;
    }

    this.reconnectAttempts++;
    const jitter = Math.random() * 500;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) + jitter,
      30000,
    );

    this.logger.info(
      `Reconnecting in ${delay.toFixed(0)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
    );

    this.emit("reconnecting", {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
    });

    this.reconnectTimeout = setTimeout(async () => {
      try {
        if (this.intentionalDisconnect) return;

        const tokenStillValid = this._accessToken && Date.now() < this._tokenExpiresAt;

        if (!tokenStillValid) {
          // Token expired — session is over. Cannot reconnect without losing
          // the conversation (a new token = new UID = 403 on existing conversation).
          this.logger.error("Access token expired — session cannot be resumed");
          this.emit("error", {
            code: "SESSION_EXPIRED",
            message: "Session expired. Call connect() to start a new session.",
            recoverable: false,
          });
          this._conversationId = null;
          return;
        }

        this.logger.info("Reusing existing access token for SSE reconnection");

        if (this.intentionalDisconnect) return;

        await this.openSSE();
        this.reconnectAttempts = 0;
        this.logger.info("Reconnected successfully");
      } catch (err) {
        if (this.intentionalDisconnect) return;

        // If SSE open returned 401, the token is no longer accepted server-side.
        // Treat as session expired.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("(401)")) {
          this.logger.error("SSE rejected token (401) — session expired");
          this.emit("error", {
            code: "SESSION_EXPIRED",
            message: "Session expired. Call connect() to start a new session.",
            recoverable: false,
          });
          this._conversationId = null;
          return;
        }

        this.logger.error(`Reconnect attempt ${this.reconnectAttempts} failed: ${errMsg}`);
        this.attemptReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  // ─── SSE Event Handling ─────────────────────────────────────────────────────

  private handleSSEEvent(eventType: string, rawData: string): void {
    // Ignore pings
    if (eventType === "ping") return;

    let data: SSEEventData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // Non-JSON event, ignore
      this.logger.debug(`Non-JSON SSE event (${eventType}): ${rawData.slice(0, 100)}`);
      return;
    }

    switch (eventType) {
      case "CONVERSATION_MESSAGE":
        this.handleConversationMessage(data);
        break;
      case "CONVERSATION_STREAMING_TOKEN":
        this.handleStreamingToken(data);
        break;
      case "CONVERSATION_TYPING_STARTED_INDICATOR":
        this.handleTypingStarted(data);
        break;
      case "CONVERSATION_TYPING_STOPPED_INDICATOR":
        this.handleTypingStopped(data);
        break;
      default:
        this.logger.debug(`Unhandled SSE event type: ${eventType}`);
        break;
    }
  }

  private handleConversationMessage(data: SSEEventData): void {
    const entry = data.conversationEntry;
    if (!entry) return;

    // Ignore end-user echo messages
    const senderRole = entry.sender?.role || "";
    if (senderRole === "EndUser" || senderRole === "Customer") return;

    const entryPayload = this.parseEntryPayload(entry);

    // Extract text from abstractMessage.staticContent.text or abstractMessage.content.text
    const abstractMessage = this.getNestedValue(entryPayload, "abstractMessage");
    const text =
      this.getNestedString(abstractMessage, "staticContent", "text") ||
      this.getNestedString(abstractMessage, "content", "text") ||
      "";

    if (!text) return;

    this.emit("message", {
      conversationId: this._conversationId || "",
      messageId: entry.identifier || "",
      content: text,
      sender: {
        role: senderRole,
        name: entry.senderDisplayName,
      },
      timestamp: entry.transcriptedTimestamp || new Date().toISOString(),
      raw: entryPayload,
    });
  }

  private handleStreamingToken(data: SSEEventData): void {
    // SCRT2 nests the streaming chunk under
    // conversationEntry.entryPayload.streamingToken (same envelope pattern as
    // CONVERSATION_MESSAGE). Parse that first, then fall back to the legacy
    // top-level token/text shape for backward compatibility (tests/mocks).
    let token = "";
    let sequenceNumber: number | undefined;
    let targetMessageId: string | undefined;
    let tokenType: string | undefined;

    if (data.conversationEntry) {
      const entryPayload = this.parseEntryPayload(data.conversationEntry);
      const streamingToken = this.getNestedValue(entryPayload, "streamingToken");

      token =
        this.getNestedString(streamingToken, "token", "text") ||
        this.getNestedString(streamingToken, "token", "content") ||
        "";

      const seq = this.getNestedValue(streamingToken, "sequenceNumber");
      if (typeof seq === "number") sequenceNumber = seq;

      const extractedTargetId = this.getNestedString(
        streamingToken,
        "targetMessageIdentifier",
      );
      if (extractedTargetId) targetMessageId = extractedTargetId;

      const extractedTokenType = this.getNestedString(streamingToken, "tokenType");
      if (extractedTokenType) tokenType = extractedTokenType;
    }

    // Fallback: legacy top-level shape.
    if (!token) {
      token = data.token || data.text || "";
    }

    if (!token) {
      // Tripwire: a STREAMING_TOKEN event arrived but no token text could be
      // pulled from either the nested
      // (conversationEntry.entryPayload.streamingToken) or legacy top-level
      // shape. If this fires, SCRT2 likely changed the payload location again.
      this.logger.warn(
        "STREAMING_TOKEN received but no token text could be extracted — payload shape may have changed",
      );
      return;
    }

    this.emit("streaming_token", {
      conversationId: this._conversationId || "",
      token: String(token),
      ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
      ...(targetMessageId ? { targetMessageId } : {}),
      ...(tokenType ? { tokenType } : {}),
    });
  }

  private handleTypingStarted(data: SSEEventData): void {
    this.emit("typing_started", {
      conversationId: this._conversationId || "",
      participant: data.conversationEntry?.sender
        ? {
            role: data.conversationEntry.sender.role || "",
            name: data.conversationEntry.senderDisplayName,
          }
        : undefined,
    });
  }

  private handleTypingStopped(data: SSEEventData): void {
    this.emit("typing_stopped", {
      conversationId: this._conversationId || "",
      participant: data.conversationEntry?.sender
        ? {
            role: data.conversationEntry.sender.role || "",
            name: data.conversationEntry.senderDisplayName,
          }
        : undefined,
    });
  }

  // ─── REST Helpers ───────────────────────────────────────────────────────────

  /**
   * Fetch an unauthenticated access token from SCRT2.
   */
  private async fetchAccessToken(): Promise<string> {
    const body: AccessTokenRequest = {
      orgId: this.orgId,
      esDeveloperName: this.esDeveloperName,
      capabilitiesVersion: "1",
      platform: this.platform,
    };

    const response = await this.executeRequest<AccessTokenResponse>(
      "POST",
      "/iamessage/api/v2/authorization/unauthenticated/access-token",
      body,
      { useAuth: false },
    );

    if (!response.accessToken) {
      throw new AgentforceAuthError("Token response missing accessToken field");
    }

    this._tokenExpiresAt = this.getTokenExpiry(response.accessToken);
    if (response.lastEventId) this._lastEventId = response.lastEventId;
    return response.accessToken;
  }

  /**
   * Generic request executor with retry logic and error classification.
   */
  private async executeRequest<T = void>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    options?: RequestOptions & { useAuth?: boolean },
  ): Promise<T> {
    const useAuth = options?.useAuth !== false;
    let retries = 0;

    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), options?.timeout || this.timeout);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...options?.headers,
        };

        if (useAuth && this._accessToken) {
          headers["Authorization"] = `Bearer ${this._accessToken}`;
        }

        const requestInit: RequestInit = {
          method,
          headers,
          signal: options?.signal || controller.signal,
        };

        if (body && method === "POST") {
          requestInit.body = JSON.stringify(body);
        }

        const response = await fetch(`${this.baseURL}${path}`, requestInit);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.text().catch(() => response.statusText);

          if (response.status === 401 && useAuth && retries === 0) {
            // If a conversation exists, surface an auth error so the consumer can recover.
            if (this._conversationId) {
              this.logger.warn(
                "Got 401 with active conversation — cannot auto-refresh (would orphan conversation)",
              );
              throw new AgentforceAuthError(
                `Request ${method} ${path} failed (401): session expired. ` +
                  "Call connect() to start a new session.",
              );
            }

            // No conversation yet (pre-createConversation) — safe to refresh.
            this.logger.info("Got 401 — refreshing token and retrying...");
            this._accessToken = await this.fetchAccessToken();
            retries++;
            continue;
          }

          throw new AgentforceApiError(
            `Request ${method} ${path} failed (${response.status}): ${errorData}`,
            response.status,
            errorData,
          );
        }

        // For 204 No Content or DELETE, return empty
        if (response.status === 204 || method === "DELETE") {
          return {} as T;
        }

        return response.text().then((text) => {
          return text ? (JSON.parse(text) as T) : null;
        }) as T;
      } catch (err: unknown) {
        clearTimeout(timeoutId);

        // Pass through our own errors
        if (err instanceof AgentforceClientError) {
          throw err;
        }

        // Handle abort/timeout
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new AgentforceNetworkError("Request timeout exceeded", retries + 1, {
            cause: err,
          });
        }

        // Handle fetch failures (network errors)
        if (err instanceof TypeError) {
          if (retries < this.maxRetries) {
            retries++;
            const jitter = Math.random() * 100;
            const delay = 300 * Math.pow(2, retries - 1) + jitter;
            this.logger.info(
              `Network error, retrying (${retries}/${this.maxRetries}) in ${delay.toFixed(0)}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new AgentforceNetworkError(`Network error: ${err.message}`, retries, {
            cause: err,
          });
        }

        throw new AgentforceClientError(
          `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
          "unknown",
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this._isConnected || !this._accessToken) {
      throw new AgentforceClientError(
        "Client is not connected. Call connect() first.",
        "unknown",
      );
    }
  }

  /**
   * Extract the expiration time (as epoch ms) from a JWT access token.
   * Returns 0 if the token cannot be parsed (treated as already expired).
   */
  private getTokenExpiry(token: string): number {
    try {
      const payload = token.split(".")[1];
      const decoded = JSON.parse(this.base64UrlDecode(payload));
      return (decoded.exp ?? 0) * 1000; // convert seconds to ms
    } catch {
      return 0;
    }
  }

  /**
   * Decode a base64URL string (the JWT segment alphabet: `-`/`_` instead of
   * `+`/`/`, and padding stripped). `atob` only accepts standard base64 and
   * THROWS on `-`/`_`, which real Salesforce token payloads routinely contain —
   * without this the token would be misread as unparseable → expiry 0 → treated
   * as already expired (breaking restore() and the reconnect token-validity
   * check). Translate the alphabet and restore padding before `atob`.
   */
  private base64UrlDecode(segment: string): string {
    let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = b64.length % 4;
    if (remainder) b64 += "=".repeat(4 - remainder);
    return atob(b64);
  }

  /**
   * Parse the entryPayload field from a conversation entry.
   * It may be a JSON string or already an object.
   */
  private parseEntryPayload(entry: ConversationEntry): Record<string, unknown> {
    if (!entry.entryPayload) return {};

    if (typeof entry.entryPayload === "string") {
      try {
        return JSON.parse(entry.entryPayload) as Record<string, unknown>;
      } catch {
        return {};
      }
    }

    return entry.entryPayload as Record<string, unknown>;
  }

  /**
   * Safely traverse nested objects and return the value at the given path.
   */
  private getNestedValue(obj: unknown, ...path: string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  /**
   * Safely traverse nested objects and return a string value, or empty string.
   */
  private getNestedString(obj: unknown, ...path: string[]): string {
    const value = this.getNestedValue(obj, ...path);
    return typeof value === "string" ? value : "";
  }
}
