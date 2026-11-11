import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { createPostgresOrderFinancialPosition } from "../order-financial-position.js";
import { observeOrdinaryRefundOrderAfterFence } from "./ordinary-refund-request-store.js";

/**
 * WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5): money staff take back after refunding too
 * much by mistake. Recorded on the same order, on the business day it happens, by a Store Manager
 * or the Owner in their own name (payment.refund.recover). The compensating entry for a refund:
 * the refund itself never changes. Append-only.
 */
export const refundRecoveryMethods = Object.freeze(["Cash", "CardMachine"] as const);
export const refundRecoveryReasons = Object.freeze([
  "REFUNDED_TOO_MUCH",
  "WRONG_ITEM_REFUNDED",
  "OTHER",
] as const);
export type RefundRecoveryMethod = (typeof refundRecoveryMethods)[number];
export type RefundRecoveryReason = (typeof refundRecoveryReasons)[number];
export interface RefundRecovery {
  readonly recoveryReference: string;
  readonly operationReference: string;
  readonly orderReference: string;
  readonly method: RefundRecoveryMethod;
  readonly slipReference: string | null;
  readonly amountMinor: bigint;
  readonly currencyCode: "CAD";
  readonly reasonCode: RefundRecoveryReason;
  readonly actorReference: string;
  readonly businessDate: string;
  readonly recordedAt: string;
}
export class RefundRecoveryError extends Error {
  constructor(
    readonly code:
      | "REFUND_RECOVERY_INPUT_INVALID"
      | "REFUND_RECOVERY_ABOVE_REFUNDED"
      | "REFUND_RECOVERY_CONFLICT"
      | "REFUND_RECOVERY_UNAVAILABLE",
  ) {
    super(code);
    this.name = "RefundRecoveryError";
  }
}
const fail = (code: RefundRecoveryError["code"]): never => {
  throw new RefundRecoveryError(code);
};
interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
const ref = (value: unknown) => String(parsePaymentReference(value));
const selection =
  "recovery_id::text AS recovery,operation_id::text AS operation,order_id::text AS order_ref,method,slip_reference AS slip,amount_minor::text AS amount,currency_code AS currency,reason_code AS reason,actor_id::text AS actor,to_char(business_date,'YYYY-MM-DD') AS business_date,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_at";
function bind(row: Record<string, unknown>): RefundRecovery {
  if (
    !refundRecoveryMethods.includes(row.method as never) ||
    !refundRecoveryReasons.includes(row.reason as never) ||
    row.currency !== "CAD" ||
    typeof row.amount !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(row.amount) ||
    typeof row.business_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date) ||
    (row.slip !== null && typeof row.slip !== "string")
  )
    return fail("REFUND_RECOVERY_UNAVAILABLE");
  return Object.freeze({
    recoveryReference: ref(row.recovery),
    operationReference: ref(row.operation),
    orderReference: ref(row.order_ref),
    method: row.method as RefundRecoveryMethod,
    slipReference: row.slip as string | null,
    amountMinor: BigInt(row.amount),
    currencyCode: "CAD" as const,
    reasonCode: row.reason as RefundRecoveryReason,
    actorReference: ref(row.actor),
    businessDate: row.business_date,
    recordedAt: String(parsePaymentInstant(row.recorded_at)),
  });
}
async function setScope(tx: ConsumerTransaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}

/** The recoveries recorded for the given Orders of the Store, oldest first. Caller authorizes. */
export async function listRefundRecoveriesByOrders(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<readonly RefundRecovery[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 100) return fail("REFUND_RECOVERY_UNAVAILABLE");
  await setScope(tx, scope);
  const found = await tx.query<Record<string, unknown>>(
    "SELECT " +
      selection +
      " FROM rms_payment.refund_recovery WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) ORDER BY recorded_at,recovery_id LIMIT 1001",
    [ref(scope.brandReference), ref(scope.storeReference), orderReferences.map(ref)],
  );
  if (found.rows.length > 1000) return fail("REFUND_RECOVERY_UNAVAILABLE");
  return Object.freeze(found.rows.map(bind));
}

/** The recoveries recorded on one business date of the Store (settlement, Today's summary). */
export async function listRefundRecoveriesByBusinessDate(
  tx: ConsumerTransaction,
  scope: Scope,
  businessDate: string,
): Promise<readonly RefundRecovery[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) return fail("REFUND_RECOVERY_INPUT_INVALID");
  await setScope(tx, scope);
  const found = await tx.query<Record<string, unknown>>(
    "SELECT " +
      selection +
      " FROM rms_payment.refund_recovery WHERE brand_id=$1 AND store_id=$2 AND business_date=$3::date ORDER BY recorded_at,recovery_id LIMIT 5001",
    [ref(scope.brandReference), ref(scope.storeReference), businessDate],
  );
  if (found.rows.length > 5000) return fail("REFUND_RECOVERY_UNAVAILABLE");
  return Object.freeze(found.rows.map(bind));
}

/**
 * Records one recovery, or answers the one already recorded for its operation (a retry). Under the
 * Order's refund fence: never more than the Order's confirmed refunds (online, card machine and
 * table, Payment's own position) less what was already taken back. Refunds still pending or not
 * sent cannot be taken back: they can still be stopped. The caller authorizes the actor's
 * payment.refund.recover and supplies the business date of `recordedAt` in the Store's zone.
 */
export function createPostgresRefundRecoveryStore(options: {
  scope: Scope;
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize(tx: ConsumerTransaction, query: { orderReference: string }): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: ref(options.scope.tenantReference),
    brandReference: ref(options.scope.brandReference),
    storeReference: ref(options.scope.storeReference),
  });
  const position = createPostgresOrderFinancialPosition({
    scope,
    providerAccountReference: options.providerAccountReference,
    environment: options.environment,
    authorize: (tx, query) => options.authorize(tx, { orderReference: query.orderReference }),
  });
  return async (
    tx: ConsumerTransaction,
    input: {
      readonly recoveryReference: string;
      readonly operationReference: string;
      readonly orderReference: string;
      readonly method: RefundRecoveryMethod;
      readonly slipReference: string | null;
      readonly amountMinor: bigint;
      readonly reasonCode: RefundRecoveryReason;
      readonly actorReference: string;
      readonly recordedAt: string;
      readonly businessDate: string;
      readonly audit: Parameters<typeof appendAuditRecordInTransaction>[1];
    },
  ): Promise<{
    readonly status: "Recorded" | "AlreadyRecorded";
    readonly recovery: RefundRecovery;
  }> => {
    const orderReference = ref(input.orderReference),
      operationReference = ref(input.operationReference);
    if (
      !refundRecoveryMethods.includes(input.method) ||
      !refundRecoveryReasons.includes(input.reasonCode) ||
      typeof input.amountMinor !== "bigint" ||
      input.amountMinor <= 0n ||
      input.amountMinor > 100_000_000n ||
      (input.method === "CardMachine") !==
        (typeof input.slipReference === "string" &&
          /^[A-Za-z0-9 -]{1,24}$/u.test(input.slipReference)) ||
      (input.method === "Cash" && input.slipReference !== null) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate)
    )
      return fail("REFUND_RECOVERY_INPUT_INVALID");
    validateAuditRecord(input.audit);
    if (!(await options.authorize(tx, { orderReference })))
      return fail("REFUND_RECOVERY_UNAVAILABLE");
    // The Order's refund fence, then the time: every refund recorded before is in the position.
    const observedAt = await observeOrdinaryRefundOrderAfterFence(
      tx,
      scope,
      orderReference,
      String(parsePaymentInstant(input.recordedAt)),
      () => input.recordedAt,
    );
    await setScope(tx, scope);
    const prior = await tx.query<Record<string, unknown>>(
      "SELECT " +
        selection +
        " FROM rms_payment.refund_recovery WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [scope.brandReference, scope.storeReference, operationReference],
    );
    if (prior.rows.length > 0) {
      const existing = bind(prior.rows[0] as Record<string, unknown>);
      if (
        existing.orderReference !== orderReference ||
        existing.amountMinor !== input.amountMinor ||
        existing.method !== input.method ||
        existing.actorReference !== ref(input.actorReference)
      )
        return fail("REFUND_RECOVERY_CONFLICT");
      return Object.freeze({ status: "AlreadyRecorded" as const, recovery: existing });
    }
    const current = await position(tx, { orderReference, observedAt });
    await setScope(tx, scope);
    const taken = (await listRefundRecoveriesByOrders(tx, scope, [orderReference])).reduce(
      (sum, recovery) => sum + recovery.amountMinor,
      0n,
    );
    if (input.amountMinor > current.settlement.confirmedRefundMinor - taken)
      return fail("REFUND_RECOVERY_ABOVE_REFUNDED");
    await setScope(tx, scope);
    const inserted = await tx.query<Record<string, unknown>>(
      "INSERT INTO rms_payment.refund_recovery (tenant_id,brand_id,store_id,recovery_id,operation_id,order_id,method,slip_reference,amount_minor,currency_code,reason_code,actor_type,actor_id,permission_code,business_date,recorded_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD',$10,'User',$11,'payment.refund.recover',$12::date,$13::timestamptz,$14) RETURNING " +
        selection,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        ref(input.recoveryReference),
        operationReference,
        orderReference,
        input.method,
        input.slipReference,
        input.amountMinor.toString(),
        input.reasonCode,
        ref(input.actorReference),
        input.businessDate,
        String(parsePaymentInstant(input.recordedAt)),
        ref(input.audit.auditId),
      ],
    );
    if (inserted.rows.length !== 1) return fail("REFUND_RECOVERY_UNAVAILABLE");
    await appendAuditRecordInTransaction(tx, input.audit);
    return Object.freeze({
      status: "Recorded" as const,
      recovery: bind(inserted.rows[0] as Record<string, unknown>),
    });
  };
}
