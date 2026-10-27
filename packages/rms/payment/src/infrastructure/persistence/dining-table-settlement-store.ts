import { appendAuditRecordInTransaction, type AuditTransaction } from "@bop/audit";
import {
  planDiningTableSettlement,
  type DiningTableSettlementMethod,
  type DiningTableSettlementRound,
} from "../../domain/dining-table-settlement.js";
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
  /** One line per round the table owed; the tip and rounding are on the last line. */
  readonly lines: readonly {
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
 s.actor_id::text AS actor,s.audit_id::text AS audit,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('batch',r.order_batch_id,'submission',r.submission_id,
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
  const method = row.method === "Cash" || row.method === "CardMachine" ? row.method : fail();
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
    lines: Object.freeze(
      lines.map((value: Record<string, unknown>) =>
        Object.freeze({
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
  return Object.freeze({
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
      const taken = await settlements(
        tx,
        "((s.taken_at>=$3 AND s.taken_at<$4) OR s.settlement_id=ANY($5::uuid[])) ORDER BY s.taken_at,s.settlement_id LIMIT 100001",
        [from, to, [...new Set(refunds.map((refund) => refund.settlementReference))]],
      );
      // DEC-DINE-IN-PAY-LATER (decision 4): bills written off when the guests left, by when the
      // manager decided — never paid, but kept in the day's summary and reconciliation.
      const writtenOff = await writeOffs(tx, "w.decided_at>=$3 AND w.decided_at<$4", [from, to]);
      return Object.freeze({
        settlements: Object.freeze(taken),
        cashRefunds: Object.freeze(refunds),
        writeOffs: Object.freeze(writtenOff),
      });
    },

    /** The settlements of these Orders (a table Order has at most one). */
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
      },
    ) {
      const order = ref(input.orderReference);
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
      if ((await settlements(tx, "s.order_id=$3", [order])).length > 0)
        return fail("DINING_TABLE_SETTLEMENT_ALREADY_PAID");
      const recordedAt = String(parsePaymentInstant(input.recordedAt)),
        takenAt = String(parsePaymentInstant(input.takenAt));
      await tx.query(
        `INSERT INTO rms_payment.dining_table_settlement (settlement_id,tenant_id,brand_id,store_id,operation_id,
 intent_digest,dining_session_id,order_id,method,rounds_minor,tip_minor,rounding_minor,total_minor,tendered_minor,
 change_minor,currency_code,payment_environment,slip_reference,recording_reason,taken_at,recorded_at,actor_id,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CAD',$16,$17,$18,$19,$20,$21,$22)`,
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
            order,
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
        actor: { type: "User", reference: ref(input.actorReference) },
        actionCode: "PAYMENT_DINING_TABLE_SETTLED",
        targetType: "Order",
        targetId: order,
        afterSummary: {
          method: plan.method,
          totalMinor: plan.totalMinor.toString(),
          tipMinor: plan.tipMinor.toString(),
          roundingMinor: plan.roundingMinor.toString(),
          rounds: plan.lines.length,
        },
        reasonCode:
          input.recordingReason === "AtTable"
            ? plan.method === "Cash"
              ? "CASH_RECEIVED"
              : "CARD_MACHINE_APPROVED"
            : "RECORDED_AFTER_OUTAGE",
        correlationId: ref(input.correlationReference),
        occurredAt: recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const [saved] = await settlements(tx, "s.settlement_id=$3", [ref(input.settlementReference)]);
      if (saved === undefined) return fail();
      return Object.freeze({ status: "Recorded" as const, settlement: saved });
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
