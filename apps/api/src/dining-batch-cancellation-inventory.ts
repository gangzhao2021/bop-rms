import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderBatchCheckoutCancellationReader,
  parseOrderBatchCheckoutCancellation,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import {
  createPostgresSubmissionFinalValidationStore,
  createPostgresStockReservationStore,
  planInventoryReservationSetRelease,
  type StockReservationWrite,
} from "@rms/inventory";
type Cancellation = ReturnType<typeof parseOrderBatchCheckoutCancellation>;
const fail = (): never => {
  throw new Error("DINING_CANCELLATION_INVENTORY_UNAVAILABLE");
};
/** Stable nonsecret child identity; timestamp prefix comes from the owning cancellation UUIDv7. */
function childReference(record: Cancellation, reservation: string, role: string) {
  const h = createHash("sha256")
    .update(
      canonicalizeRfc8785([
        "DiningCancellationInventory/v1",
        record.tenantReference,
        record.brandReference,
        record.storeReference,
        record.cancellationReference,
        reservation,
        role,
      ]),
    )
    .digest("hex");
  return parseOrderingReference(
    record.cancellationReference.slice(0, 14) +
      "7" +
      h.slice(0, 3) +
      "-8" +
      h.slice(3, 6) +
      "-" +
      h.slice(6, 18),
  );
}
/** Caller retains Payment/Ordering fences and must roll back the transaction on any failure. */
export function createDiningBatchCancellationInventory(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  systemActorReference: string;
  now(): string;
  authorize(tx: ConsumerTransaction, record: Cancellation): Promise<boolean>;
}) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  const principal = parseOrderingReference(options.systemActorReference);
  return async (transaction: ConsumerTransaction, value: unknown): Promise<boolean> => {
    const raw = readClosedRecord(value, ["mode", "cancellation"]),
      record = parseOrderBatchCheckoutCancellation(raw.cancellation);
    if (
      !["Release", "Verify"].includes(String(raw.mode)) ||
      record.tenantReference !== scope.tenantReference ||
      record.brandReference !== scope.brandReference ||
      record.storeReference !== scope.storeReference ||
      record.cancelledAt > parseOrderingInstant(options.now())
    )
      return fail();
    const allowed = async () => (await options.authorize(transaction, record)) === true;
    if (!(await allowed())) return fail();
    const stored = await createPostgresOrderBatchCheckoutCancellationReader({
      ...scope,
      now: options.now,
      authorize: async (tx, identity) =>
        tx === transaction &&
        identity.orderReference === record.orderReference &&
        identity.orderBatchReference === record.orderBatchReference &&
        identity.operationReference === record.operationReference &&
        (await allowed()),
    }).loadOperation(transaction, {
      orderReference: record.orderReference,
      orderBatchReference: record.orderBatchReference,
      operationReference: record.operationReference,
    });
    if (stored === null || canonicalizeRfc8785(stored) !== canonicalizeRfc8785(record))
      return fail();
    const runner = {
      run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
    };
    const original = await createPostgresSubmissionFinalValidationStore(runner, scope, {
      authorize: async () => false,
      resolveCurrent: async () => fail(),
      authorizeSystemRelease: async (tx, input) =>
        tx === transaction &&
        input.systemActorReference === principal &&
        input.cancellationReference === record.cancellationReference &&
        input.submissionReference === record.submissionReference &&
        input.orderReference === record.orderReference &&
        input.observedAt === record.cancelledAt &&
        (await allowed()),
    }).loadForSystemRelease({
      systemActorReference: principal,
      cancellationReference: record.cancellationReference,
      submissionReference: record.submissionReference,
      orderReference: record.orderReference,
      observedAt: record.cancelledAt,
    });
    if (
      original === null ||
      String(original.orderReference) !== record.orderReference ||
      String(original.submissionReference) !== record.submissionReference ||
      original.items.some((item) => item.disposition === "Deferred")
    )
      return fail();
    const set = original.reservationSet;
    if (set === null) return await allowed();
    const members = new Map(
      set.entries.map((entry) => [entry.reservation.reservationReference, entry]),
    );
    const store = createPostgresStockReservationStore(runner, scope, {
      systemActorReference: principal,
      authorize: async (tx, input) => {
        const member = members.get(input.reservation.reservationReference);
        return (
          tx === transaction &&
          member !== undefined &&
          member.accountReference === input.accountReference &&
          input.operationReference ===
            childReference(record, input.reservation.reservationReference, "operation") &&
          String(input.reservation.updatedAt) === record.cancelledAt &&
          (await allowed())
        );
      },
    });
    const verify = async () => {
      for (const entry of set.entries) {
        const prior = await store.verifySystemRelease(
          childReference(record, entry.reservation.reservationReference, "operation"),
        );
        if (
          prior === null ||
          prior.movementReference !==
            childReference(record, entry.reservation.reservationReference, "movement") ||
          prior.auditReference !==
            childReference(record, entry.reservation.reservationReference, "audit")
        )
          return fail();
        const next = prior.reservation,
          base = entry.reservation;
        if (
          next.reservationReference !== base.reservationReference ||
          canonicalizeRfc8785(next.binding) !== canonicalizeRfc8785(base.binding) ||
          canonicalizeRfc8785(next.unit) !== canonicalizeRfc8785(base.unit) ||
          next.originalQuantity !== base.originalQuantity ||
          next.createdAt !== base.createdAt ||
          String(next.updatedAt) !== record.cancelledAt ||
          next.remainingQuantity !== "0" ||
          next.releasedQuantity !== base.originalQuantity ||
          next.consumedQuantity !== "0" ||
          next.productionStartedAt !== null ||
          next.version <= base.version
        )
          return fail();
      }
      return await allowed();
    };
    if (raw.mode === "Verify") return verify();
    const current = [];
    for (const entry of set.entries) {
      if (
        (await store.resolveOperation(
          childReference(record, entry.reservation.reservationReference, "operation"),
        )) !== null
      )
        return fail();
      const observed = await store.loadCurrent(entry.reservation.reservationReference);
      if (observed === null) return fail();
      current.push({
        accountReference: observed.accountReference,
        reservation: observed.reservation,
      });
    }
    const plan = planInventoryReservationSetRelease({
      set,
      current,
      occurredAt: record.cancelledAt,
    });
    const writes: StockReservationWrite[] = [];
    for (const entry of plan.entries) {
      const version = await store.loadAccountLedgerVersion(entry.accountReference);
      if (version === null) return fail();
      const reservation = entry.reservation,
        operationReference = childReference(record, reservation.reservationReference, "operation");
      writes.push({
        operationReference,
        accountReference: entry.accountReference,
        action: "Release",
        expectedLedgerVersion: version,
        quantity: entry.quantity,
        reservation,
        movementReference: childReference(record, reservation.reservationReference, "movement"),
        audit: {
          auditId: childReference(record, reservation.reservationReference, "audit"),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "INVENTORY_RESERVATION_RELEASE",
          targetType: "InventoryReservation",
          targetId: reservation.reservationReference,
          reasonCode: "CHECKOUT_DEADLINE_REACHED",
          correlationId: operationReference,
          occurredAt: record.cancelledAt,
          sourceChannel: "SYSTEM",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      });
    }
    const receipt = await store.releaseSet(
      { set, writes },
      async (tx, candidate) =>
        tx === transaction &&
        canonicalizeRfc8785(candidate) === canonicalizeRfc8785(set) &&
        (await allowed()),
    );
    if (receipt.status !== "Applied" || receipt.entries.length !== set.entries.length)
      return fail();
    return verify();
  };
}
