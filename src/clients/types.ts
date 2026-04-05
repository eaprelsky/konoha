/**
 * types.ts — shared config interface for all API clients.
 */

export interface ApiClientConfig {
  baseUrl: string;
  token: string;
  retryAttempts?: number;  // default: 3
  retryDelay?: number;     // default: 1000ms, exponential backoff
  timeout?: number;        // default: 30000ms
  rateLimitRps?: number;   // requests per second
}
