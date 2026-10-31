import type { ConsumerTransaction } from "@bop/eventing";
import { parseConfirmedOrderIntakeReceipt } from "./confirmed-order-intake.js";
import type { ConfirmedOrderConsumerPorts } from "./ports/confirmed-order-consumer-ports.js";
import {
  loadKitchenBatchPreparationDecision,
  loadKitchenNotPreparedProducts,
  recordKitchenBatchPreparationDecision,
} from "../infrastructure/persistence/kitchen-not-prepared-store.js";

type Intakes = ConfirmedOrderConsumerPorts["intakes"];
type Transaction = Parameters<typeof loadKitchenBatchPreparationDecision>[0];

/** A receipt as stored with the round's decision (its bigint version kept as text). */
const storedReceipt = (receipt: unknown) =>
  JSON.parse(
    JSON.stringify(receipt, (_key, value: unknown) =>
      typeof value === "bigint" ? { bigint: value.toString() } : value,
    ),
  ) as unknown;
const receiptFromStore = (value: unknown) =>
  parseConfirmedOrderIntakeReceipt(
    JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
      item !== null &&
      typeof item === "object" &&
      Object.keys(item).length === 1 &&
      typeof (item as { bigint?: unknown }).bigint === "string"
        ? BigInt((item as { bigint: string }).bigint)
        : item,
    ),
  );

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): the
 * kitchen takes a confirmed round without the dishes it does not prepare. When the round first
 * reaches the kitchen, the dishes marked "not prepared" at that moment are fixed as the round's
 * decision (later changes of the mark never move work already issued). A round with something to
 * prepare goes on to its ticket (its kitchen source then leaves those lines out); a round made only
 * of such dishes makes no ticket, and its intake receipt is kept with the decision, so the
 * confirmed round is still consumed exactly once.
 */
export function createKitchenNotPreparedIntakeAdapter(options: {
  readonly inner: Intakes;
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  /** Every line of the round as the kitchen would make it (no dish left out). */
  allLines(
    transaction: ConsumerTransaction,
    receipt: Parameters<Intakes["accept"]>[0]["receipt"],
  ): Promise<readonly { readonly orderItemReference: string; readonly productReference: string }[]>;
  now(): string;
}): Intakes {
  const tx = (transaction: ConsumerTransaction) => transaction as unknown as Transaction;
  return Object.freeze<Intakes>({
    async resolveByIdentity(input) {
      const found = await options.inner.resolveByIdentity(input);
      if (found.status !== "NotFound") return found;
      const decision = await loadKitchenBatchPreparationDecision(
        tx(input.transaction),
        options.scope,
        String(input.orderBatchReference),
      );
      if (
        decision === null ||
        !decision.allNotPrepared ||
        decision.sourceEventReference !== String(input.sourceEventReference) ||
        decision.confirmationReference !== String(input.confirmationReference)
      )
        return found;
      return Object.freeze({
        status: "Resolved" as const,
        receipt: receiptFromStore(decision.intakeReceipt),
      });
    },
    async accept(input) {
      const round = String(input.receipt.orderBatchReference);
      const decided = await loadKitchenBatchPreparationDecision(
        tx(input.transaction),
        options.scope,
        round,
      );
      if (decided !== null) {
        if (!decided.allNotPrepared) return options.inner.accept(input);
        if (decided.sourceEventReference !== String(input.receipt.sourceEventReference))
          return Object.freeze({ status: "Conflict" as const });
        return Object.freeze({
          status: "AlreadyAccepted" as const,
          receipt: receiptFromStore(decided.intakeReceipt),
        });
      }
      const lines = await options.allLines(input.transaction, input.receipt);
      const marks = await loadKitchenNotPreparedProducts(tx(input.transaction), options.scope, [
        ...new Set(lines.map((line) => line.productReference)),
      ]);
      const notPrepared = lines
        .filter((line) => marks.get(line.productReference)?.notPrepared === true)
        .map((line) => line.orderItemReference);
      const allNotPrepared = lines.length > 0 && notPrepared.length === lines.length;
      await recordKitchenBatchPreparationDecision(tx(input.transaction), options.scope, {
        orderReference: String(input.receipt.orderReference),
        orderBatchReference: round,
        sourceEventReference: String(input.receipt.sourceEventReference),
        confirmationReference: String(input.receipt.confirmationReference),
        notPreparedOrderItemReferences: notPrepared,
        allNotPrepared,
        intakeReceipt: allNotPrepared ? storedReceipt(input.receipt) : null,
        decidedAt: new Date(Date.parse(options.now())).toISOString(),
      });
      if (!allNotPrepared) return options.inner.accept(input);
      return Object.freeze({ status: "Created" as const, receipt: input.receipt });
    },
  });
}
