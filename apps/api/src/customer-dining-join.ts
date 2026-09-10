import {
  guestSessionCookie,
  parseGuestOperationReference,
  parseGuestDiningAdmissionReference,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import type { Request, RequestHandler, Response } from "express";
import type { CustomerDiningJoinRequestContext } from "./customer-dining-join-composition.js";
export const customerDiningJoinRoute = "/bff/customer/dining/join";
export interface CustomerDiningJoinPort {
  join(
    input: {
      readonly operationReference: string;
      readonly sessionCredential: string;
      readonly csrfCredential: string;
      readonly joinCredential: string;
    },
    context: CustomerDiningJoinRequestContext,
  ): Promise<unknown>;
}
function controls(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}
function error(response: Response, invalid = false) {
  response.status(invalid ? 400 : 503).json({
    error: {
      code: invalid ? "dining_join_request_invalid" : "dining_join_unavailable",
      messageKey: invalid
        ? "customer.dining.join_request_invalid"
        : "customer.dining.join_unavailable",
    },
  });
}
function single(request: Request, name: string): string {
  const count = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  ).length;
  const value = request.get(name);
  if (count !== 1 || value === undefined) throw new Error("invalid request header");
  return value;
}
function cookie(header: string, name: string): string | null {
  const values: string[] = [];
  for (const field of header.split(";")) {
    const trimmed = field.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error("invalid cookie");
    if (trimmed.slice(0, separator) === name) values.push(trimmed.slice(separator + 1));
  }
  if (values.length > 1) throw new Error("ambiguous credential cookie");
  return values.length === 0 ? null : parseGuestRawCredential(values[0]);
}

function credential(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid credential");
  if (/^[0-9]{6}$/.test(value)) return value;
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error("invalid credential");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== value)
    throw new Error("invalid credential");
  return value;
}
export const unavailableCustomerDiningJoinHandler: RequestHandler = (_request, response) => {
  controls(response);
  error(response);
};
/** Transport only: Identity and Dining own current authority and effects. */
export class CustomerDiningJoinHandler {
  readonly #origin: string;
  readonly #port: CustomerDiningJoinPort;
  readonly #resolve: (request: Request) => Promise<CustomerDiningJoinRequestContext | null>;
  constructor(options: {
    allowedOrigin: string;
    port: CustomerDiningJoinPort;
    resolveRequestContext: (request: Request) => Promise<CustomerDiningJoinRequestContext | null>;
  }) {
    const origin = new URL(options.allowedOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== options.allowedOrigin ||
      origin.username !== "" ||
      origin.password !== ""
    )
      throw new TypeError("allowedOrigin must be an exact HTTPS origin");
    this.#origin = origin.origin;
    this.#port = options.port;
    this.#resolve = options.resolveRequestContext;
  }
  join(): RequestHandler {
    return async (request, response) => {
      controls(response);
      let operationReference: string;
      let sessionCredential: string;
      let csrfCredential: string;
      let joinCredential: string;
      try {
        if (
          request.method !== "POST" ||
          request.originalUrl !== customerDiningJoinRoute ||
          single(request, "origin") !== this.#origin ||
          single(request, "sec-fetch-site") !== "same-origin" ||
          single(request, "sec-fetch-mode") !== "cors" ||
          !single(request, "content-type") ||
          request.is("application/json") !== "application/json"
        )
          throw new Error("invalid request");
        operationReference = parseGuestOperationReference(single(request, "idempotency-key"));
        csrfCredential = parseGuestRawCredential(single(request, "x-csrf-token"));
        const current = cookie(single(request, "cookie"), guestSessionCookie.name);
        if (current === null || current === csrfCredential) throw new Error("invalid credentials");
        sessionCredential = current;
        joinCredential = credential(
          readClosedRecord(request.body, ["joinCredential"]).joinCredential,
        );
      } catch {
        error(response, true);
        return;
      }
      try {
        const context = await this.#resolve(request);
        if (context === null || context === undefined || typeof context.abuse?.admit !== "function")
          throw new Error("missing request context");
        const result = readClosedRecord(
          await this.#port.join(
            { operationReference, sessionCredential, csrfCredential, joinCredential },
            context,
          ),
          ["status", "operationReference", "admissionReference"],
        );
        const admissionReference = parseGuestDiningAdmissionReference(result.admissionReference);
        if (result.status !== "Joined" || result.operationReference !== operationReference)
          throw new Error("invalid join result");
        response.status(200).json({ status: "Joined", operationReference, admissionReference });
      } catch {
        error(response);
      }
    };
  }
}
