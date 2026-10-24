import { createTaskRecord } from "@bop/task";
import { createDiningExceptionResolution } from "./dining-exception-resolution.js";
import {
  exactObject,
  parsePositiveDiningVersion,
  DiningClosingError,
} from "../contracts/dining-closing.js";
import { parseDiningInstant, parseDiningReference } from "../contracts/dining-session.js";
type CurrentOptions<T> = Parameters<typeof createDiningExceptionResolution<T>>[0];
const fail = (): never => {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
};
/** Resolves the original exception episode from committed historical owner facts.
 * Does not clear present-day Order blockers after a later Reopen/refund. */
export function createDiningExceptionEpisodeResolution<Transaction>(
  options: Omit<CurrentOptions<Transaction>, "financial"> & {
    closure(
      tx: Transaction,
      input: { orderReference: string; requestedAt: string; observedAt: string },
    ): Promise<unknown>;
  },
) {
  return Object.freeze({
    async resolve(
      tx: Transaction,
      input: Parameters<
        ReturnType<typeof createDiningExceptionResolution<Transaction>>["resolve"]
      >[1],
    ) {
      try {
        let association: unknown = null;
        const validator = createDiningExceptionResolution<Transaction>({
          ...options,
          association: async (t, query) => {
            association = await options.association(t, query);
            return association;
          },
          financial: async () => null,
        });
        const current = await validator.resolve(tx, input);
        const unresolved = (outcome: "UnresolvedEpisode" | "NotApplicable" = "UnresolvedEpisode") =>
          Object.freeze({
            ...current,
            outcome,
            closureReference: null,
            historicalOrderVersion: null,
            resolvedAt: null,
          });
        if (current.outcome === "NotApplicable") return unresolved("NotApplicable");
        if (association === null) return unresolved();
        const link = association as { requestedAt: unknown };
        const requestedAt = parseDiningInstant(link.requestedAt);
        const value = await options.closure(tx, {
          orderReference: current.orderReference,
          requestedAt,
          observedAt: current.observedAt,
        });
        // Recheck the current Task authority after the historical owner query.
        if ((await options.authorize(tx, createTaskRecord(input.task))) !== true) return fail();
        if (value === null) return unresolved();
        const raw = exactObject(value, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "orderReference",
          "orderVersion",
          "closureReference",
          "closureVersion",
          "closedAt",
          "ownerFinalityReference",
          "ownerDecidedAt",
          "observedAt",
        ]);
        if (
          raw.tenantReference !== current.tenantReference ||
          raw.brandReference !== current.brandReference ||
          raw.storeReference !== current.storeReference ||
          raw.orderReference !== current.orderReference ||
          raw.observedAt !== current.observedAt
        )
          return fail();
        const version = parsePositiveDiningVersion(raw.orderVersion);
        parsePositiveDiningVersion(raw.closureVersion);
        const closureReference = parseDiningReference(raw.closureReference),
          ownerFinalityReference = parseDiningReference(raw.ownerFinalityReference),
          closedAt = parseDiningInstant(raw.closedAt),
          decidedAt = parseDiningInstant(raw.ownerDecidedAt);
        if (version > current.orderVersion || decidedAt > closedAt || closedAt > current.observedAt)
          return fail();
        if (closedAt <= requestedAt || decidedAt <= requestedAt) return unresolved();
        return Object.freeze({
          ...current,
          outcome: "ResolvedEpisode" as const,
          closureReference,
          historicalOrderVersion: version,
          ownerFinalityReference,
          resolvedAt: closedAt,
        });
      } catch {
        return fail();
      }
    },
  });
}
