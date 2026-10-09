import type { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { OrderStatusProjectionError, type CustomerOrderStatusView } from "@rms/ordering";
import type { RequestHandler, Response } from "express";

type SourcedStatus = Awaited<ReturnType<ReturnType<typeof createCustomerOrderStatusRead>["read"]>>;
type CustomerStatusResponse = CustomerOrderStatusView & Partial<Pick<SourcedStatus, "sources">>;

export const customerOrderStatusRoute = "/api/v1/orders/:order_id/status";
export interface CustomerOrderStatusInput {
  readonly sessionCredential: string;
  readonly csrfCredential: string;
  readonly orderReference: string;
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
    error: { code: "order_status_" + code, messageKey: "customer.order.status." + code },
  });
}
export class CustomerOrderStatusHandler {
  readonly #origin: string;
  readonly #port: { read(input: CustomerOrderStatusInput): Promise<CustomerStatusResponse> };
  constructor(options: {
    allowedOrigin: string;
    port: { read(input: CustomerOrderStatusInput): Promise<CustomerStatusResponse> };
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      protect(response);
      let input: CustomerOrderStatusInput;
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
        const view = await this.#port.read(input);
        if (view.order.orderReference !== input.orderReference)
          throw new Error("invalid order binding");
        // Explicit public-field serialization prevents owner metadata or credential leakage.
        const order = view.order;
        const status = {
          projectionName: view.projectionName,
          projectionVersion: view.projectionVersion,
          sourceCheckpoint: view.sourceCheckpoint,
          projectedAt: view.projectedAt,
          freshnessStatus: view.freshnessStatus,
          order: {
            orderReference: order.orderReference,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            canonicalPhase: order.canonicalPhase,
            paymentStatus: order.paymentStatus,
            kitchenStatus: order.kitchenStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            fulfilledAt: order.fulfilledAt,
            eta: order.eta,
            submittedAt: order.submittedAt,
            batches: order.batches.map((batch) => ({
              orderBatchReference: batch.orderBatchReference,
              submittedAt: batch.submittedAt,
              items: batch.items.map((item) => {
                if (
                  typeof item.lineTotal.amountMinor !== "bigint" ||
                  item.lineTotal.amountMinor < -(2n ** 63n) ||
                  item.lineTotal.amountMinor > 2n ** 63n - 1n
                )
                  throw new Error("invalid amount");
                return {
                  orderItemReference: item.orderItemReference,
                  displayName: item.displayName,
                  quantity: item.quantity,
                  lineTotal: {
                    amountMinor: item.lineTotal.amountMinor.toString(),
                    currencyCode: item.lineTotal.currencyCode,
                  },
                };
              }),
            })),
          },
        };
        const sources = view.sources;
        const publicSources =
          sources === undefined
            ? {}
            : {
                sources: {
                  checkedAt: sources.checkedAt,
                  ...(sources.dining === undefined
                    ? {}
                    : {
                        dining: {
                          items: sources.dining.items.map((item) => ({
                            orderItemReference: item.orderItemReference,
                            orderBatchReference: item.orderBatchReference,
                            servedQuantity: item.servedQuantity,
                          })),
                        },
                      }),
                  kitchen:
                    sources.kitchen === null
                      ? null
                      : {
                          batches: sources.kitchen.batches.map((batch) => ({
                            orderBatchReference: batch.orderBatchReference,
                            status: batch.status,
                            updatedAt: batch.updatedAt,
                          })),
                        },
                  payments:
                    sources.payments === null
                      ? null
                      : sources.payments.map((payment) => ({
                          status: payment.status,
                          occurredAt: payment.occurredAt,
                          freshnessStatus: payment.freshnessStatus,
                          amount:
                            payment.amount === null
                              ? null
                              : {
                                  amountMinor: payment.amount.amountMinor.toString(),
                                  currencyCode: payment.amount.currencyCode,
                                },
                        })),
                  ...(sources.pickup === undefined
                    ? {}
                    : {
                        pickup:
                          sources.pickup === null
                            ? null
                            : { notCollectedAt: sources.pickup.notCollectedAt },
                      }),
                },
              };
        response.status(200).json({ schemaVersion: 1, status: { ...status, ...publicSources } });
      } catch (error) {
        const status =
          error instanceof GuestSessionError
            ? 404
            : error instanceof OrderStatusProjectionError &&
                ["ORDER_STATUS_PERMISSION_DENIED", "ORDER_STATUS_NOT_FOUND"].includes(error.code)
              ? 404
              : 503;
        reject(response, status);
      }
    };
  }
}
export const unavailableCustomerOrderStatusHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
