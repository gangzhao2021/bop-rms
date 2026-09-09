import {
  guestSessionCookie,
  parseCanonicalInstant,
  parseGuestOperationReference,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import type { Request, RequestHandler, Response } from "express";
export const customerCartBindingRoutes = Object.freeze({
  prepare: "/bff/customer/cart-binding/prepare",
  activate: "/bff/customer/cart-binding/activate",
  complete: "/bff/customer/cart-binding/complete",
});
interface Credentials {
  readonly operationReference: string;
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}
export interface CustomerCartBindingPort {
  prepare(input: Credentials): Promise<unknown>;
  activate(
    input: Credentials & {
      readonly candidateSessionCredential: string;
      readonly candidateCsrfCredential: string;
      readonly recoveryProof: string;
    },
  ): Promise<unknown>;
  complete(input: Credentials): Promise<unknown>;
}
type Action = keyof typeof customerCartBindingRoutes;
function stagedName(operation: string) {
  return `__Host-bop-guest-candidate-${operation}`;
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
      code: invalid ? "cart_binding_request_invalid" : "cart_binding_unavailable",
      messageKey: invalid
        ? "customer.cart.binding_request_invalid"
        : "customer.cart.binding_unavailable",
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
function serialize(name: string, value: string, clear = false) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax${clear ? "; Max-Age=0" : ""}`;
}
export const unavailableCustomerCartBindingHandler: RequestHandler = (_request, response) => {
  controls(response);
  error(response);
};

/** Credential transport only. The supplied Identity service owns current authorization and all effects. */
export class CustomerCartBindingHandler {
  readonly #origin: string;
  readonly #port: CustomerCartBindingPort;
  readonly #now: () => string;
  constructor(options: {
    allowedOrigin: string;
    port: CustomerCartBindingPort;
    now?: () => string;
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
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  prepare(): RequestHandler {
    return this.#handler("prepare");
  }
  activate(): RequestHandler {
    return this.#handler("activate");
  }
  complete(): RequestHandler {
    return this.#handler("complete");
  }
  #handler(action: Action): RequestHandler {
    return async (request, response) => {
      controls(response);
      let operationReference: string;
      let sessionCredential: string;
      let csrfCredential: string;
      let candidateSessionCredential: string | null;
      let candidateCsrfCredential: string | null = null;
      let recoveryProof: string | null = null;
      try {
        if (
          request.method !== "POST" ||
          request.originalUrl !== customerCartBindingRoutes[action] ||
          single(request, "origin") !== this.#origin ||
          single(request, "sec-fetch-site") !== "same-origin" ||
          single(request, "sec-fetch-mode") !== "cors" ||
          !single(request, "content-type") ||
          request.is("application/json") !== "application/json"
        )
          throw new Error("invalid request");
        operationReference = parseGuestOperationReference(single(request, "idempotency-key"));
        csrfCredential = parseGuestRawCredential(single(request, "x-csrf-token"));
        const header = single(request, "cookie");
        const current = cookie(header, guestSessionCookie.name);
        candidateSessionCredential = cookie(header, stagedName(operationReference));
        const selected = action === "complete" ? (candidateSessionCredential ?? current) : current;
        if (selected === null) throw new Error("missing credential");
        sessionCredential = selected;
        const body = readClosedRecord(
          request.body,
          action === "activate" ? ["candidateCsrfToken", "recoveryProof"] : [],
        );
        if (action === "activate") {
          candidateCsrfCredential = parseGuestRawCredential(body.candidateCsrfToken);
          recoveryProof = parseGuestRawCredential(body.recoveryProof);
          if (
            candidateSessionCredential === null ||
            new Set([
              sessionCredential,
              csrfCredential,
              candidateSessionCredential,
              candidateCsrfCredential,
              recoveryProof,
            ]).size !== 5
          )
            throw new Error("invalid acknowledgement");
        } else if (sessionCredential === csrfCredential) throw new Error("invalid credentials");
      } catch {
        error(response, true);
        return;
      }
      try {
        if (action === "prepare") {
          const raw = readClosedRecord(
            await this.#port.prepare({ operationReference, sessionCredential, csrfCredential }),
            [
              "status",
              "operationReference",
              "sessionCredential",
              "csrfCredential",
              "recoveryProof",
              "expiresAt",
            ],
          );
          const candidate = parseGuestRawCredential(raw.sessionCredential);
          const csrf = parseGuestRawCredential(raw.csrfCredential);
          const proof = parseGuestRawCredential(raw.recoveryProof);
          const expiresAt = parseCanonicalInstant(raw.expiresAt);
          const now = parseCanonicalInstant(this.#now());
          if (
            raw.status !== "Prepared" ||
            raw.operationReference !== operationReference ||
            Date.parse(expiresAt) <= Date.parse(now) ||
            Date.parse(expiresAt) - Date.parse(now) > 900000 ||
            new Set([sessionCredential, csrfCredential, candidate, csrf, proof]).size !== 5
          )
            throw new Error("invalid preparation result");
          response.setHeader("Set-Cookie", serialize(stagedName(operationReference), candidate));
          response.status(200).json({
            status: "Prepared",
            operationReference,
            candidateCsrfToken: csrf,
            recoveryProof: proof,
            expiresAt,
          });
          return;
        }
        const credentials = { operationReference, sessionCredential, csrfCredential };
        const expectedSession =
          action === "activate" ? candidateSessionCredential : sessionCredential;
        const expectedCsrf = action === "activate" ? candidateCsrfCredential : csrfCredential;
        if (expectedSession === null || expectedCsrf === null)
          throw new Error("missing credentials");
        const value =
          action === "activate"
            ? await this.#port.activate({
                ...credentials,
                candidateSessionCredential: expectedSession,
                candidateCsrfCredential: expectedCsrf,
                recoveryProof: recoveryProof ?? "",
              })
            : await this.#port.complete(credentials);
        const raw = readClosedRecord(value, [
          "status",
          "operationReference",
          "sessionCredential",
          "csrfCredential",
          "cookie",
        ]);
        const descriptor = readClosedRecord(raw.cookie, [
          "name",
          "secure",
          "httpOnly",
          "sameSite",
          "path",
          "domain",
        ]);
        if (
          raw.status !== "Activated" ||
          raw.operationReference !== operationReference ||
          raw.sessionCredential !== expectedSession ||
          raw.csrfCredential !== expectedCsrf ||
          descriptor.name !== guestSessionCookie.name ||
          descriptor.secure !== true ||
          descriptor.httpOnly !== true ||
          descriptor.sameSite !== "lax" ||
          descriptor.path !== "/" ||
          descriptor.domain !== null ||
          expectedSession === expectedCsrf
        )
          throw new Error("invalid activation result");
        response.setHeader("Set-Cookie", [
          serialize(guestSessionCookie.name, expectedSession),
          serialize(stagedName(operationReference), "", true),
        ]);
        response
          .status(200)
          .json({ status: "Activated", operationReference, csrfToken: expectedCsrf });
      } catch {
        error(response);
      }
    };
  }
}
