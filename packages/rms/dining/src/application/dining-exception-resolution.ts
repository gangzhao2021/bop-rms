import { createTaskRecord } from "@bop/task";
import {
  exactObject,
  parsePositiveDiningVersion,
  DiningClosingError,
  diningFinancialClasses,
} from "../contracts/dining-closing.js";
import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningHash,
} from "../contracts/dining-session.js";
const fail = (): never => {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
};
/** Ports provide current owner facts under retained transaction fences. Task status
 * is not financial truth. Clearance can precede Order Close; another Order remains
 * independently unresolved even when its task does not block this Order. */
export function createDiningExceptionResolution<Transaction>(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  authorize(tx: Transaction, task: ReturnType<typeof createTaskRecord>): Promise<boolean>;
  association(tx: Transaction, input: { task: unknown; observedAt: string }): Promise<unknown>;
  financial(
    tx: Transaction,
    input: { orderReference: string; observedAt: string },
  ): Promise<unknown>;
}) {
  const scope = {
    tenantReference: parseDiningReference(options.scope.tenantReference),
    brandReference: parseDiningReference(options.scope.brandReference),
    storeReference: parseDiningReference(options.scope.storeReference),
  };
  return Object.freeze({
    async resolve(
      tx: Transaction,
      input: {
        task: unknown;
        orderReference: string;
        expectedOrderVersion: number;
        observedAt: string;
      },
    ) {
      try {
        const orderVersion = parsePositiveDiningVersion(input.expectedOrderVersion);
        const task = createTaskRecord(input.task),
          orderReference = parseDiningReference(input.orderReference),
          observedAt = parseDiningInstant(input.observedAt);
        if (
          task.scope.kind !== "Store" ||
          String(task.scope.brandReference) !== scope.brandReference ||
          String(task.scope.storeReference) !== scope.storeReference ||
          task.taskType !== "DINING_UNPAID_BATCH_EXCEPTION" ||
          task.source.sourceType !== "DINING_SESSION" ||
          String(task.updatedAt) > observedAt
        )
          return fail();
        const authorize = async () => {
          if ((await options.authorize(tx, task)) !== true) return fail();
        };
        await authorize();
        const result = async (
          outcome: "Unknown" | "NotApplicable" | "Blocking" | "Cleared",
          ownerFinalityReference: string | null = null,
        ) => {
          await authorize();
          return Object.freeze({
            ...scope,
            orderReference,
            orderVersion,
            taskReference: task.taskReference,
            taskVersion: task.version,
            observedAt,
            outcome,
            ownerFinalityReference,
          });
        };
        const value = await options.association(tx, { task, observedAt });
        if (value === null) return await result("Unknown");
        const link = exactObject(value, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "orderReference",
          "evidenceVersion",
          "evidenceDigest",
          "intentHash",
          "taskReference",
          "taskVersion",
          "requestedAt",
          "observedAt",
        ]);
        if (
          link.tenantReference !== scope.tenantReference ||
          link.brandReference !== scope.brandReference ||
          link.storeReference !== scope.storeReference ||
          link.taskReference !== task.taskReference ||
          link.taskVersion !== task.version ||
          link.diningSessionReference !== String(task.source.sourceReference) ||
          link.observedAt !== observedAt ||
          parseDiningInstant(link.requestedAt) > observedAt ||
          task.source.snapshotDigest !== `sha256:${parseDiningHash(link.evidenceDigest)}`
        )
          return fail();
        parsePositiveDiningVersion(link.evidenceVersion);
        parseDiningHash(link.intentHash);
        const linkedOrder = parseDiningReference(link.orderReference);
        if (linkedOrder !== orderReference) return await result("NotApplicable");
        const financial = await options.financial(tx, { orderReference, observedAt });
        if (financial === null) return await result("Unknown");
        const fact = exactObject(financial, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "orderReference",
          "orderVersion",
          "observedAt",
          "financialClass",
          "ownerFinalityReference",
          "ownerDecidedAt",
        ]);
        if (
          fact.tenantReference !== scope.tenantReference ||
          fact.brandReference !== scope.brandReference ||
          fact.storeReference !== scope.storeReference ||
          fact.orderReference !== orderReference ||
          fact.observedAt !== observedAt ||
          typeof fact.financialClass !== "string" ||
          !diningFinancialClasses.includes(
            fact.financialClass as (typeof diningFinancialClasses)[number],
          )
        )
          return fail();
        if (parsePositiveDiningVersion(fact.orderVersion) !== orderVersion) return fail();
        if (fact.financialClass === "Unpaid" || fact.financialClass === "Indeterminate") {
          if (fact.ownerFinalityReference !== null || fact.ownerDecidedAt !== null) return fail();
          return await result("Blocking");
        }
        const reference = parseDiningReference(fact.ownerFinalityReference);
        if (parseDiningInstant(fact.ownerDecidedAt) > observedAt) return fail();
        return await result("Cleared", reference);
      } catch {
        return fail();
      }
    },
  });
}
