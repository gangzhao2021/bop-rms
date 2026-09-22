import type { ConsumerTransaction } from "@bop/eventing";
import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createTaskRecord } from "@bop/task";
import { summarizeOrderItemProgress } from "@rms/ordering";
import {
  createDiningExceptionResolution,
  createPostgresDiningExceptionTaskSource,
  parseDiningClosureEvidence,
  parseDiningHash,
  parsePositiveDiningVersion,
} from "@rms/dining";
import { createDiningSessionClosureInputs } from "./dining-session-closure-inputs.js";
type Options = Parameters<typeof createDiningSessionClosureInputs>[0];
const fail = (): never => {
  throw new Error("DINING_SETTLED_SESSION_EVIDENCE_UNAVAILABLE");
};
/** Settled path only; callers retain admission/owner fences until Finalize commits.
 * Other financial classes require their own owner evidence, never inferred here. */
export function createDiningSettledSessionEvidence(options: Options) {
  return createSessionEvidence(options, false);
}
/** General closing evidence: unresolved money requires the Dining service's
 * transaction-bound Manager task. This adapter never creates financial finality. */
export function createDiningSessionClosingEvidence(options: Options) {
  return createSessionEvidence(options, true);
}
function createSessionEvidence(options: Options, allowUnresolved: boolean) {
  const source = createDiningSessionClosureInputs(options);
  return {
    async load(
      tx: ConsumerTransaction,
      query: { diningSessionReference: string; observedAt: string },
      version: number,
    ) {
      try {
        const evidenceVersion = parsePositiveDiningVersion(version);
        const current = await source.load(tx, query),
          orders = [],
          digests = [];
        const authorize = () => options.authorizeAndFence(tx, query);
        const hashes = {
          hashIntent: (value: string) =>
            parseDiningHash(createHash("sha256").update(value).digest("hex")),
          equals: (a: string, b: string) => a === b,
        };
        const association = createPostgresDiningExceptionTaskSource({
          scope: options.diningScope,
          hashes,
          authorizeAndFence: authorize,
        });
        for (const entry of current.orders) {
          const { closure, current: position, historicalFinality: fact } = entry;
          const batches = entry.inventory.batches.map((batch) => {
            const items = position.execution.items.filter(
              (item) => String(item.orderBatchReference) === String(batch.orderBatchReference),
            );
            const state = summarizeOrderItemProgress(items).phase;
            if (state !== "Fulfilled" && state !== "Rejected" && state !== "Cancelled")
              return fail();
            return { batchReference: batch.orderBatchReference, executionState: state };
          });
          if (
            allowUnresolved &&
            (position.settlement.classification === "Unpaid" ||
              position.settlement.classification === "Indeterminate")
          ) {
            if (
              closure.status !== "Open" ||
              fact !== null ||
              closure.financialFinalityReference !== null ||
              !position.execution.kitchenEvidenceComplete ||
              position.cancellation.pendingCount !== 0 ||
              position.priced.pendingAmendmentCount !== 0
            )
              return fail();
            for (const snapshot of position.tasks.taskSources) {
              for (const value of snapshot.tasks) {
                const task = createTaskRecord(value);
                if (task.severityCode !== "CRITICAL") continue;
                if (
                  task.taskType !== "DINING_UNPAID_BATCH_EXCEPTION" ||
                  task.source.sourceType !== "DINING_SESSION"
                )
                  return fail();
                const linked = await association.load(tx, { task, observedAt: current.observedAt });
                if (
                  !linked ||
                  String(linked.diningSessionReference) !== current.diningSessionReference
                )
                  return fail();
              }
            }
            orders.push({
              orderReference: entry.inventory.orderReference,
              orderClosureStatus: closure.status,
              batches,
              financialClass: position.settlement.classification,
              ownerFinalityReference: null,
              ownerDecidedAt: null,
            });
            digests.push([closure.snapshotDigest, position.snapshotDigest, null]);
            continue;
          }
          if (
            !fact ||
            closure.status !== "Closed" ||
            position.settlement.classification !== "Settled" ||
            !position.execution.kitchenEvidenceComplete ||
            position.cancellation.pendingCount !== 0 ||
            position.priced.pendingAmendmentCount !== 0
          )
            return fail();
          if (
            fact.tenantReference !== current.tenantReference ||
            fact.brandReference !== current.brandReference ||
            fact.storeReference !== current.storeReference ||
            String(fact.orderReference) !== String(entry.inventory.orderReference) ||
            fact.orderVersion !== closure.orderVersion ||
            String(fact.orderCheckpoint) !== String(closure.orderCheckpoint) ||
            String(fact.finalityReference) !== String(closure.financialFinalityReference) ||
            fact.decidedAt > current.observedAt ||
            fact.currencyCode !== position.financial.currencyCode ||
            fact.pricedOrderTotalMinor !== position.priced.pricedTotalMinor.toString() ||
            fact.capturedMinor !== position.financial.capturedMinor.toString() ||
            fact.capturedOrderAllocationMinor !==
              position.financial.capturedOrderAllocationMinor.toString() ||
            fact.capturedTipMinor !== position.financial.capturedTipMinor.toString()
          )
            return fail();
          const resolver = createDiningExceptionResolution({
            scope: options.diningScope,
            authorize,
            association: association.load,
            financial: async () => ({
              ...options.diningScope,
              orderReference: entry.inventory.orderReference,
              orderVersion: closure.orderVersion,
              observedAt: current.observedAt,
              financialClass: fact.classification,
              ownerFinalityReference: fact.finalityReference,
              ownerDecidedAt: fact.decidedAt,
            }),
          });
          const seen = new Set<string>();
          for (const snapshot of position.tasks.taskSources)
            for (const value of snapshot.tasks) {
              const task = createTaskRecord(value);
              if (seen.has(task.taskReference)) return fail();
              seen.add(task.taskReference);
              if (task.severityCode !== "CRITICAL") continue;
              if (
                task.taskType !== "DINING_UNPAID_BATCH_EXCEPTION" ||
                task.source.sourceType !== "DINING_SESSION"
              )
                return fail();
              const result = await resolver.resolve(tx, {
                task,
                orderReference: entry.inventory.orderReference,
                expectedOrderVersion: closure.orderVersion,
                observedAt: current.observedAt,
              });
              if (result.outcome !== "Cleared" && result.outcome !== "NotApplicable") return fail();
            }
          orders.push({
            orderReference: entry.inventory.orderReference,
            orderClosureStatus: closure.status,
            batches,
            financialClass: fact.classification,
            ownerFinalityReference: fact.finalityReference,
            ownerDecidedAt: fact.decidedAt,
          });
          digests.push([closure.snapshotDigest, position.snapshotDigest, fact]);
        }
        if ((await authorize()) !== true) return fail();
        const evidence = {
          diningSessionReference: current.diningSessionReference,
          brandReference: current.brandReference,
          storeReference: current.storeReference,
          evidenceVersion,
          observedAt: current.observedAt,
          orders,
        };
        return parseDiningClosureEvidence({
          ...evidence,
          evidenceDigest: createHash("sha256")
            .update(canonicalizeRfc8785({ evidence, digests }))
            .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  };
}
