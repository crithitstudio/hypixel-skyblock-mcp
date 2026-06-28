import type { RateLimitInfo } from "./types.js";

export class McpUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpUserError";
  }
}

export class HypixelApiError extends Error {
  readonly status: number;
  readonly rateLimit?: RateLimitInfo;
  readonly body?: unknown;

  constructor(message: string, status: number, options?: { rateLimit?: RateLimitInfo; body?: unknown }) {
    super(message);
    this.name = "HypixelApiError";
    this.status = status;
    this.rateLimit = options?.rateLimit;
    this.body = options?.body;
  }
}
