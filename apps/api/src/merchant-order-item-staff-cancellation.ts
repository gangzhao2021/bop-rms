import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createPostgresFulfillmentItemCancellation } from "@rms/fulfillment";
import {
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
} from "@rms/kitchen";
import {
  createPostgresStaffItemCancellationReader,
  createPostgresStaffItemCancellationStore,
  createPostgresStaffOrderCancellationStore,
  parseOrderingInstant,
  parseOrderingReference,
  parseStaffItemCancellationSelection,
  staffOrderCancellationReasonCodes,
  type StaffItemCancellationRecord,
  type StaffOrderCancellationReasonCode,
} from "@rms/ordering";
import {
  createPostgresCancellationRefundFollowUp,
  createPostgresCancellationRefundRuntime,
  readCancellationRefundStatus,
  readPaymentRemainingRefundable,
  type CancellationRefundRuntimeOptions,
  type CancellationRefundStatus,
  createPostgresCardMachinePaymentStore,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
import {
  StaffOrderCancellationError,
  staffOrderCancellationPermission,
  type createMerchantOrderStaffCancellation,
} from "./merchant-order-staff-cancellation.js";

export const staffItemCancellationErrorCodes = [
  "ORDER_CANCELLATION_INPUT_INVALID",
  "ORDER_CANCELLATION_PERMISSION_DENIED",
  "ORDER_CANCELLATION_NOT_FOUND",
  "ORDER_CANCELLATION_VERSION_CONFLICT",
  "ORDER_CANCELLATION_PREPARATION_STARTED",
  "ORDER_CANCELLATION_NOT_CANCELLABLE",
  "ORDER_CANCELLATION_STOCK_NOT_RELEASABLE",
  /** The submission reserved stock submission-wide (schema 1): lines cannot be released alone. */
  "ORDER_ITEM_CANCELLATION_STOCK_LEGACY",
  /** WP-2423 Q7: the Batch was paid on the Store's card machine; cancel the whole order instead. */
  "ORDER_ITEM_CANCELLATION_CARD_MACHINE",
  "ORDER_CANCELLATION_UNAVAILABLE",
] as const;
export type StaffItemCancellationErrorCode = (typeof staffItemCancellationErrorCodes)[number];
export class StaffItemCancellationError extends Error {
  readonly code: StaffItemCancellationErrorCode;
  constructor(code: StaffItemCancellationErrorCode) {
    super("staff item cancellation is unavailable");
    this.name = "StaffItemCancellationError";
    this.code = code;
  }
}
const fail = (code: StaffItemCancellationErrorCode): never => {
  throw new StaffItemCancellationError(code);
};

/** WP-2423 Q7: items of a card-machine payment are not refunded line by line (slice 1). */
async function refuseCardMachineBatch(
  context: {
    tx: ConsumerTransaction;
    selected: { brandReference: string; storeReference: string };
    allowed(): Promise<boolean>;
  },
  orderReference: string,
  orderBatchReference: string,
) {
  const paid = await createPostgresCardMachinePaymentStore({
    scope: context.selected,
    authorize: async (_tx, value) =>
      value.orderReference === orderReference && (await context.allowed()),
  }).loadByBatch(context.tx, orderReference, orderBatchReference);
  if (paid !== null) return fail("ORDER_ITEM_CANCELLATION_CARD_MACHINE");
}

export interface StaffItemCancellationRefund {
  readonly status: CancellationRefundStatus;
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
  readonly includesTip: boolean;
}
export interface StaffItemCancellationResult {
  readonly status: "Cancelled" | "AlreadyCancelled";
  readonly scope: "Items" | "Batch";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly cancellationReference: string;
  readonly orderItemReferences: readonly string[];
  readonly cancelledAt: string;
  readonly refund: StaffItemCancellationRefund;
}
export interface StaffItemCancellationPreview {
  readonly scope: "Items" | "Batch";
  readonly refund: {
    readonly amountMinor: string;
    readonly currencyCode: "CAD";
    readonly includesTip: boolean;
    readonly netAmountMinor: string;
    readonly taxAmountMinor: string;
  };
}

function databaseCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
interface RefundConfiguration {
  providerAccountReference: string;
  environment: "Test" | "Live";
}
type Provider = Parameters<typeof createPostgresCancellationRefundFollowUp>[0]["provider"];

/**
 * Binds a Payment Cancellation refund claim to the Ordering item cancellation that caused it:
 * the record must exist in this Store, name this refund request, amount, actor and digest.
 * This is the claim's whole approval (decision 4: no independent approver).
 */
export function createItemCancellationRefundAuthority(
  scope: Pick<Scope, "brandReference" | "storeReference">,
): CancellationRefundRuntimeOptions["cancellationAuthority"] {
  const reader = createPostgresStaffItemCancellationReader(scope);
  return async (tx, query) => {
    const record = await reader.loadByCancellation(tx, query.cancellationReference);
    return (
      record !== null &&
      query.brandReference === record.brandReference &&
      query.storeReference === record.storeReference &&
      query.orderReference === record.orderReference &&
      query.requestReference === record.refundRequestReference &&
      query.cancellationDigest === record.sourceDigest &&
      query.actorReference === record.actorReference &&
      query.amountMinor === record.refundAmountMinor
    );
  };
}

/** Refund progress of one item cancellation from Payment's ordinary claim outcome. */
export async function readItemCancellationRefundStatus(
  transaction: ConsumerTransaction,
  scope: Scope & RefundConfiguration,
  record: Pick<StaffItemCancellationRecord, "orderReference" | "refundRequestReference">,
  authorize: () => Promise<boolean>,
): Promise<CancellationRefundStatus> {
  const result = await readCancellationRefundStatus(transaction, {
    scope,
    orderReference: String(record.orderReference),
    requestReference: String(record.refundRequestReference),
    authorize: async (tx) => tx === transaction && (await authorize()),
  });
  return result.status;
}

/**
 * WP-2423 Q6 step 2a (DEC-ORDER-CANCELLATION-PILOT, implementation decision 4): staff cancel whole
 * item lines of a paid, accepted Batch whose kitchen work has not started. One transaction:
 * permission and reason → Ordering fence (order version, Confirmed payment, lines of the Batch
 * not cancelled before) → Kitchen cancels the work of exactly those lines (not started, row locks)
 * → Ordering append-only item cancellation, revision and audit → Payment ordinary refund claim of
 * kind Cancellation for exactly those lines' net + tax (never the tip), approved by that record,
 * with its refund operation prepared → Fulfillment excludes the lines → Inventory releases those
 * lines' per-line reservations. After commit the refund is dispatched through the ordinary
 * dispatch journal (never submitted twice; an unknown result is only queried). Selecting every
 * remaining line ends the Batch through the whole staff cancellation (step 1), which refunds the
 * remaining payment including tip. A retry with the same operation reference replays.
 */
export function createMerchantOrderItemStaffCancellation(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(transaction: ConsumerTransaction, scope: Scope): Promise<void>;
  nextReference(): string;
  wholeCancellation: ReturnType<typeof createMerchantOrderStaffCancellation>;
  resolveRefundConfiguration(
    transaction: ConsumerTransaction,
    scope: Scope,
  ): Promise<RefundConfiguration>;
  businessDate: CancellationRefundRuntimeOptions["businessDate"];
  provider: Provider;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  const retention = { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 };

  function parse(command: unknown, withOperation: boolean) {
    try {
      const intent = readClosedRecord(command, [
        "orderReference",
        "orderBatchReference",
        "orderItemReferences",
        "expectedOrderVersion",
        ...(withOperation ? ["operationReference", "reasonCode"] : []),
      ]);
      const expectedOrderVersion = intent.expectedOrderVersion;
      if (
        typeof expectedOrderVersion !== "number" ||
        !Number.isSafeInteger(expectedOrderVersion) ||
        expectedOrderVersion < 1 ||
        expectedOrderVersion > 2147483646 ||
        (withOperation &&
          (typeof intent.reasonCode !== "string" ||
            !(staffOrderCancellationReasonCodes as readonly string[]).includes(intent.reasonCode)))
      )
        return fail("ORDER_CANCELLATION_INPUT_INVALID");
      return {
        orderReference: String(parseOrderingReference(intent.orderReference)),
        orderBatchReference: String(parseOrderingReference(intent.orderBatchReference)),
        orderItemReferences: parseStaffItemCancellationSelection(intent.orderItemReferences).map(
          String,
        ),
        expectedOrderVersion,
        operationReference: withOperation
          ? String(parseOrderingReference(intent.operationReference))
          : null,
        reasonCode: (withOperation
          ? intent.reasonCode
          : "CUSTOMER_REQUEST") as StaffOrderCancellationReasonCode,
      };
    } catch (error) {
      if (error instanceof StaffItemCancellationError) throw error;
      return fail("ORDER_CANCELLATION_INPUT_INVALID");
    }
  }

  /** Runs one authorized Store-scoped transaction for the staff member's command. */
  async function scoped<T>(
    input: { sessionCookie: unknown; csrf: unknown },
    sessionReference: string,
    work: (context: {
      tx: ConsumerTransaction;
      selected: Scope;
      refund: Scope & RefundConfiguration;
      actorReference: string;
      allowed: () => Promise<boolean>;
    }) => Promise<T>,
  ): Promise<T> {
    try {
      return await options.persistence.transactions.run(async (transaction) => {
        const scope = await resolveScope(
          transaction,
          input.sessionCookie,
          staffOrderCancellationPermission,
          sessionReference,
        ).catch(() => fail("ORDER_CANCELLATION_PERMISSION_DENIED"));
        const allowed = async () => (await scope.allowed()) === true;
        if (!(await allowed())) return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
        const tx = transaction as unknown as ConsumerTransaction;
        const selected = {
          tenantReference: String(scope.selected.tenantReference),
          brandReference: String(scope.context.brand.brandReference),
          storeReference: String(scope.store.storeReference),
        };
        await options.installContext(tx, selected);
        const configuration = await options.resolveRefundConfiguration(tx, selected);
        const result = await work({
          tx,
          selected,
          refund: {
            ...selected,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
          },
          actorReference: String(scope.actorReference),
          allowed,
        });
        if (!(await allowed())) return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
        return result;
      });
    } catch (error) {
      if (error instanceof StaffItemCancellationError) throw error;
      if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
        return fail("ORDER_CANCELLATION_PREPARATION_STARTED");
      // A line already (partly) refunded is refunded through the ordinary refund instead.
      if (error instanceof Error && error.message === "CANCELLATION_REFUND_LINE_ALREADY_REFUNDED")
        return fail("ORDER_CANCELLATION_NOT_CANCELLABLE");
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("ORDER_CANCELLATION_VERSION_CONFLICT");
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("ORDER_CANCELLATION_PERMISSION_DENIED");
      return fail("ORDER_CANCELLATION_UNAVAILABLE");
    }
  }

  function refundRuntime(context: {
    tx: ConsumerTransaction;
    selected: Scope;
    refund: Scope & RefundConfiguration;
    allowed: () => Promise<boolean>;
  }) {
    return createPostgresCancellationRefundRuntime({
      scope: context.refund,
      authorize: async (t, query) =>
        t === context.tx &&
        query.tenantReference === context.selected.tenantReference &&
        query.brandReference === context.selected.brandReference &&
        query.storeReference === context.selected.storeReference &&
        (await context.allowed()),
      cancellationAuthority: createItemCancellationRefundAuthority(context.selected),
      businessDate: options.businessDate,
      now: options.persistence.now,
      ...retention,
    });
  }

  /** The remaining payment the whole cancellation refunds (incl. tip), for a Batch-scope answer. */
  async function remaining(
    context: Parameters<typeof refundRuntime>[0],
    payment: {
      orderReference: string;
      paymentTransactionReference: string;
      paymentIntentReference: string;
      paymentAttemptReference: string;
    },
  ) {
    return readPaymentRemainingRefundable(context.tx, {
      scope: context.refund,
      ...payment,
      observedAt: parseOrderingInstant(options.persistence.now()),
      authorize: async (t) => t === context.tx && (await context.allowed()),
    });
  }

  /** After commit: dispatch (or, when already sent, query) the item refund; never resend. */
  async function drive(
    refundScope: Scope & RefundConfiguration,
    record: StaffItemCancellationRecord,
  ) {
    const transactions = {
      run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) =>
        options.persistence.transactions.run(async (transaction) => {
          const tx = transaction as unknown as ConsumerTransaction;
          await options.installContext(tx, refundScope);
          return work(tx);
        }),
    };
    const followUp = createPostgresCancellationRefundFollowUp({
      scope: refundScope,
      // System follow-up of an already authorized cancellation: bound to its Ordering record.
      authorize: async (_tx, query) =>
        query.tenantReference === refundScope.tenantReference &&
        query.brandReference === refundScope.brandReference &&
        query.storeReference === refundScope.storeReference &&
        (query.orderReference === undefined || query.orderReference === record.orderReference),
      cancellationAuthority: createItemCancellationRefundAuthority(refundScope),
      businessDate: options.businessDate,
      now: options.persistence.now,
      ...retention,
      transactions,
      provider: options.provider,
      generateObservationIdentity: () => ({
        observationReference: options.nextReference(),
        auditReference: options.nextReference(),
      }),
      dispatchIdentity: () => ({
        dispatchReference: options.nextReference(),
        auditReference: options.nextReference(),
      }),
    });
    return followUp.drive({
      orderReference: String(record.orderReference),
      requestReference: String(record.refundRequestReference),
      operationReference: String(record.refundOperationReference),
    });
  }

  const itemsResult = (
    status: "Cancelled" | "AlreadyCancelled",
    record: StaffItemCancellationRecord,
    refundStatus: CancellationRefundStatus,
  ): StaffItemCancellationResult =>
    Object.freeze({
      status,
      scope: "Items" as const,
      orderReference: String(record.orderReference),
      orderBatchReference: String(record.orderBatchReference),
      cancellationReference: String(record.cancellationReference),
      orderItemReferences: Object.freeze(record.orderItemReferences.map(String)),
      cancelledAt: String(record.cancelledAt),
      refund: Object.freeze({
        status: refundStatus,
        amountMinor: record.refundAmountMinor.toString(),
        currencyCode: "CAD" as const,
        includesTip: false,
      }),
    });

  return Object.freeze({
    async preview(input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
    }): Promise<StaffItemCancellationPreview> {
      const session = await options.authentication.authorize(input);
      const intent = parse(input.command, false);
      return scoped(input, session.sessionReference, async (context) => {
        await refuseCardMachineBatch(
          context,
          String(intent.orderReference),
          String(intent.orderBatchReference),
        );
        const store = createPostgresStaffItemCancellationStore({
          brandReference: context.selected.brandReference,
          storeReference: context.selected.storeReference,
          authorize: async (t, identity) =>
            t === context.tx &&
            identity.orderReference === intent.orderReference &&
            identity.orderBatchReference === intent.orderBatchReference &&
            identity.actorReference === context.actorReference &&
            (await context.allowed()),
        });
        const prepared = await store.prepare(context.tx, {
          ...intent,
          actorReference: context.actorReference,
        });
        if (prepared.status === "NotEligible")
          return fail(
            prepared.reason === "NotFound" || prepared.reason === "ItemNotInBatch"
              ? "ORDER_CANCELLATION_NOT_FOUND"
              : prepared.reason === "VersionConflict"
                ? "ORDER_CANCELLATION_VERSION_CONFLICT"
                : "ORDER_CANCELLATION_NOT_CANCELLABLE",
          );
        const plan = prepared.plan;
        if (plan.remainingOrderItemReferences.length === 0) {
          const position = await remaining(context, {
            orderReference: intent.orderReference,
            paymentTransactionReference: String(plan.payment.paymentTransactionReference),
            paymentIntentReference: String(plan.payment.paymentIntentReference),
            paymentAttemptReference: String(plan.payment.paymentAttemptReference),
          });
          return Object.freeze({
            scope: "Batch" as const,
            refund: Object.freeze({
              amountMinor: position.remainingMinor.toString(),
              currencyCode: "CAD" as const,
              includesTip: position.tipMinor > 0n,
              netAmountMinor: "0",
              taxAmountMinor: "0",
            }),
          });
        }
        const preview = await refundRuntime(context).preview(context.tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences: plan.lines.map((line) => String(line.orderItemReference)),
          actorReference: context.actorReference,
          reasonCode: "CUSTOMER_REQUEST",
        });
        return Object.freeze({
          scope: "Items" as const,
          refund: Object.freeze({
            amountMinor: preview.amountMinor.toString(),
            currencyCode: "CAD" as const,
            includesTip: false,
            netAmountMinor: (
              preview.components.netAmountMinor + preview.components.serviceChargeAmountMinor
            ).toString(),
            taxAmountMinor: (
              preview.components.taxAmountMinor + preview.components.serviceChargeTaxAmountMinor
            ).toString(),
          }),
        });
      });
    },

    async cancel(input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
    }): Promise<StaffItemCancellationResult> {
      const session = await options.authentication.authorize(input);
      const intent = parse(input.command, true);
      const operationReference = intent.operationReference as string;
      const outcome = await scoped(input, session.sessionReference, async (context) => {
        await refuseCardMachineBatch(
          context,
          String(intent.orderReference),
          String(intent.orderBatchReference),
        );
        const { tx, selected, actorReference, allowed } = context;
        const owned = async (
          t: ConsumerTransaction,
          identity: { orderReference: string; orderBatchReference: string; actorReference: string },
        ) =>
          t === tx &&
          identity.orderReference === intent.orderReference &&
          identity.orderBatchReference === intent.orderBatchReference &&
          identity.actorReference === actorReference &&
          (await allowed());
        const ordering = createPostgresStaffItemCancellationStore({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          authorize: owned,
        });
        // Replay of the same staff command: the original outcome, nothing written.
        const prior = await ordering.loadByOperation(tx, operationReference);
        if (prior !== null) {
          if (
            String(prior.orderReference) !== intent.orderReference ||
            String(prior.orderBatchReference) !== intent.orderBatchReference ||
            prior.reasonCode !== intent.reasonCode ||
            String(prior.actorReference) !== actorReference ||
            prior.expectedOrderVersion !== intent.expectedOrderVersion ||
            prior.orderItemReferences.join(",") !== intent.orderItemReferences.join(",")
          )
            return fail("ORDER_CANCELLATION_NOT_CANCELLABLE");
          return { kind: "Replay" as const, record: prior, refund: context.refund };
        }
        // A replay of a command that ended the whole Batch goes through the whole cancellation.
        const whole = await createPostgresStaffOrderCancellationStore({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          authorize: owned,
        }).loadByOperation(tx, operationReference);
        if (whole !== null) return { kind: "Whole" as const };
        const prepared = await ordering.prepare(tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences: intent.orderItemReferences,
          expectedOrderVersion: intent.expectedOrderVersion,
          actorReference,
        });
        if (prepared.status === "NotEligible")
          return fail(
            prepared.reason === "NotFound" || prepared.reason === "ItemNotInBatch"
              ? "ORDER_CANCELLATION_NOT_FOUND"
              : prepared.reason === "VersionConflict"
                ? "ORDER_CANCELLATION_VERSION_CONFLICT"
                : "ORDER_CANCELLATION_NOT_CANCELLABLE",
          );
        const plan = prepared.plan;
        // The last remaining lines: the whole Batch (pickup: the Order) is cancelled instead.
        if (plan.remainingOrderItemReferences.length === 0) return { kind: "Whole" as const };
        const cancellationReference = String(parseOrderingReference(options.nextReference()));
        const cancelledAt = parseOrderingInstant(options.persistence.now());
        const orderItemReferences = plan.lines.map((line) => String(line.orderItemReference));
        // Kitchen after the Ordering fence: the work of exactly these lines, still unstarted.
        const kitchen = await createPostgresKitchenBatchCancellation({
          ...selected,
          authorize: owned,
        }).cancelItems(tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences,
          operationReference,
          orderCancellationReference: cancellationReference,
          actorReference,
          cancelledAt,
          auditReference: options.nextReference(),
          eventReference: options.nextReference(),
          nextReference: options.nextReference,
        });
        const refunds = refundRuntime(context);
        const preview = await refunds.preview(tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences,
          actorReference,
          reasonCode: intent.reasonCode,
        });
        const refundRequestReference = String(parseOrderingReference(options.nextReference()));
        const refundOperationReference = String(parseOrderingReference(options.nextReference()));
        const { record } = await ordering.commit(tx, {
          plan,
          cancellationReference,
          operationReference,
          actorReference,
          reasonCode: intent.reasonCode,
          kitchenEvidenceDigest: kitchen.evidenceDigest,
          refundRequestReference,
          refundOperationReference,
          refundAmountMinor: preview.amountMinor,
          auditReference: options.nextReference(),
          cancelledAt,
        });
        // The refund claim for exactly these lines, approved by the record just written.
        const claim = await refunds.record(tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences,
          actorReference,
          reasonCode: intent.reasonCode,
          requestReference: refundRequestReference,
          requestOperationReference: operationReference,
          refundOperationReference,
          requestAuditReference: options.nextReference(),
          operationAuditReference: options.nextReference(),
          cancellationReference,
          cancellationDigest: String(record.sourceDigest),
        });
        if (claim.status !== "Created" || claim.amountMinor !== record.refundAmountMinor)
          return fail("ORDER_CANCELLATION_UNAVAILABLE");
        // A pickup's remaining lines may now all be ready for collection.
        await createPostgresFulfillmentItemCancellation({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          authorize: owned,
        }).cancelItems(tx, {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          orderItemReferences,
          orderCancellationReference: cancellationReference,
          operationReference: options.nextReference(),
          auditReference: options.nextReference(),
          actorReference,
          cancelledAt,
          nextReference: options.nextReference,
        });
        // Stock reserved for these lines returns in the same transaction, or nothing is cancelled.
        const inventory = await createSubmissionInventoryRelease({
          scope: selected,
          systemActorReference: actorReference,
          reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
          now: options.persistence.now,
        }).releaseLines(tx, {
          source: {
            kind: "StaffItemCancellationInventory/v1",
            reference: cancellationReference,
            submissionReference: String(record.submissionReference),
            orderReference: String(record.orderReference),
            occurredAt: String(record.cancelledAt),
          },
          releasedAt: String(record.cancelledAt),
          authorize: allowed,
          cartLineReferences: plan.lines.map((line) => String(line.sourceCartLineReference)),
        });
        if (inventory.status === "NotReleasable")
          return fail(
            inventory.reason === "LegacyReservation"
              ? "ORDER_ITEM_CANCELLATION_STOCK_LEGACY"
              : "ORDER_CANCELLATION_STOCK_NOT_RELEASABLE",
          );
        return { kind: "Created" as const, record, refund: context.refund };
      });
      if (outcome.kind === "Whole") return cancelWhole(input, intent);
      // Dispatch after commit; the refund stays Pending (and can be followed up) on any failure.
      let refundStatus: CancellationRefundStatus;
      try {
        refundStatus = (await drive(outcome.refund, outcome.record)).status;
      } catch {
        refundStatus = "Pending";
      }
      return itemsResult(
        outcome.kind === "Created" ? "Cancelled" : "AlreadyCancelled",
        outcome.record,
        refundStatus,
      );
    },

    /** "Check refund": dispatches a refund not yet sent, otherwise queries the Provider. */
    async refund(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
      const session = await options.authentication.authorize(input);
      let orderReference: string, cancellationReference: string;
      try {
        const intent = readClosedRecord(input.command, ["orderReference", "cancellationReference"]);
        orderReference = String(parseOrderingReference(intent.orderReference));
        cancellationReference = String(parseOrderingReference(intent.cancellationReference));
      } catch {
        return fail("ORDER_CANCELLATION_INPUT_INVALID");
      }
      const found = await scoped(input, session.sessionReference, async (context) => {
        const record = await createPostgresStaffItemCancellationReader(
          context.selected,
        ).loadByCancellation(context.tx, cancellationReference);
        if (record === null || String(record.orderReference) !== orderReference)
          return fail("ORDER_CANCELLATION_NOT_FOUND");
        return { record, refund: context.refund };
      });
      let status: CancellationRefundStatus;
      try {
        status = (await drive(found.refund, found.record)).status;
      } catch {
        status = await scoped(input, session.sessionReference, (context) =>
          readItemCancellationRefundStatus(
            context.tx,
            context.refund,
            found.record,
            context.allowed,
          ),
        );
      }
      return Object.freeze({
        refund: Object.freeze({
          status,
          amountMinor: found.record.refundAmountMinor.toString(),
          currencyCode: "CAD" as const,
        }),
      });
    },
  });

  /** The selection is every remaining line: step 1's whole Batch (pickup: Order) cancellation. */
  async function cancelWhole(
    input: { sessionCookie: unknown; csrf: unknown },
    intent: ReturnType<typeof parse>,
  ): Promise<StaffItemCancellationResult> {
    let result: Awaited<ReturnType<typeof options.wholeCancellation>>;
    try {
      result = await options.wholeCancellation({
        ...input,
        command: {
          orderReference: intent.orderReference,
          orderBatchReference: intent.orderBatchReference,
          expectedOrderVersion: intent.expectedOrderVersion,
          operationReference: intent.operationReference,
          reasonCode: intent.reasonCode,
        },
      });
    } catch (error) {
      if (error instanceof StaffOrderCancellationError) return fail(error.code);
      return fail("ORDER_CANCELLATION_UNAVAILABLE");
    }
    const session = await options.authentication.authorize(input);
    // The amount the compensation refunds: the remaining payment, including tip.
    const whole = await scoped(input, session.sessionReference, async (context) => {
      const record =
        (await createPostgresStaffOrderCancellationStore({
          brandReference: context.selected.brandReference,
          storeReference: context.selected.storeReference,
          authorize: async (t) => t === context.tx && (await context.allowed()),
        }).loadByOperation(context.tx, intent.operationReference as string)) ??
        fail("ORDER_CANCELLATION_UNAVAILABLE");
      const position = await remaining(context, {
        orderReference: intent.orderReference,
        paymentTransactionReference: String(record.paymentTransactionReference),
        paymentIntentReference: String(record.paymentIntentReference),
        paymentAttemptReference: String(record.paymentAttemptReference),
      });
      return { record, position };
    });
    return Object.freeze({
      status: result.status,
      scope: "Batch" as const,
      orderReference: result.orderReference,
      orderBatchReference: result.orderBatchReference,
      cancellationReference: String(whole.record.cancellationReference),
      orderItemReferences: Object.freeze([...intent.orderItemReferences]),
      cancelledAt: result.cancelledAt,
      refund: Object.freeze({
        status: result.refundStatus,
        // Before the compensation case opens, the remaining payment; afterwards, its refund.
        amountMinor: (whole.position.compensationMinor > 0n
          ? whole.position.compensationMinor
          : whole.position.remainingMinor
        ).toString(),
        currencyCode: "CAD" as const,
        includesTip: whole.position.tipMinor > 0n,
      }),
    });
  }
}
