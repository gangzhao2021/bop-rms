import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { createPostgresOrderFinancialPosition } from "../order-financial-position.js";
import { createPostgresCardMachinePaymentStore } from "./card-machine-payment-store.js";
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
      /** b12: an Order paid only in cash takes back cash, never a card-machine charge. */
      | "REFUND_RECOVERY_CASH_ONLY"
      /** b12: cash comes back in whole nickels. */
      | "REFUND_RECOVERY_WHOLE_NICKELS"
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
  "recovery_id::text AS recovery,operation_id::text AS operation,order_id::text AS order_ref,method,slip_reference AS slip,amount_minor::text AS amount,currency_code AS currency,reason_code AS reason,actor_id::text AS actor,to_char(business_date,'YYYY-MM-DD') AS business_date,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_text";
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
    recordedAt: String(parsePaymentInstant(row.recorded_text)),
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
 * The recoveries recorded in [startsAt, endsAt) at the Store (the Store sales reports and Today's
 * summary count each on the business day of its recording, by how it came back). Caller authorizes.
 */
export async function listRefundRecoveriesRecordedBetween(
  tx: ConsumerTransaction,
  scope: Scope,
  window: { readonly startsAt: string; readonly endsAt: string },
): Promise<readonly RefundRecovery[]> {
  const startsAt = String(parsePaymentInstant(window.startsAt)),
    endsAt = String(parsePaymentInstant(window.endsAt));
  if (startsAt >= endsAt) return fail("REFUND_RECOVERY_INPUT_INVALID");
  await setScope(tx, scope);
  const found = await tx.query<Record<string, unknown>>(
    "SELECT " +
      selection +
      " FROM rms_payment.refund_recovery WHERE brand_id=$1 AND store_id=$2 AND recorded_at>=$3::timestamptz AND recorded_at<$4::timestamptz ORDER BY recorded_at,recovery_id LIMIT 5001",
    [ref(scope.brandReference), ref(scope.storeReference), startsAt, endsAt],
  );
  if (found.rows.length > 5000) return fail("REFUND_RECOVERY_UNAVAILABLE");
  return Object.freeze(found.rows.map(bind));
}

/**
 * b10 cash-refund-approvals (M163): what can still be taken back on an Order, and how. An Order
 * paid only in cash at the counter (no online, table or card-machine charge) can only get back the
 * cash its drawer gave out: in cash, in whole nickels, up to every cash refund handed back (the
 * drawer's rounding included) less what was taken back already. Any other Order: its confirmed
 * refunds less what was taken back, in cash or on the card machine. Caller authorizes.
 */
export async function readRefundRecoveryAllowance(
  tx: ConsumerTransaction,
  options: {
    readonly scope: Scope & { readonly tenantReference: string };
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
    authorize(tx: ConsumerTransaction, query: { orderReference: string }): Promise<boolean>;
  },
  query: { readonly orderReference: string; readonly observedAt: string },
): Promise<{ readonly cashOnly: boolean; readonly leftMinor: bigint }> {
  const scope = Object.freeze({
    tenantReference: ref(options.scope.tenantReference),
    brandReference: ref(options.scope.brandReference),
    storeReference: ref(options.scope.storeReference),
  });
  const orderReference = ref(query.orderReference),
    observedAt = String(parsePaymentInstant(query.observedAt));
  const position = await createPostgresOrderFinancialPosition({
    scope,
    providerAccountReference: options.providerAccountReference,
    environment: options.environment,
    authorize: (t, value) => options.authorize(t, { orderReference: value.orderReference }),
  })(tx, { orderReference, observedAt });
  const machine = (
    await createPostgresCardMachinePaymentStore({
      scope,
      authorize: (t, value) => options.authorize(t as never, value),
    }).listByOrder(tx, orderReference)
  ).filter((entry) => entry.payment.recordedAt <= observedAt);
  await setScope(tx, scope);
  const taken = (await listRefundRecoveriesByOrders(tx, scope, [orderReference])).reduce(
    (sum, recovery) => sum + recovery.amountMinor,
    0n,
  );
  const cashOnly =
    machine.length > 0 &&
    machine.every((entry) => entry.payment.cash !== undefined) &&
    position.capturedMinor === 0n &&
    position.tableSettlementCaptures.length === 0;
  const back = cashOnly
    ? machine.reduce(
        (sum, entry) =>
          sum +
          entry.refunds
            .filter((refund) => refund.recordedAt <= observedAt)
            .reduce((total, refund) => total + refund.amountMinor, 0n),
        0n,
      )
    : position.settlement.confirmedRefundMinor;
  const left = back - taken;
  // Cash comes back in whole nickels. A recovery recorded before b10 may be in any cents or way
  // ($0.02 in cash, $3.67 on the card machine), so what is left is rounded down to whole nickels:
  // the most the guest can still hand back, never an odd amount the page can't offer.
  const leftMinor = left > 0n ? (cashOnly ? left - (left % 5n) : left) : 0n;
  return Object.freeze({ cashOnly, leftMinor });
}

/**
 * Records one recovery, or answers the one already recorded for its operation (a retry). Under the
 * Order's refund fence: never more than the Order's confirmed refunds (online, card machine and
 * table, Payment's own position) less what was already taken back; an Order paid only in cash at
 * the counter takes back cash alone, in whole nickels, up to the cash given back (b10). Refunds still pending or not
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
        existing.reasonCode !== input.reasonCode ||
        existing.slipReference !== input.slipReference ||
        existing.actorReference !== ref(input.actorReference)
      )
        return fail("REFUND_RECOVERY_CONFLICT");
      return Object.freeze({ status: "AlreadyRecorded" as const, recovery: existing });
    }
    const allowance = await readRefundRecoveryAllowance(
      tx,
      {
        scope,
        providerAccountReference: options.providerAccountReference,
        environment: options.environment,
        authorize: options.authorize,
      },
      { orderReference, observedAt },
    );
    // b10: an Order paid only in cash gets back cash, in whole nickels (never a card charge).
    // b12: each refused for its own reason (an amount or method, never the person's permission).
    if (allowance.cashOnly && input.method !== "Cash") return fail("REFUND_RECOVERY_CASH_ONLY");
    if (allowance.cashOnly && input.amountMinor % 5n !== 0n)
      return fail("REFUND_RECOVERY_WHOLE_NICKELS");
    if (input.amountMinor > allowance.leftMinor) return fail("REFUND_RECOVERY_ABOVE_REFUNDED");
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
