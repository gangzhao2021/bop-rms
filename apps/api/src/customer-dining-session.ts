import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import { customerFailureCode } from "./customer-failure-diagnostic.js";
import { markRequestFailure, markRequestRetryLater } from "./request-correlation.js";
import { customerDisplayLocale } from "./customer-display-locale.js";
import {
  DiningOrderStillProcessingError,
  DiningTableMovedError,
  type CustomerDiningSessionView,
  type CustomerBillView,
  type CustomerMoney,
} from "./customer-dining-session-read.js";

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
/** b13: a bill or round as printed — public amounts only. */
function billLines(bill: CustomerBillView) {
  return {
    items: money(bill.items),
    takenOff: money(bill.takenOff),
    pointsUsed: money(bill.pointsUsed),
    subtotal: money(bill.subtotal),
    tax: money(bill.tax),
    total: money(bill.total),
  };
}

interface DiningSessionPort {
  /** `displayLocale` (Owner 2026-10-23): the guest's chosen language for item names. */
  read(
    input: CustomerDiningSessionInput,
    displayLocale?: string,
  ): Promise<CustomerDiningSessionView>;
}
export class CustomerDiningSessionHandler {
  readonly #origin: string;
  readonly #port: DiningSessionPort;
  constructor(options: { allowedOrigin: string; port: DiningSessionPort }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerDiningSessionInput;
      let displayLocale: string | null;
      try {
        if (
          (request.get("origin") !== undefined && request.get("origin") !== this.#origin) ||
          request.get("sec-fetch-site") !== "same-origin"
        )
          throw new Error();
        displayLocale = customerDisplayLocale(request.query);
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
        const view =
          displayLocale === null
            ? await this.#port.read(input)
            : await this.#port.read(input, displayLocale);
        // Explicit public-field serialization: no owner references, guest identity or codes.
        const session = {
          tableLabel: view.tableLabel,
          orderNumber: view.orderNumber,
          checkedAt: view.checkedAt,
          paymentTiming: view.paymentTiming,
          ...(view.startedByGuest === true ? { startedByGuest: true } : {}),
          ...(view.movedFromTableLabel === undefined
            ? {}
            : { movedFromTableLabel: view.movedFromTableLabel }),
          rounds: view.rounds.map((round) => ({
            roundNumber: round.roundNumber,
            orderedBy: round.orderedBy,
            submittedAt: round.submittedAt,
            status: round.status,
            payment: round.payment,
            cancelsAt: round.cancelsAt,
            storeCancellationReason: round.storeCancellationReason,
            ...(round.waitingReason ? { waitingReason: round.waitingReason } : {}),
            ...(round.stoppedBeforePaying === true ? { stoppedBeforePaying: true } : {}),
            ...(round.tea === true ? { tea: true } : {}),
            ...(round.charge === true ? { charge: true } : {}),
            // M41: a paid round the store has not accepted yet ("Still waiting? Let staff know").
            ...(round.awaitingStore === true ? { awaitingStore: true } : {}),
            items: round.items.map((item) => ({
              displayName: item.displayName,
              quantity: item.quantity,
              servedQuantity: item.servedQuantity,
              cancelled: item.cancelled,
              lineTotal: money(item.lineTotal),
              // WP-2423 D5: the item's price before tax, when every item's price is known.
              ...(item.priceBeforeTax === undefined
                ? {}
                : { priceBeforeTax: money(item.priceBeforeTax) }),
              // WP-2423 Q26: only while the kitchen is making this item again (as on pickup).
              ...(item.beingRemade === true ? { beingRemade: true } : {}),
              // M91: Waiting / Making / Ready / Served; absent for a cancelled dish or a charge.
              ...(item.progress === undefined ? {} : { progress: item.progress }),
              // WP-2423 item 8 ③ (decision 13): the published menu item and options "Order
              // again" adds to this guest's own cart; public menu references only.
              ...(item.orderAgain === undefined
                ? {}
                : {
                    orderAgain: {
                      sellableReference: item.orderAgain.sellableReference,
                      optionSelections: item.orderAgain.optionSelections.map((option) => ({
                        optionReference: option.optionReference,
                        quantity: option.quantity,
                      })),
                    },
                  }),
            })),
            ...(round.subtotal === undefined || round.tax === undefined
              ? {}
              : { subtotal: money(round.subtotal), tax: money(round.tax) }),
            itemsTotal: money(round.itemsTotal),
            // b13: a round on the table's bill, as the bill prints it.
            ...(round.bill === undefined ? {} : { bill: billLines(round.bill) }),
          })),
          summary:
            view.summary === null
              ? null
              : {
                  paid: money(view.summary.paid),
                  refunded: money(view.summary.refunded),
                  refundPending: money(view.summary.refundPending),
                  due: money(view.summary.due),
                  // WP-2423 item 8 ④: the table pays in parts (how many, how many paid).
                  ...(view.summary.splitParts === undefined
                    ? {}
                    : { splitParts: view.summary.splitParts }),
                  // WP-2423 item 8 ⑦ 4b-3: the per-head tea: one guest's tea and how many.
                  ...(view.summary.teaCharge === undefined
                    ? {}
                    : {
                        teaCharge: {
                          perGuest: money(view.summary.teaCharge.perGuest),
                          guests: view.summary.teaCharge.guests,
                          name: view.summary.teaCharge.name,
                        },
                      }),
                  ...(view.summary.pointsUsed === undefined
                    ? {}
                    : { pointsUsed: money(view.summary.pointsUsed) }),
                  ...(view.summary.takenOff === undefined
                    ? {}
                    : { takenOff: money(view.summary.takenOff) }),
                  ...(view.summary.taxRounding === undefined
                    ? {}
                    : { taxRounding: money(view.summary.taxRounding) }),
                  // b13 (DEC-TAX-WHOLE-RECEIPT): the whole bill as staff checkout prints it.
                  ...(view.summary.bill === undefined
                    ? {}
                    : { bill: billLines(view.summary.bill) }),
                  // DEC-DINE-IN-PAY-LATER: the table's one payment's tip and cash rounding.
                  ...(view.summary.cashRounding === undefined || view.summary.tableTip === undefined
                    ? {}
                    : {
                        tableTip: money(view.summary.tableTip),
                        cashRounding: money(view.summary.cashRounding),
                      }),
                  ...(view.summary.ordered === undefined
                    ? {}
                    : {
                        ordered: {
                          subtotal: money(view.summary.ordered.subtotal),
                          tax: money(view.summary.ordered.tax),
                          total: money(view.summary.ordered.total),
                        },
                      }),
                },
        };
        response.status(200).json({ schemaVersion: 1, session });
      } catch (error) {
        // WP-2423 item 8 ⑧: staff moved the party; this phone scans the new table's code.
        if (error instanceof DiningTableMovedError) {
          protect(response);
          response.status(409).json({
            schemaVersion: 1,
            error: {
              code: "dining_table_moved",
              messageKey: "customer.dining.session.table_moved",
            },
            tableLabel: error.tableLabel,
            ...(error.merged ? { merged: true } : {}),
          });
          return;
        }
        // v15 2026-10-27: the first round's Order is still being prepared — read again shortly.
        if (error instanceof DiningOrderStillProcessingError) {
          markRequestRetryLater(request);
          protect(response);
          response.setHeader("Retry-After", "2");
          response.status(503).json({
            schemaVersion: 1,
            error: {
              code: "dining_session_order_processing",
              messageKey: "customer.dining.session.order_processing",
            },
          });
          return;
        }
        const status =
          error instanceof GuestSessionError ||
          (error instanceof OrderStatusProjectionError &&
            ["ORDER_STATUS_PERMISSION_DENIED", "ORDER_STATUS_NOT_FOUND"].includes(error.code))
            ? 404
            : 503;
        if (status === 503) markRequestFailure(request, customerFailureCode(error));
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerDiningSessionHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
