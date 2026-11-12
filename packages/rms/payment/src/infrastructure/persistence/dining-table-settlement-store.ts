import { appendAuditRecordInTransaction, type AuditTransaction } from "@bop/audit";
import {
  planDiningTableSettlement,
  type DiningTableSettlementMethod,
  type DiningTableSettlementRound,
} from "../../domain/dining-table-settlement.js";
import type {
  DiningTableSplit,
  DiningTableSplitDishChoice,
  DiningTableSplitMode,
  DiningTableSplitPart,
  DiningTableSplitUnit,
} from "../../domain/dining-table-split.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";

export type DiningTableSettlementStoreErrorCode =
  | "DINING_TABLE_SETTLEMENT_UNAVAILABLE"
  | "DINING_TABLE_SETTLEMENT_PERMISSION_DENIED"
  | "DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT"
  | "DINING_TABLE_SETTLEMENT_ALREADY_PAID"
  | "DINING_TABLE_WRITE_OFF_ALREADY_RECORDED";
export class DiningTableSettlementStoreError extends Error {
  constructor(readonly code: DiningTableSettlementStoreErrorCode) {
    super("dining table settlement is unavailable");
    this.name = "DiningTableSettlementStoreError";
  }
}
const fail = (
  code: DiningTableSettlementStoreErrorCode = "DINING_TABLE_SETTLEMENT_UNAVAILABLE",
): never => {
  throw new DiningTableSettlementStoreError(code);
};
const ref = (value: unknown) => String(parsePaymentReference(value));
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const minor = (value: unknown, minimum = 0n) => {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
  const parsed = BigInt(value);
  return parsed < minimum ? fail() : parsed;
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  const value = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : fail();
}

export interface DiningTableSettlementRecord {
  readonly settlementReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly diningSessionReference: string;
  readonly orderReference: string;
  readonly method: DiningTableSettlementMethod;
  readonly roundsMinor: bigint;
  readonly tipMinor: bigint;
  readonly roundingMinor: bigint;
  readonly totalMinor: bigint;
  readonly tenderedMinor: bigint | null;
  readonly changeMinor: bigint | null;
  readonly environment: "Test" | "Live";
  readonly slipReference: string | null;
  readonly recordingReason: "AtTable" | "RecordedAfterOutage";
  readonly takenAt: string;
  readonly recordedAt: string;
  readonly actorReference: string;
  readonly auditReference: string;
  /** S4: the guest's online payment this settlement records (method Online only). */
  readonly onlinePaymentReference: string | null;
  /** WP-2423 item 8 ④: the part of the table's split plan this payment is (null: the whole table). */
  readonly part: DiningTableSplitPartReference | null;
  /** One line per round the table owed; the tip and rounding are on the last line. */
  readonly lines: readonly {
    /** WP-2423 item 8 ⑨: the Order of the round (a merged table's round keeps its own). */
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly submissionReference: string;
    readonly lineNumber: number;
    readonly roundMinor: bigint;
    readonly tipMinor: bigint;
    readonly roundingMinor: bigint;
  }[];
}

export type DiningTableCashRefundReason =
  "FOOD_ISSUE" | "CUSTOMER_REQUEST" | "OVERCHARGED" | "STORE_ERROR";
export const diningTableCashRefundReasons: readonly DiningTableCashRefundReason[] = [
  "FOOD_ISSUE",
  "CUSTOMER_REQUEST",
  "OVERCHARGED",
  "STORE_ERROR",
];
/** Cash given back from a table's cash payment (manager-approved; compensating, append-only). */
export interface DiningTableCashRefundRecord {
  readonly cashRefundReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly settlementReference: string;
  readonly orderReference: string;
  readonly amountMinor: bigint;
  readonly reasonCode: DiningTableCashRefundReason;
  readonly approvedByActorReference: string;
  readonly refundedAt: string;
  readonly recordedAt: string;
  readonly auditReference: string;
}
const cashRefundSelect = `SELECT r.cash_refund_id::text AS refund,r.tenant_id::text AS tenant,r.operation_id::text AS operation,
 r.intent_digest,r.settlement_id::text AS settlement,r.order_id::text AS "order",r.amount_minor::text AS amount,
 r.reason_code,r.approved_by_actor_id::text AS approved_by,${instant("r.refunded_at")} AS refunded_at,
 ${instant("r.recorded_at")} AS recorded_at,r.audit_id::text AS audit
 FROM rms_payment.dining_table_cash_refund r WHERE r.brand_id=$1 AND r.store_id=$2`;
function cashRefundFrom(row: Record<string, unknown>): DiningTableCashRefundRecord {
  const reason = diningTableCashRefundReasons.includes(
    row.reason_code as DiningTableCashRefundReason,
  )
    ? (row.reason_code as DiningTableCashRefundReason)
    : fail();
  return Object.freeze({
    cashRefundReference: ref(row.refund),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    settlementReference: ref(row.settlement),
    orderReference: ref(row.order),
    amountMinor: minor(row.amount, 1n),
    reasonCode: reason,
    approvedByActorReference: ref(row.approved_by),
    refundedAt: String(parsePaymentInstant(row.refunded_at)),
    recordedAt: String(parsePaymentInstant(row.recorded_at)),
    auditReference: ref(row.audit),
  });
}

/**
 * S4 (DEC-DINE-IN-PAY-LATER decisions 3-5): a guest's attempt to pay the whole table on their
 * phone — one Provider transaction — and, once the Provider reports it, its outcome.
 */
/** WP-2423 item 8 ④: one part of a table's split plan. */
export interface DiningTableSplitPartReference {
  readonly splitPlanReference: string;
  readonly partNumber: number;
}
const partFrom = (plan: unknown, number: unknown): DiningTableSplitPartReference | null => {
  if (plan === null && number === null) return null;
  const partNumber = Number(number);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 100) return fail();
  return Object.freeze({ splitPlanReference: ref(plan), partNumber });
};

/** WP-2423 item 8 ④: a recorded split plan (the latest version is the table's current split). */
export interface DiningTableSplitPlanRecord {
  readonly splitPlanReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly diningSessionReference: string;
  readonly orderReference: string;
  readonly planVersion: number;
  /** "Whole": back to one payment for the table (no parts). */
  readonly mode: "Whole" | DiningTableSplitMode;
  readonly billMinor: bigint;
  readonly recordedAt: string;
  readonly actorReference: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly amountMinor: bigint;
    readonly subtotalMinor: bigint;
    readonly taxMinor: bigint;
    readonly slices: readonly {
      readonly orderBatchReference: string;
      readonly roundMinor: bigint;
      readonly subtotalMinor: bigint;
      readonly taxMinor: bigint;
    }[];
  }[];
  /** ByItems: which part each unit of each dish goes to (null: all the parts share it). */
  readonly dishChoices: readonly DiningTableSplitDishChoice[];
  /**
   * WP-2423 同桌结账, ByGuests only: who chose each part (in part order), the units it pays for,
   * whether it took the last of the bill, and whether it was withdrawn (its phone payment failed or
   * was cancelled: its dishes are unpaid again).
   */
  readonly guestParts: readonly DiningTableGuestPartRecord[];
}
export interface DiningTableGuestPartRecord {
  readonly partNumber: number;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly choice: "Mine" | "Chosen" | "Rest";
  readonly actorType: "Guest" | "Staff";
  readonly guestSessionReference: string | null;
  readonly actorReference: string | null;
  readonly completesBill: boolean;
  readonly recordedAt: string;
  readonly units: readonly DiningTableSplitUnit[];
  readonly withdrawn: null | {
    readonly reason: "PaymentFailed" | "PaymentCancelled";
    readonly lastPartNumber: number;
    readonly recordedAt: string;
  };
}
/** WP-2423 同桌结账: the parts of a ByGuests plan still standing (paid or being paid). */
export function diningTableStandingGuestParts(plan: DiningTableSplitPlanRecord) {
  const standing = new Set(
    plan.guestParts.filter((part) => part.withdrawn === null).map((part) => part.partNumber),
  );
  return plan.parts.filter((part) => standing.has(part.partNumber));
}
/**
 * WP-2423 item 8 ④ and 同桌结账: whether a split plan is paid in full by these settlements — every
 * part paid; for guests paying by dish, also a part still standing took the last of the bill (no
 * earlier part gave its dishes back after it) and every part still standing is paid. The same rule
 * as the database's (2000_524 rms_payment.dining_table_by_guests_paid).
 */
export function diningTableSplitPaidInFull(
  plan: DiningTableSplitPlanRecord,
  settlements: readonly { readonly part: DiningTableSplitPartReference | null }[],
): boolean {
  if (plan.mode === "Whole") return false;
  const paid = (partNumber: number) =>
    settlements.some(
      (settlement) =>
        settlement.part?.splitPlanReference === plan.splitPlanReference &&
        settlement.part.partNumber === partNumber,
    );
  if (plan.mode !== "ByGuests") return plan.parts.every((part) => paid(part.partNumber));
  const withdrawals = plan.guestParts.flatMap((part) =>
    part.withdrawn === null ? [] : [{ partNumber: part.partNumber, ...part.withdrawn }],
  );
  const completing = plan.guestParts.some(
    (part) =>
      part.completesBill &&
      part.withdrawn === null &&
      !withdrawals.some(
        (withdrawal) =>
          withdrawal.partNumber < part.partNumber && withdrawal.lastPartNumber >= part.partNumber,
      ),
  );
  return (
    completing &&
    plan.guestParts.filter((part) => part.withdrawn === null).every((part) => paid(part.partNumber))
  );
}
const splitPlanSelect = `SELECT p.split_plan_id::text AS plan,p.tenant_id::text AS tenant,p.operation_id::text AS operation,
 p.intent_digest,p.dining_session_id::text AS session,p.order_id::text AS "order",p.plan_version,p.mode,
 p.part_count,p.bill_minor::text AS bill,${instant("p.recorded_at")} AS recorded_at,p.actor_id::text AS actor,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('part',x.part_number,'amount',x.amount_minor::text,
   'subtotal',x.subtotal_minor::text,'tax',x.tax_minor::text,
   'slices',(SELECT coalesce(jsonb_agg(jsonb_build_object('batch',r.order_batch_id,'round',r.round_minor::text,
     'subtotal',r.subtotal_minor::text,'tax',r.tax_minor::text) ORDER BY r.order_batch_id),'[]'::jsonb)
     FROM rms_payment.dining_table_split_part_round r WHERE r.split_plan_id=x.split_plan_id
     AND r.part_number=x.part_number AND r.brand_id=x.brand_id AND r.store_id=x.store_id))
   ORDER BY x.part_number),'[]'::jsonb) FROM rms_payment.dining_table_split_part x
   WHERE x.split_plan_id=p.split_plan_id AND x.brand_id=p.brand_id AND x.store_id=p.store_id) AS parts,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('item',i.order_item_id,'unit',i.unit_number,'part',i.part_number)
   ORDER BY i.order_item_id,i.unit_number),'[]'::jsonb) FROM rms_payment.dining_table_split_part_item i
   WHERE i.split_plan_id=p.split_plan_id AND i.brand_id=p.brand_id AND i.store_id=p.store_id) AS dish_choices,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('part',a.part_number,'operation',a.operation_id,
   'digest',a.intent_digest,'choice',a.choice,'actorType',a.actor_type,'actor',a.actor_id,
   'guest',a.guest_session_id,'completes',a.completes_bill,'at',${instant("a.recorded_at")},
   'units',(SELECT coalesce(jsonb_agg(jsonb_build_object('item',u.order_item_id,'unit',u.unit_number)
     ORDER BY u.order_item_id,u.unit_number),'[]'::jsonb) FROM rms_payment.dining_table_split_part_unit u
     WHERE u.split_plan_id=a.split_plan_id AND u.part_number=a.part_number AND u.brand_id=a.brand_id
     AND u.store_id=a.store_id),
   'withdrawn',(SELECT jsonb_build_object('reason',w.reason,'last',w.last_part_number,
     'at',${instant("w.recorded_at")}) FROM rms_payment.dining_table_split_part_withdrawal w
     WHERE w.split_plan_id=a.split_plan_id AND w.part_number=a.part_number AND w.brand_id=a.brand_id
     AND w.store_id=a.store_id)) ORDER BY a.part_number),'[]'::jsonb)
   FROM rms_payment.dining_table_split_part_append a
   WHERE a.split_plan_id=p.split_plan_id AND a.brand_id=p.brand_id AND a.store_id=p.store_id) AS guest_parts
 FROM rms_payment.dining_table_split_plan p WHERE p.brand_id=$1 AND p.store_id=$2`;
function splitPlanFrom(row: Record<string, unknown>): DiningTableSplitPlanRecord {
  const mode =
    row.mode === "Whole" ||
    row.mode === "Even" ||
    row.mode === "ByRounds" ||
    row.mode === "ByItems" ||
    row.mode === "ByGuests"
      ? row.mode
      : fail();
  const version = Number(row.plan_version);
  const parts = row.parts;
  const dishChoices = row.dish_choices;
  const guestParts = row.guest_parts;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Array.isArray(parts) ||
    !Array.isArray(dishChoices) ||
    !Array.isArray(guestParts)
  )
    return fail();
  // A ByGuests plan's parts are appended as guests choose (its part count stays 0).
  if (
    mode === "ByGuests"
      ? guestParts.length !== parts.length
      : parts.length !== Number(row.part_count)
  )
    return fail();
  return Object.freeze({
    splitPlanReference: ref(row.plan),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    diningSessionReference: ref(row.session),
    orderReference: ref(row.order),
    planVersion: version,
    mode,
    billMinor: minor(row.bill, 1n),
    recordedAt: String(parsePaymentInstant(row.recorded_at)),
    actorReference: ref(row.actor),
    parts: Object.freeze(
      parts.map((part: Record<string, unknown>) => {
        if (!Array.isArray(part.slices)) return fail();
        return Object.freeze({
          partNumber: Number(part.part),
          amountMinor: minor(part.amount, 1n),
          subtotalMinor: minor(part.subtotal),
          taxMinor: minor(part.tax),
          slices: Object.freeze(
            part.slices.map((slice: Record<string, unknown>) =>
              Object.freeze({
                orderBatchReference: ref(slice.batch),
                roundMinor: minor(slice.round, 1n),
                subtotalMinor: minor(slice.subtotal),
                taxMinor: minor(slice.tax),
              }),
            ),
          ),
        });
      }),
    ),
    dishChoices: Object.freeze(
      dishChoices.map((choice: Record<string, unknown>) =>
        Object.freeze({
          orderItemReference: ref(choice.item),
          unit: Number(choice.unit),
          partNumber: choice.part === null ? null : Number(choice.part),
        }),
      ),
    ),
    guestParts: Object.freeze(
      guestParts.map((part: Record<string, unknown>) => {
        const withdrawn = part.withdrawn as Record<string, unknown> | null;
        if (!Array.isArray(part.units)) return fail();
        return Object.freeze({
          partNumber: Number(part.part),
          operationReference: ref(part.operation),
          intentDigest: String(part.digest),
          choice:
            part.choice === "Mine" || part.choice === "Chosen" || part.choice === "Rest"
              ? part.choice
              : fail(),
          actorType:
            part.actorType === "Guest" || part.actorType === "Staff" ? part.actorType : fail(),
          guestSessionReference: part.guest === null ? null : ref(part.guest),
          actorReference: part.actor === null ? null : ref(part.actor),
          completesBill: part.completes === true,
          recordedAt: String(parsePaymentInstant(part.at)),
          units: Object.freeze(
            part.units.map((unit: Record<string, unknown>) =>
              Object.freeze({ orderItemReference: ref(unit.item), unit: Number(unit.unit) }),
            ),
          ),
          withdrawn:
            withdrawn === null || withdrawn === undefined
              ? null
              : Object.freeze({
                  reason:
                    withdrawn.reason === "PaymentFailed" || withdrawn.reason === "PaymentCancelled"
                      ? withdrawn.reason
                      : fail(),
                  lastPartNumber: Number(withdrawn.last),
                  recordedAt: String(parsePaymentInstant(withdrawn.at)),
                }),
        });
      }),
    ),
  });
}

/** WP-2423 DEC-TABLE-ONLINE-REFUND: a refund made on the card machine, of a table paid there. */
export interface DiningTableCardRefundRecord {
  readonly cardRefundReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly settlementReference: string;
  readonly orderReference: string;
  readonly amountMinor: bigint;
  readonly reasonCode: DiningTableCashRefundReason;
  readonly slipReference: string | null;
  readonly approvedByActorReference: string;
  readonly refundedAt: string;
  readonly recordedAt: string;
}
const cardRefundSelect = `SELECT r.card_refund_id::text AS refund,r.tenant_id::text AS tenant,r.operation_id::text AS operation,
 r.intent_digest,r.settlement_id::text AS settlement,r.order_id::text AS "order",r.amount_minor::text AS amount,
 r.reason_code,r.slip_reference,r.approved_by_actor_id::text AS approved_by,${instant("r.refunded_at")} AS refunded_at,
 ${instant("r.recorded_at")} AS recorded_at
 FROM rms_payment.dining_table_card_refund r WHERE r.brand_id=$1 AND r.store_id=$2`;
function cardRefundFrom(row: Record<string, unknown>): DiningTableCardRefundRecord {
  return Object.freeze({
    cardRefundReference: ref(row.refund),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    settlementReference: ref(row.settlement),
    orderReference: ref(row.order),
    amountMinor: minor(row.amount, 1n),
    reasonCode: diningTableCashRefundReasons.includes(
      row.reason_code as DiningTableCashRefundReason,
    )
      ? (row.reason_code as DiningTableCashRefundReason)
      : fail(),
    slipReference: row.slip_reference === null ? null : String(row.slip_reference),
    approvedByActorReference: ref(row.approved_by),
    refundedAt: String(parsePaymentInstant(row.refunded_at)),
    recordedAt: String(parsePaymentInstant(row.recorded_at)),
  });
}

/**
 * WP-2423 DEC-TABLE-ONLINE-REFUND: money going back to the card of a table paid on a guest's phone.
 * The approval fixes the amount and the Provider key; `outcome` is null until the Provider answers.
 */
export interface DiningTableOnlineRefundRecord {
  readonly onlineRefundReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly settlementReference: string;
  readonly onlinePaymentReference: string;
  readonly orderReference: string;
  readonly amountMinor: bigint;
  readonly reasonCode: DiningTableCashRefundReason;
  readonly approvedByActorReference: string;
  readonly providerIdempotencyKey: string;
  readonly requestedAt: string;
  readonly outcome: null | {
    readonly status: "Succeeded" | "Failed";
    readonly providerRefundReference: string | null;
    readonly providerCreatedAt: string | null;
    readonly recordedAt: string;
  };
}
const onlineRefundSelect = `SELECT r.online_refund_id::text AS refund,r.tenant_id::text AS tenant,r.operation_id::text AS operation,
 r.intent_digest,r.settlement_id::text AS settlement,r.online_payment_id::text AS payment,r.order_id::text AS "order",
 r.amount_minor::text AS amount,r.reason_code,r.approved_by_actor_id::text AS approved_by,
 r.provider_idempotency_key,${instant("r.requested_at")} AS requested_at,o.status,
 o.provider_refund_reference,${instant("o.provider_created_at")} AS provider_created_at,
 ${instant("o.recorded_at")} AS outcome_recorded_at
 FROM rms_payment.dining_table_online_refund r LEFT JOIN rms_payment.dining_table_online_refund_outcome o
 ON o.online_refund_id=r.online_refund_id AND o.brand_id=r.brand_id AND o.store_id=r.store_id
 WHERE r.brand_id=$1 AND r.store_id=$2`;
function onlineRefundFrom(row: Record<string, unknown>): DiningTableOnlineRefundRecord {
  const reason = diningTableCashRefundReasons.includes(
    row.reason_code as DiningTableCashRefundReason,
  )
    ? (row.reason_code as DiningTableCashRefundReason)
    : fail();
  const status =
    row.status === null
      ? null
      : row.status === "Succeeded" || row.status === "Failed"
        ? row.status
        : fail();
  return Object.freeze({
    onlineRefundReference: ref(row.refund),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    settlementReference: ref(row.settlement),
    onlinePaymentReference: ref(row.payment),
    orderReference: ref(row.order),
    amountMinor: minor(row.amount, 1n),
    reasonCode: reason,
    approvedByActorReference: ref(row.approved_by),
    providerIdempotencyKey:
      typeof row.provider_idempotency_key === "string" ? row.provider_idempotency_key : fail(),
    requestedAt: String(parsePaymentInstant(row.requested_at)),
    outcome:
      status === null
        ? null
        : Object.freeze({
            status,
            providerRefundReference:
              row.provider_refund_reference === null ? null : String(row.provider_refund_reference),
            providerCreatedAt:
              row.provider_created_at === null
                ? null
                : String(parsePaymentInstant(row.provider_created_at)),
            recordedAt: String(parsePaymentInstant(row.outcome_recorded_at)),
          }),
  });
}

export interface DiningTableOnlinePaymentRecord {
  readonly onlinePaymentReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly diningSessionReference: string;
  readonly orderReference: string;
  readonly guestSessionReference: string;
  readonly roundsMinor: bigint;
  readonly tipMinor: bigint;
  readonly totalMinor: bigint;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly providerIntentReference: string;
  readonly createdAt: string;
  /** WP-2423 item 8 ④: the part this payment is for (null: the whole table). */
  readonly part: DiningTableSplitPartReference | null;
  readonly outcome: null | {
    readonly status: "Captured" | "Failed" | "Cancelled";
    readonly capturedMinor: bigint | null;
    readonly providerTransactionReference: string | null;
    readonly occurredAt: string;
    readonly recordedAt: string;
  };
}
/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT: whether a guest's online attempt holds the table's bill as it was
 * when it started — while it is open (no Provider outcome yet) or once it captured (its settlement
 * follows). A Failed or Cancelled attempt took no money, so the bill (its tax rounding, merging,
 * rounds waiting for staff) moves on as if it never started.
 */
export const onlinePaymentHoldsBill = (
  payment: Pick<DiningTableOnlinePaymentRecord, "outcome">,
): boolean => payment.outcome === null || payment.outcome.status === "Captured";
const onlinePaymentSelect = `SELECT p.online_payment_id::text AS payment,p.tenant_id::text AS tenant,
 p.operation_id::text AS operation,p.intent_digest,p.dining_session_id::text AS session,p.order_id::text AS "order",
 p.guest_session_id::text AS guest,p.rounds_minor::text AS rounds,p.tip_minor::text AS tip,
 p.total_minor::text AS total,p.provider_account_id::text AS account,p.payment_environment AS environment,
 p.provider_intent_reference AS intent,${instant("p.created_at")} AS created_at,
 p.split_plan_id::text AS split_plan,p.part_number,o.status,
 o.captured_minor::text AS captured,o.provider_transaction_reference AS transaction,
 ${instant("o.occurred_at")} AS occurred_at,${instant("o.recorded_at")} AS outcome_recorded_at
 FROM rms_payment.dining_table_online_payment p LEFT JOIN rms_payment.dining_table_online_payment_outcome o
 ON o.online_payment_id=p.online_payment_id AND o.brand_id=p.brand_id AND o.store_id=p.store_id
 WHERE p.brand_id=$1 AND p.store_id=$2`;
function onlinePaymentFrom(row: Record<string, unknown>): DiningTableOnlinePaymentRecord {
  const environment =
    row.environment === "Test" || row.environment === "Live" ? row.environment : fail();
  const status =
    row.status === null
      ? null
      : row.status === "Captured" || row.status === "Failed" || row.status === "Cancelled"
        ? row.status
        : fail();
  return Object.freeze({
    onlinePaymentReference: ref(row.payment),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    diningSessionReference: ref(row.session),
    orderReference: ref(row.order),
    guestSessionReference: ref(row.guest),
    roundsMinor: minor(row.rounds, 1n),
    tipMinor: minor(row.tip),
    totalMinor: minor(row.total, 1n),
    providerAccountReference: ref(row.account),
    environment,
    providerIntentReference:
      typeof row.intent === "string" && /^pi_[A-Za-z0-9]{1,250}$/u.test(row.intent)
        ? row.intent
        : fail(),
    createdAt: String(parsePaymentInstant(row.created_at)),
    part: partFrom(row.split_plan, row.part_number),
    outcome:
      status === null
        ? null
        : Object.freeze({
            status,
            capturedMinor: row.captured === null ? null : minor(row.captured, 1n),
            providerTransactionReference: row.transaction === null ? null : String(row.transaction),
            occurredAt: String(parsePaymentInstant(row.occurred_at)),
            recordedAt: String(parsePaymentInstant(row.outcome_recorded_at)),
          }),
  });
}

export interface OrderUnpaidWriteOffRecord {
  readonly writeOffReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly operationReference: string;
  readonly diningSessionReference: string;
  readonly orderReference: string;
  readonly orderVersion: number;
  readonly orderCheckpoint: string;
  readonly reasonCode: "GUEST_LEFT_UNPAID";
  readonly pricedOrderTotalMinor: bigint;
  readonly capturedOrderAllocationMinor: bigint;
  readonly writtenOffMinor: bigint;
  readonly requestedByActorReference: string;
  readonly approvedByActorReference: string;
  readonly orderEvidenceDigest: string;
  readonly paymentEvidenceDigest: string;
  readonly decidedAt: string;
  readonly auditReference: string;
}

const settlementSelect = `SELECT s.settlement_id::text AS settlement,s.tenant_id::text AS tenant,
 s.brand_id::text AS brand,s.store_id::text AS store,s.operation_id::text AS operation,s.intent_digest,
 s.dining_session_id::text AS session,s.order_id::text AS "order",s.method,s.rounds_minor::text AS rounds,
 s.tip_minor::text AS tip,s.rounding_minor::text AS rounding,s.total_minor::text AS total,
 s.tendered_minor::text AS tendered,s.change_minor::text AS change,s.payment_environment AS environment,
 s.slip_reference,s.recording_reason,${instant("s.taken_at")} AS taken_at,${instant("s.recorded_at")} AS recorded_at,
 s.actor_id::text AS actor,s.audit_id::text AS audit,s.online_payment_id::text AS online_payment,
 s.split_plan_id::text AS split_plan,s.part_number,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('order',r.order_id,'batch',r.order_batch_id,'submission',r.submission_id,
   'line',r.line_number,'round',r.round_minor::text,'tip',r.tip_minor::text,'rounding',r.rounding_minor::text)
   ORDER BY r.line_number),'[]'::jsonb) FROM rms_payment.dining_table_settlement_round r
   WHERE r.settlement_id=s.settlement_id AND r.brand_id=s.brand_id AND r.store_id=s.store_id) AS lines
 FROM rms_payment.dining_table_settlement s WHERE s.brand_id=$1 AND s.store_id=$2`;
const writeOffSelect = `SELECT w.write_off_id::text AS write_off,w.tenant_id::text AS tenant,
 w.brand_id::text AS brand,w.store_id::text AS store,w.operation_id::text AS operation,
 w.dining_session_id::text AS session,w.order_id::text AS "order",w.order_version,
 w.order_checkpoint::text AS checkpoint,w.reason_code,w.priced_order_total_minor::text AS priced,
 w.captured_order_allocation_minor::text AS captured,w.written_off_minor::text AS written_off,
 w.requested_by_actor_id::text AS requested_by,w.approved_by_actor_id::text AS approved_by,
 w.order_evidence_digest,w.payment_evidence_digest,${instant("w.decided_at")} AS decided_at,
 w.audit_id::text AS audit FROM rms_payment.order_unpaid_write_off w WHERE w.brand_id=$1 AND w.store_id=$2`;

function settlementFrom(row: Record<string, unknown>): DiningTableSettlementRecord {
  const lines = row.lines;
  if (!Array.isArray(lines) || lines.length < 1) return fail();
  const method =
    row.method === "Cash" || row.method === "CardMachine" || row.method === "Online"
      ? row.method
      : fail();
  if ((method === "Online") !== (row.online_payment !== null)) return fail();
  const environment =
    row.environment === "Test" || row.environment === "Live" ? row.environment : fail();
  const reason =
    row.recording_reason === "AtTable" || row.recording_reason === "RecordedAfterOutage"
      ? row.recording_reason
      : fail();
  return Object.freeze({
    settlementReference: ref(row.settlement),
    tenantReference: ref(row.tenant),
    brandReference: ref(row.brand),
    storeReference: ref(row.store),
    operationReference: ref(row.operation),
    intentDigest:
      typeof row.intent_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.intent_digest)
        ? row.intent_digest
        : fail(),
    diningSessionReference: ref(row.session),
    orderReference: ref(row.order),
    method,
    roundsMinor: minor(row.rounds, 1n),
    tipMinor: minor(row.tip),
    roundingMinor: minor(row.rounding, -2n),
    totalMinor: minor(row.total, 1n),
    tenderedMinor: row.tendered === null ? null : minor(row.tendered, 1n),
    changeMinor: row.change === null ? null : minor(row.change),
    environment,
    slipReference: row.slip_reference === null ? null : String(row.slip_reference),
    recordingReason: reason,
    takenAt: String(parsePaymentInstant(row.taken_at)),
    recordedAt: String(parsePaymentInstant(row.recorded_at)),
    actorReference: ref(row.actor),
    auditReference: ref(row.audit),
    onlinePaymentReference: row.online_payment === null ? null : ref(row.online_payment),
    part: partFrom(row.split_plan, row.part_number),
    lines: Object.freeze(
      lines.map((value: Record<string, unknown>) =>
        Object.freeze({
          orderReference: ref(value.order),
          orderBatchReference: ref(value.batch),
          submissionReference: ref(value.submission),
          lineNumber: Number(value.line),
          roundMinor: minor(value.round, 1n),
          tipMinor: minor(value.tip),
          roundingMinor: minor(value.rounding, -2n),
        }),
      ),
    ),
  });
}
function writeOffFrom(row: Record<string, unknown>): OrderUnpaidWriteOffRecord {
  if (row.reason_code !== "GUEST_LEFT_UNPAID") return fail();
  const version = Number(row.order_version);
  if (!Number.isSafeInteger(version) || version < 1) return fail();
  return Object.freeze({
    writeOffReference: ref(row.write_off),
    tenantReference: ref(row.tenant),
    brandReference: ref(row.brand),
    storeReference: ref(row.store),
    operationReference: ref(row.operation),
    diningSessionReference: ref(row.session),
    orderReference: ref(row.order),
    orderVersion: version,
    orderCheckpoint: ref(row.checkpoint),
    reasonCode: "GUEST_LEFT_UNPAID" as const,
    pricedOrderTotalMinor: minor(row.priced, 1n),
    capturedOrderAllocationMinor: minor(row.captured),
    writtenOffMinor: minor(row.written_off, 1n),
    requestedByActorReference: ref(row.requested_by),
    approvedByActorReference: ref(row.approved_by),
    orderEvidenceDigest: String(row.order_evidence_digest),
    paymentEvidenceDigest: String(row.payment_evidence_digest),
    decidedAt: String(parsePaymentInstant(row.decided_at)),
    auditReference: ref(row.audit),
  });
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: Payment-owned table settlements (one payment split by round) and
 * unpaid-departure write-offs. The caller holds the transaction, authorizes the staff member (and,
 * for a write-off, the approving manager) and supplies server-resolved owner facts only: the rounds
 * the table owes and what each comes to.
 */
/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): staff merged a table into another; from now on the
 * merged table's Order is paid on the other table's bill (2000_130). Refused when either table has
 * any payment, split or write-off. The same operation again returns what it recorded. Caller
 * authorizes and owns the transaction (the dining and order merge commit with it).
 */
export async function recordDiningTableBillOrder(
  tx: AuditTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly operationReference: string;
    readonly billOrderReference: string;
    readonly memberOrderReference: string;
    readonly recordedAt: string;
  },
): Promise<{ readonly status: "Recorded" | "AlreadyRecorded" }> {
  const brand = ref(scope.brandReference),
    store = ref(scope.storeReference),
    operation = ref(input.operationReference),
    bill = ref(input.billOrderReference),
    member = ref(input.memberOrderReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT bill_order_id::text bill,member_order_id::text member FROM rms_payment.dining_table_bill_order WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.bill !== bill || prior.member !== member)
      return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ status: "AlreadyRecorded" as const });
  }
  try {
    await tx.query(
      "INSERT INTO rms_payment.dining_table_bill_order (brand_id,store_id,bill_order_id,member_order_id,operation_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [brand, store, bill, member, operation, parsePaymentInstant(input.recordedAt)],
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "23514")
      return fail("DINING_TABLE_SETTLEMENT_ALREADY_PAID");
    throw error;
  }
  return Object.freeze({ status: "Recorded" as const });
}

export function createPostgresDiningTableSettlementStore(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  authorize(transaction: AuditTransaction, input: { orderReference: string }): Promise<boolean>;
}) {
  const tenant = ref(options.scope.tenantReference),
    brand = ref(options.scope.brandReference),
    store = ref(options.scope.storeReference);
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const allowed = async (tx: AuditTransaction, orderReference: string) => {
    if ((await options.authorize(tx, { orderReference })) !== true)
      return fail("DINING_TABLE_SETTLEMENT_PERMISSION_DENIED");
  };
  const settlements = async (tx: AuditTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const found = rows(
      await tx.query(`${settlementSelect} AND ${where}`, [brand, store, ...values]),
    );
    if (found.length > 100000) return fail();
    return found.map((row) => {
      const record = settlementFrom(row);
      if (record.tenantReference !== tenant) return fail();
      return record;
    });
  };
  const writeOffs = async (tx: AuditTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const found = rows(await tx.query(`${writeOffSelect} AND ${where}`, [brand, store, ...values]));
    if (found.length > 500) return fail();
    return found.map((row) => {
      const record = writeOffFrom(row);
      if (record.tenantReference !== tenant) return fail();
      return record;
    });
  };
  const cashRefunds = async (tx: AuditTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const found = rows(
      await tx.query(
        `${cashRefundSelect} AND ${where} ORDER BY r.refunded_at,r.cash_refund_id LIMIT 10001`,
        [brand, store, ...values],
      ),
    );
    if (found.length > 10000) return fail();
    return found.map((row) => {
      if (ref(row.tenant) !== tenant) return fail();
      return cashRefundFrom(row);
    });
  };
  const onlineRefunds = async (tx: AuditTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const found = rows(
      await tx.query(
        `${onlineRefundSelect} AND ${where} ORDER BY r.requested_at,r.online_refund_id LIMIT 10001`,
        [brand, store, ...values],
      ),
    );
    if (found.length > 10000) return fail();
    return found.map((row) => {
      if (ref(row.tenant) !== tenant) return fail();
      return onlineRefundFrom(row);
    });
  };
  const cardRefunds = async (tx: AuditTransaction, where: string, values: readonly unknown[]) => {
    await context(tx);
    const found = rows(
      await tx.query(
        `${cardRefundSelect} AND ${where} ORDER BY r.refunded_at,r.card_refund_id LIMIT 10001`,
        [brand, store, ...values],
      ),
    );
    if (found.length > 10000) return fail();
    return found.map((row) => {
      if (ref(row.tenant) !== tenant) return fail();
      return cardRefundFrom(row);
    });
  };
  return Object.freeze({
    /** Refunds made on the card machine from these Orders' table payments, oldest first. */
    async listCardRefundsByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(await cardRefunds(tx, "r.order_id=ANY($3::uuid[])", [orders]));
    },

    /**
     * Records a refund the manager made on the card machine. A retry with the same operation and
     * intent returns the same record.
     */
    async recordCardRefund(
      tx: AuditTransaction,
      input: DiningTableCardRefundRecord & {
        readonly auditReference: string;
        readonly correlationReference: string;
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (
        !diningTableCashRefundReasons.includes(input.reasonCode) ||
        input.amountMinor <= 0n ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)
      )
        return fail();
      const prior = await cardRefunds(tx, "r.operation_id=$3", [ref(input.operationReference)]);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableCardRefundRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, refund: same });
      }
      const refundedAt = String(parsePaymentInstant(input.refundedAt)),
        recordedAt = String(parsePaymentInstant(input.recordedAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_card_refund (card_refund_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,settlement_id,order_id,amount_minor,currency_code,reason_code,slip_reference,approved_by_actor_id,refunded_at,recorded_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD',$10,$11,$12,$13,$14,$15)`,
        [
          ref(input.cardRefundReference),
          tenant,
          brand,
          store,
          ref(input.operationReference),
          input.intentDigest,
          ref(input.settlementReference),
          order,
          input.amountMinor.toString(),
          input.reasonCode,
          input.slipReference,
          ref(input.approvedByActorReference),
          refundedAt,
          recordedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: ref(input.approvedByActorReference) },
        actionCode: "PAYMENT_DINING_TABLE_CARD_REFUNDED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          amountMinor: input.amountMinor.toString(),
          settlement: ref(input.settlementReference),
        },
        reasonCode: input.reasonCode,
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await cardRefunds(tx, "r.card_refund_id=$3", [
        ref(input.cardRefundReference),
      ]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, refund: saved });
    },

    /** Refunds to the card from these Orders' phone payments, oldest first. */
    async listOnlineRefundsByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(await onlineRefunds(tx, "r.order_id=ANY($3::uuid[])", [orders]));
    },

    /**
     * Records the manager's approved refund before anything is sent; the fixed key means sending
     * again can never pay twice. A retry with the same operation and intent returns the same one.
     */
    async recordOnlineRefund(
      tx: AuditTransaction,
      input: Omit<DiningTableOnlineRefundRecord, "outcome" | "providerIdempotencyKey"> & {
        readonly auditReference: string;
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (
        !diningTableCashRefundReasons.includes(input.reasonCode) ||
        input.amountMinor <= 0n ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)
      )
        return fail();
      const operation = ref(input.operationReference);
      const prior = await onlineRefunds(tx, "r.operation_id=$3", [operation]);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableOnlineRefundRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, refund: same });
      }
      const requestedAt = String(parsePaymentInstant(input.requestedAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_online_refund (online_refund_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,settlement_id,online_payment_id,order_id,amount_minor,currency_code,reason_code,approved_by_actor_id,
 provider_idempotency_key,requested_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD',$11,$12,$13,$14,$15)`,
        [
          ref(input.onlineRefundReference),
          tenant,
          brand,
          store,
          operation,
          input.intentDigest,
          ref(input.settlementReference),
          ref(input.onlinePaymentReference),
          order,
          input.amountMinor.toString(),
          input.reasonCode,
          ref(input.approvedByActorReference),
          "table-online-refund:" + operation,
          requestedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: ref(input.approvedByActorReference) },
        actionCode: "PAYMENT_DINING_TABLE_ONLINE_REFUND_APPROVED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          amountMinor: input.amountMinor.toString(),
          settlement: ref(input.settlementReference),
        },
        reasonCode: input.reasonCode,
        correlationId: operation,
        occurredAt: requestedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await onlineRefunds(tx, "r.online_refund_id=$3", [
        ref(input.onlineRefundReference),
      ]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, refund: saved });
    },

    /** The Provider's final answer for a refund; only the first is recorded. */
    async recordOnlineRefundOutcome(
      tx: AuditTransaction,
      input: {
        readonly onlineRefundReference: string;
        readonly status: "Succeeded" | "Failed";
        readonly providerRefundReference: string | null;
        readonly providerCreatedAt: string | null;
        readonly providerObservedAt: string;
        readonly evidenceDigest: string | null;
        readonly recordedAt: string;
        readonly auditReference: string;
      },
    ) {
      const reference = ref(input.onlineRefundReference);
      const [refund] = await onlineRefunds(tx, "r.online_refund_id=$3", [reference]);
      if (refund === undefined) return fail();
      await allowed(tx, refund.orderReference);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTableOnlineRefundOutcome:" + brand + ":" + store + ":" + reference,
      ]);
      const [current] = await onlineRefunds(tx, "r.online_refund_id=$3", [reference]);
      if (current === undefined) return fail();
      if (current.outcome !== null) return current;
      const recordedAt = String(parsePaymentInstant(input.recordedAt)),
        observedAt = String(parsePaymentInstant(input.providerObservedAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_online_refund_outcome (online_refund_id,brand_id,store_id,status,amount_minor,
 provider_refund_reference,provider_created_at,provider_observed_at,evidence_digest,recorded_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          reference,
          brand,
          store,
          input.status,
          current.amountMinor.toString(),
          input.providerRefundReference,
          input.providerCreatedAt === null
            ? null
            : String(parsePaymentInstant(input.providerCreatedAt)),
          observedAt > recordedAt ? recordedAt : observedAt,
          input.evidenceDigest,
          recordedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "System" },
        actionCode:
          input.status === "Succeeded"
            ? "PAYMENT_DINING_TABLE_ONLINE_REFUND_CONFIRMED"
            : "PAYMENT_DINING_TABLE_ONLINE_REFUND_REFUSED",
        targetType: "Order",
        targetId: current.orderReference,
        afterSummary: { amountMinor: current.amountMinor.toString() },
        reasonCode: "PROVIDER_REPORTED",
        correlationId: current.operationReference,
        occurredAt: recordedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await onlineRefunds(tx, "r.online_refund_id=$3", [reference]);
      return saved ?? fail();
    },

    /** Refunds the Provider has not answered yet, oldest first: Store-level, for resending. */
    async listOpenOnlineRefunds(tx: AuditTransaction, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail();
      if ((await options.authorize(tx, { orderReference: "" })) !== true)
        return fail("DINING_TABLE_SETTLEMENT_PERMISSION_DENIED");
      const open = await onlineRefunds(tx, "o.online_refund_id IS NULL", []);
      return Object.freeze(open.slice(0, limit));
    },

    /**
     * WP-2423 DEC-TABLE-ONLINE-REFUND: the day's money back to phones, by the Provider's creation
     * time (the rule the day-end settlement and the Provider statement share), and how many are
     * still waiting for an answer. Reads only the refund tables, for every settlement source.
     */
    async onlineRefundWindow(tx: AuditTransaction, window: { from: string; to: string }) {
      const from = String(parsePaymentInstant(window.from)),
        to = String(parsePaymentInstant(window.to));
      if (from >= to) return fail();
      if ((await options.authorize(tx, { orderReference: "" })) !== true)
        return fail("DINING_TABLE_SETTLEMENT_PERMISSION_DENIED");
      const confirmed = await onlineRefunds(
        tx,
        "o.status='Succeeded' AND o.provider_created_at>=$3 AND o.provider_created_at<$4",
        [from, to],
      );
      const open = await onlineRefunds(tx, "o.online_refund_id IS NULL", []);
      return Object.freeze({
        refunds: Object.freeze(confirmed),
        count: confirmed.length,
        amountMinor: confirmed.reduce((sum, refund) => sum + refund.amountMinor, 0n),
        unresolvedCount: open.length,
      });
    },

    /** Cash given back from these Orders' table payments, oldest first. */
    async listCashRefundsByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(await cashRefunds(tx, "r.order_id=ANY($3::uuid[])", [orders]));
    },

    /**
     * Records cash given back from a table's cash payment (the caller has the manager's approval).
     * A retry with the same operation and intent returns the same record.
     */
    async recordCashRefund(
      tx: AuditTransaction,
      input: Omit<DiningTableCashRefundRecord, never> & { readonly correlationReference: string },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (
        !diningTableCashRefundReasons.includes(input.reasonCode) ||
        input.amountMinor <= 0n ||
        !/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)
      )
        return fail();
      await context(tx);
      const prior = await cashRefunds(tx, "r.operation_id=$3", [ref(input.operationReference)]);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableCashRefundRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, refund: same });
      }
      const refundedAt = String(parsePaymentInstant(input.refundedAt)),
        recordedAt = String(parsePaymentInstant(input.recordedAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_cash_refund (cash_refund_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,settlement_id,order_id,amount_minor,currency_code,reason_code,approved_by_actor_id,refunded_at,recorded_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD',$10,$11,$12,$13,$14)`,
        [
          ref(input.cashRefundReference),
          tenant,
          brand,
          store,
          ref(input.operationReference),
          input.intentDigest,
          ref(input.settlementReference),
          order,
          input.amountMinor.toString(),
          input.reasonCode,
          ref(input.approvedByActorReference),
          refundedAt,
          recordedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: ref(input.approvedByActorReference) },
        actionCode: "PAYMENT_DINING_TABLE_CASH_REFUNDED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          amountMinor: input.amountMinor.toString(),
          settlement: ref(input.settlementReference),
        },
        reasonCode: input.reasonCode,
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await cashRefunds(tx, "r.cash_refund_id=$3", [
        ref(input.cashRefundReference),
      ]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, refund: saved });
    },

    /**
     * The Store's table payments taken and cash given back in a window, by when the money moved
     * (the day-end settlement's rule): every table settlement taken in the window, every cash
     * refund made in it, and the settlements those refunds belong to. Store-level read: the
     * caller's Store authority applies (no per-Order check).
     */
    async listWindow(tx: AuditTransaction, window: { from: string; to: string }) {
      const from = String(parsePaymentInstant(window.from)),
        to = String(parsePaymentInstant(window.to));
      if (from >= to) return fail();
      if ((await options.authorize(tx, { orderReference: "" })) !== true)
        return fail("DINING_TABLE_SETTLEMENT_PERMISSION_DENIED");
      const refunds = await cashRefunds(tx, "r.refunded_at>=$3 AND r.refunded_at<$4", [from, to]);
      const cardInWindow = await cardRefunds(tx, "r.refunded_at>=$3 AND r.refunded_at<$4", [
        from,
        to,
      ]);
      const onlineInWindow = await onlineRefunds(
        tx,
        "o.status='Succeeded' AND o.provider_created_at>=$3 AND o.provider_created_at<$4",
        [from, to],
      );
      const taken = await settlements(
        tx,
        // WP-2423: and the other parts of a split bill one of them paid in the window (a round
        // sold in parts adds up only with all of them).
        "((s.taken_at>=$3 AND s.taken_at<$4) OR s.settlement_id=ANY($5::uuid[]) OR s.split_plan_id IN (SELECT w.split_plan_id FROM rms_payment.dining_table_settlement w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.taken_at>=$3 AND w.taken_at<$4 AND w.split_plan_id IS NOT NULL)) ORDER BY s.taken_at,s.settlement_id LIMIT 100001",
        [
          from,
          to,
          [
            ...new Set(
              [...refunds, ...cardInWindow, ...onlineInWindow].map(
                (refund) => refund.settlementReference,
              ),
            ),
          ],
        ],
      );
      // DEC-DINE-IN-PAY-LATER (decision 4): bills written off when the guests left, by when the
      // manager decided — never paid, but kept in the day's summary and reconciliation.
      const writtenOff = await writeOffs(tx, "w.decided_at>=$3 AND w.decided_at<$4", [from, to]);
      return Object.freeze({
        settlements: Object.freeze(taken),
        cashRefunds: Object.freeze(refunds),
        cardRefunds: Object.freeze(cardInWindow),
        onlineRefunds: Object.freeze(onlineInWindow),
        writeOffs: Object.freeze(writtenOff),
      });
    },

    /** The settlements of these Orders (a table Order has at most one). */
    /**
     * WP-2423 item 8 ⑨: the bill an Order is paid on — itself, or the bill of the table it was
     * merged into (2000_130), followed to the end.
     */
    async billOrderOf(tx: AuditTransaction, orderReference: string): Promise<string> {
      const order = ref(orderReference);
      await context(tx);
      const [found] = rows(
        await tx.query(
          "WITH RECURSIVE up(order_id,depth) AS (SELECT $3::uuid,0 UNION ALL SELECT b.bill_order_id,up.depth+1 FROM rms_payment.dining_table_bill_order b JOIN up ON b.brand_id=$1 AND b.store_id=$2 AND b.member_order_id=up.order_id WHERE up.depth<50) SELECT order_id::text order_id FROM up ORDER BY depth DESC LIMIT 1",
          [brand, store, order],
        ),
      );
      return found === undefined ? order : ref(found.order_id);
    },
    async listByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(await settlements(tx, "s.order_id=ANY($3::uuid[])", [orders]));
    },

    async loadByOperation(tx: AuditTransaction, operationReference: string) {
      const found = await settlements(tx, "s.operation_id=$3", [ref(operationReference)]);
      if (found.length > 1) return fail();
      const record = found[0] ?? null;
      if (record !== null) await allowed(tx, record.orderReference);
      return record;
    },

    /**
     * WP-2423 item 8 ④: the current split plan of each of these Orders (the latest version), or
     * none for an Order that was never split.
     */
    async listSplitPlans(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      await context(tx);
      const found = rows(
        await tx.query(
          `${splitPlanSelect} AND p.order_id=ANY($3::uuid[]) AND p.plan_version=(SELECT max(q.plan_version)
 FROM rms_payment.dining_table_split_plan q WHERE q.brand_id=p.brand_id AND q.store_id=p.store_id AND q.order_id=p.order_id)`,
          [brand, store, orders],
        ),
      );
      return Object.freeze(
        found.map((row) => {
          if (ref(row.tenant) !== tenant) return fail();
          return splitPlanFrom(row);
        }),
      );
    },

    /**
     * WP-2423 item 8 ④: records how the table's bill is split (or that it is paid whole again), as
     * the Order's next plan version. The parts come from splitDiningTableBill over the Order's own
     * rounds. Refused (by the database too) once anything was paid, written off or started on a
     * guest's phone. A retry with the same operation and intent returns the same plan.
     */
    async recordSplitPlan(
      tx: AuditTransaction,
      input: {
        readonly splitPlanReference: string;
        readonly operationReference: string;
        readonly intentDigest: string;
        readonly diningSessionReference: string;
        readonly orderReference: string;
        readonly split: DiningTableSplit | { readonly mode: "Whole"; readonly billMinor: bigint };
        /**
         * WP-2423 item 8 ⑨: the Order each round belongs to, when the bill includes a merged table's
         * Order (2000_130); a round not named is of `orderReference`.
         */
        readonly roundOrders?: ReadonlyMap<string, string>;
        readonly recordedAt: string;
        readonly actorReference: string;
        readonly auditReference: string;
        readonly correlationReference: string;
        /**
         * v15 batch 9: why the table is paid whole again, on the audit (absent: staff chose
         * "All together"). CHECKOUT_CANCELLED: checkout was cancelled, so the split ended with it.
         */
        readonly reasonCode?: "CHECKOUT_CANCELLED";
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)) return fail();
      if (input.reasonCode !== undefined && input.split.mode !== "Whole") return fail();
      const bill = minor(String(input.split.billMinor), 1n);
      const parts = input.split.mode === "Whole" ? [] : input.split.parts;
      if (input.split.mode !== "Whole" && (parts.length < 2 || parts.length > 20)) return fail();
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTablePaidOrWrittenOff:" + brand + ":" + store + ":" + order,
      ]);
      const prior = rows(
        await tx.query(`${splitPlanSelect} AND p.operation_id=$3`, [
          brand,
          store,
          ref(input.operationReference),
        ]),
      ).map(splitPlanFrom);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableSplitPlanRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, plan: same });
      }
      if (
        (await settlements(tx, "s.order_id=$3", [order])).length > 0 ||
        (await writeOffs(tx, "w.order_id=$3", [order])).length > 0
      )
        return fail("DINING_TABLE_SETTLEMENT_ALREADY_PAID");
      const versions = rows(
        await tx.query(
          "SELECT coalesce(max(plan_version),0) AS version FROM rms_payment.dining_table_split_plan WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
          [brand, store, order],
        ),
      );
      const version = Number(versions[0]?.version ?? 0) + 1;
      const recordedAt = String(parsePaymentInstant(input.recordedAt));
      const plan = ref(input.splitPlanReference);
      await tx.query(
        `INSERT INTO rms_payment.dining_table_split_plan (split_plan_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,dining_session_id,order_id,plan_version,mode,part_count,bill_minor,currency_code,recorded_at,actor_id,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CAD',$13,$14,$15)`,
        [
          plan,
          tenant,
          brand,
          store,
          ref(input.operationReference),
          input.intentDigest,
          ref(input.diningSessionReference),
          order,
          version,
          input.split.mode,
          parts.length,
          bill.toString(),
          recordedAt,
          ref(input.actorReference),
          ref(input.auditReference),
        ],
      );
      for (const part of parts) {
        await tx.query(
          `INSERT INTO rms_payment.dining_table_split_part (split_plan_id,brand_id,store_id,order_id,part_number,
 amount_minor,subtotal_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            plan,
            brand,
            store,
            order,
            part.partNumber,
            part.amountMinor.toString(),
            part.subtotalMinor.toString(),
            part.taxMinor.toString(),
          ],
        );
        for (const slice of part.slices)
          await tx.query(
            `INSERT INTO rms_payment.dining_table_split_part_round (split_plan_id,part_number,brand_id,store_id,
 order_id,order_batch_id,round_minor,subtotal_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              plan,
              part.partNumber,
              brand,
              store,
              ref(input.roundOrders?.get(slice.orderBatchReference) ?? order),
              ref(slice.orderBatchReference),
              slice.roundMinor.toString(),
              slice.subtotalMinor.toString(),
              slice.taxMinor.toString(),
            ],
          );
      }
      if (input.split.mode !== "Whole")
        for (const choice of input.split.dishChoices ?? [])
          await tx.query(
            `INSERT INTO rms_payment.dining_table_split_part_item (split_plan_id,brand_id,store_id,order_item_id,
 unit_number,part_number) VALUES ($1,$2,$3,$4,$5,$6)`,
            [plan, brand, store, ref(choice.orderItemReference), choice.unit, choice.partNumber],
          );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: ref(input.actorReference) },
        actionCode: "PAYMENT_DINING_TABLE_SPLIT_PLANNED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          mode: input.split.mode,
          parts: parts.length,
          billMinor: bill.toString(),
          planVersion: version,
        },
        reasonCode:
          input.reasonCode ?? (input.split.mode === "Whole" ? "PAY_WHOLE_TABLE" : "SPLIT_BILL"),
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const saved = rows(
        await tx.query(`${splitPlanSelect} AND p.split_plan_id=$3`, [brand, store, plan]),
      ).map(splitPlanFrom);
      if (saved[0] === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, plan: saved[0] });
    },

    /**
     * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): appends one part to the table's "ByGuests"
     * plan — the dishes a guest pays on their phone ("only what I added", "choose dishes", "the
     * rest") or staff take at the counter — with its units, slices and who chose it. The plan is
     * created first when the table has none (refused by the database once anything was paid
     * another way). The part's amounts come from chooseDiningTableGuestPart over the bill as it
     * stands, read under the Order's lock taken here. A retry of the same operation and intent
     * returns the same part.
     */
    async appendGuestSplitPart(
      tx: AuditTransaction,
      input: {
        /** Null: the current plan is already this table's ByGuests plan. */
        readonly createPlan: null | { readonly billMinor: bigint };
        readonly splitPlanReference: string;
        readonly operationReference: string;
        readonly intentDigest: string;
        readonly diningSessionReference: string;
        readonly orderReference: string;
        readonly part: DiningTableSplitPart;
        readonly units: readonly DiningTableSplitUnit[];
        readonly completesBill: boolean;
        readonly choice: "Mine" | "Chosen" | "Rest";
        readonly actor:
          | { readonly type: "Guest"; readonly guestSessionReference: string }
          | { readonly type: "Staff"; readonly reference: string };
        readonly roundOrders?: ReadonlyMap<string, string>;
        readonly recordedAt: string;
        readonly auditReference: string;
        readonly correlationReference: string;
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)) return fail();
      const part = input.part;
      if (
        !Number.isSafeInteger(part.partNumber) ||
        part.partNumber < 1 ||
        part.partNumber > 100 ||
        part.slices.length < 1 ||
        input.units.length < 1 ||
        input.units.length > 1000
      )
        return fail();
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTablePaidOrWrittenOff:" + brand + ":" + store + ":" + order,
      ]);
      const [prior] = rows(
        await tx.query(
          'SELECT split_plan_id::text AS plan,part_number,intent_digest,order_id::text AS "order" FROM rms_payment.dining_table_split_part_append WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3',
          [brand, store, ref(input.operationReference)],
        ),
      );
      if (prior !== undefined) {
        if (prior.intent_digest !== input.intentDigest || ref(prior.order) !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyRecorded" as const,
          part: Object.freeze({
            splitPlanReference: ref(prior.plan),
            partNumber: Number(prior.part_number),
          }),
        });
      }
      const plan = ref(input.splitPlanReference);
      const recordedAt = String(parsePaymentInstant(input.recordedAt));
      const actorReference =
        input.actor.type === "Guest"
          ? ref(input.actor.guestSessionReference)
          : ref(input.actor.reference);
      if (input.createPlan !== null) {
        if ((await settlements(tx, "s.order_id=$3", [order])).length > 0)
          return fail("DINING_TABLE_SETTLEMENT_ALREADY_PAID");
        const versions = rows(
          await tx.query(
            "SELECT coalesce(max(plan_version),0) AS version FROM rms_payment.dining_table_split_plan WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
            [brand, store, order],
          ),
        );
        await tx.query(
          `INSERT INTO rms_payment.dining_table_split_plan (split_plan_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,dining_session_id,order_id,plan_version,mode,part_count,bill_minor,currency_code,recorded_at,actor_id,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ByGuests',0,$10,'CAD',$11,$12,$13)`,
          [
            plan,
            tenant,
            brand,
            store,
            ref(input.operationReference),
            input.intentDigest,
            ref(input.diningSessionReference),
            order,
            Number(versions[0]?.version ?? 0) + 1,
            minor(String(input.createPlan.billMinor), 1n).toString(),
            recordedAt,
            actorReference,
            ref(input.auditReference),
          ],
        );
      }
      await tx.query(
        `INSERT INTO rms_payment.dining_table_split_part (split_plan_id,brand_id,store_id,order_id,part_number,
 amount_minor,subtotal_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          plan,
          brand,
          store,
          order,
          part.partNumber,
          minor(String(part.amountMinor), 1n).toString(),
          minor(String(part.subtotalMinor)).toString(),
          minor(String(part.taxMinor)).toString(),
        ],
      );
      for (const slice of part.slices)
        await tx.query(
          `INSERT INTO rms_payment.dining_table_split_part_round (split_plan_id,part_number,brand_id,store_id,
 order_id,order_batch_id,round_minor,subtotal_minor,tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            plan,
            part.partNumber,
            brand,
            store,
            ref(input.roundOrders?.get(slice.orderBatchReference) ?? order),
            ref(slice.orderBatchReference),
            slice.roundMinor.toString(),
            slice.subtotalMinor.toString(),
            slice.taxMinor.toString(),
          ],
        );
      for (const unit of input.units)
        await tx.query(
          `INSERT INTO rms_payment.dining_table_split_part_unit (split_plan_id,part_number,brand_id,store_id,
 order_item_id,unit_number) VALUES ($1,$2,$3,$4,$5,$6)`,
          [plan, part.partNumber, brand, store, ref(unit.orderItemReference), unit.unit],
        );
      await tx.query(
        `INSERT INTO rms_payment.dining_table_split_part_append (split_plan_id,part_number,tenant_id,brand_id,store_id,
 order_id,operation_id,intent_digest,choice,actor_type,actor_id,guest_session_id,completes_bill,recorded_at,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          plan,
          part.partNumber,
          tenant,
          brand,
          store,
          order,
          ref(input.operationReference),
          input.intentDigest,
          input.choice,
          input.actor.type,
          input.actor.type === "Staff" ? actorReference : null,
          input.actor.type === "Guest" ? actorReference : null,
          input.completesBill,
          recordedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor:
          input.actor.type === "Staff"
            ? { type: "User", reference: actorReference }
            : { type: "System" },
        actionCode: "PAYMENT_DINING_TABLE_SPLIT_PART_CHOSEN",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          mode: "ByGuests",
          partNumber: part.partNumber,
          choice: input.choice,
          amountMinor: part.amountMinor.toString(),
          units: input.units.length,
          completesBill: input.completesBill,
          planCreated: input.createPlan !== null,
        },
        reasonCode: input.actor.type === "Staff" ? "STAFF_TAKES_REST" : "GUEST_PAYS_BY_DISH",
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: input.actor.type === "Staff" ? "MERCHANT_WEB" : "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      return Object.freeze({
        status: "Recorded" as const,
        part: Object.freeze({ splitPlanReference: plan, partNumber: part.partNumber }),
      });
    },

    /**
     * Records one table payment, split by round. A retry with the same operation and intent returns
     * the same settlement; a second payment for the Order is refused.
     */
    async record(
      tx: AuditTransaction,
      input: {
        readonly settlementReference: string;
        readonly operationReference: string;
        readonly intentDigest: string;
        readonly diningSessionReference: string;
        readonly orderReference: string;
        readonly method: DiningTableSettlementMethod;
        readonly rounds: readonly DiningTableSettlementRound[];
        readonly tipMinor: bigint;
        readonly tenderedMinor: bigint | null;
        readonly environment: "Test" | "Live";
        readonly slipReference: string | null;
        readonly recordingReason: "AtTable" | "RecordedAfterOutage";
        readonly takenAt: string;
        readonly recordedAt: string;
        readonly actorReference: string;
        readonly auditReference: string;
        readonly correlationReference: string;
        /** S4: method Online only — the captured guest payment this settlement records. */
        readonly onlinePaymentReference?: string;
        /** WP-2423 item 8 ④: this payment is one part of the current split plan (`rounds` its slices). */
        readonly part?: DiningTableSplitPartReference;
        /** WP-2423 item 8 ⑨: the Order each round belongs to (a merged table's); default `orderReference`. */
        readonly roundOrders?: ReadonlyMap<string, string>;
      },
    ) {
      const order = ref(input.orderReference);
      if ((input.method === "Online") !== (input.onlinePaymentReference !== undefined))
        return fail();
      await allowed(tx, order);
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)) return fail();
      if (input.method === "Cash" && input.slipReference !== null) return fail();
      const plan = planDiningTableSettlement({
        method: input.method,
        rounds: input.rounds,
        tipMinor: input.tipMinor,
        tenderedMinor: input.tenderedMinor,
      });
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTableSettlement:" + brand + ":" + store + ":" + order,
      ]);
      const prior = await settlements(tx, "s.operation_id=$3", [ref(input.operationReference)]);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableSettlementRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, settlement: same });
      }
      // The whole table is paid once; a part once (the database checks both, and the plan).
      const paid = await settlements(tx, "s.order_id=$3", [order]);
      if (
        input.part === undefined
          ? paid.length > 0
          : paid.some(
              (entry) =>
                entry.part === null ||
                (entry.part.splitPlanReference === ref(input.part?.splitPlanReference) &&
                  entry.part.partNumber === input.part?.partNumber),
            )
      )
        return fail("DINING_TABLE_SETTLEMENT_ALREADY_PAID");
      const recordedAt = String(parsePaymentInstant(input.recordedAt)),
        takenAt = String(parsePaymentInstant(input.takenAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_settlement (settlement_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,dining_session_id,order_id,method,rounds_minor,tip_minor,rounding_minor,total_minor,tendered_minor,
 change_minor,currency_code,payment_environment,slip_reference,recording_reason,taken_at,recorded_at,actor_id,audit_id,
 online_payment_id,split_plan_id,part_number)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CAD',$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          ref(input.settlementReference),
          tenant,
          brand,
          store,
          ref(input.operationReference),
          input.intentDigest,
          ref(input.diningSessionReference),
          order,
          plan.method,
          plan.roundsMinor.toString(),
          plan.tipMinor.toString(),
          plan.roundingMinor.toString(),
          plan.totalMinor.toString(),
          plan.tenderedMinor === null ? null : plan.tenderedMinor.toString(),
          plan.changeMinor === null ? null : plan.changeMinor.toString(),
          input.environment,
          input.slipReference,
          input.recordingReason,
          takenAt,
          recordedAt,
          ref(input.actorReference),
          ref(input.auditReference),
          input.onlinePaymentReference === undefined ? null : ref(input.onlinePaymentReference),
          input.part === undefined ? null : ref(input.part.splitPlanReference),
          input.part === undefined ? null : input.part.partNumber,
        ],
      );
      for (const [index, line] of plan.lines.entries())
        await tx.query(
          `INSERT INTO rms_payment.dining_table_settlement_round (settlement_id,brand_id,store_id,order_id,order_batch_id,
 submission_id,line_number,round_minor,tip_minor,rounding_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ref(input.settlementReference),
            brand,
            store,
            ref(input.roundOrders?.get(line.orderBatchReference) ?? order),
            ref(line.orderBatchReference),
            ref(line.submissionReference),
            index + 1,
            line.roundMinor.toString(),
            line.tipMinor.toString(),
            line.roundingMinor.toString(),
          ],
        );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        // S4: a guest's online payment is recorded by the System from the Provider's capture.
        actor:
          plan.method === "Online"
            ? { type: "System" }
            : { type: "User", reference: ref(input.actorReference) },
        actionCode: "PAYMENT_DINING_TABLE_SETTLED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          method: plan.method,
          totalMinor: plan.totalMinor.toString(),
          tipMinor: plan.tipMinor.toString(),
          roundingMinor: plan.roundingMinor.toString(),
          rounds: plan.lines.length,
          ...(input.part === undefined ? {} : { partNumber: input.part.partNumber }),
        },
        reasonCode:
          input.recordingReason === "AtTable"
            ? plan.method === "Cash"
              ? "CASH_RECEIVED"
              : plan.method === "Online"
                ? "ONLINE_PAYMENT_CAPTURED"
                : "CARD_MACHINE_APPROVED"
            : "RECORDED_AFTER_OUTAGE",
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: plan.method === "Online" ? "CUSTOMER_PWA" : "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await settlements(tx, "s.settlement_id=$3", [ref(input.settlementReference)]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, settlement: saved });
    },

    /** S4: the guests' online payments of these Orders, oldest first, with their outcomes. */
    async listOnlinePaymentsByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      await context(tx);
      const found = rows(
        await tx.query(
          `${onlinePaymentSelect} AND p.order_id=ANY($3::uuid[]) ORDER BY p.created_at,p.online_payment_id LIMIT 1001`,
          [brand, store, orders],
        ),
      );
      if (found.length > 1000) return fail();
      return Object.freeze(
        found.map((row) => (ref(row.tenant) === tenant ? onlinePaymentFrom(row) : fail())),
      );
    },

    /**
     * S4: records a guest's attempt to pay the whole table on their phone, after its Provider
     * transaction was created (with the attempt's own idempotency key). A retry with the same
     * operation returns it; while another attempt is open, or once the table paid or was written
     * off, the database refuses it.
     */
    async recordOnlinePayment(
      tx: AuditTransaction,
      input: {
        readonly onlinePaymentReference: string;
        readonly operationReference: string;
        readonly intentDigest: string;
        readonly diningSessionReference: string;
        readonly orderReference: string;
        readonly guestSessionReference: string;
        readonly roundsMinor: bigint;
        readonly tipMinor: bigint;
        readonly providerAccountReference: string;
        readonly environment: "Test" | "Live";
        readonly providerIntentReference: string;
        readonly createdAt: string;
        readonly auditReference: string;
        /** WP-2423 item 8 ④: the part of the current split plan this payment is for. */
        readonly part?: DiningTableSplitPartReference;
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest)) return fail();
      const rounds = minor(String(input.roundsMinor), 1n),
        tip = minor(String(input.tipMinor));
      await context(tx);
      const prior = rows(
        await tx.query(`${onlinePaymentSelect} AND p.operation_id=$3`, [
          brand,
          store,
          ref(input.operationReference),
        ]),
      ).map(onlinePaymentFrom);
      if (prior.length > 0) {
        const same = prior[0] as DiningTableOnlinePaymentRecord;
        if (same.intentDigest !== input.intentDigest || same.orderReference !== order)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, payment: same });
      }
      const createdAt = String(parsePaymentInstant(input.createdAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_online_payment (online_payment_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,dining_session_id,order_id,guest_session_id,rounds_minor,tip_minor,total_minor,currency_code,
 provider_account_id,payment_environment,provider_intent_reference,created_at,audit_id,split_plan_id,part_number)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CAD',$13,$14,$15,$16,$17,$18,$19)`,
        [
          ref(input.onlinePaymentReference),
          tenant,
          brand,
          store,
          ref(input.operationReference),
          input.intentDigest,
          ref(input.diningSessionReference),
          order,
          ref(input.guestSessionReference),
          rounds.toString(),
          tip.toString(),
          (rounds + tip).toString(),
          ref(input.providerAccountReference),
          input.environment,
          input.providerIntentReference,
          createdAt,
          ref(input.auditReference),
          input.part === undefined ? null : ref(input.part.splitPlanReference),
          input.part === undefined ? null : input.part.partNumber,
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "System" },
        actionCode: "PAYMENT_DINING_TABLE_ONLINE_STARTED",
        targetType: "Order",
        targetId: order,
        afterSummary: { totalMinor: (rounds + tip).toString(), tipMinor: tip.toString() },
        reasonCode: "GUEST_PAYS_TABLE",
        correlationId: ref(input.operationReference),
        occurredAt: createdAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const saved = rows(
        await tx.query(`${onlinePaymentSelect} AND p.online_payment_id=$3`, [
          brand,
          store,
          ref(input.onlinePaymentReference),
        ]),
      ).map(onlinePaymentFrom)[0];
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, payment: saved });
    },

    /**
     * S4: what the Provider reported for a guest's online payment (captured, failed, cancelled),
     * once. Recording it again returns the outcome already recorded.
     */
    async recordOnlinePaymentOutcome(
      tx: AuditTransaction,
      input: {
        readonly onlinePaymentReference: string;
        readonly orderReference: string;
        readonly status: "Captured" | "Failed" | "Cancelled";
        readonly capturedMinor: bigint | null;
        readonly providerTransactionReference: string | null;
        readonly occurredAt: string;
        readonly recordedAt: string;
        readonly auditReference: string;
        readonly correlationReference: string;
        readonly actor:
          { readonly type: "System" } | { readonly type: "User"; readonly reference: string };
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTableOnlinePayment:" + brand + ":" + store + ":" + ref(input.onlinePaymentReference),
      ]);
      const [current] = rows(
        await tx.query(`${onlinePaymentSelect} AND p.online_payment_id=$3`, [
          brand,
          store,
          ref(input.onlinePaymentReference),
        ]),
      ).map(onlinePaymentFrom);
      if (current === undefined || current.orderReference !== order) return fail();
      if (current.outcome !== null)
        return Object.freeze({ status: "AlreadyRecorded" as const, payment: current });
      const occurredAt = String(parsePaymentInstant(input.occurredAt)),
        recordedAt = String(parsePaymentInstant(input.recordedAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_online_payment_outcome (online_payment_id,brand_id,store_id,order_id,status,
 captured_minor,provider_transaction_reference,occurred_at,recorded_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ref(input.onlinePaymentReference),
          brand,
          store,
          order,
          input.status,
          input.capturedMinor === null ? null : input.capturedMinor.toString(),
          input.providerTransactionReference,
          occurredAt,
          recordedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor:
          input.actor.type === "System"
            ? { type: "System" }
            : { type: "User", reference: ref(input.actor.reference) },
        actionCode: "PAYMENT_DINING_TABLE_ONLINE_" + input.status.toUpperCase(),
        targetType: "Order",
        targetId: order,
        afterSummary: {
          status: input.status,
          capturedMinor: input.capturedMinor === null ? null : input.capturedMinor.toString(),
        },
        reasonCode: "PROVIDER_REPORTED",
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: input.actor.type === "System" ? "CUSTOMER_PWA" : "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      // WP-2423 同桌结账: a part guests chose by dish whose payment failed or was cancelled is
      // withdrawn in the same transaction, so its dishes are unpaid again (never deleted).
      if (input.status !== "Captured" && current.part !== null) {
        const [planRow] = rows(
          await tx.query(
            "SELECT mode,(SELECT max(x.part_number) FROM rms_payment.dining_table_split_part x WHERE x.split_plan_id=p.split_plan_id) AS last FROM rms_payment.dining_table_split_plan p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.split_plan_id=$3",
            [brand, store, ref(current.part.splitPlanReference)],
          ),
        );
        if (planRow?.mode === "ByGuests")
          await tx.query(
            `INSERT INTO rms_payment.dining_table_split_part_withdrawal (split_plan_id,part_number,brand_id,store_id,
 order_id,reason,online_payment_id,last_part_number,recorded_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              ref(current.part.splitPlanReference),
              current.part.partNumber,
              brand,
              store,
              order,
              input.status === "Failed" ? "PaymentFailed" : "PaymentCancelled",
              ref(input.onlinePaymentReference),
              Number(planRow.last),
              recordedAt,
              ref(input.auditReference),
            ],
          );
      }
      const [saved] = rows(
        await tx.query(`${onlinePaymentSelect} AND p.online_payment_id=$3`, [
          brand,
          store,
          ref(input.onlinePaymentReference),
        ]),
      ).map(onlinePaymentFrom);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, payment: saved });
    },

    /** The write-offs of these Orders (at most one each). */
    async listWriteOffsByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      if (orderReferences.length === 0) return Object.freeze([]);
      if (orderReferences.length > 200) return fail();
      const orders = orderReferences.map(ref);
      for (const order of orders) await allowed(tx, order);
      return Object.freeze(await writeOffs(tx, "w.order_id=ANY($3::uuid[])", [orders]));
    },

    async loadWriteOff(tx: AuditTransaction, writeOffReference: string) {
      const found = await writeOffs(tx, "w.write_off_id=$3", [ref(writeOffReference)]);
      if (found.length > 1) return fail();
      const record = found[0] ?? null;
      if (record !== null) await allowed(tx, record.orderReference);
      return record;
    },

    /**
     * A manager's recorded decision that the table left without paying what its Order still owes.
     * The amount is the Order's priced total less what was paid, as the caller resolved it from the
     * owners in this transaction. A retry with the same operation returns the same record.
     */
    async recordWriteOff(
      tx: AuditTransaction,
      input: Omit<
        OrderUnpaidWriteOffRecord,
        "tenantReference" | "brandReference" | "storeReference"
      > & {
        readonly correlationReference: string;
      },
    ) {
      const order = ref(input.orderReference);
      await allowed(tx, order);
      if (
        input.reasonCode !== "GUEST_LEFT_UNPAID" ||
        input.writtenOffMinor !==
          input.pricedOrderTotalMinor - input.capturedOrderAllocationMinor ||
        input.writtenOffMinor <= 0n ||
        ![input.orderEvidenceDigest, input.paymentEvidenceDigest].every((digest) =>
          /^sha256:[0-9a-f]{64}$/u.test(digest),
        )
      )
        return fail();
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "DiningTableSettlement:" + brand + ":" + store + ":" + order,
      ]);
      const prior = await writeOffs(tx, "w.operation_id=$3", [ref(input.operationReference)]);
      if (prior.length > 0) {
        const same = prior[0] as OrderUnpaidWriteOffRecord;
        if (same.orderReference !== order || same.writtenOffMinor !== input.writtenOffMinor)
          return fail("DINING_TABLE_SETTLEMENT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, writeOff: same });
      }
      if ((await writeOffs(tx, "w.order_id=$3", [order])).length > 0)
        return fail("DINING_TABLE_WRITE_OFF_ALREADY_RECORDED");
      const decidedAt = String(parsePaymentInstant(input.decidedAt));
      await tx.query(
        `INSERT INTO rms_payment.order_unpaid_write_off (write_off_id,tenant_id,brand_id,store_id,operation_id,
 dining_session_id,order_id,order_version,order_checkpoint,reason_code,currency_code,priced_order_total_minor,
 captured_order_allocation_minor,written_off_minor,requested_by_actor_id,approved_by_actor_id,order_evidence_digest,
 payment_evidence_digest,decided_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD',$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          ref(input.writeOffReference),
          tenant,
          brand,
          store,
          ref(input.operationReference),
          ref(input.diningSessionReference),
          order,
          input.orderVersion,
          ref(input.orderCheckpoint),
          input.reasonCode,
          input.pricedOrderTotalMinor.toString(),
          input.capturedOrderAllocationMinor.toString(),
          input.writtenOffMinor.toString(),
          ref(input.requestedByActorReference),
          ref(input.approvedByActorReference),
          input.orderEvidenceDigest,
          input.paymentEvidenceDigest,
          decidedAt,
          ref(input.auditReference),
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: ref(input.auditReference),
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: ref(input.approvedByActorReference) },
        actionCode: "PAYMENT_UNPAID_DEPARTURE_WRITTEN_OFF",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          writtenOffMinor: input.writtenOffMinor.toString(),
          requestedBy: ref(input.requestedByActorReference),
        },
        reasonCode: input.reasonCode,
        correlationId: ref(input.correlationReference),
        occurredAt: decidedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await writeOffs(tx, "w.write_off_id=$3", [ref(input.writeOffReference)]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, writeOff: saved });
    },
  });
}
