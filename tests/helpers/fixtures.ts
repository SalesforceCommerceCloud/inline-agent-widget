import type { AgentforceClientOptions } from "../../src/sdk";

export const TEST_BASE_URL = "https://test.salesforce-scrt.com";
export const TEST_ORG_ID = "00DQZ000000TEST";
export const TEST_ES_NAME = "TestAgent";
// Valid JWT structure with far-future exp (year 2100) so getTokenExpiry() returns a future timestamp.
// Payload: {"sub":"test-uid-123","exp":4102444800}
export const TEST_ACCESS_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVpZC0xMjMiLCJleHAiOjQxMDI0NDQ4MDB9.bW9jay1zaWduYXR1cmU";
export const TEST_CONVERSATION_ID = "550e8400-e29b-41d4-a716-446655440000";

export function createClientOptions(
  overrides: Partial<AgentforceClientOptions> = {},
): AgentforceClientOptions {
  return {
    baseURL: TEST_BASE_URL,
    orgId: TEST_ORG_ID,
    esDeveloperName: TEST_ES_NAME,
    options: {
      enableLogging: false,
      maxRetries: 3,
      timeout: 15000,
      maxReconnectAttempts: 5,
      reconnectDelay: 2000,
      ...(overrides.options ?? {}),
    },
    ...overrides,
  };
}
