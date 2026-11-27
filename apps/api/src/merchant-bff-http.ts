/** Merchant BFF shared HTTP helpers: cookies, origin/host checks, safe reads and shared failure replies. */
import express, { type Request, type RequestHandler } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import {
  isExpectedContention,
  merchantFailureCode,
  merchantFailureKind,
} from "./merchant-failure.js";

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

/**
 * WP-2423 item 10: tells the log about a failure, once per request. The router installs the reporter
 * (createMerchantBffRouter), with the Express route's own template and never an id. Contention that
 * outlasted its own reruns is ordinary service, so it is answered and not logged; reporting never
 * changes the answer. Only a route that answers something other than 5xx calls this itself.
 */
export function reportFailure(response: express.Response, error: unknown): void {
  response.locals.failureReported = true;
  if (isExpectedContention(error)) return;
  const report = response.locals.reportFailure as ((failure: unknown) => void) | undefined;
  try {
    report?.(error);
  } catch {
    // Reporting never changes the answer.
  }
}

/**
 * For a route with its own answers: if this request ends in a 5xx, that is the failure to report
 * (the router reports it as the answer is written), so no 5xx loses its code and frames.
 */
export function noteFailure(response: express.Response, error: unknown): void {
  if (error !== undefined) response.locals.failure = error;
}

/**
 * WP-2423 item 10: the answer to any failure a route has no typed answer for. A failure is a
 * permission refusal only when the error says so (merchantFailureKind). Facts that moved under the
 * request answer 409, so the page reads again. Anything else is logged by code and frames and
 * answered 503 `retry_later`, the body the workspace and refund clients already understand:
 * "try again, it may not have saved" is true, "you have no permission" would not be.
 */
export function failed(response: express.Response, error: unknown): void {
  const kind = merchantFailureKind(error);
  if (kind === "Refused") {
    denied(response);
    return;
  }
  if (kind === "Changed") {
    response
      .status(409)
      .set("Cache-Control", NO_STORE)
      .set("Retry-After", "0")
      .json({ error: "changed_while_loading" });
    return;
  }
  noteFailure(response, error);
  response
    .status(503)
    .set("Cache-Control", NO_STORE)
    .set("Retry-After", kind === "RetryLater" ? "1" : "5")
    .json({ error: "retry_later" });
}

/** The read routes' name for the same answer (WP-2423 Q19, v15 2026-10-18). */
export const refundReadFailure = failed;

/**
 * v15 finding: a read that kept meeting a database transaction conflict after its own reruns
 * (Store setup sections read together on page load) answers "retry later": 503 with Retry-After,
 * so the page retries instead of reporting an outage. Returns false for any other error.
 */
export function transactionConflictRetryLater(response: express.Response, error: unknown): boolean {
  if (merchantFailureCode(error) !== "TENANT_DATABASE_TRANSACTION_CONFLICT") return false;
  failed(response, error);
  return true;
}

export function denied(response: express.Response): void {
  response.status(403).set("Cache-Control", NO_STORE).json({ error: "request_denied" });
}
