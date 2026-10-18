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

/** The failure's code: an owner error's `code`, or the UPPER_SNAKE message of a plain Error. */
function failureCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  if (typeof code === "string") return code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)
    ? error.message
    : null;
}

/**
 * Why a merchant read failed, for the reply. WP-2423 Q19: a read that kept meeting a database
 * transaction conflict is "retry later" (503). v15 2026-10-18 (dd750045): a read that met facts
 * recorded while it was loading (an Order's refund history that changed under it) is
 * "changed while loading" (409, retry at once), and a dependency that could not be read is
 * "retry later" (503) — never a permission refusal, which staff read as "you may not do this".
 * Only a refusal (`*_DENIED`) or an unrecognised failure stays a plain denial (403).
 */
export function readFailureKind(error: unknown): "RetryLater" | "Changed" | "Denied" {
  const code = failureCode(error);
  if (code === null) return "Denied";
  if (code === "TENANT_DATABASE_TRANSACTION_CONFLICT" || code === "TENANT_DATABASE_ACQUIRE_FAILED")
    return "RetryLater";
  if (code === "TENANT_DATABASE_TRANSACTION_FAILED") {
    // A statement cancelled by its timeout or a lost connection is transient; a refused row
    // (a missing grant) or any other database failure stays a refusal.
    const diagnostic = Object.getOwnPropertyDescriptor(error, "diagnostic")?.value as
      { sqlState?: unknown } | null | undefined;
    const sqlState = diagnostic?.sqlState;
    return typeof sqlState === "string" && (sqlState === "57014" || sqlState.startsWith("08"))
      ? "RetryLater"
      : "Denied";
  }
  if (code.endsWith("_DENIED")) return "Denied";
  if (code.endsWith("_HISTORY_UNAVAILABLE") || code.endsWith("_READ_CHANGED")) return "Changed";
  if (code.endsWith("_UNAVAILABLE")) return "RetryLater";
  return "Denied";
}

export function refundReadFailure(response: express.Response, error: unknown): void {
  const kind = readFailureKind(error);
  if (kind === "Denied") {
    denied(response);
    return;
  }
  response
    .status(kind === "Changed" ? 409 : 503)
    .set("Cache-Control", NO_STORE)
    .set("Retry-After", kind === "Changed" ? "0" : "1")
    .json({ error: kind === "Changed" ? "changed_while_loading" : "retry_later" });
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
