import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createPostgresFulfillmentItemCancellation } from "@rms/fulfillment";
import {
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
} from "@rms/kitchen";
import {
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresPayLaterItemCancellationStore,
  listOrderItemPrices,
  listOrderPriceReductions,
  listOrderBillOrders,
  listOrderMergedInto,
  parseOrderingInstant,
  parseOrderingReference,
  parseStaffItemCancellationSelection,
  staffOrderCancellationReasonCodes,
  type StaffOrderCancellationReasonCode,
} from "@rms/ordering";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";
import { fenceTableBill } from "./dining-waiting-rounds.js";
import { billOwedMinor } from "./merchant-order-bill-owed.js";
import {
  refreshBillTaxRounding,
  splitAgainAfterBillChange,
} from "./merchant-dining-table-checkout.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (rule 2): staff take dishes — or a whole round — off the bill of a
 * table that pays at the end, before it pays, with who and why. One transaction, as a paid item
 * cancellation without the refund: Ordering's fence and eligibility → the kitchen cancels the work
 * of exactly those lines (still unstarted) → Ordering's append-only cancellation on the
 * 'PayLater' basis (revision, audit) → fulfillment leaves them out → their reserved stock returns.
 * Refused once the table has paid (a paid table's dishes are refunded instead), and for a dish a
 * manager comped or discounted (DEC-KITCHEN-ONE-TAP: Start is optional, so a comped dish may still
 * read not started; its comp must never be left on a dish the table no longer has).
 */
export type UnpaidItemRemovalErrorCode =
  | "UNPAID_ITEM_REMOVAL_INPUT_INVALID"
  | "UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"
  | "UNPAID_ITEM_REMOVAL_NOT_FOUND"
  | "UNPAID_ITEM_REMOVAL_NOT_PAY_LATER"
  | "UNPAID_ITEM_REMOVAL_ALREADY_PAID"
  | "UNPAID_ITEM_REMOVAL_VERSION_CONFLICT"
  | "UNPAID_ITEM_REMOVAL_NOT_REMOVABLE"
  | "UNPAID_ITEM_REMOVAL_PREPARATION_STARTED"
  | "UNPAID_ITEM_REMOVAL_COMPED"
  | "UNPAID_ITEM_REMOVAL_UNAVAILABLE";
export class UnpaidItemRemovalError extends Error {
  constructor(readonly code: UnpaidItemRemovalErrorCode) {
    super(code);
    this.name = "UnpaidItemRemovalError";
  }
}
const fail = (code: UnpaidItemRemovalErrorCode): never => {
  throw new UnpaidItemRemovalError(code);
};
const databaseCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const sha256 = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

/** The browser's intent: the round's dishes, the Order version it saw and a reason. */
export function parseUnpaidItemRemovalCommand(value: unknown) {
  return parseUnpaidItemRemoval(value, "Command") as UnpaidItemRemovalIntent & {
    readonly operationReference: string;
    readonly reasonCode: StaffOrderCancellationReasonCode;
  };
}

/** v15 b20: what taking these dishes off would take off the bill (no reason or reference). */
export function parseUnpaidItemRemovalPreview(value: unknown): UnpaidItemRemovalIntent {
  return parseUnpaidItemRemoval(value, "Preview");
}

interface UnpaidItemRemovalIntent {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReferences: readonly string[];
  readonly expectedOrderVersion: number;
  readonly operationReference: string | null;
  readonly reasonCode: StaffOrderCancellationReasonCode | null;
}

function parseUnpaidItemRemoval(
  value: unknown,
  mode: "Command" | "Preview",
): UnpaidItemRemovalIntent {
  try {
    const raw = readClosedRecord(value, [
      "orderReference",
      "orderBatchReference",
      "orderItemReferences",
      "expectedOrderVersion",
      ...(mode === "Command" ? ["operationReference", "reasonCode"] : []),
    ]);
    if (
      typeof raw.expectedOrderVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedOrderVersion) ||
      raw.expectedOrderVersion < 2 ||
      (mode === "Command" &&
        (typeof raw.reasonCode !== "string" ||
          !(staffOrderCancellationReasonCodes as readonly string[]).includes(raw.reasonCode)))
    )
      throw new Error();
    return Object.freeze({
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
      orderItemReferences: parseStaffItemCancellationSelection(raw.orderItemReferences).map(String),
      expectedOrderVersion: raw.expectedOrderVersion,
      operationReference:
        mode === "Command" ? String(parseOrderingReference(raw.operationReference)) : null,
      reasonCode: mode === "Command" ? (raw.reasonCode as StaffOrderCancellationReasonCode) : null,
    });
  } catch {
    return fail("UNPAID_ITEM_REMOVAL_INPUT_INVALID");
  }
}

/**
 * v15 b20 (DEC-TAX-WHOLE-RECEIPT): what the bill holding this Order goes down by when these
 * dishes come off it: the bill as it stands (earlier dishes taken off left out, comps kept) less
 * the bill without them, its tax worked out once over the whole bill (a merged table's too). The
 * same sum the Order's detail reads afterwards as "Taken off the bill", so the button and the
 * bill agree to the cent; their own prices added up can be a cent more. A read.
 */
async function billRemovalMinor(
  tx: ConsumerTransaction,
  owner: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
  lines: ReadonlySet<string>,
  authorize: () => Promise<boolean>,
): Promise<bigint> {
  const holder =
    (await listOrderMergedInto(tx, owner, [orderReference])).get(orderReference) ?? orderReference;
  const billOrders = await listOrderBillOrders(tx, owner, holder);
  const rounds = await createPostgresOrderPayLaterConfirmationStore({
    ...owner,
    quoteVersion: 2,
    sha256,
    authorize,
  }).listByOrders({ transaction: tx, orderReferences: billOrders });
  const sent = new Set(rounds.map((round) => String(round.orderBatchReference)));
  const takenOff = new Set(
    (
      await createPostgresPayLaterItemCancellationStore({
        ...owner,
        authorize: async (_tx, value) =>
          billOrders.includes(String(value.orderReference)) && (await authorize()),
      }).listByOrders(tx, billOrders)
    ).flatMap((record) => record.orderItemReferences.map(String)),
  );
  const prices = [];
  // One query at a time on the transaction.
  for (const billOrder of billOrders)
    prices.push(
      ...(await listOrderItemPrices(tx, owner, billOrder)).filter(
        (price) =>
          sent.has(String(price.orderBatchReference)) &&
          !takenOff.has(String(price.orderItemReference)),
      ),
    );
  const reduced = new Map(
    (await listOrderPriceReductions(tx, owner, billOrders)).map(
      (record) => [record.orderItemReference, record] as const,
    ),
  );
  if (!(await authorize())) return fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED");
  const billRounds = rounds.map((round) => ({
    orderReference: String(round.orderReference),
    orderBatchReference: String(round.orderBatchReference),
  }));
  return (
    billOwedMinor(holder, billRounds, prices, reduced) -
    billOwedMinor(
      holder,
      billRounds,
      prices.filter((price) => !lines.has(String(price.orderItemReference))),
      reduced,
    )
  );
}

interface UnpaidItemRemovalOptions {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}

/**
 * v15 b20 (DEC-TAX-WHOLE-RECEIPT): what taking the chosen dishes off the bill would take off it —
 * the amount the button names — with the command's permission and checks (paid, a guest paying,
 * the dishes and version, a comp on them). Nothing is recorded and no staff PIN is asked (the PIN
 * confirms the command).
 */
export function createMerchantDiningUnpaidItemRemovalPreview(options: UnpaidItemRemovalOptions) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ readonly status: "Preview"; readonly totalMinor: string }> => {
    const session = await options.authentication.authorize(input);
    const intent = parseUnpaidItemRemovalPreview(input.command);
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = authority.scope;
            const guard = () => authority.guard();
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const owner = {
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            };
            await options.installContext(tx, selected);
            const payments = createPostgresDiningTableSettlementStore({
              scope: selected,
              authorize: async (_t, value) =>
                value.orderReference === intent.orderReference && (await guard()) === true,
            });
            if ((await payments.listByOrders(tx, [intent.orderReference])).length > 0)
              return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            if (
              (await payments.listOnlinePaymentsByOrders(tx, [intent.orderReference])).some(
                (attempt) => attempt.outcome === null,
              )
            )
              return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            const prepared = await createPostgresPayLaterItemCancellationStore({
              ...owner,
              authorize: async (t, value) =>
                t === tx && value.orderReference === intent.orderReference && (await guard()),
            }).prepare(tx, intent);
            if (prepared.status === "NotEligible") return fail(notEligibleCode(prepared.reason));
            const removing = new Set(prepared.plan.lines.map((line) => line.orderItemReference));
            if (
              (await listOrderPriceReductions(tx, owner, [intent.orderReference])).some(
                (reduction) => removing.has(String(reduction.orderItemReference)),
              )
            )
              return fail("UNPAID_ITEM_REMOVAL_COMPED");
            const totalMinor = await billRemovalMinor(
              tx,
              owner,
              intent.orderReference,
              removing,
              async () => (await guard()) === true,
            );
            if (!(await guard())) return fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED");
            if (totalMinor < 0n) return fail("UNPAID_ITEM_REMOVAL_UNAVAILABLE");
            return Object.freeze({ status: "Preview" as const, totalMinor: totalMinor.toString() });
          },
        ),
      );
    } catch (error) {
      if (error instanceof UnpaidItemRemovalError) throw error;
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("UNPAID_ITEM_REMOVAL_VERSION_CONFLICT");
      return keepingCause(() => fail("UNPAID_ITEM_REMOVAL_UNAVAILABLE"))(error);
    }
  };
}

const notEligibleCode = (reason: string): UnpaidItemRemovalErrorCode =>
  reason === "NotFound" || reason === "ItemNotInBatch"
    ? "UNPAID_ITEM_REMOVAL_NOT_FOUND"
    : reason === "NotPayLater"
      ? "UNPAID_ITEM_REMOVAL_NOT_PAY_LATER"
      : reason === "VersionConflict"
        ? "UNPAID_ITEM_REMOVAL_VERSION_CONFLICT"
        : "UNPAID_ITEM_REMOVAL_NOT_REMOVABLE";

export function createMerchantDiningUnpaidItemRemoval(options: UnpaidItemRemovalOptions) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const intent = parseUnpaidItemRemovalCommand(input.command);
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = authority.scope;
            const guard = () => authority.guard();
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            await options.installContext(tx, selected);
            const ordering = createPostgresPayLaterItemCancellationStore({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: async (t, value) =>
                t === tx && value.orderReference === intent.orderReference && (await guard()),
            });
            const result = (
              record: Awaited<ReturnType<typeof ordering.loadByOperation>> & object,
              status: "Removed" | "AlreadyRemoved",
            ) =>
              Object.freeze({
                status,
                orderReference: record.orderReference,
                orderBatchReference: record.orderBatchReference,
                orderItemReferences: record.orderItemReferences,
                cancelledOrderVersion: record.cancelledOrderVersion,
              });
            const prior = await ordering.loadByOperation(tx, intent.operationReference);
            if (prior !== null) {
              if (
                prior.orderReference !== intent.orderReference ||
                prior.orderBatchReference !== intent.orderBatchReference ||
                prior.orderItemReferences.join(",") !== intent.orderItemReferences.join(",") ||
                prior.reasonCode !== intent.reasonCode ||
                prior.actorReference !== actorReference
              )
                return fail("UNPAID_ITEM_REMOVAL_NOT_REMOVABLE");
              return result(prior, "AlreadyRemoved");
            }
            // Once the table paid, its dishes are refunded instead (never taken off a paid bill).
            const payments = createPostgresDiningTableSettlementStore({
              scope: selected,
              authorize: async (_t, value) =>
                value.orderReference === intent.orderReference && (await guard()) === true,
            });
            const paid = await payments.listByOrders(tx, [intent.orderReference]);
            if (paid.length > 0) return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            // S4: while a guest pays the whole table on their phone, the bill can't change.
            if (
              (await payments.listOnlinePaymentsByOrders(tx, [intent.orderReference])).some(
                (attempt) => attempt.outcome === null,
              )
            )
              return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            // v15 b11: the whole bill's fences, the Order holding the bill first (the order the
            // payment commands take): the bill's tax rounding is recorded again below.
            const owner = {
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            };
            const holder =
              (await listOrderMergedInto(tx, owner, [intent.orderReference])).get(
                intent.orderReference,
              ) ?? intent.orderReference;
            await fenceTableBill(tx, owner, await listOrderBillOrders(tx, owner, holder));
            const prepared = await ordering.prepare(tx, intent);
            if (prepared.status === "NotEligible") return fail(notEligibleCode(prepared.reason));
            const plan = prepared.plan;
            // A comped or discounted dish stays on the bill (the fence is held, so a comp either
            // committed before this read or waits): its reduction would otherwise stay on a dish the
            // table no longer has and the bill could not be taken. The table is refunded after it
            // pays instead, which is recorded.
            const removing = new Set(plan.lines.map((line) => line.orderItemReference));
            if (
              (
                await listOrderPriceReductions(
                  tx,
                  {
                    brandReference: selected.brandReference,
                    storeReference: selected.storeReference,
                  },
                  [intent.orderReference],
                )
              ).some((reduction) => removing.has(String(reduction.orderItemReference)))
            )
              return fail("UNPAID_ITEM_REMOVAL_COMPED");
            const cancellationReference = String(parseOrderingReference(options.nextReference()));
            const cancelledAt = String(parseOrderingInstant(options.persistence.now()));
            const owned = async (
              t: ConsumerTransaction,
              identity: { orderReference: string; orderBatchReference: string },
            ) =>
              t === tx &&
              identity.orderReference === intent.orderReference &&
              identity.orderBatchReference === intent.orderBatchReference &&
              (await guard());
            const lines = plan.lines.map((line) => line.orderItemReference);
            const kitchen = await createPostgresKitchenBatchCancellation({
              ...selected,
              authorize: owned,
            }).cancelItems(tx, {
              orderReference: intent.orderReference,
              orderBatchReference: intent.orderBatchReference,
              orderItemReferences: lines,
              operationReference: intent.operationReference,
              orderCancellationReference: cancellationReference,
              actorReference,
              cancelledAt,
              auditReference: options.nextReference(),
              eventReference: options.nextReference(),
              nextReference: options.nextReference,
            });
            const { record } = await ordering.commit(tx, {
              plan,
              cancellationReference,
              operationReference: intent.operationReference,
              actorReference,
              reasonCode: intent.reasonCode,
              kitchenEvidenceDigest: kitchen.evidenceDigest,
              auditReference: options.nextReference(),
              cancelledAt,
            });
            await createPostgresFulfillmentItemCancellation({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: owned,
            }).cancelItems(tx, {
              orderReference: intent.orderReference,
              orderBatchReference: intent.orderBatchReference,
              orderItemReferences: lines,
              orderCancellationReference: cancellationReference,
              operationReference: options.nextReference(),
              auditReference: options.nextReference(),
              actorReference,
              cancelledAt,
              nextReference: options.nextReference,
            });
            const inventory = await createSubmissionInventoryRelease({
              scope: selected,
              systemActorReference: actorReference,
              reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
              now: options.persistence.now,
            }).releaseLines(tx, {
              source: {
                kind: "StaffItemCancellationInventory/v1",
                reference: cancellationReference,
                submissionReference: record.submissionReference,
                orderReference: record.orderReference,
                occurredAt: record.cancelledAt,
              },
              releasedAt: record.cancelledAt,
              authorize: guard,
              cartLineReferences: plan.lines.map((line) => line.sourceCartLineReference),
            });
            if (inventory.status === "NotReleasable")
              return fail("UNPAID_ITEM_REMOVAL_NOT_REMOVABLE");
            // v15 b11 (DEC-TAX-WHOLE-RECEIPT): the bill changed, so a tax rounding recorded for it
            // is recorded again for the bill as it now stands.
            await refreshBillTaxRounding(tx, selected, {
              orderReference: intent.orderReference,
              observedAt: cancelledAt,
              authorize: async () => (await guard()) === true,
              nextReference: options.nextReference,
            });
            // v15 b12 (DEC-DINE-IN-SPLIT-BILL rule 7): a split bill is split again the same way, so
            // no guest is asked to pay a share of the bill as it was before.
            await splitAgainAfterBillChange(tx, selected, {
              orderReference: intent.orderReference,
              observedAt: cancelledAt,
              authorize: async () => (await guard()) === true,
              nextReference: options.nextReference,
              actorReference,
              correlationReference: intent.operationReference,
            });
            return result(record, "Removed");
          },
        ),
      );
    } catch (error) {
      if (error instanceof UnpaidItemRemovalError) throw error;
      if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
        return fail("UNPAID_ITEM_REMOVAL_PREPARATION_STARTED");
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("UNPAID_ITEM_REMOVAL_VERSION_CONFLICT");
      return keepingCause(() => fail("UNPAID_ITEM_REMOVAL_UNAVAILABLE"))(error);
    }
  };
}
