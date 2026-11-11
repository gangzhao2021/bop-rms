import {
  parseOrderPaymentPreparationEvidence,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";

import type { PaymentSucceededEnvelope } from "../contracts/payment-terminal-event.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import {
  parsePaymentDigest,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
  type PaymentDigest,
  type PaymentInstant,
  type PaymentIntentCreationRecord,
} from "./payment-intent-creation.js";
import { parsePaymentSucceededEnvelope } from "./payment-terminal-event.js";
import {
  DiningTableSettlementError,
  planDiningTableSettlement,
  roundCashTotal,
} from "../domain/dining-table-settlement.js";

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD): a payment staff took on the Store's own card machine.
 * At the counter it is recorded right after the machine approved it; a paper order taken while the
 * system was unreachable is recorded afterwards with the time it was actually paid.
 */
export const cardMachineRecordingReasons = ["AtCounter", "RecordedAfterOutage"] as const;
export type CardMachineRecordingReason = (typeof cardMachineRecordingReasons)[number];

/** How long after the fact a paper order's payment may still be recorded. */
export const cardMachineBackEntryWindowMs = 72 * 60 * 60 * 1000;

export const cardMachinePaymentErrorCodes = [
  "CARD_MACHINE_INPUT_INVALID",
  "CARD_MACHINE_PERMISSION_DENIED",
  "CARD_MACHINE_NOT_FOUND",
  "CARD_MACHINE_NOT_PAYABLE",
  "CARD_MACHINE_AMOUNT_CHANGED",
  "CARD_MACHINE_PAYMENT_WINDOW_CLOSED",
  "CARD_MACHINE_ALREADY_PAID",
  "CARD_MACHINE_IDEMPOTENCY_CONFLICT",
  "CARD_MACHINE_REFUND_EXCEEDS_PAYMENT",
  /** WP-2423 M52: the cash handed over is less than the cash total (rounded to 5 cents). */
  "CARD_MACHINE_CASH_TENDER_SHORT",
  "CARD_MACHINE_UNAVAILABLE",
] as const;
export type CardMachinePaymentErrorCode = (typeof cardMachinePaymentErrorCodes)[number];

export class CardMachinePaymentError extends Error {
  readonly code: CardMachinePaymentErrorCode;
  constructor(code: CardMachinePaymentErrorCode) {
    super("card machine payment is unavailable");
    this.name = "CardMachinePaymentError";
    this.code = code;
  }
}

const invalid = (): never => {
  throw new CardMachinePaymentError("CARD_MACHINE_INPUT_INVALID");
};

/**
 * The last part of the machine's slip (approval or reference code). Never a card number: at most
 * 40 characters and at most 12 digits, so a full card number cannot be stored.
 */
export function parseCardMachineSlipReference(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(value) ||
    value.replace(/[^0-9]/gu, "").length > 12
  )
    return invalid();
  return value;
}

/**
 * WP-2423 M52 (DEC-COUNTER-CASH): a counter order paid in cash, by the table's cash rules: the
 * total is rounded to 5 cents (Canada), the guest hands over at least that and gets the change.
 * The order's amount (the preparation total) is unchanged; the rounding is its own amount.
 */
export interface CardMachineCashTender {
  readonly roundingMinor: bigint;
  readonly tenderedMinor: bigint;
  readonly changeMinor: bigint;
}

export interface CardMachinePaymentRecord {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  /** Also the payment transaction reference carried by PaymentSucceeded. */
  readonly cardMachinePaymentReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  /** The Order's payment operation opened when the payment clock started. */
  readonly paymentOperationReference: string;
  /** The staff command operation; replay returns the same record. */
  readonly operationReference: string;
  readonly intentDigest: PaymentDigest;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly preparation: OrderPaymentPreparationEvidence;
  readonly environment: "Test" | "Live";
  readonly slipReference: string | null;
  readonly recordingReason: CardMachineRecordingReason;
  readonly takenAt: PaymentInstant;
  readonly recordedAt: PaymentInstant;
  readonly actorReference: string;
  readonly eventReference: string;
  readonly auditReference: string;
  /** WP-2423 M52: present when the counter took cash (absent: the Store's card machine). */
  readonly cash?: CardMachineCashTender;
}

/**
 * WP-2423 M52: the cash a counter order takes for its payment total, with the table's cash code
 * (one line: the order and its tip). Throws CARD_MACHINE_CASH_TENDER_SHORT when the guest handed
 * over less than the cash total.
 */
export function planCounterCashTender(
  preparation: OrderPaymentPreparationEvidence,
  tenderedMinor: bigint,
): CardMachineCashTender {
  try {
    const plan = planDiningTableSettlement({
      method: "Cash",
      rounds: [
        {
          orderBatchReference: String(preparation.orderBatchReference),
          submissionReference: String(preparation.submissionReference),
          sequence: 1,
          roundMinor: preparation.orderAllocation.amountMinor,
        },
      ],
      tipMinor: preparation.tip.amountMinor,
      tenderedMinor,
    });
    if (
      plan.totalMinor <= 0n ||
      plan.roundsMinor + plan.tipMinor !== preparation.total.amountMinor ||
      plan.tenderedMinor === null ||
      plan.changeMinor === null
    )
      return invalid();
    return Object.freeze({
      roundingMinor: plan.roundingMinor,
      tenderedMinor: plan.tenderedMinor,
      changeMinor: plan.changeMinor,
    });
  } catch (error) {
    if (
      error instanceof DiningTableSettlementError &&
      error.code === "DINING_TABLE_SETTLEMENT_TENDER_SHORT"
    )
      throw new CardMachinePaymentError("CARD_MACHINE_CASH_TENDER_SHORT");
    if (error instanceof CardMachinePaymentError) throw error;
    return invalid();
  }
}

/** What the payment took: the card-machine charge, or the cash total (rounding included). */
export function cardMachinePaymentTakenMinor(record: CardMachinePaymentRecord): bigint {
  return record.preparation.total.amountMinor + (record.cash?.roundingMinor ?? 0n);
}

/**
 * WP-2423 M52/M131: what goes back for a refund of `wantedMinor` from this payment when
 * `refundedMinor` already went back. A card-machine refund is the amount itself; cash goes back in
 * whole nickels (the table's cash rounding: 1–2 cents down, 3–4 up), never more than the drawer
 * still holds of it. Zero when nothing can go back.
 */
export function cardMachineRefundGivenBackMinor(
  record: CardMachinePaymentRecord,
  wantedMinor: bigint,
  refundedMinor: bigint,
): bigint {
  const left = cardMachinePaymentTakenMinor(record) - refundedMinor;
  if (wantedMinor <= 0n || left <= 0n) return 0n;
  const amount = record.cash === undefined ? wantedMinor : roundCashTotal(wantedMinor).roundedMinor;
  return amount < left ? amount : left;
}

/**
 * WP-2423 M52/M131: how much of the Order this payment's recorded refunds gave back, in the
 * Order's terms (never the drawer's). On the card machine a refund is the Order's to the cent, so
 * it is `nominalMinor` itself. Cash goes back in whole nickels, so `nominalMinor` (each ordinary
 * request at its own amount, every other refund at what it handed back) can differ from the Order's
 * by the cash rounding; once the drawer has given back all the cash it took for the payment
 * (`handedBackMinor`, every recorded refund), nothing more can go back, so the Order is refunded in
 * full less what is still pending: no shortfall of a few cents stays open, and rounding handed back
 * beyond the Order's amount is never a refund of the Order.
 */
export function cardMachineOrderRefundedMinor(
  record: CardMachinePaymentRecord,
  input: {
    readonly nominalMinor: bigint;
    readonly pendingMinor: bigint;
    readonly handedBackMinor: bigint;
  },
): bigint {
  if (record.cash === undefined) return input.nominalMinor;
  const open = record.preparation.total.amountMinor - input.pendingMinor;
  if (open < 0n) return input.nominalMinor;
  return input.handedBackMinor >= cardMachinePaymentTakenMinor(record) || input.nominalMinor > open
    ? open
    : input.nominalMinor;
}

/**
 * WP-2423 M52/M131: a refund request on a counter cash payment that cannot be handed back in cash
 * (under 3 cents rounds to nothing), or for which the drawer holds nothing more of the payment.
 */
export function cardMachineCashRequestRefusal(
  record: CardMachinePaymentRecord,
  requestMinor: bigint,
  handedBackMinor: bigint,
): "UnderNickel" | "DrawerEmpty" | null {
  if (record.cash === undefined) return null;
  if (handedBackMinor >= cardMachinePaymentTakenMinor(record)) return "DrawerEmpty";
  return requestMinor > 0n && roundCashTotal(requestMinor).roundedMinor === 0n
    ? "UnderNickel"
    : null;
}

function parseCashTender(value: unknown, totalMinor: bigint): CardMachineCashTender {
  const raw = exact(value, ["roundingMinor", "tenderedMinor", "changeMinor"]);
  const { roundingMinor, tenderedMinor, changeMinor } = raw;
  if (
    typeof roundingMinor !== "bigint" ||
    typeof tenderedMinor !== "bigint" ||
    typeof changeMinor !== "bigint" ||
    roundCashTotal(totalMinor).roundingMinor !== roundingMinor ||
    totalMinor + roundingMinor <= 0n ||
    tenderedMinor < totalMinor + roundingMinor ||
    tenderedMinor > 9223372036854775807n ||
    changeMinor !== tenderedMinor - (totalMinor + roundingMinor)
  )
    return invalid();
  return Object.freeze({ roundingMinor, tenderedMinor, changeMinor });
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as string)))
    return invalid();
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    output[field] = descriptor.value;
  }
  return Object.freeze(output);
}

export function parseCardMachinePaymentRecord(value: unknown): CardMachinePaymentRecord {
  try {
    const paidInCash =
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "cash");
    const raw = exact(value, [
      ...(paidInCash ? ["cash"] : []),
      "tenantReference",
      "brandReference",
      "storeReference",
      "cardMachinePaymentReference",
      "paymentIntentReference",
      "paymentAttemptReference",
      "paymentOperationReference",
      "operationReference",
      "intentDigest",
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "preparation",
      "environment",
      "slipReference",
      "recordingReason",
      "takenAt",
      "recordedAt",
      "actorReference",
      "eventReference",
      "auditReference",
    ]);
    const preparation = parseOrderPaymentPreparationEvidence(raw.preparation);
    const takenAt = parsePaymentInstant(raw.takenAt);
    const recordedAt = parsePaymentInstant(raw.recordedAt);
    const reason = raw.recordingReason as CardMachineRecordingReason;
    const record = Object.freeze({
      tenantReference: String(parsePaymentReference(raw.tenantReference)),
      brandReference: String(parsePaymentReference(raw.brandReference)),
      storeReference: String(parsePaymentReference(raw.storeReference)),
      cardMachinePaymentReference: String(parsePaymentReference(raw.cardMachinePaymentReference)),
      paymentIntentReference: String(parsePaymentReference(raw.paymentIntentReference)),
      paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
      paymentOperationReference: String(parsePaymentReference(raw.paymentOperationReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      intentDigest: parsePaymentDigest(raw.intentDigest),
      orderReference: String(parsePaymentReference(raw.orderReference)),
      orderBatchReference: String(parsePaymentReference(raw.orderBatchReference)),
      submissionReference: String(parsePaymentReference(raw.submissionReference)),
      preparation,
      environment: raw.environment as "Test" | "Live",
      slipReference: parseCardMachineSlipReference(raw.slipReference),
      recordingReason: reason,
      takenAt,
      recordedAt,
      actorReference: String(parsePaymentReference(raw.actorReference)),
      eventReference: String(parsePaymentReference(raw.eventReference)),
      auditReference: String(parsePaymentReference(raw.auditReference)),
      ...(paidInCash ? { cash: parseCashTender(raw.cash, preparation.total.amountMinor) } : {}),
    });
    if (
      (record.cash !== undefined && record.slipReference !== null) ||
      (record.environment !== "Test" && record.environment !== "Live") ||
      !cardMachineRecordingReasons.includes(reason) ||
      takenAt > recordedAt ||
      Date.parse(recordedAt) - Date.parse(takenAt) > cardMachineBackEntryWindowMs ||
      (reason === "AtCounter" && takenAt !== recordedAt) ||
      String(preparation.brandReference) !== record.brandReference ||
      String(preparation.storeReference) !== record.storeReference ||
      String(preparation.orderReference) !== record.orderReference ||
      String(preparation.orderBatchReference) !== record.orderBatchReference ||
      String(preparation.submissionReference) !== record.submissionReference ||
      new Set([
        record.cardMachinePaymentReference,
        record.paymentIntentReference,
        record.paymentAttemptReference,
        record.paymentOperationReference,
        record.operationReference,
        record.eventReference,
        record.auditReference,
      ]).size !== 7
    )
      return invalid();
    return record;
  } catch (error) {
    if (error instanceof CardMachinePaymentError) throw error;
    return invalid();
  }
}

/** Canonical JSON of the payment preparation, money as exact decimal strings. */
export function serializeCardMachinePreparation(preparation: OrderPaymentPreparationEvidence) {
  return JSON.stringify(preparation, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** Revives stored preparation JSON (amountMinor strings become exact integers). */
export function reviveCardMachinePreparation(value: unknown): OrderPaymentPreparationEvidence {
  const revive = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return invalid();
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (key === "amountMinor") {
        if (typeof item !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(item)) return invalid();
        output[key] = BigInt(item);
      } else output[key] = revive(item);
    }
    return output;
  };
  try {
    return parseOrderPaymentPreparationEvidence(revive(value));
  } catch {
    return invalid();
  }
}

/**
 * The same paid signal an online capture produces, so the Order reaches acceptance and the
 * kitchen through the ordinary consumers. The terminal time is when the Store recorded the
 * payment (a back-entered paper order keeps its actual paid time on the record itself).
 */
export function createCardMachinePaymentEnvelope(
  record: CardMachinePaymentRecord,
): PaymentSucceededEnvelope {
  return parsePaymentSucceededEnvelope({
    eventId: record.eventReference,
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    occurredAt: record.recordedAt,
    producerModule: "@rms/payment",
    tenantId: record.brandReference,
    storeId: record.storeReference,
    aggregateType: "PaymentIntent",
    aggregateId: record.paymentIntentReference,
    aggregateVersion: 2n,
    correlationId: record.paymentOperationReference,
    causationId: record.operationReference,
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: record.cardMachinePaymentReference,
      paymentIntentReference: record.paymentIntentReference,
      paymentAttemptReference: record.paymentAttemptReference,
      orderReference: record.orderReference,
      amountMinor: record.preparation.total.amountMinor.toString(),
      currencyCode: "CAD",
      evidenceKind: "Captured",
      terminalOccurredAt: record.recordedAt,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  });
}

/** The Payment Intent view of a card-machine payment, for owners that read captured payments. */
export function cardMachinePaymentIntentView(
  record: CardMachinePaymentRecord,
): PaymentIntentCreationRecord {
  return parsePaymentIntentCreationRecord({
    intent: {
      paymentIntentReference: record.paymentIntentReference,
      paymentOperationReference: record.paymentOperationReference,
      intentDigest: record.intentDigest,
      preparation: record.preparation,
      paymentMethod: "StoreCardMachine",
      captureMode: "Automatic",
      aggregateVersion: 1,
      creationStatus: "Recorded",
      createdAt: record.recordedAt,
    },
    attempt: {
      paymentAttemptReference: record.paymentAttemptReference,
      paymentIntentReference: record.paymentIntentReference,
      attemptNumber: 1,
      provider: "StoreCardMachine",
      providerEnvironment: record.environment,
      providerIdempotencyDigest: record.intentDigest,
      createdAt: record.recordedAt,
    },
    providerOutcome: null,
  });
}

/** The captured terminal view of a card-machine payment (the subset owners compare). */
export function cardMachineTerminalView(record: CardMachinePaymentRecord) {
  return Object.freeze({
    outcome: "Succeeded" as const,
    paymentTransactionReference: record.cardMachinePaymentReference,
    paymentIntentReference: record.paymentIntentReference,
    paymentAttemptReference: record.paymentAttemptReference,
    orderReference: record.orderReference,
    amount: Object.freeze({
      amountMinor: record.preparation.total.amountMinor,
      currencyCode: "CAD" as const,
    }),
    occurredAt: record.recordedAt,
    recordedAt: record.recordedAt,
    event: createCardMachinePaymentEnvelope(record),
  });
}

export const cardMachineRefundSourceKinds = [
  "StaffCancellation",
  "ItemCancellation",
  "UnfulfillableOrder",
  "OrdinaryRefund",
] as const;
export type CardMachineRefundSourceKind = (typeof cardMachineRefundSourceKinds)[number];

export interface CardMachineRefundRecord {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly cardMachineRefundReference: string;
  readonly cardMachinePaymentReference: string;
  readonly orderReference: string;
  readonly operationReference: string;
  readonly intentDigest: PaymentDigest;
  readonly sourceKind: CardMachineRefundSourceKind;
  readonly sourceReference: string;
  readonly amountMinor: bigint;
  readonly slipReference: string | null;
  readonly refundedAt: PaymentInstant;
  readonly recordedAt: PaymentInstant;
  readonly actorReference: string;
  readonly auditReference: string;
}

export function parseCardMachineRefundRecord(value: unknown): CardMachineRefundRecord {
  try {
    const raw = exact(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "cardMachineRefundReference",
      "cardMachinePaymentReference",
      "orderReference",
      "operationReference",
      "intentDigest",
      "sourceKind",
      "sourceReference",
      "amountMinor",
      "slipReference",
      "refundedAt",
      "recordedAt",
      "actorReference",
      "auditReference",
    ]);
    const refundedAt = parsePaymentInstant(raw.refundedAt);
    const recordedAt = parsePaymentInstant(raw.recordedAt);
    if (
      typeof raw.amountMinor !== "bigint" ||
      raw.amountMinor < 1n ||
      raw.amountMinor > 9223372036854775807n ||
      !cardMachineRefundSourceKinds.includes(raw.sourceKind as CardMachineRefundSourceKind) ||
      refundedAt > recordedAt ||
      Date.parse(recordedAt) - Date.parse(refundedAt) > cardMachineBackEntryWindowMs
    )
      return invalid();
    return Object.freeze({
      tenantReference: String(parsePaymentReference(raw.tenantReference)),
      brandReference: String(parsePaymentReference(raw.brandReference)),
      storeReference: String(parsePaymentReference(raw.storeReference)),
      cardMachineRefundReference: String(parsePaymentReference(raw.cardMachineRefundReference)),
      cardMachinePaymentReference: String(parsePaymentReference(raw.cardMachinePaymentReference)),
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      intentDigest: parsePaymentDigest(raw.intentDigest),
      sourceKind: raw.sourceKind as CardMachineRefundSourceKind,
      sourceReference: String(parsePaymentReference(raw.sourceReference)),
      amountMinor: raw.amountMinor,
      slipReference: parseCardMachineSlipReference(raw.slipReference),
      refundedAt,
      recordedAt,
      actorReference: String(parsePaymentReference(raw.actorReference)),
      auditReference: String(parsePaymentReference(raw.auditReference)),
    });
  } catch (error) {
    if (error instanceof CardMachinePaymentError) throw error;
    return invalid();
  }
}
