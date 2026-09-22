import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createTaskRecord } from "@bop/task";
import { parseOrderSettledFinality } from "@rms/payment";
import { evaluateOrderClosureEligibility, summarizeOrderItemProgress } from "@rms/ordering";
import {
  createPostgresDiningExceptionTaskSource,
  createDiningExceptionResolution,
  parseDiningHash,
} from "@rms/dining";
import { createDiningOrderClosureInputs } from "./dining-order-closure-inputs.js";
type Options = Parameters<typeof createDiningOrderClosureInputs>[0];
type Input = Parameters<ReturnType<typeof createDiningOrderClosureInputs>["load"]>[0];
const fail = (): never => {
  throw new Error("DINING_SETTLED_CLOSE_EVIDENCE_UNAVAILABLE");
};
/** Internal callback for the paired owner writer, never a client-supplied finality.
 * Caller retains all owner fences; unknown critical sources cannot silently clear. */
export function createDiningSettledCloseEvidence(options: Options) {
  const inputs = createDiningOrderClosureInputs(options);
  return Object.freeze({
    async load(input: Input, finality: unknown) {
      try {
        const fact = parseOrderSettledFinality(finality),
          current = await inputs.load(input);
        if (!current) return fail();
        const execution = current.execution;
        if (
          fact.tenantReference !== String(options.diningScope.tenantReference) ||
          fact.brandReference !== String(execution.brandReference) ||
          fact.storeReference !== String(execution.storeReference) ||
          fact.orderReference !== String(execution.orderReference) ||
          fact.orderVersion !== execution.orderVersion ||
          fact.orderCheckpoint !== String(execution.revisionCheckpoint) ||
          fact.decidedAt !== execution.observedAt ||
          fact.providerAccountReference !== options.paymentScope.providerAccountReference ||
          fact.environment !== options.paymentScope.environment ||
          fact.paymentEvidenceDigest !== current.financial.snapshotDigest ||
          fact.orderEvidenceDigest !==
            "sha256:" +
              createHash("sha256")
                .update(JSON.stringify([execution.revisionDigest, current.priced.snapshotDigest]))
                .digest("hex") ||
          current.settlement.classification !== "Settled"
        )
          return fail();
        const hashes = {
          hashIntent: (value: string) =>
            parseDiningHash(createHash("sha256").update(value).digest("hex")),
          equals: (a: string, b: string) => a === b,
        };
        const association = createPostgresDiningExceptionTaskSource({
          scope: options.diningScope,
          hashes,
          authorizeAndFence: () => options.authorize(input.transaction, input),
        });
        const resolver = createDiningExceptionResolution({
          scope: options.diningScope,
          authorize: () => options.authorize(input.transaction, input),
          association: (tx: Input["transaction"], query) => association.load(tx, query),
          financial: async () => ({
            tenantReference: fact.tenantReference,
            brandReference: fact.brandReference,
            storeReference: fact.storeReference,
            orderReference: fact.orderReference,
            orderVersion: fact.orderVersion,
            observedAt: fact.decidedAt,
            financialClass: fact.classification,
            ownerFinalityReference: fact.finalityReference,
            ownerDecidedAt: fact.decidedAt,
          }),
        });
        let blocking = 0,
          unknown = false;
        const seen = new Set<string>(),
          taskOutcomes = [];
        for (const source of current.tasks.taskSources)
          for (const value of source.tasks) {
            const task = createTaskRecord(value);
            if (seen.has(task.taskReference)) return fail();
            seen.add(task.taskReference);
            if (task.severityCode !== "CRITICAL") continue;
            const outcome =
              task.taskType === "DINING_UNPAID_BATCH_EXCEPTION" &&
              task.source.sourceType === "DINING_SESSION"
                ? (
                    await resolver.resolve(input.transaction, {
                      task,
                      orderReference: execution.orderReference,
                      expectedOrderVersion: execution.orderVersion,
                      observedAt: execution.observedAt,
                    })
                  ).outcome
                : "Unknown";
            if (outcome === "Unknown") unknown = true;
            else if (outcome === "Blocking") blocking++;
            taskOutcomes.push(
              Object.freeze({
                taskReference: task.taskReference,
                taskVersion: task.version,
                outcome,
              }),
            );
          }
        const state = (phase: string) =>
          phase === "Submitted" ? "Pending" : phase === "Ready" ? "InProgress" : phase;
        const batchIds = [...new Set(execution.items.map((item) => item.orderBatchReference))];
        const evidence = Object.freeze({
          brandReference: execution.brandReference,
          storeReference: execution.storeReference,
          orderReference: execution.orderReference,
          orderVersion: execution.orderVersion,
          observedAt: execution.observedAt,
          inventoryComplete: execution.kitchenEvidenceComplete,
          batches: Object.freeze(
            batchIds.map((batchReference) =>
              Object.freeze({
                batchReference,
                state: state(
                  summarizeOrderItemProgress(
                    execution.items.filter((item) => item.orderBatchReference === batchReference),
                  ).phase,
                ),
              }),
            ),
          ),
          items: Object.freeze(
            execution.items.map((item) =>
              Object.freeze({
                itemReference: item.orderItemReference,
                batchReference: item.orderBatchReference,
                state: state(item.phase),
              }),
            ),
          ),
          fulfillmentState: ["Fulfilled", "Rejected", "Cancelled"].includes(execution.phase)
            ? execution.phase
            : "InProgress",
          pendingAmendmentCount: current.priced.pendingAmendmentCount,
          pendingCancellationCount: current.cancellation.pendingCount,
          criticalBlockingTaskCount: unknown ? null : blocking,
          financialFinality: Object.freeze({
            orderReference: fact.orderReference,
            class: fact.classification,
            ownerFinalityReference: fact.finalityReference,
            decidedAt: fact.decidedAt,
          }),
        });
        const decision = evaluateOrderClosureEligibility(evidence);
        if ((await options.authorize(input.transaction, input)) !== true) return fail();
        return Object.freeze({
          evidence,
          decision,
          taskOutcomes: Object.freeze(taskOutcomes),
          evidenceDigest:
            "sha256:" + createHash("sha256").update(canonicalizeRfc8785(evidence)).digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}
