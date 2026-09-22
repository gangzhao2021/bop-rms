import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { CheckoutSessionServiceError } from "@rms/ordering";
import type { RequestHandler, Response } from "express";

export const customerPaymentResultRoute =
  "/api/v1/checkout-sessions/:checkout_session_id/payment-result";
export interface CustomerPaymentResultInput {
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
    error: { code: "payment_result_" + code, messageKey: "customer.payment.result." + code },
  });
}
export class CustomerPaymentResultHandler {
  readonly #origin: string;
  readonly #port: { read(input: CustomerPaymentResultInput): Promise<unknown> };
  constructor(options: {
    allowedOrigin: string;
    port: { read(input: CustomerPaymentResultInput): Promise<unknown> };
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(mode: "read" | "reconcile" = "read"): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerPaymentResultInput;
      try {
        if (
          mode === "reconcile" &&
          (request.method !== "POST" ||
            request.get("origin") !== this.#origin ||
            request.is("application/json") !== "application/json")
        )
          throw new Error();
        if (
          (request.get("origin") !== undefined && request.get("origin") !== this.#origin) ||
          request.get("sec-fetch-site") !== "same-origin" ||
          Object.keys(request.query).length !== 0
        )
          throw new Error();
        readClosedRecord(request.body ?? {}, []);
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
        const result = readClosedRecord(await this.#port.read(input), [
          "checkoutSessionReference",
          "paymentIntentReference",
          "orderReference",
          "status",
          "total",
        ]);
        if (
          result.checkoutSessionReference !== input.checkoutSessionReference ||
          !["Pending", "Unknown", "Succeeded", "Failed"].includes(String(result.status))
        )
          throw new Error();
        if (result.paymentIntentReference === null) {
          if (
            result.status !== "Pending" ||
            result.orderReference !== null ||
            result.total !== null
          )
            throw new Error();
        } else {
          if (
            typeof result.paymentIntentReference !== "string" ||
            !reference.test(result.paymentIntentReference) ||
            typeof result.orderReference !== "string" ||
            !reference.test(result.orderReference)
          )
            throw new Error();
          const total = readClosedRecord(result.total, ["amountMinor", "currency"]);
          if (
            total.currency !== "CAD" ||
            typeof total.amountMinor !== "string" ||
            !/^(0|[1-9][0-9]{0,18})$/u.test(total.amountMinor) ||
            BigInt(total.amountMinor) > 9223372036854775807n
          )
            throw new Error();
        }
        response.status(200).json({ schemaVersion: 1, payment: result });
      } catch (error) {
        const status =
          error instanceof GuestSessionError
            ? 404
            : error instanceof CheckoutSessionServiceError && error.code === "PERMISSION_DENIED"
              ? 404
              : 503;
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerPaymentResultHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
