import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { loadDiningRoundPaymentIdentity, parseOrderingReference } from "@rms/ordering";
import type { createDiningBatchCancellation } from "./dining-batch-cancellation.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";
import type { OpenPaymentAttemptResolution } from "./open-payment-attempt-resolution.js";

export const unpaidRoundCancellationErrorCodes = [
  "UNPAID_ROUND_INPUT_INVALID",
  "UNPAID_ROUND_PERMISSION_DENIED",
  "UNPAID_ROUND_NOT_FOUND",
  "UNPAID_ROUND_PAID",
  "UNPAID_ROUND_PAYMENT_IN_PROGRESS",
  "UNPAID_ROUND_NOT_CANCELLABLE",
  "UNPAID_ROUND_VERSION_CONFLICT",
  "UNPAID_ROUND_UNAVAILABLE",
] as const;
export type UnpaidRoundCancellationErrorCode = (typeof unpaidRoundCancellationErrorCodes)[number];
export class UnpaidRoundCancellationError extends Error {
  readonly code: UnpaidRoundCancellationErrorCode;
  constructor(code: UnpaidRoundCancellationErrorCode) {
    super("unpaid round cancellation is unavailable");
    this.name = "UnpaidRoundCancellationError";
    this.code = code;
  }
}
const fail = (code: UnpaidRoundCancellationErrorCode): never => {
  throw new UnpaidRoundCancellationError(code);
};
function databaseCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): a manager cancels a dine-in round
 * nobody paid for, before its payment window ends ("Cancel this unpaid round" on Tables/Orders).
 * Same managers who may cancel orders (`ordering.order.cancel`). Steps:
 * 1. the manager and the round's payment identity are read (no write);
 * 2. outside any transaction, Payment resolves the round's online payment with the Provider — a
 *    never-confirmed attempt is cancelled there first, so it can't be paid from an old page; a
 *    payment that succeeded is refused ("already paid"), one still processing is refused;
 * 3. one transaction: the manager is authorized again, Payment is re-read under the round's payment
 *    operation fence (nothing charged), then the same unpaid round cancellation as the System's
 *    (Workflow transition, stock release, OrderCancelled, audit naming the manager).
 * Nothing was charged, so nothing is refunded; a payment that still arrives later is refunded by
 * the existing "paid without a fulfillable order" compensation. Same operation reference → the
 * original outcome.
 *
 * When the card provider still can't confirm the round's online payment
 * `unconfirmedPaymentGraceMs` after its payment window ended, staff are told so and a manager may
 * cancel after checking with the guest (`acknowledgeUnconfirmedPayment: true`); the transaction
 * re-checks the deadline and refuses a payment Payment recorded as succeeded.
 */
export function createMerchantUnpaidRoundCancellation(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  /** Payment's open-attempt resolution with the Store's Provider (no transaction held). */
  resolvePayment(paymentOperationReference: string): Promise<OpenPaymentAttemptResolution>;
  cancellation: Pick<ReturnType<typeof createDiningBatchCancellation>, "cancelUnpaidForStaff">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ status: "Cancelled" | "AlreadyCancelled"; cancelledAt: string }> => {
    const session = await options.authentication.authorize(input);
    let orderReference: string, orderBatchReference: string, operationReference: string;
    let paymentUnconfirmed = false;
    try {
      const acknowledged =
        input.command !== null &&
        typeof input.command === "object" &&
        Object.prototype.hasOwnProperty.call(input.command, "acknowledgeUnconfirmedPayment");
      const intent = readClosedRecord(input.command, [
        "orderReference",
        "orderBatchReference",
        "operationReference",
        ...(acknowledged ? ["acknowledgeUnconfirmedPayment"] : []),
      ]);
      if (acknowledged && intent.acknowledgeUnconfirmedPayment !== true)
        return fail("UNPAID_ROUND_INPUT_INVALID");
      paymentUnconfirmed = acknowledged;
      orderReference = String(parseOrderingReference(intent.orderReference));
      orderBatchReference = String(parseOrderingReference(intent.orderBatchReference));
      operationReference = String(parseOrderingReference(intent.operationReference));
    } catch (error) {
      if (error instanceof UnpaidRoundCancellationError) throw error;
      return fail("UNPAID_ROUND_INPUT_INVALID");
    }
    const authorized = <T>(
      work: (authority: {
        transaction: ConsumerTransaction;
        selected: { tenantReference: string; brandReference: string; storeReference: string };
        actorReference: string;
        allowed: () => Promise<boolean>;
      }) => Promise<T>,
    ) =>
      options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(() => fail("UNPAID_ROUND_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true) return fail("UNPAID_ROUND_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("UNPAID_ROUND_PERMISSION_DENIED"),
          },
          async (authority) => {
            const scope = authority.scope;
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const tx = transaction as unknown as ConsumerTransaction;
            await options.installContext(tx, selected);
            return work({
              transaction: tx,
              selected,
              actorReference: String(scope.actorReference),
              allowed: () => authority.guard(),
            });
          },
        ),
      );
    try {
      const round = await authorized(async ({ transaction, selected }) =>
        loadDiningRoundPaymentIdentity(transaction, selected, {
          orderReference,
          orderBatchReference,
        }),
      );
      if (round === null) return fail("UNPAID_ROUND_NOT_FOUND");
      const payment = await options.resolvePayment(round.paymentOperationReference);
      if (payment.status === "Paid") return fail("UNPAID_ROUND_PAID");
      // The card provider can't confirm the payment: only once the manager checked with the guest
      // and the grace after the deadline has passed (re-checked in the transaction below).
      if (payment.status === "Processing" && !paymentUnconfirmed)
        return fail("UNPAID_ROUND_PAYMENT_IN_PROGRESS");
      if (payment.status === "Unavailable" && !paymentUnconfirmed)
        return fail("UNPAID_ROUND_UNAVAILABLE");
      const result = await authorized(async ({ transaction, actorReference, allowed }) =>
        options.cancellation.cancelUnpaidForStaff(transaction, {
          operationReference,
          orderReference,
          orderBatchReference,
          actorReference,
          authorize: async () => (await allowed()) === true,
          ...(paymentUnconfirmed &&
          (payment.status === "Processing" || payment.status === "Unavailable")
            ? { paymentUnconfirmed: true }
            : {}),
        }),
      );
      if (result.status === "NotEligible")
        return fail(
          (
            {
              NotFound: "UNPAID_ROUND_NOT_FOUND",
              Paid: "UNPAID_ROUND_PAID",
              PaymentInProgress: "UNPAID_ROUND_PAYMENT_IN_PROGRESS",
              NotCancellable: "UNPAID_ROUND_NOT_CANCELLABLE",
            } as const
          )[result.reason],
        );
      if (result.record.reasonCode !== "STAFF_CANCELLED_UNPAID")
        return fail("UNPAID_ROUND_UNAVAILABLE");
      return Object.freeze({
        status:
          result.status === "Created" ? ("Cancelled" as const) : ("AlreadyCancelled" as const),
        cancelledAt: String(result.record.cancelledAt),
      });
    } catch (error) {
      if (error instanceof UnpaidRoundCancellationError) throw error;
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("UNPAID_ROUND_VERSION_CONFLICT");
      if (code === "STORE_SERVICE_PERMISSION_DENIED") return fail("UNPAID_ROUND_PERMISSION_DENIED");
      return fail("UNPAID_ROUND_UNAVAILABLE");
    }
  };
}
