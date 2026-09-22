import type { CustomerReceiptFinancialView } from "./customer-receipt-financial.js";
import { GuestSessionError, readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptError,
  parseDigitalReceiptChain,
  type DigitalReceiptChain,
} from "@rms/ordering";
import type { RequestHandler, Response } from "express";

export const customerReceiptRoute = "/api/v1/orders/:order_id/receipt";
export interface CustomerReceiptInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly orderReference: string;
}
interface ReceiptPort {
  read(input: CustomerReceiptInput): Promise<DigitalReceiptChain>;
  readView?(
    input: CustomerReceiptInput,
  ): Promise<{ chain: DigitalReceiptChain; financial: CustomerReceiptFinancialView | null }>;
}
function financialJson(value: CustomerReceiptFinancialView | null) {
  if (value === null) return null;
  const amounts = [value.capturedMinor, value.confirmedRefundMinor, value.pendingRefundMinor];
  if (
    amounts.some(
      (amount) => typeof amount !== "bigint" || amount < 0n || amount > 9223372036854775807n,
    ) ||
    value.confirmedRefundMinor + value.pendingRefundMinor > value.capturedMinor ||
    !Number.isSafeInteger(value.unresolvedAttemptCount) ||
    value.unresolvedAttemptCount < 0 ||
    !/^[A-Z]{3}$/u.test(value.currencyCode) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.observedAt) ||
    new Date(value.observedAt).toISOString() !== value.observedAt
  )
    throw new Error("invalid financial source");
  return {
    observedAt: value.observedAt,
    currencyCode: value.currencyCode,
    capturedMinor: value.capturedMinor.toString(),
    confirmedRefundMinor: value.confirmedRefundMinor.toString(),
    pendingRefundMinor: value.pendingRefundMinor.toString(),
    unresolvedAttemptCount: value.unresolvedAttemptCount,
  };
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
    error: { code: "receipt_" + code, messageKey: "customer.receipt." + code },
  });
}
export class CustomerReceiptHandler {
  readonly #origin: string;
  readonly #port: ReceiptPort;
  constructor(options: { allowedOrigin: string; port: ReceiptPort }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerReceiptInput;
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
        const csrf = request.headers["x-csrf-token"],
          id = request.params.order_id;
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
          orderReference: id,
        };
      } catch {
        reject(response, 400);
        return;
      }
      try {
        const view = this.#port.readView ? await this.#port.readView(input) : null;
        const chain = parseDigitalReceiptChain(view ? view.chain : await this.#port.read(input));
        if (chain.orderReference !== input.orderReference)
          throw new Error("invalid receipt binding");
        const money = (value: { amountMinor: bigint; currencyCode: string }) => ({
          amountMinor: value.amountMinor.toString(),
          currencyCode: value.currencyCode,
        });
        const receipt = {
          orderReference: chain.orderReference,
          ...(view ? { financial: financialJson(view.financial) } : {}),
          // No current financial, delivery or support source is inferred from immutable history.
          freshnessStatus: "Stale",
          deliveryStatus: "Unavailable",
          supportEligible: false,
          cancellationEligible: false,
          records: chain.records.map((record) => {
            const snapshot = record.snapshot;
            return {
              recordReference: record.recordReference,
              version: record.version,
              kind: record.kind,
              recordedAt: record.recordedAt,
              reasonCode: record.reasonCode,
              snapshot: {
                receiptReference: snapshot.receiptReference,
                operatingEntityDisplayName: snapshot.operatingEntityDisplayName,
                storeDisplayName: snapshot.storeDisplayName,
                orderNumber: snapshot.orderNumber,
                issuedAt: snapshot.issuedAt,
                locale: snapshot.locale,
                lines: snapshot.lines.map((line) => ({
                  lineReference: line.lineReference,
                  displayName: line.displayName,
                  quantity: line.quantity,
                  lineTotal: money(line.lineTotal),
                })),
                subtotal: money(snapshot.subtotal),
                tax: money(snapshot.tax),
                tip: money(snapshot.tip),
                total: money(snapshot.total),
                refundedTotal: money(snapshot.refundedTotal),
                paymentStatus: snapshot.paymentStatus,
                ...(snapshot.adjustments
                  ? {
                      adjustments: {
                        discount: money(snapshot.adjustments.discount),
                        fee: money(snapshot.adjustments.fee),
                      },
                    }
                  : {}),
              },
            };
          }),
        };
        response.status(200).json({ schemaVersion: 1, receipt });
      } catch (error) {
        const status =
          error instanceof GuestSessionError ||
          (error instanceof DigitalReceiptError &&
            ["DIGITAL_RECEIPT_PERMISSION_DENIED", "DIGITAL_RECEIPT_NOT_FOUND"].includes(error.code))
            ? 404
            : 503;
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerReceiptHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
