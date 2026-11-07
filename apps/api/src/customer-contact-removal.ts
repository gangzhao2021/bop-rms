import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  CheckoutContactRemovalError,
  parseOrderingReference,
  removeCheckoutContactOnCustomerRequest,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";

/**
 * WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): "Remove my contact details" on the customer's own order
 * page. The current Guest Session (with its CSRF credential) must be the one that placed the order;
 * the contact is removed at once through the Ordering owner (the Q10 one-time redaction with
 * evidence), audited without the value, and a repeat request changes nothing.
 */
export const customerContactRemovalRoute = "/api/v1/orders/:order_id/contact-removal";

export class CustomerContactRemovalError extends Error {
  constructor(readonly code: "NotFound" | "Unavailable" | "Invalid") {
    super("contact removal " + code);
    this.name = "CustomerContactRemovalError";
  }
}

export function createCustomerContactRemoval(
  options: Omit<CustomerCheckoutSessionAuthorizationOptions, "transactions"> & {
    readonly transactions: {
      run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
    };
    readonly newReference: () => string;
  },
) {
  return async (value: unknown) => {
    let credentials: { sessionCredential: string; csrfCredential: string };
    let orderReference: string;
    try {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "orderReference",
      ]);
      credentials = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      };
      orderReference = String(parseOrderingReference(raw.orderReference));
    } catch {
      throw new CustomerContactRemovalError("Invalid");
    }
    try {
      return await options.transactions.run(async (transaction) => {
        const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
        const now = () => String(parseCanonicalInstant(options.now()));
        const identity = new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(runner, options.scope),
          credentials: options.credentials,
          binding: options.binding(transaction),
          now,
          admission: { consume: async () => null },
        });
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          guest.brandReference !== options.scope.brandReference ||
          guest.storeReference !== options.scope.storeReference
        )
          throw new CustomerContactRemovalError("NotFound");
        const observedAt = now();
        const result = await removeCheckoutContactOnCustomerRequest(transaction, options.scope, {
          orderReference,
          guestSessionReference: String(guest.sessionReference),
          observedAt,
          redactionReference: options.newReference(),
        });
        if (result.status === "Removed")
          await appendAuditRecordInTransaction(
            transaction,
            validateAuditRecord({
              auditId: options.newReference(),
              brandId: options.scope.brandReference,
              storeId: options.scope.storeReference,
              actor: { type: "System" },
              actionCode: "CHECKOUT_CONTACT_REMOVED_ON_REQUEST",
              targetType: "OrderCheckoutContact",
              targetId: orderReference,
              reasonCode: "CUSTOMER_REQUEST",
              correlationId: options.newReference(),
              occurredAt: observedAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            }),
          );
        // The Session must still be current when the change commits.
        await identity.authorize({ ...credentials, observedAt: now() });
        return Object.freeze({ status: result.status });
      });
    } catch (error) {
      if (error instanceof CustomerContactRemovalError) throw error;
      if (
        error instanceof GuestSessionError ||
        (error instanceof CheckoutContactRemovalError &&
          error.code === "CHECKOUT_CONTACT_REMOVAL_NOT_FOUND")
      )
        throw new CustomerContactRemovalError("NotFound");
      throw new CustomerContactRemovalError("Unavailable");
    }
  };
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function reject(response: Response, status: 400 | 404 | 503) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400 ? "request_invalid" : status === 404 ? "not_found" : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "contact_removal_" + code, messageKey: "customer.contact_removal." + code },
  });
}

export function createCustomerContactRemovalHandler(options: {
  readonly allowedOrigin: string;
  readonly port?: ReturnType<typeof createCustomerContactRemoval>;
}): RequestHandler {
  const origin = new URL(options.allowedOrigin).origin;
  return async (request, response) => {
    let input: { sessionCredential: string; csrfCredential: string; orderReference: string };
    try {
      if (
        request.get("origin") !== origin ||
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
    if (options.port === undefined) {
      reject(response, 503);
      return;
    }
    try {
      const result = await options.port(input);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.status(200).json({ schemaVersion: 1, removal: { status: result.status } });
    } catch (error) {
      reject(
        response,
        error instanceof CustomerContactRemovalError && error.code === "NotFound"
          ? 404
          : error instanceof CustomerContactRemovalError && error.code === "Invalid"
            ? 400
            : 503,
      );
    }
  };
}
