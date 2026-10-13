import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresCounterOrderEntryStore,
  parseOrderingReference,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import {
  cardMachineBackEntryWindowMs,
  cardMachinePaymentIntentView,
  CardMachinePaymentError,
  createPostgresCardMachinePaymentStore,
  parseCardMachinePaymentRecord,
  parseCardMachineSlipReference,
  parsePaymentDigest,
  parsePaymentInstant,
  type CardMachinePaymentRecord,
  type PaymentIntentClaimAdmission,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readCounterPaymentPreparation } from "./counter-payment-preparation.js";
import { counterOrderPermission } from "./merchant-counter-order.js";

export const cardMachinePaymentCommandErrorCodes = [
  "CARD_MACHINE_INPUT_INVALID",
  "CARD_MACHINE_PERMISSION_DENIED",
  "CARD_MACHINE_NOT_FOUND",
  "CARD_MACHINE_NOT_PAYABLE",
  "CARD_MACHINE_AMOUNT_CHANGED",
  "CARD_MACHINE_PAYMENT_WINDOW_CLOSED",
  "CARD_MACHINE_ALREADY_PAID",
  "CARD_MACHINE_IDEMPOTENCY_CONFLICT",
  "CARD_MACHINE_UNAVAILABLE",
] as const;
export type CardMachinePaymentCommandErrorCode =
  (typeof cardMachinePaymentCommandErrorCodes)[number];
export class CardMachinePaymentCommandError extends Error {
  readonly code: CardMachinePaymentCommandErrorCode;
  /** For CARD_MACHINE_AMOUNT_CHANGED: the amount to charge now. */
  readonly totalMinor: string | null;
  constructor(code: CardMachinePaymentCommandErrorCode, totalMinor: string | null = null) {
    super("card machine payment is unavailable");
    this.name = "CardMachinePaymentCommandError";
    this.code = code;
    this.totalMinor = totalMinor;
  }
}
const fail = (
  code: CardMachinePaymentCommandErrorCode,
  totalMinor: string | null = null,
): never => {
  throw new CardMachinePaymentCommandError(code, totalMinor);
};

export interface CardMachinePaymentResult {
  readonly status: "Recorded" | "AlreadyRecorded";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly amountMinor: string;
  readonly recordingReason: CardMachinePaymentRecord["recordingReason"];
  readonly takenAt: string;
  readonly recordedAt: string;
}

export function parseCardMachinePaymentCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "orderReference",
      "orderBatchReference",
      "expectedTotalMinor",
      "slipReference",
      "takenAt",
    ]);
    if (
      typeof raw.expectedTotalMinor !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(raw.expectedTotalMinor)
    )
      return fail("CARD_MACHINE_INPUT_INVALID");
    return Object.freeze({
      operationReference: String(parseOrderingReference(raw.operationReference)),
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
      expectedTotalMinor: raw.expectedTotalMinor,
      slipReference:
        raw.slipReference === null ? null : parseCardMachineSlipReference(raw.slipReference),
      /** A back-entered paper order: when it was actually paid. Null at the counter. */
      takenAt: raw.takenAt === null ? null : String(parsePaymentInstant(raw.takenAt)),
    });
  } catch (error) {
    if (error instanceof CardMachinePaymentCommandError) throw error;
    return fail("CARD_MACHINE_INPUT_INVALID");
  }
}

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 1–2): after the Store's card machine approved the
 * payment, staff record it. The amount is the server's payment preparation total (quote with tax
 * plus the tip choice), checked against what staff charged; the same payment admission as an
 * online payment (order still payable, capacity clock open, reserved stock intact) applies; the
 * Payment record, its PaymentSucceeded event and audit are one transaction, so the order reaches
 * acceptance and the kitchen through the ordinary consumers. Only counter orders take this payment.
 */
export function createMerchantCardMachinePayment(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** The same owner admission an online payment of a pickup Order passes, built for this staff
   * member's authority. */
  admission(input: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    preparation: OrderPaymentPreparationEvidence;
    allowed(): Promise<boolean>;
  }): PaymentIntentClaimAdmission;
  environment: "Test" | "Live";
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const now = () => options.persistence.now();
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<CardMachinePaymentResult> => {
    const session = await options.authentication.authorize(input);
    const command = parseCardMachinePaymentCommand(input.command);
    const intentDigest = parsePaymentDigest(
      "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            kind: "CardMachinePayment/v1",
            orderReference: command.orderReference,
            orderBatchReference: command.orderBatchReference,
            expectedTotalMinor: command.expectedTotalMinor,
            slipReference: command.slipReference,
            takenAt: command.takenAt,
          }),
        ),
    );
    const reply = (status: CardMachinePaymentResult["status"], record: CardMachinePaymentRecord) =>
      Object.freeze({
        status,
        orderReference: record.orderReference,
        orderBatchReference: record.orderBatchReference,
        amountMinor: record.preparation.total.amountMinor.toString(),
        recordingReason: record.recordingReason,
        takenAt: String(record.takenAt),
        recordedAt: String(record.recordedAt),
      });
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const resolved = await resolveScope(
          transaction,
          input.sessionCookie,
          counterOrderPermission,
          session.sessionReference,
        ).catch(() => fail("CARD_MACHINE_PERMISSION_DENIED"));
        const allowed = async () => (await resolved.allowed()) === true;
        if (!(await allowed())) return fail("CARD_MACHINE_PERMISSION_DENIED");
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
        const prior = await payments.loadByOperation(tx, command.operationReference);
        if (prior !== null) {
          if (
            prior.intentDigest !== intentDigest ||
            prior.actorReference !== actorReference ||
            prior.orderBatchReference !== command.orderBatchReference
          )
            return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
          return reply("AlreadyRecorded", prior);
        }
        const recordedAt = parsePaymentInstant(now());
        const takenAt =
          command.takenAt === null ? recordedAt : parsePaymentInstant(command.takenAt);
        if (
          takenAt > recordedAt ||
          Date.parse(recordedAt) - Date.parse(takenAt) > cardMachineBackEntryWindowMs
        )
          return fail("CARD_MACHINE_INPUT_INVALID");
        if (
          (await payments.loadByBatch(tx, command.orderReference, command.orderBatchReference)) !==
          null
        )
          return fail("CARD_MACHINE_ALREADY_PAID");
        // Only an order staff took at the counter is paid on the Store's card machine.
        const entry = (
          await createPostgresCounterOrderEntryStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: allowed,
          }).listByOrders(tx, [command.orderReference])
        ).get(command.orderReference);
        if (entry === undefined) return fail("CARD_MACHINE_NOT_FOUND");
        const order = await createPostgresCounterOrderEntryStore({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          authorize: allowed,
        }).loadOrder(tx, String(entry.cartReference));
        if (
          order === null ||
          String(order.orderReference) !== command.orderReference ||
          String(order.orderBatchReference) !== command.orderBatchReference
        )
          return fail("CARD_MACHINE_NOT_FOUND");
        const current = await readCounterPaymentPreparation(
          tx,
          { scope, now, nextPreparationReference: options.nextReference, authorize: allowed },
          {
            submissionReference: String(order.submissionReference),
            guestSessionReference: String(entry.guestSessionReference),
            tipSelectionReference: String(entry.tipSelectionReference),
          },
        );
        if (current === null) return fail("CARD_MACHINE_NOT_PAYABLE");
        const preparation = current.preparation;
        const total = preparation.total.amountMinor.toString();
        if (total !== command.expectedTotalMinor) return fail("CARD_MACHINE_AMOUNT_CHANGED", total);
        if (recordedAt >= String(preparation.capacityExpiresAt))
          return fail("CARD_MACHINE_PAYMENT_WINDOW_CLOSED");
        const record = parseCardMachinePaymentRecord({
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          cardMachinePaymentReference: options.nextReference(),
          paymentIntentReference: options.nextReference(),
          paymentAttemptReference: options.nextReference(),
          paymentOperationReference: current.paymentOperationReference,
          operationReference: command.operationReference,
          intentDigest,
          orderReference: command.orderReference,
          orderBatchReference: command.orderBatchReference,
          submissionReference: String(order.submissionReference),
          preparation,
          environment: options.environment,
          slipReference: command.slipReference,
          recordingReason: command.takenAt === null ? "AtCounter" : "RecordedAfterOutage",
          takenAt,
          recordedAt,
          actorReference,
          eventReference: options.nextReference(),
          auditReference: options.nextReference(),
        });
        const admitted = await options
          .admission({ scope, preparation, allowed })
          .admit(tx, cardMachinePaymentIntentView(record), recordedAt);
        if (
          admitted === false ||
          (admitted !== true && admitted.validUntil <= recordedAt) ||
          !(await allowed())
        )
          return fail("CARD_MACHINE_NOT_PAYABLE");
        const saved = await payments.record(tx, record);
        return reply(saved.status === "Created" ? "Recorded" : "AlreadyRecorded", saved.record);
      });
    } catch (error) {
      if (error instanceof CardMachinePaymentCommandError) throw error;
      if (error instanceof CardMachinePaymentError) {
        if (error.code === "CARD_MACHINE_IDEMPOTENCY_CONFLICT")
          return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
        if (error.code === "CARD_MACHINE_ALREADY_PAID") return fail("CARD_MACHINE_ALREADY_PAID");
        if (error.code === "CARD_MACHINE_INPUT_INVALID") return fail("CARD_MACHINE_INPUT_INVALID");
        if (error.code === "CARD_MACHINE_PERMISSION_DENIED")
          return fail("CARD_MACHINE_PERMISSION_DENIED");
      }
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED") return fail("CARD_MACHINE_PERMISSION_DENIED");
      if (code === "23505") return fail("CARD_MACHINE_ALREADY_PAID");
      return fail("CARD_MACHINE_UNAVAILABLE");
    }
  };
}
