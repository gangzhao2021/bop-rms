/** Merchant BFF shared HTTP helpers: cookies, origin/host checks, safe reads and shared failure replies. */
import express, { type Request, type RequestHandler } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export const NO_STORE = "no-store";

export function rawHeaderValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

export function cookie(request: Request, name: string): string | null {
  const headers = rawHeaderValues(request, "cookie");
  const header = headers[0];
  if (headers.length !== 1 || header === undefined || header.length > 4096) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match === undefined) return null;
  const value = match.slice(name.length + 1);
  return value && !/[\s;,]/u.test(value) ? value : null;
}

export function exactHeader(request: Request, name: string): string | null {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

export function safeRead(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      (fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

export function sameOriginMutation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (
      exactHeader(request, "origin") !== options.exactOrigin ||
      exactHeader(request, "sec-fetch-site") !== "same-origin"
    ) {
      denied(response);
      return;
    }
    next();
  };
}

/** WP-2423 Q19: a read that kept meeting a database transaction conflict is "retry later"
 * (503), never a permission refusal; anything else stays a plain denial. */
export function refundReadFailure(response: express.Response, error: unknown): void {
  const code =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined;
  if (code === "TENANT_DATABASE_TRANSACTION_CONFLICT") {
    response
      .status(503)
      .set("Cache-Control", NO_STORE)
      .set("Retry-After", "1")
      .json({ error: "retry_later" });
    return;
  }
  denied(response);
}

/**
 * v15 finding: a read that kept meeting a database transaction conflict after its own reruns
 * (Store setup sections read together on page load) answers "retry later": 503 with Retry-After,
 * so the page retries instead of reporting an outage. Returns false for any other error.
 */
export function transactionConflictRetryLater(response: express.Response, error: unknown): boolean {
  if (
    error === null ||
    typeof error !== "object" ||
    Object.getOwnPropertyDescriptor(error, "code")?.value !== "TENANT_DATABASE_TRANSACTION_CONFLICT"
  )
    return false;
  response
    .status(503)
    .set("Cache-Control", NO_STORE)
    .set("Retry-After", "1")
    .json({ error: "retry_later" });
  return true;
}

export function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}
