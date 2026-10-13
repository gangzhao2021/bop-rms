import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresAsapCapacityStore } from "@rms/fulfillment";
import { createPostgresSubmissionFinalValidationStore } from "@rms/inventory";
import {
  createPostgresOrderCreationQueryStore,
  parseOrderingReference,
  readOrderCreationQuoteVersion,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import { createPostgresPaymentTipSelectionStore } from "@rms/payment";
import { buildCustomerPaymentPreparationSnapshot } from "./customer-payment-preparation-snapshot.js";

/**
 * WP-2423 Q7: the Payment preparation of a counter pickup order, rebuilt from owner records alone
 * (Order, pickup capacity clock, tip choice, reserved stock) inside the caller's transaction. The
 * walk-up guest's session is never needed again after the order was sent; staff authority is the
 * caller's. Returns null while the order has no payment clock (it was not finished).
 */
export async function readCounterPaymentPreparation(
  transaction: ConsumerTransaction,
  options: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    now(): string;
    nextPreparationReference(): string;
    authorize(): Promise<boolean>;
  },
  input: {
    submissionReference: string;
    guestSessionReference: string;
    tipSelectionReference: string;
  },
): Promise<{
  readonly preparation: OrderPaymentPreparationEvidence;
  readonly orderNumber: string;
  readonly orderVersion: number;
  /** The payment operation the pickup capacity clock opened (the Payment correlation). */
  readonly paymentOperationReference: string;
} | null> {
  const scope = {
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  const owners = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const runner = {
    run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
  };
  if (!(await options.authorize())) return null;
  const quoteVersion =
    (await readOrderCreationQuoteVersion(transaction, owners, input.submissionReference)) ?? 2;
  const order = await createPostgresOrderCreationQueryStore(
    runner,
    owners,
    quoteVersion,
  ).withCurrentSubmission(input.submissionReference, async (_, record) => record);
  if (order === null) return null;
  const capacity = await createPostgresAsapCapacityStore(runner, owners, {
    now: options.now,
  }).withCurrentSubmission(input.submissionReference, async (_, commitment) => commitment);
  if (
    capacity === null ||
    capacity.state !== "PaymentPending" ||
    capacity.paymentOperationReference === null
  )
    return null;
  const selection = await createPostgresPaymentTipSelectionStore(runner, owners, {
    now: options.now,
  }).load(input.tipSelectionReference);
  if (selection === null) return null;
  const inventory = await createPostgresSubmissionFinalValidationStore(runner, scope, {
    authorize: async (_tx, value) =>
      value.submissionReference === input.submissionReference &&
      value.actorReference === input.guestSessionReference &&
      (await options.authorize()),
    resolveCurrent: async () => {
      throw new Error("READ_ONLY_INVENTORY_SOURCE");
    },
  }).load({
    submissionReference: input.submissionReference,
    actorReference: input.guestSessionReference,
  });
  if (inventory === null) return null;
  const preparation = buildCustomerPaymentPreparationSnapshot(
    { scope, owner: "AsapPickup", quoteVersion },
    {
      preparationReference: options.nextPreparationReference(),
      order,
      capacity,
      selection,
      inventory,
    },
  );
  return Object.freeze({
    preparation,
    orderNumber: String(order.orderNumberAllocation.orderNumber),
    orderVersion: order.order.aggregateVersion,
    paymentOperationReference: String(capacity.paymentOperationReference),
  });
}
