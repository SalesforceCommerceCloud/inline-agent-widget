/**
 * Simple logger that can be enabled/disabled via configuration.
 * All messages are prefixed with [Agentforce] (the Salesforce product name).
 */
export class Logger {
  private readonly enabled: boolean;
  private readonly prefix = "[Agentforce]";

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  info(message: string, ...args: unknown[]): void {
    if (this.enabled) {
      console.log(`${this.prefix} ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.enabled) {
      console.warn(`${this.prefix} ${message}`, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.enabled) {
      console.error(`${this.prefix} ${message}`, ...args);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled) {
      console.debug(`${this.prefix} ${message}`, ...args);
    }
  }
}
