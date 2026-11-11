import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  assertGuestSessionUsable,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  CartError,
  findGuestDiningRound,
  loadDiningRoundPaymentIdentity,
  parseOrderingReference,
  returnDiningRoundToCart,
} from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import type { createDiningBatchCancellation } from "./dining-batch-cancellation.js";
import { fenceTableBill } from "./dining-waiting-rounds.js";
import type { OpenPaymentAttemptResolution } from "./open-payment-attempt-resolution.js";

/**
 * WP-2423 shared-table-cart-staff-round M38 (Owner defaults 2026-11-06: whoever checks out pays
 * for the dishes in the cart then). At a pay-first table the guest who pressed "Continue to
 * payment" can stop before paying: "Don't pay. Put the dishes back". Steps, as a manager's "Cancel
 * this unpaid round" (merchant-unpaid-round-cancellation.ts):
 * 1. the guest's own bound Guest Session and the round it sent are read (no write);
 * 2. outside any transaction, Payment resolves the round's online payment with the Provider: a
 *    never-confirmed attempt is cancelled there first; a payment that succeeded is refused ("your
 *    payment went through"), one still processing or unreadable is refused ("may still be going
 *    through"): nothing is cancelled;
 * 3. one transaction: the guest is authorized again; under the table bill's fence and the round's
 *    payment operation fence Payment must show nothing was charged; the unpaid round cancellation
 *    GUEST_CANCELLED_UNPAID (Workflow transition, stock release, OrderCancelled) and, in the same
 *    transaction, its dishes back in the table's cart, once (2000_412).
 * Nothing was charged, so nothing is refunded; a payment that still arrives later is refunded by the
 * existing "paid without a fulfillable order" compensation. Same operation → the same outcome. The
 * browser names only the round's number at the table, never an order or batch reference.
 */
export const customerDiningRoundWithdrawRoute = "/api/v1/dine-in/rounds/withdraw";

export type CustomerDiningRoundWithdrawResult =
  /** The round is cancelled unpaid and its dishes are back in the table's cart. */
  | { readonly status: "Returned" | "AlreadyReturned" }
  /** The payment went through: the round is paid and stays. */
  | { readonly status: "Paid" }
  /** The payment may still be going through (or can't be read): nothing changed. */
  | { readonly status: "PaymentPending" }
  /** Not a round of this phone that can be stopped (another phone's, sent, or held for staff). */
  | { readonly status: "NotWithdrawable" }
  /** The table closed: there is no cart to put the dishes back into. */
  | { readonly status: "TableClosed" };

export class CustomerDiningRoundWithdrawError extends Error {
  constructor(readonly code: "NotJoined" | "Invalid" | "Unavailable") {
    super("dining round withdraw " + code);
    this.name = "CustomerDiningRoundWithdrawError";
  }
}

export interface CustomerDiningRoundWithdrawOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: ConsumerTransaction): GuestSessionServiceOptions["binding"];
  /** Payment's open-attempt resolution with the Store's Provider (no transaction held). */
  resolvePayment(paymentOperationReference: string): Promise<OpenPaymentAttemptResolution>;
  readonly cancellation: Pick<
    ReturnType<typeof createDiningBatchCancellation>,
    "cancelUnpaidForGuest"
  >;
  newReference(): string;
  now(): string;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
  onUnexpected?(error: unknown): void;
  retentionPolicyCode?: string;
  retentionPolicyVersion?: number;
}

function bound(guest: GuestSession, scope: CustomerDiningRoundWithdrawOptions["scope"]) {
  if (
    String(guest.brandReference) !== scope.brandReference ||
    String(guest.storeReference) !== scope.storeReference ||
    guest.channel !== "DineIn" ||
    guest.diningState !== "DiningBound" ||
    guest.diningSessionReference === null
  )
    throw new CustomerDiningRoundWithdrawError("NotJoined");
  return Object.freeze({
    guestSessionReference: String(guest.sessionReference),
    diningSessionReference: String(guest.diningSessionReference),
  });
}

export function createCustomerDiningRoundWithdraw(options: CustomerDiningRoundWithdrawOptions) {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  /** One transaction with the guest's current, bound Guest Session checked first. */
  const asGuest = <T>(
    credentials: { readonly sessionCredential: string; readonly csrfCredential: string },
    work: (
      transaction: ConsumerTransaction,
      member: ReturnType<typeof bound>,
      stillTheGuest: () => Promise<boolean>,
    ) => Promise<T>,
  ) =>
    options.transactions.run(async (transaction) => {
      const binding = options.binding(transaction);
      const identity = new GuestSessionService({
        credentials: options.credentials,
        binding,
        store: createPostgresGuestSessionEntryStore(
          { run: <R>(next: (tx: ConsumerTransaction) => Promise<R>) => next(transaction) },
          owner,
        ),
        admission: { consume: async () => null },
        now: options.now,
      });
      const authorize = async () => {
        const guest = await identity.authorize({
          ...credentials,
          observedAt: parseCanonicalInstant(options.now()),
        });
        const checked = parseCanonicalInstant(options.now());
        assertGuestSessionUsable(guest, checked);
        if ((await binding.validate(guest, checked)) !== "Current")
          throw new CustomerDiningRoundWithdrawError("NotJoined");
        return bound(guest, scope);
      };
      const member = await authorize();
      const fingerprint = JSON.stringify(member);
      await transaction.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
      return work(transaction, member, async () => {
        try {
          return JSON.stringify(await authorize()) === fingerprint;
        } catch {
          return false;
        }
      });
    });
  return Object.freeze({
    async withdraw(value: unknown): Promise<CustomerDiningRoundWithdrawResult> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let operationReference: string;
      let roundNumber: number;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "operationReference",
          "roundNumber",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        operationReference = String(parseOrderingReference(raw.operationReference));
        if (
          typeof raw.roundNumber !== "number" ||
          !Number.isSafeInteger(raw.roundNumber) ||
          raw.roundNumber < 1 ||
          raw.roundNumber > 999
        )
          throw new Error("invalid");
        roundNumber = raw.roundNumber;
      } catch {
        throw new CustomerDiningRoundWithdrawError("Invalid");
      }
      try {
        // 1. This phone's own round, read only.
        const round = await asGuest(credentials, async (transaction, member) => {
          const found = await findGuestDiningRound(transaction as never, owner, {
            diningSessionReference: member.diningSessionReference,
            guestSessionReference: member.guestSessionReference,
            roundNumber,
          });
          if (found === null) return null;
          const identity = await loadDiningRoundPaymentIdentity(transaction, owner, found);
          return identity === null ? null : { ...found, ...identity };
        });
        if (round === null) return Object.freeze({ status: "NotWithdrawable" as const });
        // Its dishes already came back (the same tap, or another): nothing more is done.
        if (round.returned) return Object.freeze({ status: "AlreadyReturned" as const });
        // 2. With the Provider, no transaction held: an unfinished attempt is cancelled first.
        const payment = await options.resolvePayment(round.paymentOperationReference);
        if (payment.status === "Paid") return Object.freeze({ status: "Paid" as const });
        if (payment.status === "Processing" || payment.status === "Unavailable")
          return Object.freeze({ status: "PaymentPending" as const });
        // 3. One transaction: cancelled unpaid, and the dishes back in the table's cart.
        return await asGuest(credentials, async (transaction, member, stillTheGuest) => {
          await fenceTableBill(transaction, owner, [round.orderReference]);
          const cancelled = await options.cancellation.cancelUnpaidForGuest(transaction, {
            operationReference,
            orderReference: round.orderReference,
            orderBatchReference: round.orderBatchReference,
            authorize: stillTheGuest,
          });
          if (cancelled.status === "NotEligible") {
            if (cancelled.reason === "Paid") return Object.freeze({ status: "Paid" as const });
            if (cancelled.reason === "PaymentInProgress")
              return Object.freeze({ status: "PaymentPending" as const });
            return Object.freeze({ status: "NotWithdrawable" as const });
          }
          if (cancelled.record.reasonCode !== "GUEST_CANCELLED_UNPAID")
            return Object.freeze({ status: "NotWithdrawable" as const });
          const observedAt = options.now();
          const returned = await returnDiningRoundToCart(transaction as never, owner, {
            orderReference: round.orderReference,
            orderBatchReference: round.orderBatchReference,
            guestSessionReference: member.guestSessionReference,
            operationReference,
            observedAt,
            newLineReference: options.newReference,
            audit: (cartReference) => ({
              auditId: options.newReference(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "ORDERING_ROUND_RETURNED_TO_CART",
              targetType: "OrderingCart",
              targetId: cartReference,
              reasonCode: "GUEST_CANCELLED_UNPAID",
              correlationId: operationReference,
              occurredAt: observedAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: options.retentionPolicyCode ?? "AUDIT_DEFAULT",
              retentionPolicyVersion: options.retentionPolicyVersion ?? 1,
            }),
          });
          if (!(await stillTheGuest())) throw new CustomerDiningRoundWithdrawError("NotJoined");
          return Object.freeze({
            status:
              cancelled.status === "Existing" || returned.status === "AlreadyReturned"
                ? ("AlreadyReturned" as const)
                : ("Returned" as const),
          });
        });
      } catch (error) {
        if (error instanceof CustomerDiningRoundWithdrawError) throw error;
        if (error instanceof GuestSessionError)
          throw new CustomerDiningRoundWithdrawError("NotJoined");
        // The table's cart ended (the table closed): the cancellation rolled back with it.
        if (error instanceof CartError && error.code === "CART_UNAVAILABLE")
          return Object.freeze({ status: "TableClosed" as const });
        try {
          options.onUnexpected?.(error);
        } catch {
          // Reporting never changes the answer.
        }
        throw new CustomerDiningRoundWithdrawError("Unavailable");
      }
    },
  });
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}
function fail(response: Response, status: 400 | 404 | 503) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  const code =
    status === 400 ? "request_invalid" : status === 404 ? "not_joined" : "service_unavailable";
  response.status(status).json({
    schemaVersion: 1,
    error: { code: "dining_round_" + code, messageKey: "customer.dining.round." + code },
  });
}

/** POST {roundNumber}; the guest cookie, X-CSRF-Token and Idempotency-Key as every guest write. */
export class CustomerDiningRoundWithdrawHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningRoundWithdraw>;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningRoundWithdraw>;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      let input: Record<string, unknown>;
      try {
        if (
          request.get("origin") !== this.#origin ||
          request.get("sec-fetch-site") !== "same-origin" ||
          Object.keys(request.query).length !== 0
        )
          throw new Error("invalid request");
        const body = readClosedRecord(request.body ?? {}, ["roundNumber"]);
        const entries = (request.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim().split("="))
          .filter(([name]) => name === "__Host-bop-guest");
        const csrf = request.headers["x-csrf-token"];
        const key = request.get("idempotency-key");
        if (
          entries.length !== 1 ||
          entries[0]?.length !== 2 ||
          !credential.test(entries[0]?.[1] ?? "") ||
          typeof csrf !== "string" ||
          !credential.test(csrf) ||
          typeof key !== "string" ||
          !reference.test(key)
        )
          throw new Error("invalid credentials");
        input = {
          sessionCredential: entries[0]?.[1],
          csrfCredential: csrf,
          operationReference: key,
          roundNumber: body.roundNumber,
        };
      } catch {
        fail(response, 400);
        return;
      }
      try {
        const result = await this.#port.withdraw(input);
        protect(response);
        response.status(200).json({ schemaVersion: 1, status: result.status });
      } catch (error) {
        fail(
          response,
          error instanceof CustomerDiningRoundWithdrawError && error.code === "NotJoined"
            ? 404
            : error instanceof CustomerDiningRoundWithdrawError && error.code === "Invalid"
              ? 400
              : 503,
        );
      }
    };
  }
}

export const unavailableCustomerDiningRoundWithdrawHandler: RequestHandler = (_request, response) =>
  fail(response, 503);
