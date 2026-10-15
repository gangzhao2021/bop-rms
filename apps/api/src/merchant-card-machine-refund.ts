import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresOrderPaymentDispositionReader,
  createPostgresStaffOrderCancellationReader,
  parseOrderingReference,
} from "@rms/ordering";
import {
  cardMachineBackEntryWindowMs,
  CardMachinePaymentError,
  createPostgresCardMachinePaymentStore,
  parseCardMachineRefundRecord,
  parseCardMachineSlipReference,
  parsePaymentDigest,
  parsePaymentInstant,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";

export const cardMachineRefundCommandErrorCodes = [
  "CARD_MACHINE_REFUND_INPUT_INVALID",
  "CARD_MACHINE_REFUND_PERMISSION_DENIED",
  "CARD_MACHINE_REFUND_NOT_FOUND",
  "CARD_MACHINE_REFUND_NOTHING_OWED",
  "CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT",
  /** WP-2423 item 4: an escalated ordinary refund needs its approval recorded first. */
  "CARD_MACHINE_REFUND_APPROVAL_REQUIRED",
  "CARD_MACHINE_REFUND_UNAVAILABLE",
] as const;
export type CardMachineRefundCommandErrorCode = (typeof cardMachineRefundCommandErrorCodes)[number];
export class CardMachineRefundCommandError extends Error {
  readonly code: CardMachineRefundCommandErrorCode;
  constructor(code: CardMachineRefundCommandErrorCode) {
    super("card machine refund is unavailable");
    this.name = "CardMachineRefundCommandError";
    this.code = code;
  }
}
const fail = (code: CardMachineRefundCommandErrorCode): never => {
  throw new CardMachineRefundCommandError(code);
};

export interface CardMachineRefundResult {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly amountMinor: string;
  readonly refundedAt: string;
}

export function parseCardMachineRefundCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "orderBatchReference",
      "slipReference",
      "refundedAt",
    ]);
    return Object.freeze({
      operationReference: String(parseOrderingReference(raw.operationReference)),
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
      slipReference:
        raw.slipReference === null ? null : parseCardMachineSlipReference(raw.slipReference),
      /** When the machine refund was actually made, if not just now (e.g. during an outage). */
      refundedAt: raw.refundedAt === null ? null : String(parsePaymentInstant(raw.refundedAt)),
    });
  } catch (error) {
    if (error instanceof CardMachineRefundCommandError) throw error;
    return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
  }
}

/**
 * Why a whole card-machine payment is owed back, if it is: the store cancelled its Batch (Q6), or
 * Ordering found the paid Order could no longer be fulfilled. Null when neither applies (an
 * ordinary refund request is then the only way to refund it). Ordering owner reads only.
 */
export async function cardMachineWholeRefundSource(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  payment: {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly cardMachinePaymentReference: string;
    readonly eventReference: string;
  },
): Promise<{
  kind: "StaffCancellation" | "UnfulfillableOrder";
  reference: string;
  at: string;
} | null> {
  const cancellation = (
    await createPostgresStaffOrderCancellationReader({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    }).listByOrders(tx, [payment.orderReference])
  ).find(
    (record) =>
      String(record.orderBatchReference) === payment.orderBatchReference &&
      String(record.paymentTransactionReference) === payment.cardMachinePaymentReference,
  );
  if (cancellation !== undefined)
    return {
      kind: "StaffCancellation",
      reference: String(cancellation.cancellationReference),
      at: String(cancellation.cancelledAt),
    };
  const outcome = await createPostgresOrderPaymentDispositionReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  }).loadByPaymentEvent({
    transaction: tx,
    paymentEventReference: parseOrderingReference(payment.eventReference),
  });
  const record = outcome?.record as
    { disposition?: unknown; dispositionReference?: unknown; evaluatedAt?: unknown } | undefined;
  if (record?.disposition !== "PaidWithoutFulfillableOrder") return null;
  return {
    kind: "UnfulfillableOrder",
    reference: String(parseOrderingReference(record.dispositionReference)),
    at: String(record.evaluatedAt),
  };
}

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 4; Q6 DEC-ORDER-CANCELLATION-PILOT): a Batch
 * paid on the Store's card machine was cancelled by staff, or Ordering found the paid Order could
 * no longer be fulfilled; staff refund the whole remaining payment (tip included) on that machine
 * and record it here. No Provider is called. As for the online refund of these cases (made by the
 * compensation workload without further approval) the reason is the approval; the staff member
 * holds the cancel permission and the amount is server-owned.
 */
export function createMerchantCardMachineCancellationRefund(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
  /** Told the original error of an unexpected failure (the pilot logs code and frames only). */
  onUnexpected?(error: unknown): void;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CardMachineRefundResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseCardMachineRefundCommand(input.command);
    const intentDigest = parsePaymentDigest(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "CardMachineCancellationRefund/v1",
            orderReference: command.orderReference,
            orderBatchReference: command.orderBatchReference,
            slipReference: command.slipReference,
            refundedAt: command.refundedAt,
          }),
        ),
    );
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const resolved = await resolveScope(
          transaction,
          input.sessionCookie,
          staffOrderCancellationPermission,
          session.sessionReference,
        ).catch(() => fail("CARD_MACHINE_REFUND_PERMISSION_DENIED"));
        const allowed = async () => (await resolved.allowed()) === true;
        if (!(await allowed())) return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
        const tx = transaction as unknown as ConsumerTransaction;
        const scope = {
          tenantReference: String(resolved.selected.tenantReference),
          brandReference: String(resolved.context.brand.brandReference),
          storeReference: String(resolved.store.storeReference),
        };
        const actorReference = String(resolved.actorReference);
        const payments = createPostgresCardMachinePaymentStore({
          scope,
          authorize: async (_tx, value) =>
            value.orderReference === command.orderReference && (await allowed()),
        });
        const reply = (
          status: CardMachineRefundResult["status"],
          refund: { amountMinor: bigint; refundedAt: string },
        ) =>
          Object.freeze({
            status,
            orderReference: command.orderReference,
            orderBatchReference: command.orderBatchReference,
            amountMinor: refund.amountMinor.toString(),
            refundedAt: String(refund.refundedAt),
          });
        const prior = await payments.loadRefundByOperation(tx, command.operationReference);
        if (prior !== null) {
          if (prior.intentDigest !== intentDigest || prior.actorReference !== actorReference)
            return fail("CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT");
          return reply("AlreadyRecorded", prior);
        }
        const payment = await payments.loadByBatch(
          tx,
          command.orderReference,
          command.orderBatchReference,
        );
        if (payment === null) return fail("CARD_MACHINE_REFUND_NOT_FOUND");
        // Why the money is owed: the store cancelled the Batch (Q6), or Ordering found the paid
        // Order could no longer be fulfilled (for example it was not accepted in time).
        const source = await cardMachineWholeRefundSource(tx, scope, payment);
        if (source === null) return fail("CARD_MACHINE_REFUND_NOT_FOUND");
        const already = await payments.loadRefundBySource(tx, source.kind, source.reference);
        if (already !== null) return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
        const refunded = (await payments.refunds(tx, payment.cardMachinePaymentReference)).reduce(
          (sum, refund) => sum + refund.amountMinor,
          0n,
        );
        const owed = payment.preparation.total.amountMinor - refunded;
        if (owed <= 0n) return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
        const recordedAt = parsePaymentInstant(options.persistence.now());
        const refundedAt =
          command.refundedAt === null ? recordedAt : parsePaymentInstant(command.refundedAt);
        if (
          refundedAt > recordedAt ||
          refundedAt < source.at ||
          Date.parse(recordedAt) - Date.parse(refundedAt) > cardMachineBackEntryWindowMs
        )
          return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
        if (!(await allowed())) return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
        const saved = await payments.recordRefund(
          tx,
          parseCardMachineRefundRecord({
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            cardMachineRefundReference: options.nextReference(),
            cardMachinePaymentReference: payment.cardMachinePaymentReference,
            orderReference: command.orderReference,
            operationReference: command.operationReference,
            intentDigest,
            sourceKind: source.kind,
            sourceReference: source.reference,
            amountMinor: owed,
            slipReference: command.slipReference,
            refundedAt,
            recordedAt,
            actorReference,
            auditReference: options.nextReference(),
          }),
        );
        return reply(saved.status === "Created" ? "Recorded" : "AlreadyRecorded", saved.refund);
      });
    } catch (error) {
      if (error instanceof CardMachineRefundCommandError) throw error;
      if (error instanceof CardMachinePaymentError) {
        if (error.code === "CARD_MACHINE_IDEMPOTENCY_CONFLICT")
          return fail("CARD_MACHINE_REFUND_IDEMPOTENCY_CONFLICT");
        if (error.code === "CARD_MACHINE_REFUND_EXCEEDS_PAYMENT")
          return fail("CARD_MACHINE_REFUND_NOTHING_OWED");
        if (error.code === "CARD_MACHINE_PERMISSION_DENIED")
          return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
        if (error.code === "CARD_MACHINE_INPUT_INVALID")
          return fail("CARD_MACHINE_REFUND_INPUT_INVALID");
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("CARD_MACHINE_REFUND_PERMISSION_DENIED");
      try {
        options.onUnexpected?.(error);
      } catch {
        // Reporting never changes the answer.
      }
      return fail("CARD_MACHINE_REFUND_UNAVAILABLE");
    }
  };
}
