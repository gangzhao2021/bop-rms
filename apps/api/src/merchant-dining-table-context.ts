import { createHash } from "node:crypto";
import {
  createPostgresDiningClosingStore,
  createPostgresDiningTableStore,
  parseDiningHash,
  parseDiningReference,
  type DiningTableStoreScope,
  type DiningTableTransaction,
} from "@rms/dining";
/** Observed table context only. A serving write must still fence and revalidate versions. */
export function createMerchantDiningTableContext(options: {
  scope: DiningTableStoreScope;
  authorize(): Promise<boolean>;
  allowClosedSession?: boolean;
  allowClosingSession?: boolean;
}) {
  return {
    async load(
      transaction: DiningTableTransaction,
      diningSessionReference: string,
      observedAt: string,
    ) {
      const reference = parseDiningReference(diningSessionReference);
      const fail = (): never => {
        throw new Error("DINING_TABLE_CONTEXT_UNAVAILABLE");
      };
      if ((await options.authorize()) !== true) return fail();
      const runner = {
        run: <T>(work: (tx: DiningTableTransaction) => Promise<T>) => work(transaction),
      };
      const sessions = createPostgresDiningClosingStore(runner, options.scope, {
        hashIntent: (value) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
        equals: (a, b) => a === b,
      });
      const tables = createPostgresDiningTableStore(runner, options.scope, {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      });
      const session = await sessions.load(reference);
      if (!session || session.startedAt > observedAt) return fail();
      const historical = options.allowClosedSession === true && session.phase === "Closed";
      if (
        !historical &&
        session.phase !== "Active" &&
        !(options.allowClosingSession === true && session.phase === "Closing")
      )
        return fail();
      const table = await tables.loadTable(session.tableReference);
      if (
        !table ||
        (!historical &&
          (table.activeDiningSessionReference !== reference ||
            table.lifecycle !== "Published" ||
            table.operationalState !== "Available")) ||
        table.observedAt > observedAt
      )
        return fail();
      const again = await sessions.load(reference),
        tableAgain = await tables.loadTable(session.tableReference);
      if (
        !again ||
        !tableAgain ||
        again.version !== session.version ||
        again.tableReference !== session.tableReference ||
        again.tableAssignmentVersion !== session.tableAssignmentVersion ||
        again.phase !== session.phase ||
        tableAgain.aggregateVersion !== table.aggregateVersion ||
        tableAgain.activeDiningSessionReference !== table.activeDiningSessionReference ||
        (await options.authorize()) !== true
      )
        return fail();
      return Object.freeze({
        diningSessionReference: reference,
        sessionPhase: session.phase,
        tableReference: session.tableReference,
        tableLabel: table.stableLabel,
        sessionVersion: session.version,
        tableAssignmentVersion: session.tableAssignmentVersion,
        tableVersion: table.aggregateVersion,
      });
    },
  };
}
