import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningClosingFence,
  countDiningGuestTableStarts,
  decideGuestNewParty,
  decideGuestTableQuietClose,
  listDiningGuestStartedSessions,
  listDiningSessionMergesInto,
  listOpenDiningGuestStartedSessions,
  loadDiningGuestStartedSessionAtTable,
  loadDiningGuestTableActivity,
  parseDiningItemServiceRecord,
  type GuestTableCloseFacts,
  type GuestTableCloseReason,
  type GuestTableHold,
} from "@rms/dining";
import {
  createPostgresKitchenCustomerStatusReader,
  listOpenKitchenReworkItems,
} from "@rms/kitchen";
import {
  acquireOrderDispositionFence,
  createPostgresMerchantOrderIndex,
  createPostgresOrderClosurePosition,
  listStoreDiningSessionOrderActivity,
  listStoreDiningSessionOrders,
} from "@rms/ordering";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { runDiningOrderClose } from "./dining-order-close-run.js";
import { runDiningSessionClosing } from "./dining-session-closing-run.js";
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
import { createDiningTableReleaseComposition } from "./dining-table-release-composition.js";
import { createMerchantDiningItemServiceComposition } from "./merchant-dining-item-service-composition.js";

const fail = (): never => {
  throw new Error("DINING_GUEST_TABLE_CLOSE_UNAVAILABLE");
};
/** The kitchen-side reasons that only mean "items not served yet"; the close serves finished ones. */
const servingReasons = new Set(["EXECUTION_NOT_FINAL", "FULFILLMENT_NOT_FINAL"]);

export interface DiningGuestTableCloseOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  /** Reads that decide nothing (a refused table takes no lock); defaults to `transactions`. */
  readonly readTransactions?: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(): Promise<boolean>;
  now(): string;
  newReference(): string;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly orderAudit: { retentionPolicyCode: string; retentionPolicyVersion: number };
}

export type DiningGuestTableCloseResult =
  | {
      readonly status: "Closed";
      readonly orderReference: string | null;
      readonly servedItems: number;
    }
  | { readonly status: "Held"; readonly hold: GuestTableHold | "Budget" | "Changed" };

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: the System frees a guest-started table when its quiet rule
 * says so, or when the next party says they aren't with the people there. It gathers the owners'
 * facts, the rule decides (Dining), and the close runs the same owner paths staff use: settled
 * finality and Order closure in Payment and Ordering, Session and table in Dining. Anything owed or
 * unfinished keeps the table open. One table per transaction, and the Order fence comes before the
 * table, as a paid event takes them, so neither waits on the other.
 */
export function createDiningGuestTableClose(options: DiningGuestTableCloseOptions) {
  const { scope } = options;
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const authorize = () => options.authorize();
  const paymentScope = {
    ...scope,
    providerAccountReference: options.providerAccountReference,
    environment: options.environment,
  };
  const sourceOptions = {
    ...scope,
    diningScope: scope,
    paymentScope,
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
    includeCancelled: true,
  };

  async function orderBinding(tx: ConsumerTransaction, session: string) {
    const orderReference = (await listStoreDiningSessionOrders(tx, owner, [session])).get(session);
    if (orderReference === undefined) return null;
    const binding = await createPostgresMerchantOrderIndex({ ...owner, authorize }).find({
      transaction: tx,
      orderReference,
    });
    if (!binding || binding.diningSessionReference === null) return fail();
    return Object.freeze({
      orderReference,
      diningSessionReference: String(binding.diningSessionReference),
      guestSessionReference: String(binding.guestSessionReference),
    });
  }

  /** Every owner's facts for one table; reads only. */
  async function readFacts(tx: ConsumerTransaction, session: string, observedAt: string) {
    const startedAt = (await listDiningGuestStartedSessions(tx, owner, [session])).get(session);
    if (startedAt === undefined) return null;
    const dining = (await loadDiningGuestTableActivity(tx, owner, [session])).get(session);
    if (dining?.phase !== "Active") return null;
    const ordering = (
      await listStoreDiningSessionOrderActivity(tx, owner, [session], observedAt)
    ).get(session);
    const merges = (await listDiningSessionMergesInto(tx as never, owner, [session])).get(session);
    const binding = await orderBinding(tx, session);
    let order: GuestTableCloseFacts["order"] = null;
    let kitchenAt: string | null = null;
    let closureOpen = false;
    let readyItems: readonly {
      orderItemReference: string;
      orderBatchReference: string;
      remainingQuantity: number;
      itemServiceVersion: number;
    }[] = [];
    if (binding !== null) {
      const input = {
        ...scope,
        transaction: tx,
        orderReference: binding.orderReference,
        diningSessionReference: binding.diningSessionReference,
        guestSessionReference: binding.guestSessionReference,
        observedAt,
      };
      const position = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, {
        orderReference: binding.orderReference,
        observedAt,
      });
      closureOpen = position.status === "Open";
      if (!closureOpen) order = Object.freeze({ unfinishedItems: 0, blockers: [], readyItems: 0 });
      else {
        const delivery = await createDiningOrderDeliveryProgress(sourceOptions).load(input);
        if (delivery === null) return fail();
        const remaking = new Map<string, number>();
        for (const remake of await listOpenKitchenReworkItems(tx, owner, [binding.orderReference]))
          remaking.set(
            remake.orderItemReference,
            (remaking.get(remake.orderItemReference) ?? 0) + remake.openQuantity,
          );
        const finished = (phase: string) =>
          phase === "Fulfilled" || phase === "Cancelled" || phase === "Rejected";
        const unfinishedItems = delivery.items.filter(
          (item) =>
            !finished(item.phase) &&
            (item.phase !== "Ready" || remaking.has(String(item.orderItemReference))),
        ).length;
        readyItems = delivery.items
          .filter((item) => item.phase === "Ready" && item.remainingQuantity > 0)
          .map((item) =>
            Object.freeze({
              orderItemReference: String(item.orderItemReference),
              orderBatchReference: String(item.orderBatchReference),
              remainingQuantity: item.remainingQuantity,
              itemServiceVersion: item.itemServiceVersion,
            }),
          );
        const readiness = await createDiningSettledCloseEvidence(sourceOptions).readiness(input);
        if (readiness === null) return fail();
        order = Object.freeze({
          unfinishedItems,
          blockers: Object.freeze(
            readiness.reasons.filter((reason) => !servingReasons.has(reason)),
          ),
          readyItems: readyItems.length,
        });
        const kitchen = await createPostgresKitchenCustomerStatusReader({
          ...owner,
          authorize,
        }).loadByOrder({ transaction: tx, orderReference: binding.orderReference });
        for (const batch of kitchen?.batches ?? [])
          if (kitchenAt === null || batch.updatedAt > kitchenAt) kitchenAt = batch.updatedAt;
      }
    }
    const facts: GuestTableCloseFacts = Object.freeze({
      startedAt: startedAt.startedAt,
      activity: Object.freeze([
        dining.lastPhoneJoinedAt,
        dining.lastServedAt,
        ordering?.lastRoundAt ?? null,
        ordering?.lastCartChangeAt ?? null,
        kitchenAt,
      ]),
      cartHasItems: ordering?.cartHasItems === true,
      openStaffCall: dining.openStaffCall,
      merged: (merges?.length ?? 0) > 0,
      order,
    });
    return Object.freeze({ facts, binding, closureOpen, readyItems });
  }

  const rule = async (
    tx: ConsumerTransaction,
    reason: GuestTableCloseReason,
    tableReference: string | null,
    facts: GuestTableCloseFacts,
    at: string,
  ): Promise<GuestTableHold | "Budget" | null> => {
    if (reason === "GUEST_TABLE_QUIET") {
      const decided = decideGuestTableQuietClose(facts, at);
      return decided.close ? null : decided.hold;
    }
    const spent = await countDiningGuestTableStarts(tx, owner, tableReference ?? fail(), at);
    const decided = decideGuestNewParty(facts, at, spent.table);
    return decided.ask ? null : decided.hold;
  };

  /** Finished dishes nobody marked served count as handed over, recorded by the System. */
  async function serveFinished(
    tx: ConsumerTransaction,
    input: {
      readonly reason: GuestTableCloseReason;
      readonly sourceChannel: "SYSTEM" | "CUSTOMER_PWA";
      readonly session: Awaited<ReturnType<ReturnType<typeof createPostgresDiningClosingFence>>>;
      readonly binding: NonNullable<Awaited<ReturnType<typeof orderBinding>>>;
      readonly items: NonNullable<Awaited<ReturnType<typeof readFacts>>>["readyItems"];
      readonly orderVersion: number;
      readonly observedAt: string;
      readonly operationReference: string;
    },
  ) {
    const digest = (current: { orderVersion: number; items: unknown }) =>
      createHash("sha256")
        .update(JSON.stringify({ orderVersion: current.orderVersion, items: current.items }))
        .digest("hex");
    for (const item of input.items) {
      const composition = createMerchantDiningItemServiceComposition({
        scope,
        now: () => input.observedAt,
        authorize,
        validateSource: async () => true,
        audit: async (fact) => ({
          auditId: fact.auditReference,
          brandId: fact.brandReference,
          storeId: fact.storeReference,
          actor: { type: "System" },
          actionCode: "DINING_ITEM_SERVED",
          targetType: "OrderItem",
          targetId: fact.orderItemReference,
          reasonCode: input.reason,
          correlationId: fact.operationReference,
          occurredAt: fact.recordedAt,
          afterSummary: { quantity: fact.quantity, version: fact.itemServiceVersion },
          sourceChannel: input.sourceChannel,
          dataClassification: "Restricted",
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        }),
      });
      await composition.commit({
        transaction: tx,
        guestSessionReference: input.binding.guestSessionReference,
        orderDiningSessionReference: input.binding.diningSessionReference,
        record: parseDiningItemServiceRecord({
          ...scope,
          serviceReference: options.newReference(),
          operationReference: options.newReference(),
          auditReference: options.newReference(),
          diningSessionReference: input.session.diningSessionReference,
          tableReference: input.session.tableReference,
          sessionVersion: input.session.version,
          tableAssignmentVersion: input.session.tableAssignmentVersion,
          orderReference: input.binding.orderReference,
          orderBatchReference: item.orderBatchReference,
          orderItemReference: item.orderItemReference,
          // The System is nobody; the record names the close that decided this.
          actorReference: input.operationReference,
          expectedOrderVersion: input.orderVersion,
          expectedItemServiceVersion: item.itemServiceVersion,
          itemServiceVersion: item.itemServiceVersion + 1,
          quantity: item.remainingQuantity,
          purposeCode: "ServeDiningOrderItem",
          permissionCode: "dining.item.serve",
          servedAt: input.observedAt,
          recordedAt: input.observedAt,
          sourceCheckpoint: input.binding.orderReference,
          sourceDigest: digest({ orderVersion: input.orderVersion, items: item }),
        }),
      });
    }
  }

  async function closeInOneTransaction(
    session: string,
    reason: GuestTableCloseReason,
    sourceChannel: "SYSTEM" | "CUSTOMER_PWA",
  ): Promise<DiningGuestTableCloseResult> {
    return options.transactions.run(async (tx) => {
      const observedAt = options.now();
      const expected = await orderBinding(tx, session);
      // Order first, then table and Session: the order a paid event takes them in.
      if (expected !== null)
        await acquireOrderDispositionFence(tx, {
          ...owner,
          orderReference: expected.orderReference,
        });
      const fenced = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
        diningSessionReference: session,
        observedAt,
      });
      if (fenced.phase !== "Active") return Object.freeze({ status: "Held", hold: "Changed" });
      const current = await readFacts(tx, session, observedAt);
      if (current === null) return Object.freeze({ status: "Held", hold: "Changed" });
      const hold = await rule(tx, reason, String(fenced.tableReference), current.facts, observedAt);
      if (hold !== null) return Object.freeze({ status: "Held", hold });
      const closeOperation = options.newReference();
      if (current.binding !== null && current.closureOpen) {
        const position = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, {
          orderReference: current.binding.orderReference,
          observedAt,
        });
        await serveFinished(tx, {
          reason,
          sourceChannel,
          session: fenced,
          binding: current.binding,
          items: current.readyItems,
          orderVersion: position.orderVersion,
          observedAt,
          operationReference: closeOperation,
        });
        const binding = current.binding;
        const delivery = await createDiningOrderDeliveryProgress(sourceOptions).load({
          ...scope,
          transaction: tx,
          orderReference: binding.orderReference,
          diningSessionReference: binding.diningSessionReference,
          guestSessionReference: binding.guestSessionReference,
          observedAt,
        });
        if (delivery === null) return fail();
        await runDiningOrderClose({
          tx,
          scope,
          actor: { type: "System" },
          sourceChannel,
          command: {
            orderReference: binding.orderReference,
            operationReference: options.newReference(),
            expectedOrderVersion: position.orderVersion,
            expectedClosureVersion: position.closureVersion,
            reasonCode: delivery.phase === "Cancelled" ? "ORDER_CANCELLED" : "ORDER_COMPLETED",
          },
          now: observedAt,
          authorize,
          newReference: options.newReference,
          audit: options.orderAudit,
          resolveConfiguration: async () =>
            Object.freeze({
              providerAccountReference: options.providerAccountReference,
              environment: options.environment,
              diningSessionReference: binding.diningSessionReference,
              guestSessionReference: binding.guestSessionReference,
            }),
        });
      }
      const closing = (
        action: "Begin" | "Finalize",
        operationReference: string,
        expectedSessionVersion: number,
      ) =>
        runDiningSessionClosing({
          transaction: tx,
          scope,
          command: {
            action,
            diningSessionReference: session,
            operationReference,
            expectedSessionVersion,
          },
          observedAt,
          providerAccountReference: options.providerAccountReference,
          environment: options.environment,
          guard: authorize,
          newReference: options.newReference,
          closingReason: async () => reason,
          authority: async (request, reasonCode) =>
            Object.freeze({
              kind: "System" as const,
              diningSessionReference: request.session.diningSessionReference,
              storeReference: request.session.storeReference,
              observedAt: request.observedAt,
              audit: {
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" as const },
                actionCode: `DINING_SESSION_CLOSING_${request.operation.toUpperCase()}`,
                targetType: "DiningSession",
                targetId: session,
                reasonCode,
                correlationId: operationReference,
                occurredAt: request.observedAt,
                sourceChannel,
                dataClassification: "Restricted" as const,
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
              },
            }),
          // No cleaning step after the System's close: nobody would clear it (only staff could).
          release: async (_closed, version) => {
            await createDiningTableReleaseComposition({
              scope,
              actorReference: null,
              sourceChannel,
              authorize,
              newReference: options.newReference,
              retentionPolicyCode: options.retentionPolicyCode,
              retentionPolicyVersion: options.retentionPolicyVersion,
            })(tx, {
              diningSessionReference: session,
              operationReference: finalizeOperation,
              expectedSessionVersion: version,
              observedAt,
            });
          },
        });
      const finalizeOperation = options.newReference();
      const begun = await closing("Begin", options.newReference(), fenced.version);
      await closing("Finalize", finalizeOperation, begun.sessionVersion);
      return Object.freeze({
        status: "Closed",
        orderReference: current.binding?.orderReference ?? null,
        servedItems: current.readyItems.length,
      });
    });
  }

  /** Decide without holding anything, then close in one transaction that decides again. */
  async function close(
    session: string,
    reason: GuestTableCloseReason,
    sourceChannel: "SYSTEM" | "CUSTOMER_PWA",
    tableReference: string | null,
  ): Promise<DiningGuestTableCloseResult> {
    const reads = options.readTransactions ?? options.transactions;
    const refused = await reads.run(async (tx) => {
      const at = options.now();
      const current = await readFacts(tx, session, at);
      if (current === null) return "Changed" as const;
      return rule(tx, reason, tableReference, current.facts, at);
    });
    if (refused !== null) return Object.freeze({ status: "Held", hold: refused });
    return closeInOneTransaction(session, reason, sourceChannel);
  }

  let cursor: string | null = null;
  return Object.freeze({
    /** The worker: one fair page of open guest-started tables; held tables are simply passed. */
    async runOnce(input: {
      readonly limit: number;
      /** A table that could not be decided or closed now; the cycle goes on. */
      onFailure?(error: unknown): void;
    }): Promise<number> {
      const page = await options.transactions.run((tx) =>
        listOpenDiningGuestStartedSessions(tx, owner, { after: cursor, limit: input.limit }),
      );
      let closed = 0;
      for (const session of page) {
        try {
          const result = await close(session, "GUEST_TABLE_QUIET", "SYSTEM", null);
          if (result.status === "Closed") closed += 1;
        } catch (error) {
          input.onFailure?.(error);
        }
      }
      cursor = page.length === input.limit ? (page.at(-1) ?? null) : null;
      return closed;
    },
    closeQuiet: (session: string) => close(session, "GUEST_TABLE_QUIET", "SYSTEM", null),
    /**
     * A new phone said "we just sat down". The same rule that asked the question decides again, so
     * nothing owed or unfinished is closed by it.
     */
    async closeForNewParty(tableReference: string): Promise<DiningGuestTableCloseResult> {
      const session = await options.transactions.run((tx) =>
        loadDiningGuestStartedSessionAtTable(tx, owner, tableReference),
      );
      if (session === null) return Object.freeze({ status: "Held", hold: "Changed" });
      return close(session, "GUEST_NEW_PARTY", "CUSTOMER_PWA", tableReference);
    },
    /**
     * Whether a scan of this table asks "are you with the people here?". Reads only, in a read of
     * its own: the scan's transaction already holds the table, and an Order fence after it would
     * invert the order a paid event takes them in.
     */
    asksNewParty(tableReference: string): Promise<boolean> {
      return (options.readTransactions ?? options.transactions).run(async (tx) => {
        const session = await loadDiningGuestStartedSessionAtTable(tx, owner, tableReference);
        if (session === null) return false;
        const at = options.now();
        const current = await readFacts(tx, session, at);
        if (current === null) return false;
        return (await rule(tx, "GUEST_NEW_PARTY", tableReference, current.facts, at)) === null;
      });
    },
  });
}
