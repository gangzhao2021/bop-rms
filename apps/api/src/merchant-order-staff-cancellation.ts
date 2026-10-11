import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
} from "@rms/kitchen";
import {
  createPostgresStaffOrderCancellationStore,
  parseOrderingInstant,
  parseOrderingReference,
  readStaffBatchLineSources,
  staffOrderCancellationReasonCodes,
  type StaffOrderCancellationReasonCode,
  type StaffOrderCancellationRecord,
} from "@rms/ordering";
import { createPostgresPaymentCompensationRefundPositionSource } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";

/** DEC-ORDER-CANCELLATION-PILOT: store managers and owners hold it; front of house does not. */
export const staffOrderCancellationPermission = "ordering.order.cancel" as const;

export const staffOrderCancellationErrorCodes = [
  "ORDER_CANCELLATION_INPUT_INVALID",
  "ORDER_CANCELLATION_PERMISSION_DENIED",
  "ORDER_CANCELLATION_NOT_FOUND",
  "ORDER_CANCELLATION_VERSION_CONFLICT",
  "ORDER_CANCELLATION_PREPARATION_STARTED",
  "ORDER_CANCELLATION_NOT_CANCELLABLE",
  "ORDER_CANCELLATION_STOCK_NOT_RELEASABLE",
  "ORDER_CANCELLATION_UNAVAILABLE",
] as const;
export type StaffOrderCancellationErrorCode = (typeof staffOrderCancellationErrorCodes)[number];
export class StaffOrderCancellationError extends Error {
  readonly code: StaffOrderCancellationErrorCode;
  constructor(code: StaffOrderCancellationErrorCode) {
    super("staff order cancellation is unavailable");
    this.name = "StaffOrderCancellationError";
    this.code = code;
  }
}
const fail = (code: StaffOrderCancellationErrorCode): never => {
  throw new StaffOrderCancellationError(code);
};

export type StaffOrderRefundStatus = "Pending" | "Refunded";
export interface StaffOrderCancellationResult {
  readonly status: "Cancelled" | "AlreadyCancelled";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly cancelledAt: string;
  readonly refundStatus: StaffOrderRefundStatus;
}

/**
 * WP-2423 Q6: refund status of a staff cancellation from Payment's compensation-owned amounts for
 * its payment attempt. Refunded only once a Provider-confirmed refund fact exists and nothing is
 * still claimed; until the compensation workload opens its case, the refund is pending.
 */
export async function readStaffCancellationRefundStatus(
  transaction: ConsumerTransaction,
  scope: { brandReference: string; storeReference: string },
  record: Pick<
    StaffOrderCancellationRecord,
    "orderReference" | "paymentTransactionReference" | "paymentAttemptReference"
  >,
  authorize: () => Promise<boolean>,
): Promise<StaffOrderRefundStatus> {
  const position = await createPostgresPaymentCompensationRefundPositionSource({
    scope,
    authorize: async (tx, input) =>
      tx === transaction &&
      input.orderReference === String(record.orderReference) &&
      input.paymentAttemptReference === String(record.paymentAttemptReference) &&
      (await authorize()),
  })(transaction, {
    orderReference: String(record.orderReference),
    paymentTransactionReference: String(record.paymentTransactionReference),
    paymentAttemptReference: String(record.paymentAttemptReference),
  });
  return position.confirmedMinor > 0n && position.pendingMinor === 0n ? "Refunded" : "Pending";
}

function databaseCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * WP-2423 Q6 (DEC-ORDER-CANCELLATION-PILOT, implementation decision 2): staff cancel a paid,
 * accepted Order (pickup) or batch (dine-in) before the kitchen starts it. One transaction:
 * permission and reason → Ordering fence, order version and Confirmed payment → Kitchen row locks,
 * every work item still not started → Kitchen items Cancelled → Ordering append-only staff
 * cancellation (termination for pickup, batch revision for dine-in) with audit → the submission's
 * reserved stock released (all or nothing). The Ordering record is the durable compensation source:
 * the Payment compensation workload opens the case and refunds the whole remaining capture,
 * including tip, outside this transaction (lease, retrieve before refund, unknown → query only).
 * The browser sends intent only; staff identity, time and eligibility are server-owned. A retry with
 * the same operation reference returns the original outcome without writing.
 */
export function createMerchantOrderStaffCancellation(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<StaffOrderCancellationResult> => {
    const session = await options.authentication.authorize(input);
    let intent: Readonly<Record<string, unknown>>;
    let orderReference: string, orderBatchReference: string, operationReference: string;
    try {
      intent = readClosedRecord(input.command, [
        "orderReference",
        "orderBatchReference",
        "expectedOrderVersion",
        "operationReference",
        "reasonCode",
      ]);
      orderReference = String(parseOrderingReference(intent.orderReference));
      orderBatchReference = String(parseOrderingReference(intent.orderBatchReference));
      operationReference = String(parseOrderingReference(intent.operationReference));
    } catch {
      return fail("ORDER_CANCELLATION_INPUT_INVALID");
    }
    const expectedOrderVersion = intent.expectedOrderVersion;
    if (
      typeof expectedOrderVersion !== "number" ||
      !Number.isSafeInteger(expectedOrderVersion) ||
      expectedOrderVersion < 1 ||
      expectedOrderVersion > 2147483646 ||
      typeof intent.reasonCode !== "string" ||
      !(staffOrderCancellationReasonCodes as readonly string[]).includes(intent.reasonCode)
    )
      return fail("ORDER_CANCELLATION_INPUT_INVALID");
    const reasonCode = intent.reasonCode as StaffOrderCancellationReasonCode;
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const scope = await resolveScope(
          transaction,
          input.sessionCookie,
          staffOrderCancellationPermission,
          session.sessionReference,
        ).catch(() => fail("ORDER_CANCELLATION_PERMISSION_DENIED"));
        const allowed = async () => (await scope.allowed()) === true;
        if (!(await allowed())) return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
        const tx = transaction as unknown as ConsumerTransaction;
        const selected = {
          tenantReference: String(scope.selected.tenantReference),
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.store.storeReference),
        };
        const actorReference = String(scope.actorReference);
        await options.installContext(tx, selected);
        const owned = async (
          t: ConsumerTransaction,
          identity: { orderReference: string; orderBatchReference: string; actorReference: string },
        ) =>
          t === tx &&
          identity.orderReference === orderReference &&
          identity.orderBatchReference === orderBatchReference &&
          identity.actorReference === actorReference &&
          (await allowed());
        const ordering = createPostgresStaffOrderCancellationStore({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          authorize: owned,
        });
        const replied = async (
          status: "Cancelled" | "AlreadyCancelled",
          record: StaffOrderCancellationRecord,
        ) => {
          const refundStatus =
            status === "Cancelled"
              ? ("Pending" as const)
              : await readStaffCancellationRefundStatus(tx, selected, record, allowed);
          if (!(await allowed())) return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
          return Object.freeze({
            status,
            orderReference,
            orderBatchReference,
            cancelledAt: String(record.cancelledAt),
            refundStatus,
          });
        };
        // Replay of the same staff command: the original outcome, nothing written.
        const prior = await ordering.loadByOperation(tx, operationReference);
        if (prior !== null) {
          if (
            String(prior.orderReference) !== orderReference ||
            String(prior.orderBatchReference) !== orderBatchReference ||
            prior.reasonCode !== reasonCode ||
            String(prior.actorReference) !== actorReference ||
            prior.expectedOrderVersion !== expectedOrderVersion
          )
            return fail("ORDER_CANCELLATION_NOT_CANCELLABLE");
          return replied("AlreadyCancelled", prior);
        }
        const prepared = await ordering.prepare(tx, {
          orderReference,
          orderBatchReference,
          expectedOrderVersion,
          actorReference,
        });
        if (prepared.status === "NotEligible")
          return fail(
            prepared.reason === "NotFound"
              ? "ORDER_CANCELLATION_NOT_FOUND"
              : prepared.reason === "VersionConflict"
                ? "ORDER_CANCELLATION_VERSION_CONFLICT"
                : "ORDER_CANCELLATION_NOT_CANCELLABLE",
          );
        const plan = prepared.plan;
        const cancellationReference = String(parseOrderingReference(options.nextReference()));
        const cancelledAt = parseOrderingInstant(options.persistence.now());
        // Kitchen after the Ordering fence (foreign owner fences first): every item still unstarted.
        const kitchen = await createPostgresKitchenBatchCancellation({
          ...selected,
          authorize: owned,
        }).cancel(tx, {
          orderReference,
          orderBatchReference,
          operationReference,
          orderCancellationReference: cancellationReference,
          actorReference,
          cancelledAt,
          auditReference: options.nextReference(),
          eventReference: options.nextReference(),
          nextReference: options.nextReference,
        });
        if (kitchen.status === "AlreadyCancelled") return fail("ORDER_CANCELLATION_UNAVAILABLE");
        const created = await ordering.commit(tx, {
          plan,
          cancellationReference,
          operationReference,
          actorReference,
          reasonCode,
          kitchenEvidenceDigest: kitchen.evidenceDigest,
          auditReference: options.nextReference(),
          terminationAuditReference: options.nextReference(),
          cancelledAt,
        });
        const record = created.record;
        // Stock reserved at submission returns in the same transaction, or nothing is cancelled.
        // The ledger movement names the cancelling staff member; the release audit is System-owned.
        const releaser = createSubmissionInventoryRelease({
          scope: selected,
          systemActorReference: actorReference,
          reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
          now: options.persistence.now,
        });
        const request = {
          source: {
            kind: "StaffOrderCancellationInventory/v1",
            reference: String(record.cancellationReference),
            submissionReference: String(record.submissionReference),
            orderReference: String(record.orderReference),
            occurredAt: String(record.cancelledAt),
          },
          releasedAt: String(record.cancelledAt),
          authorize: allowed,
        };
        // WP-2423 Q6 step 2a: once lines of this Batch were cancelled (and their stock released),
        // the remaining lines are released line by line.
        const lines = await readStaffBatchLineSources(
          tx,
          selected,
          orderReference,
          orderBatchReference,
        );
        const inventory = lines.some((line) => line.itemCancelled)
          ? await releaser.releaseLines(tx, {
              ...request,
              cartLineReferences: lines
                .filter((line) => !line.itemCancelled)
                .map((line) => String(line.sourceCartLineReference)),
            })
          : await releaser.release(tx, request);
        if (inventory.status === "NotReleasable")
          return fail("ORDER_CANCELLATION_STOCK_NOT_RELEASABLE");
        return replied("Cancelled", record);
      });
    } catch (error) {
      if (error instanceof StaffOrderCancellationError) throw error;
      if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
        return fail("ORDER_CANCELLATION_PREPARATION_STARTED");
      // A concurrent kitchen start or order change: the staff member refreshes and decides again.
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("ORDER_CANCELLATION_VERSION_CONFLICT");
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
      return fail("ORDER_CANCELLATION_UNAVAILABLE");
    }
  };
}
