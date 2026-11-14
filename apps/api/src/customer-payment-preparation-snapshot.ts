import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import { parseAsapCapacityCommitment } from "@rms/fulfillment";
import { parseSubmissionInventoryFinalValidation } from "@rms/inventory";
import {
  parseOrderCreationRecord,
  parseAdditionalDiningBatchSnapshot,
  parseConfiguredOrderCreationRecord,
  parseOrderPaymentPreparationEvidence,
  parseOrderingReference,
} from "@rms/ordering";
import {
  derivePaymentPreparationAmounts,
  deriveAdditionalPaymentPreparationAmounts,
  deriveConfiguredPaymentPreparationAmounts,
  parsePaymentTipSelection,
} from "@rms/payment";

export class CustomerPaymentPreparationSnapshotError extends Error {
  readonly code = "CUSTOMER_PAYMENT_PREPARATION_UNAVAILABLE";
  constructor() {
    super("Payment preparation sources are unavailable");
  }
}

/**
 * Immutable source snapshot only. Current actor, capacity and Inventory eligibility must still
 * be checked by the admitted Payment store on its write transaction.
 */
export function buildCustomerPaymentPreparationSnapshot(
  options: Readonly<{
    scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
    owner: "Dining" | "AsapPickup";
    quoteVersion: 1 | 2;
    submissionKind?: "Additional";
  }>,
  value: unknown,
) {
  try {
    const raw = readClosedRecord(value, [
      "preparationReference",
      "order",
      "capacity",
      "selection",
      "inventory",
    ]);
    const preparationReference = parseOrderingReference(raw.preparationReference);
    const tenant = String(parseOrderingReference(options.scope.tenantReference));
    const brand = String(parseOrderingReference(options.scope.brandReference));
    const store = String(parseOrderingReference(options.scope.storeReference));
    if (options.quoteVersion !== 1 && options.quoteVersion !== 2) throw new Error();
    if (options.submissionKind !== undefined && options.submissionKind !== "Additional")
      throw new Error();
    if (options.submissionKind === "Additional" && options.owner !== "Dining") throw new Error();
    const order =
      options.submissionKind === "Additional"
        ? parseAdditionalDiningBatchSnapshot(raw.order)
        : options.quoteVersion === 2
          ? parseConfiguredOrderCreationRecord(raw.order)
          : parseOrderCreationRecord(raw.order);
    if ("batch" in order && order.snapshotVersion !== options.quoteVersion) throw new Error();
    const history =
      "batch" in order
        ? {
            batch: order.batch,
            brandReference: order.brandReference,
            storeReference: order.storeReference,
            orderReference: order.orderReference,
            orderType: "DineIn",
            guestSessionReference: order.guestSessionReference,
            submissionReference: order.batch.submissionReference,
          }
        : {
            batch: order.order.batches[0],
            brandReference: order.order.brandReference,
            storeReference: order.order.storeReference,
            orderReference: order.order.orderReference,
            orderType: order.order.orderType,
            guestSessionReference: order.guestSessionReference,
            submissionReference: order.submissionReference,
          };
    const selection = parsePaymentTipSelection(raw.selection);
    const inventory = parseSubmissionInventoryFinalValidation(raw.inventory);
    const capacity =
      options.owner === "Dining"
        ? parseDiningCheckoutCommitment(raw.capacity)
        : options.owner === "AsapPickup"
          ? parseAsapCapacityCommitment(raw.capacity)
          : null;
    const batch = history.batch;
    if (
      capacity === null ||
      batch === undefined ||
      capacity.state !== "PaymentPending" ||
      capacity.paymentRequestedAt === null ||
      capacity.capacityExpiresAt === null ||
      String(history.brandReference) !== brand ||
      String(history.storeReference) !== store ||
      history.orderType !== (options.owner === "Dining" ? "DineIn" : "Pickup") ||
      String(inventory.tenantReference) !== tenant ||
      String(inventory.brandReference) !== brand ||
      String(inventory.storeReference) !== store ||
      inventory.observedAt > String(capacity.paymentRequestedAt)
    )
      throw new Error();
    const binding = {
      guestSessionReference: history.guestSessionReference,
      submissionReference: history.submissionReference,
      cartReference: batch.sourceCartReference,
      cartVersion: batch.sourceCartVersion,
      quoteReference: batch.quoteReference,
      orderReference: history.orderReference,
      orderBatchReference: batch.orderBatchReference,
    };
    if (
      Object.entries(binding).some(([key, expected]) => Reflect.get(capacity, key) !== expected) ||
      String(inventory.orderReference) !== String(binding.orderReference) ||
      String(inventory.submissionReference) !== String(binding.submissionReference) ||
      String(inventory.actorReference) !== String(binding.guestSessionReference) ||
      String(inventory.cartReference) !== String(binding.cartReference) ||
      inventory.cartVersion !== binding.cartVersion ||
      String(inventory.quoteReference) !== String(binding.quoteReference)
    )
      throw new Error();
    const capacityScope = "slot" in capacity ? capacity.slot : capacity;
    if (
      String(capacityScope.brandReference) !== brand ||
      String(capacityScope.storeReference) !== store
    )
      throw new Error();
    const amountInput = {
      selection,
      paymentOperationReference: capacity.paymentOperationReference,
      requestedAt: capacity.paymentRequestedAt,
    };
    const amounts =
      options.submissionKind === "Additional"
        ? deriveAdditionalPaymentPreparationAmounts({ ...amountInput, submission: order })
        : (options.quoteVersion === 2
            ? deriveConfiguredPaymentPreparationAmounts
            : derivePaymentPreparationAmounts)({
            ...amountInput,
            order,
          });
    // Owner parsers above have detached/validated all data. Money is canonicalized as exact decimal strings.
    const sources: unknown = JSON.parse(
      JSON.stringify(
        {
          schemaVersion: 1,
          ...(options.submissionKind ? { submissionKind: options.submissionKind } : {}),
          owner: options.owner,
          quoteVersion: options.quoteVersion,
          order,
          capacity,
          selection,
          inventory,
        },
        (_key, field: unknown) => (typeof field === "bigint" ? field.toString() : field),
      ),
    );
    return parseOrderPaymentPreparationEvidence({
      preparationReference,
      orderReference: binding.orderReference,
      orderBatchReference: binding.orderBatchReference,
      submissionReference: binding.submissionReference,
      sourceCartReference: binding.cartReference,
      sourceCartVersion: binding.cartVersion,
      brandReference: brand,
      storeReference: store,
      guestSessionReference: binding.guestSessionReference,
      quoteReference: binding.quoteReference,
      capacityAllocationReference:
        "slot" in capacity ? capacity.allocationReference : capacity.commitmentReference,
      readiness: "PaymentPending",
      transactionBoundary: "OrderSubmissionPaymentPreparation",
      ...amounts,
      committedAt: capacity.paymentRequestedAt,
      capacityExpiresAt: capacity.capacityExpiresAt,
      sourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(sources)),
    });
  } catch {
    throw new CustomerPaymentPreparationSnapshotError();
  }
}
