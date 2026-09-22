import type { ConsumerTransaction } from "@bop/eventing";
import {
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationLeaseReceipt,
  PaymentCompensationError,
  type PaymentCompensationLeaseReceipt,
} from "../../application/paid-without-fulfillable-order.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";

export interface PaymentCompensationLeaseAccess {
  readonly action: "Claim" | "Release" | "Check";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly paymentAttemptReference: string;
  readonly operationReference: string;
}
type LeaseFence = Parameters<PaidWithoutFulfillableOrderPorts["lease"]["release"]>[0];
const fail = (
  code: PaymentCompensationError["code"] = "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
): never => {
  throw new PaymentCompensationError(code);
};
const sequence = (value: unknown): number => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value)) return fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fail();
  return number;
};
const instant = (value: unknown): string =>
  parsePaymentInstant(value instanceof Date ? value.toISOString() : value);

/** Durable coordination only: claim history cannot establish pending refund disposition. */
export function createPostgresPaymentCompensationLeaseStore(options: {
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly leaseDurationMs: number;
  readonly newFenceReference: () => string;
  readonly authorize: (
    transaction: ConsumerTransaction,
    access: PaymentCompensationLeaseAccess,
  ) => Promise<boolean>;
}) {
  const brandReference = parsePaymentReference(options.scope.brandReference);
  const storeReference = parsePaymentReference(options.scope.storeReference);
  const leaseDurationMs = options.leaseDurationMs;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 100 || leaseDurationMs > 300000)
    return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
  const parse = (value: unknown, fence: boolean) => {
    try {
      const raw = exactPaymentObject(value, [
        "paymentAttemptReference",
        "operationReference",
        "jobName",
        ...(fence ? ["fenceReference", "fenceVersion"] : []),
      ]);
      if (raw.jobName !== paidWithoutFulfillableOrderJobName)
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      const result = {
        paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
        operationReference: String(parsePaymentReference(raw.operationReference)),
      };
      if (fence && (!Number.isSafeInteger(raw.fenceVersion) || Number(raw.fenceVersion) < 1))
        return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
      return {
        ...result,
        fenceReference: fence ? String(parsePaymentReference(raw.fenceReference)) : null,
        fenceVersion: fence ? Number(raw.fenceVersion) : null,
      };
    } catch {
      return fail("PAYMENT_COMPENSATION_INPUT_INVALID");
    }
  };
  const accessFor = (
    action: PaymentCompensationLeaseAccess["action"],
    input: ReturnType<typeof parse>,
  ): PaymentCompensationLeaseAccess => ({
    action,
    brandReference,
    storeReference,
    paymentAttemptReference: input.paymentAttemptReference,
    operationReference: input.operationReference,
  });
  const clock = async (tx: ConsumerTransaction) => {
    const result = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    if (result.rows.length !== 1) return fail();
    return instant(result.rows[0]?.now);
  };
  const prepare = async (tx: ConsumerTransaction, access: PaymentCompensationLeaseAccess) => {
    if (!(await options.authorize(tx, access)))
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentCompensationAttempt:" +
        brandReference +
        ":" +
        storeReference +
        ":" +
        access.paymentAttemptReference,
    ]);
  };
  const authorize = async (tx: ConsumerTransaction, access: PaymentCompensationLeaseAccess) => {
    if (!(await options.authorize(tx, access)))
      return fail("PAYMENT_COMPENSATION_PERMISSION_DENIED");
  };
  const latest = async (tx: ConsumerTransaction, attempt: string) => {
    const result = await tx.query(
      "SELECT history_sequence::text,action,operation_id,fence_id,fence_version::text,claimed_at,expires_at,recorded_at " +
        "FROM rms_payment.payment_compensation_lease_history WHERE brand_id=$1 AND store_id=$2 AND payment_attempt_id=$3 " +
        "ORDER BY payment_compensation_lease_history.history_sequence DESC LIMIT 1",
      [brandReference, storeReference, attempt],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return fail();
    const row = result.rows[0];
    if (!row || (row.action !== "Claimed" && row.action !== "Released")) return fail();
    const lease = parsePaymentCompensationLeaseReceipt({
      paymentAttemptReference: attempt,
      operationReference: row.operation_id,
      jobName: paidWithoutFulfillableOrderJobName,
      fenceReference: row.fence_id,
      fenceVersion: sequence(row.fence_version),
      claimedAt: instant(row.claimed_at),
      expiresAt: instant(row.expires_at),
      status: "Claimed",
    });
    return {
      lease,
      action: row.action,
      sequence: sequence(row.history_sequence),
      recordedAt: instant(row.recorded_at),
    };
  };
  const append = async (
    tx: ConsumerTransaction,
    lease: PaymentCompensationLeaseReceipt,
    action: "Claimed" | "Released",
    historySequence: number,
    at: string,
  ) => {
    if (!Number.isSafeInteger(historySequence) || historySequence < 1) return fail();
    const result = await tx.query(
      "INSERT INTO rms_payment.payment_compensation_lease_history " +
        "(brand_id,store_id,payment_attempt_id,operation_id,history_sequence,action,fence_id,fence_version,claimed_at,expires_at,recorded_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        brandReference,
        storeReference,
        lease.paymentAttemptReference,
        lease.operationReference,
        historySequence,
        action,
        lease.fenceReference,
        lease.fenceVersion,
        lease.claimedAt,
        lease.expiresAt,
        at,
      ],
    );
    if (result.rowCount !== 1) return fail();
  };
  const matches = (lease: PaymentCompensationLeaseReceipt, input: ReturnType<typeof parse>) =>
    lease.operationReference === input.operationReference &&
    lease.fenceReference === input.fenceReference &&
    lease.fenceVersion === input.fenceVersion;
  const run = async <T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> => {
    try {
      return await options.transactions.run(work);
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      return fail();
    }
  };
  const lease: PaidWithoutFulfillableOrderPorts["lease"] = {
    claim: async (value) => {
      const input = parse(value, false);
      const access = accessFor("Claim", input);
      return run(async (tx) => {
        await prepare(tx, access);
        const prior = await latest(tx, input.paymentAttemptReference);
        const now = await clock(tx);
        await authorize(tx, access);
        if (
          prior &&
          (now < prior.recordedAt || (prior.action === "Claimed" && prior.lease.expiresAt > now))
        )
          return null;
        const next = parsePaymentCompensationLeaseReceipt({
          paymentAttemptReference: input.paymentAttemptReference,
          operationReference: input.operationReference,
          jobName: paidWithoutFulfillableOrderJobName,
          fenceReference: options.newFenceReference(),
          fenceVersion: (prior?.sequence ?? 0) + 1,
          claimedAt: now,
          expiresAt: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
          status: "Claimed",
        });
        // Reference reuse would make tracing old executions ambiguous even with a new version.
        if (prior?.lease.fenceReference === next.fenceReference) return fail();
        await append(tx, next, "Claimed", next.fenceVersion, now);
        await authorize(tx, access);
        return next;
      });
    },
    release: async (value) => {
      const input = parse(value, true);
      const access = accessFor("Release", input);
      return run(async (tx) => {
        await prepare(tx, access);
        const prior = await latest(tx, input.paymentAttemptReference);
        if (!prior || !matches(prior.lease, input)) return fail();
        const now = await clock(tx);
        if (now < prior.recordedAt) return fail();
        await authorize(tx, access);
        if (prior.action === "Released") return;
        await append(tx, prior.lease, "Released", prior.sequence + 1, now);
        await authorize(tx, access);
      });
    },
  };
  return Object.freeze({
    lease: Object.freeze(lease),
    /** Call immediately before an owned write in this same transaction; keep its lock through commit. */
    async assertCurrent(transaction: ConsumerTransaction, value: LeaseFence): Promise<void> {
      const input = parse(value, true);
      const access = accessFor("Check", input);
      await prepare(transaction, access);
      const prior = await latest(transaction, input.paymentAttemptReference);
      const now = await clock(transaction);
      await authorize(transaction, access);
      if (
        !prior ||
        prior.action !== "Claimed" ||
        !matches(prior.lease, input) ||
        prior.lease.expiresAt <= now ||
        now < prior.recordedAt
      )
        return fail();
    },
  });
}
