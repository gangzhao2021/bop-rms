import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningOrderItemStateReader,
  createPostgresMerchantOrderIndex,
  createPostgresStaffOrderCancellationReader,
  listStoreDiningBatchPaymentDeadlines,
  listStoreOrderBatchPayments,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import {
  createPostgresCardMachinePaymentStore,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
  readPaymentRemainingRefundable,
} from "@rms/payment";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import {
  readCardMachineCancellationRefund,
  readStaffCancellationRefundStatus,
} from "./merchant-order-staff-cancellation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * What a manager closing a table whose guests left must resolve for one round, in staff terms:
 * - NotPaid: never paid; nothing to refund; the System cancels it at `cancelsAt`.
 * - PaymentInProgress: an online payment was started and has no result yet; wait for it.
 * - PaidNotSent: paid but never accepted (never reached the kitchen): cancel and refund it.
 * - AlreadyRefunded: paid, never accepted, payment already refunded in full: cancel (nothing owed).
 * - NotStarted: accepted, nothing made or served yet: cancel and refund it.
 * - PartlyStarted: some items are being made or served; the items not started can be cancelled
 *   (refunded line by line, online payments only); the rest must be served.
 * - BeingMade: the items left are being made (or were paid on the card machine and cannot be
 *   cancelled one by one): serve them, or have the kitchen finish them.
 * - RefundOnCardMachine: already cancelled; refund `refund` on the card machine and record it.
 * - Refunding: already cancelled; the online refund is still being made.
 */
export type TableCloseRoundState =
  | "NotPaid"
  | "PaymentInProgress"
  | "PaidNotSent"
  | "AlreadyRefunded"
  | "NotStarted"
  | "PartlyStarted"
  | "BeingMade"
  | "RefundOnCardMachine"
  | "Refunding";

export interface TableCloseRound {
  readonly orderBatchReference: string;
  readonly sequence: number;
  readonly state: TableCloseRoundState;
  /** Items (quantities) of the round not yet served or cancelled. */
  readonly openItemCount: number;
  /** Of those, items already being made, ready or partly served. */
  readonly startedItemCount: number;
  /** Of the started ones, items the kitchen marked ready and not yet served (ready to serve). */
  readonly readyItemCount: number;
  /** PartlyStarted: the lines that can still be cancelled (kitchen not started). */
  readonly cancellableItemReferences: readonly string[];
  /** What the round's cancellation refunds (whole remaining payment, tip included), or owes. */
  readonly refund: null | {
    readonly method: "Online" | "CardMachine";
    readonly amountMinor: string;
  };
  /** NotPaid: when the System cancels it. */
  readonly cancelsAt: string | null;
}

export interface TableClosePlan {
  readonly orderReference: string;
  readonly diningSessionReference: string;
  /** The Order version each cancellation names as expected. */
  readonly orderVersion: number;
  readonly observedAt: string;
  readonly rounds: readonly TableCloseRound[];
  /** Sum of the round refunds the confirmation sends (CancelRound rounds only). */
  readonly totals: { readonly onlineMinor: string; readonly cardMachineMinor: string };
  /**
   * WP-2423 (B759): what still stops the Order from closing, as reason codes from the same
   * evaluation the close command applies (settlement and closure eligibility). Empty: the Order
   * can be closed now. CLOSE_CHECK_UNAVAILABLE: the evaluation could not be read.
   */
  readonly closeBlockers: readonly string[];
}

/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT (WP-2423, Owner 2026-10-15): the rounds still open at a table whose
 * guests have left, with what closing each one does and refunds, so an Owner or Store Manager
 * resolves them from the close dialog with the existing staff cancellations (reason GUEST_LEFT).
 * Read only; every command re-checks eligibility and amounts itself.
 */
export function createMerchantDiningTableClosePlan(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveRefundConfiguration(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<{ providerAccountReference: string; environment: "Test" | "Live" }>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    query: unknown;
  }): Promise<TableClosePlan | null> => {
    const authorized = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference", "diningSessionReference"]);
    const orderReference = String(parseOrderingReference(raw.orderReference));
    const diningSessionReference = String(parseOrderingReference(raw.diningSessionReference));
    const denied = (): never => {
      throw new Error("DINING_TABLE_CLOSE_PLAN_PERMISSION_DENIED");
    };
    const unavailable = (): never => {
      throw new Error("DINING_TABLE_CLOSE_PLAN_UNAVAILABLE");
    };
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              "dining.session.close",
              authorized.sessionReference,
            );
            if ((await resolved.allowed()) !== true) return denied();
            return resolved;
          },
          recheck: async (resolved) => (await resolved.allowed()) === true,
          denied,
        },
        async (authority) => {
          const resolved = authority.scope;
          const tenantReference = String(resolved.selected.tenantReference);
          const scope = {
            tenantReference,
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
          };
          const owner = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          };
          const tx = transaction as unknown as ConsumerTransaction;
          const allowed = () => authority.guard();
          const stillAllowed = async () => (await allowed()) === true;
          const selected = await createPostgresMerchantOrderIndex({
            ...owner,
            authorize: allowed,
          }).find({ transaction: tx, orderReference });
          if (
            !selected ||
            selected.orderType !== "DineIn" ||
            selected.diningSessionReference !== diningSessionReference
          )
            return null;
          const observedAt = String(parseOrderingInstant(options.persistence.now()));
          const query = {
            transaction: tx,
            ...owner,
            orderReference,
            diningSessionReference,
            guestSessionReference: selected.guestSessionReference,
            observedAt,
          };
          const state = await createPostgresDiningOrderItemStateReader({
            ...owner,
            authorize: allowed,
            includeCancelled: true,
          }).load(query);
          if (!state) return unavailable();
          const progress = await createDiningOrderDeliveryProgress({
            ...owner,
            diningScope: scope,
            authorize: allowed,
            authorizeKitchen: allowed,
            authorizeDining: allowed,
            includeCancelled: true,
          }).load(query);
          if (!progress || progress.orderVersion !== state.orderVersion) return unavailable();
          const payments = new Map(
            (await listStoreOrderBatchPayments(tx, owner, orderReference)).map((entry) => [
              entry.orderBatchReference,
              entry,
            ]),
          );
          const card = createPostgresCardMachinePaymentStore({
            scope: owner,
            authorize: async () => stillAllowed(),
          });
          const cardPayments = new Map(
            ((await card.listByOrders(tx, [orderReference])).get(orderReference) ?? []).map(
              (entry) => [String(entry.payment.orderBatchReference), entry],
            ),
          );
          const deadlines = new Map(
            (await listStoreDiningBatchPaymentDeadlines(tx, owner, [orderReference])).map(
              (entry) => [entry.orderBatchReference, entry.paymentDeadline],
            ),
          );
          const onlineStarted = await listStoreOrderBatchesWithOnlinePayment(tx, owner, [
            orderReference,
          ]);
          const outcomes = new Map(
            (await listStoreOrderBatchPaymentOutcomes(tx, owner, [orderReference])).map((entry) => [
              entry.orderBatchReference,
              entry.status,
            ]),
          );
          const staffCancellations = new Map(
            (
              await createPostgresStaffOrderCancellationReader(owner).listByOrders(tx, [
                orderReference,
              ])
            ).map((record) => [String(record.orderBatchReference), record]),
          );
          let configuration: Awaited<ReturnType<typeof options.resolveRefundConfiguration>> | null =
            null;
          /** What a whole-round cancellation refunds now (all that is left, tip included). */
          const remaining = async (batch: string) => {
            const paidOnMachine = cardPayments.get(batch);
            if (paidOnMachine !== undefined)
              return {
                method: "CardMachine" as const,
                amountMinor:
                  paidOnMachine.payment.preparation.total.amountMinor -
                  paidOnMachine.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n),
              };
            const online = payments.get(batch);
            if (online === undefined) return null;
            configuration ??= await options.resolveRefundConfiguration(tx, scope);
            const position = await readPaymentRemainingRefundable(tx, {
              scope: { ...scope, ...configuration },
              orderReference,
              paymentTransactionReference: online.paymentTransactionReference,
              paymentIntentReference: online.paymentIntentReference,
              paymentAttemptReference: online.paymentAttemptReference,
              observedAt,
              authorize: async (t) => t === tx && (await stillAllowed()),
            });
            return { method: "Online" as const, amountMinor: position.remainingMinor };
          };
          const rounds: TableCloseRound[] = [];
          for (const batch of state.batches) {
            const reference = String(batch.orderBatchReference);
            const items = progress.items.filter(
              (item) => String(item.orderBatchReference) === reference,
            );
            const open = items.filter(
              (item) => item.phase !== "Cancelled" && item.remainingQuantity > 0,
            );
            const openItemCount = open.reduce((sum, item) => sum + item.remainingQuantity, 0);
            const started = open.filter(
              (item) =>
                item.phase === "InProgress" || item.phase === "Ready" || item.deliveredQuantity > 0,
            );
            const startedItemCount = started.reduce((sum, item) => sum + item.remainingQuantity, 0);
            // Kitchen readiness: Ready items wait at the pass (a partly served item stays Ready).
            const readyItemCount = open
              .filter((item) => item.phase === "Ready")
              .reduce((sum, item) => sum + item.remainingQuantity, 0);
            const base = {
              orderBatchReference: reference,
              sequence: batch.sequence,
              openItemCount,
              startedItemCount,
              readyItemCount,
              cancellableItemReferences: Object.freeze([] as string[]),
              refund: null,
              cancelsAt: null,
            };
            if (batch.cancellation !== null) continue;
            const cancelled = staffCancellations.get(reference);
            if (batch.staffCancellation !== null || cancelled !== undefined) {
              if (cancelled === undefined) return unavailable();
              const onMachine = await readCardMachineCancellationRefund(
                tx,
                owner,
                cancelled,
                stillAllowed,
              );
              if (onMachine !== null) {
                if (onMachine.status === "Pending" && onMachine.amountMinor !== "0")
                  rounds.push({
                    ...base,
                    state: "RefundOnCardMachine",
                    refund: { method: "CardMachine", amountMinor: onMachine.amountMinor },
                  });
              } else if (
                (await readStaffCancellationRefundStatus(tx, owner, cancelled, stillAllowed)) ===
                "Pending"
              )
                rounds.push({ ...base, state: "Refunding" });
              continue;
            }
            if (open.length === 0) continue;
            if (batch.acceptance === null) {
              const left = await remaining(reference);
              if (left === null) {
                const failed = outcomes.get(reference) === "Failed";
                rounds.push({
                  ...base,
                  state: onlineStarted.has(reference) && !failed ? "PaymentInProgress" : "NotPaid",
                  cancelsAt:
                    onlineStarted.has(reference) && !failed
                      ? null
                      : (deadlines.get(reference) ?? null),
                });
                continue;
              }
              if (left.amountMinor < 0n) return unavailable();
              rounds.push({
                ...base,
                state: left.amountMinor === 0n ? "AlreadyRefunded" : "PaidNotSent",
                refund: { method: left.method, amountMinor: left.amountMinor.toString() },
              });
              continue;
            }
            const served = items.some((item) => item.deliveredQuantity > 0);
            if (started.length === 0 && !served) {
              const left = await remaining(reference);
              if (left === null || left.amountMinor < 0n) return unavailable();
              rounds.push({
                ...base,
                state: "NotStarted",
                refund: { method: left.method, amountMinor: left.amountMinor.toString() },
              });
              continue;
            }
            const notStarted = open.filter(
              (item) => item.phase === "Accepted" && item.deliveredQuantity === 0,
            );
            if (notStarted.length > 0 && !cardPayments.has(reference)) {
              rounds.push({
                ...base,
                state: "PartlyStarted",
                cancellableItemReferences: Object.freeze(
                  notStarted.map((item) => String(item.orderItemReference)),
                ),
              });
              continue;
            }
            rounds.push({ ...base, state: "BeingMade" });
          }
          const sum = (method: "Online" | "CardMachine") =>
            rounds
              .filter(
                (round) =>
                  (round.state === "PaidNotSent" || round.state === "NotStarted") &&
                  round.refund?.method === method,
              )
              .reduce((total, round) => total + BigInt(round.refund?.amountMinor ?? "0"), 0n)
              .toString();
          configuration ??= await options.resolveRefundConfiguration(tx, scope);
          const closeBlockers = await readCloseBlockers(tx, {
            scope,
            configuration,
            authorize: allowed,
            input: query,
          });
          if (!(await stillAllowed())) return denied();
          return Object.freeze({
            orderReference,
            diningSessionReference,
            orderVersion: state.orderVersion,
            observedAt,
            rounds: Object.freeze(rounds.map((round) => Object.freeze(round))),
            totals: Object.freeze({
              onlineMinor: sum("Online"),
              cardMachineMinor: sum("CardMachine"),
            }),
            closeBlockers,
          });
        },
      ),
    );
  };
}

/** WP-2423 (B759): the close command's own readiness evaluation, read without recording anything. */
async function readCloseBlockers(
  tx: ConsumerTransaction,
  input: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    configuration: { providerAccountReference: string; environment: "Test" | "Live" };
    authorize: () => Promise<boolean>;
    input: {
      transaction: ConsumerTransaction;
      brandReference: string;
      storeReference: string;
      orderReference: string;
      diningSessionReference: string;
      guestSessionReference: string;
      observedAt: string;
    };
  },
): Promise<readonly string[]> {
  const { scope, configuration, authorize } = input;
  await tx.query("SAVEPOINT table_close_readiness", []);
  try {
    const readiness = await createDiningSettledCloseEvidence({
      ...scope,
      diningScope: scope,
      paymentScope: { ...scope, ...configuration },
      authorize,
      authorizeKitchen: authorize,
      authorizeDining: authorize,
      includeCancelled: true,
    }).readiness({ ...input.input, ...scope });
    await tx.query("RELEASE SAVEPOINT table_close_readiness", []);
    return Object.freeze([...(readiness?.reasons ?? [])]);
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT table_close_readiness", []);
    await tx.query("RELEASE SAVEPOINT table_close_readiness", []);
    return Object.freeze(["CLOSE_CHECK_UNAVAILABLE"]);
  }
}
