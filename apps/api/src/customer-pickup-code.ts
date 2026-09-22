import type { RequestHandler, Response } from "express";
import { GuestSessionError, readClosedRecord } from "@bop/identity";
import { OrderStatusProjectionError } from "@rms/ordering";
import type { CustomerOrderStatusInput } from "./customer-order-status.js";
import type { createCustomerPickupCodeRead } from "./customer-pickup-code-read.js";
type View = Awaited<ReturnType<ReturnType<typeof createCustomerPickupCodeRead>["read"]>>;
const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const customerPickupCodeRoute = "/api/v1/orders/:order_id/pickup-code";
function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function reject(response: Response, status: number) {
  protect(response);
  response.status(status).json({
    schemaVersion: 1,
    error: {
      code:
        status === 404
          ? "pickup_not_found"
          : status === 400
            ? "pickup_request_invalid"
            : "pickup_unavailable",
    },
  });
}
export class CustomerPickupCodeHandler {
  readonly #origin: string;
  readonly #port: { read(input: CustomerOrderStatusInput): Promise<View> };
  constructor(options: {
    allowedOrigin: string;
    port: { read(input: CustomerOrderStatusInput): Promise<View> };
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
        if (view.orderReference !== input.orderReference) throw new Error("PICKUP_BINDING_INVALID");
        if (view.status === "NotReady") {
          response
            .status(200)
            .json({ schemaVersion: 1, status: "NotReady", orderReference: input.orderReference });
          return;
        }
        if (
          view.status !== "Ready" ||
          view.proofKind !== "Opaque" ||
          !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(view.proofValue) ||
          !Number.isSafeInteger(view.generation) ||
          view.generation < 1 ||
          !Number.isFinite(Date.parse(view.expiresAt)) ||
          Date.parse(view.expiresAt) <= Date.parse(view.observedAt)
        )
          throw new Error("PICKUP_RESULT_INVALID");
        response.status(200).json({
          schemaVersion: 1,
          status: "Ready",
          orderReference: view.orderReference,
          orderNumber: view.orderNumber,
          storeDisplayName: view.storeDisplayName,
          pickupInstruction: view.pickupInstruction,
          generation: view.generation,
          proofKind: view.proofKind,
          proofValue: view.proofValue,
          observedAt: view.observedAt,
          expiresAt: view.expiresAt,
        });
      } catch (error) {
        reject(
          response,
          error instanceof GuestSessionError ||
            (error instanceof OrderStatusProjectionError &&
              ["ORDER_STATUS_PERMISSION_DENIED", "ORDER_STATUS_NOT_FOUND"].includes(error.code))
            ? 404
            : 503,
        );
      }
    };
  }
}
export const unavailableCustomerPickupCodeHandler: RequestHandler = (_request, response) =>
  reject(response, 503);
