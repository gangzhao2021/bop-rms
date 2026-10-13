import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import type { CustomerDiningSessionView, CustomerMoney } from "./customer-dining-session-read.js";

/** WP-2423 Q8 (CUST-DINE-IN-SESSION): the guest's own table; the browser never names a session. */
export const customerDiningSessionRoute = "/api/v1/dine-in/session";
export interface CustomerDiningSessionInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
}
const credential = /^[A-Za-z0-9_-]{43}$/u;

function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, status: 400 | 404 | 503) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400 ? "request_invalid" : status === 404 ? "not_found" : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "dining_session_" + code, messageKey: "customer.dining.session." + code },
  });
}
function money(value: CustomerMoney) {
  if (
    typeof value.amountMinor !== "bigint" ||
    value.amountMinor < -(2n ** 63n) ||
    value.amountMinor > 2n ** 63n - 1n
  )
    throw new Error("invalid amount");
  return { amountMinor: value.amountMinor.toString(), currencyCode: value.currencyCode };
}

export class CustomerDiningSessionHandler {
  readonly #origin: string;
  readonly #port: { read(input: CustomerDiningSessionInput): Promise<CustomerDiningSessionView> };
  constructor(options: {
    allowedOrigin: string;
    port: { read(input: CustomerDiningSessionInput): Promise<CustomerDiningSessionView> };
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerDiningSessionInput;
      try {
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
        const csrf = request.headers["x-csrf-token"];
        if (
          entries.length !== 1 ||
          entries[0]?.length !== 2 ||
          !credential.test(entries[0]?.[1] ?? "") ||
          typeof csrf !== "string" ||
          !credential.test(csrf)
        )
          throw new Error();
        input = { sessionCredential: entries[0]?.[1] as string, csrfCredential: csrf };
      } catch {
        reject(response, 400);
        return;
      }
      try {
        const view = await this.#port.read(input);
        // Explicit public-field serialization: no owner references, guest identity or codes.
        const session = {
          tableLabel: view.tableLabel,
          orderNumber: view.orderNumber,
          checkedAt: view.checkedAt,
          rounds: view.rounds.map((round) => ({
            roundNumber: round.roundNumber,
            orderedBy: round.orderedBy,
            submittedAt: round.submittedAt,
            status: round.status,
            payment: round.payment,
            cancelsAt: round.cancelsAt,
            storeCancellationReason: round.storeCancellationReason,
            items: round.items.map((item) => ({
              displayName: item.displayName,
              quantity: item.quantity,
              servedQuantity: item.servedQuantity,
              cancelled: item.cancelled,
              lineTotal: money(item.lineTotal),
            })),
            itemsTotal: money(round.itemsTotal),
          })),
          summary:
            view.summary === null
              ? null
              : {
                  paid: money(view.summary.paid),
                  refunded: money(view.summary.refunded),
                  refundPending: money(view.summary.refundPending),
                  due: money(view.summary.due),
                },
        };
        response.status(200).json({ schemaVersion: 1, session });
      } catch (error) {
        const status =
          error instanceof GuestSessionError ||
          (error instanceof OrderStatusProjectionError &&
            ["ORDER_STATUS_PERMISSION_DENIED", "ORDER_STATUS_NOT_FOUND"].includes(error.code))
            ? 404
            : 503;
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerDiningSessionHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
