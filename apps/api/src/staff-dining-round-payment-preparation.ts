import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import { createPostgresSubmissionFinalValidationStore } from "@rms/inventory";
import {
  createPostgresAdditionalDiningBatchHistoryReader,
  createPostgresOrderCreationQueryStore,
  parseOrderingReference,
  readOrderCreationQuoteVersion,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import { createPostgresPaymentTipSelectionStore } from "@rms/payment";
import { buildCustomerPaymentPreparationSnapshot } from "./customer-payment-preparation-snapshot.js";

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): the Payment preparation of a dine-in round staff
 * entered, rebuilt from owner records alone (the table Order's first round or the additional round,
 * the Dining payment clock, the tip choice and reserved stock) inside the caller's transaction, as
 * {@link readCounterPaymentPreparation} does for a counter pickup order. Returns null while the
 * round has no payment clock (it was not finished) or the clock is no longer pending.
 */
export async function readStaffDiningRoundPaymentPreparation(
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
  /** The payment operation the Dining clock opened (the Payment correlation). */
  readonly paymentOperationReference: string;
  readonly additional: boolean;
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
  const additional = await createPostgresAdditionalDiningBatchHistoryReader({
    ...owners,
    transactions: runner,
    authorize: async (_tx, value) =>
      value.submissionReference === input.submissionReference && (await options.authorize()),
  }).resolveSubmission(input.submissionReference);
  let order: unknown;
  let quoteVersion: 1 | 2;
  if (additional !== null) {
    if (String(additional.guestSessionReference) !== input.guestSessionReference) return null;
    order = additional;
    quoteVersion = additional.snapshotVersion === 1 ? 1 : 2;
  } else {
    const version =
      (await readOrderCreationQuoteVersion(transaction, owners, input.submissionReference)) ?? 2;
    quoteVersion = version === 1 ? 1 : 2;
    const created = await createPostgresOrderCreationQueryStore(
      runner,
      owners,
      quoteVersion,
    ).withCurrentSubmission(input.submissionReference, async (_, record) => record);
    if (created === null || created.order.orderType !== "DineIn") return null;
    order = created;
  }
  const clockValue = await createPostgresDiningCheckoutCommitmentStore(runner, scope, {
    now: options.now,
  }).loadSubmission(input.submissionReference);
  if (clockValue === null || clockValue === undefined) return null;
  const clock = parseDiningCheckoutCommitment(clockValue);
  if (
    clock.state !== "PaymentPending" ||
    String(clock.guestSessionReference) !== input.guestSessionReference
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
    {
      scope,
      owner: "Dining",
      quoteVersion,
      ...(additional === null ? {} : { submissionKind: "Additional" as const }),
    },
    {
      preparationReference: options.nextPreparationReference(),
      order,
      capacity: clock,
      selection,
      inventory,
    },
  );
  return Object.freeze({
    preparation,
    paymentOperationReference: String(clock.paymentOperationReference),
    additional: additional !== null,
  });
}
