import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { parseConfirmedOrderIntakeReceipt } from "./confirmed-order-intake.js";
import { createKitchenReadyEventBundle } from "./kitchen-ready-events.js";
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

export interface KitchenRoundLine {
  readonly orderItemReference: string;
  readonly productReference: string;
  readonly skuReference: string;
  readonly quantity: number;
}

/**
 * WP-2423 item 8a: the lines of a round the kitchen does not prepare. The Store's own mark on the
 * dish wins, either way; a dish with no mark at this Store follows its size's default (a size
 * declared a charge, or the Store's tea item); everything else goes to the kitchen.
 */
export function kitchenLinesNotPrepared(
  lines: readonly KitchenRoundLine[],
  marks: ReadonlyMap<string, { readonly notPrepared: boolean }>,
  notPreparedByDefault: ReadonlySet<string>,
): readonly KitchenRoundLine[] {
  return lines.filter(
    (line) =>
      marks.get(line.productReference)?.notPrepared ?? notPreparedByDefault.has(line.skuReference),
  );
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): the
 * kitchen takes a confirmed round without the dishes it does not prepare. When the round first
 * reaches the kitchen, the dishes marked "not prepared" at that moment, and with no mark the charges
 * and the Store's tea item (item 8a), are fixed as the round's decision (later changes never move
 * work already issued). A round with something to prepare goes on to its ticket (its kitchen source
 * then leaves those lines out); a round made only of such dishes makes no ticket, and its intake
 * receipt is kept with the decision, so the confirmed round is still consumed exactly once.
 *
 * A Pickup round with nothing to prepare is ready the moment it reaches the kitchen: nothing else
 * would ever say so, and a bottled drink or a bag at the counter must be handed over straight away.
 * Kitchen says so with its own ready events, as when a ticket's last dish is finished; the ticket
 * they name is one derived from the round, because there is none.
 */
export function createKitchenNotPreparedIntakeAdapter(options: {
  readonly inner: Intakes;
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  /** Every line of the round as the kitchen would make it (no dish left out). */
  allLines(
    transaction: ConsumerTransaction,
    receipt: Parameters<Intakes["accept"]>[0]["receipt"],
  ): Promise<readonly KitchenRoundLine[]>;
  /** Of these sizes, the ones the kitchen does not prepare unless the Store marked the dish. */
  notPreparedByDefault(
    transaction: ConsumerTransaction,
    skuReferences: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** The round's order type; a round whose type can't be read must fail, never pass as dine-in. */
  orderType(
    transaction: ConsumerTransaction,
    receipt: Parameters<Intakes["accept"]>[0]["receipt"],
  ): Promise<"DineIn" | "Pickup">;
  /** A stable reference for this purpose and identity. */
  derive(purpose: string, identity: string): string;
  now(): string;
}): Intakes {
  const tx = (transaction: ConsumerTransaction) => transaction as unknown as Transaction;
  const publishReady = async (
    transaction: ConsumerTransaction,
    receipt: Parameters<Intakes["accept"]>[0]["receipt"],
    lines: readonly KitchenRoundLine[],
    readyAt: string,
  ) => {
    const round = String(receipt.orderBatchReference);
    const ordered = [...lines].sort((a, b) =>
      a.orderItemReference.localeCompare(b.orderItemReference),
    );
    const resultOf = (line: KitchenRoundLine) =>
      options.derive("KitchenNotPreparedReadyResult", line.orderItemReference);
    const readiness = ordered.map((line) => ({
      orderItemReference: line.orderItemReference,
      requiredQuantity: line.quantity,
      readyResultReference: resultOf(line),
      readyQuantity: line.quantity,
      readyAt,
    }));
    for (const [index, line] of ordered.entries()) {
      const bundle = createKitchenReadyEventBundle({
        itemEventReference: options.derive("KitchenNotPreparedItemEvent", line.orderItemReference),
        // The last line's bundle also says the whole round is ready.
        orderEventReference:
          index === ordered.length - 1
            ? options.derive("KitchenNotPreparedOrderEvent", round)
            : null,
        brandReference: options.scope.brandReference,
        storeReference: options.scope.storeReference,
        ticketReference: options.derive("KitchenNotPreparedRound", round),
        ticketVersion: 1n,
        orderReference: String(receipt.orderReference),
        orderBatchReference: round,
        orderItemReference: line.orderItemReference,
        readyResultReference: resultOf(line),
        readyQuantity: line.quantity,
        requiredQuantity: line.quantity,
        readyAt,
        correlationReference: String(receipt.confirmationReference),
        causationReference: String(receipt.sourceEventReference),
        // Only the last bundle checks that the whole round is ready.
        readiness:
          index === ordered.length - 1
            ? readiness
            : readiness.map((entry) =>
                entry.orderItemReference === line.orderItemReference
                  ? entry
                  : { ...entry, readyResultReference: null, readyQuantity: null, readyAt: null },
              ),
      });
      await appendEventInTransaction(transaction as never, bundle.itemEvent);
      if (bundle.orderEvent !== null)
        await appendEventInTransaction(transaction as never, bundle.orderEvent);
    }
  };
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
      const unmarked = [
        ...new Set(
          lines
            .filter((line) => !marks.has(line.productReference))
            .map((line) => line.skuReference),
        ),
      ];
      const byDefault =
        unmarked.length === 0
          ? new Set<string>()
          : await options.notPreparedByDefault(input.transaction, unmarked);
      const notPrepared = kitchenLinesNotPrepared(lines, marks, byDefault).map(
        (line) => line.orderItemReference,
      );
      const allNotPrepared = lines.length > 0 && notPrepared.length === lines.length;
      const decidedAt = new Date(Date.parse(options.now())).toISOString();
      await recordKitchenBatchPreparationDecision(tx(input.transaction), options.scope, {
        orderReference: String(input.receipt.orderReference),
        orderBatchReference: round,
        sourceEventReference: String(input.receipt.sourceEventReference),
        confirmationReference: String(input.receipt.confirmationReference),
        notPreparedOrderItemReferences: notPrepared,
        allNotPrepared,
        intakeReceipt: allNotPrepared ? storedReceipt(input.receipt) : null,
        decidedAt,
      });
      if (!allNotPrepared) return options.inner.accept(input);
      if ((await options.orderType(input.transaction, input.receipt)) === "Pickup")
        await publishReady(input.transaction, input.receipt, lines, decidedAt);
      return Object.freeze({ status: "Created" as const, receipt: input.receipt });
    },
  });
}
