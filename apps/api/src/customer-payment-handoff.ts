import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { CheckoutSessionServiceError } from "@rms/ordering";
import { CustomerPaymentHandoffError } from "@rms/payment";
import type { RequestHandler, Response } from "express";

export const customerPaymentHandoffRoute =
  "/api/v1/checkout-sessions/:checkout_session_id/payment-handoff";
export interface CustomerPaymentHandoffInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly checkoutSessionReference: string;
}
const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, status: number) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400
      ? "request_invalid"
      : status === 404
        ? "not_found"
        : status === 422
          ? "not_ready"
          : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "payment_handoff_" + code, messageKey: "customer.payment.handoff." + code },
  });
}
export class CustomerPaymentHandoffHandler {
  readonly #origin: string;
  readonly #port: { retrieve(input: CustomerPaymentHandoffInput): Promise<unknown> };
  constructor(options: {
    allowedOrigin: string;
    port: { retrieve(input: CustomerPaymentHandoffInput): Promise<unknown> };
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerPaymentHandoffInput;
      try {
        if (
          request.get("origin") !== this.#origin ||
          request.get("sec-fetch-site") !== "same-origin" ||
          request.is("application/json") !== "application/json" ||
          Object.keys(request.query).length !== 0
        )
          throw new Error();
        readClosedRecord(request.body, []);
        const entries = (request.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim().split("="))
          .filter(([name]) => name === "__Host-bop-guest");
        const csrf = request.headers["x-csrf-token"],
          id = request.params.checkout_session_id;
        if (
          entries.length !== 1 ||
          entries[0]?.length !== 2 ||
          !credential.test(entries[0]?.[1] ?? "") ||
          typeof csrf !== "string" ||
          !credential.test(csrf) ||
          typeof id !== "string" ||
          !reference.test(id)
        )
          throw new Error();
        input = {
          sessionCredential: entries[0]?.[1] as string,
          csrfCredential: csrf,
          checkoutSessionReference: id,
        };
      } catch {
        reject(response, 400);
        return;
      }
      try {
        const result = readClosedRecord(await this.#port.retrieve(input), ["clientSecret"]);
        if (
          typeof result.clientSecret !== "string" ||
          result.clientSecret.length > 512 ||
          !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u.test(result.clientSecret)
        )
          throw new Error();
        response.status(200).json({ schemaVersion: 1, clientSecret: result.clientSecret });
      } catch (error) {
        const status =
          error instanceof GuestSessionError
            ? 404
            : error instanceof CheckoutSessionServiceError && error.code === "PERMISSION_DENIED"
              ? 404
              : error instanceof CustomerPaymentHandoffError && error.code === "NOT_READY"
                ? 422
                : 503;
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerPaymentHandoffHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
