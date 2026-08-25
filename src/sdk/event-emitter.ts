import type { AgentforceEventMap, AgentforceEventName } from "./types";

type Listener = (...args: unknown[]) => void;

/**
 * Minimal typed event emitter for internal use.
 * Provides .on(), .once(), .off(), and .emit() with type safety
 * matching the AgentforceEventMap.
 */
export class TypedEventEmitter {
  private listeners = new Map<string, Set<Listener>>();
  private onceListeners = new Map<string, Set<Listener>>();

  /**
   * Register a persistent event handler.
   */
  on<E extends AgentforceEventName>(
    event: E,
    handler: AgentforceEventMap[E] extends void
      ? () => void
      : (payload: AgentforceEventMap[E]) => void,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as Listener);
  }

  /**
   * Register a one-time event handler (removed after first invocation).
   */
  once<E extends AgentforceEventName>(
    event: E,
    handler: AgentforceEventMap[E] extends void
      ? () => void
      : (payload: AgentforceEventMap[E]) => void,
  ): void {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(handler as Listener);
  }

  /**
   * Remove an event handler. If no handler is provided, removes all
   * handlers for that event. If no event is provided, removes everything.
   */
  off<E extends AgentforceEventName>(
    event?: E,
    handler?: AgentforceEventMap[E] extends void
      ? () => void
      : (payload: AgentforceEventMap[E]) => void,
  ): void {
    if (!event) {
      this.listeners.clear();
      this.onceListeners.clear();
      return;
    }

    if (!handler) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
      return;
    }

    this.listeners.get(event)?.delete(handler as Listener);
    this.onceListeners.get(event)?.delete(handler as Listener);
  }

  /**
   * Emit an event to all registered handlers.
   */
  protected emit<E extends AgentforceEventName>(
    event: E,
    ...args: AgentforceEventMap[E] extends void ? [] : [AgentforceEventMap[E]]
  ): void {
    const persistent = this.listeners.get(event);
    if (persistent) {
      for (const handler of persistent) {
        try {
          handler(...args);
        } catch {
          // Don't let listener errors crash the SDK
        }
      }
    }

    const once = this.onceListeners.get(event);
    if (once) {
      for (const handler of once) {
        try {
          handler(...args);
        } catch {
          // Don't let listener errors crash the SDK
        }
      }
      this.onceListeners.delete(event);
    }
  }
}
