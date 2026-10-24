import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningTableReleaseStore,
  createPostgresDiningClosingFence,
  createPostgresDiningTableStore,
  releaseClosedDiningSession,
  parseDiningTableReleaseRecord,
  parseDiningInstant,
  parseDiningReference,
  parsePositiveDiningVersion,
} from "@rms/dining";
const fail = (): never => {
  throw new Error("DINING_TABLE_RELEASE_UNAVAILABLE");
};
export function createDiningTableReleaseComposition(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  actorReference: string;
  authorize(): Promise<boolean>;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const hashes = {
    hashIntent: (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex"),
    equals: (a: string, b: string) => a === b,
  };
  return async (
    tx: ConsumerTransaction,
    input: {
      diningSessionReference: string;
      operationReference: string;
      expectedSessionVersion: number;
      observedAt: string;
    },
  ) => {
    const query = {
        diningSessionReference: parseDiningReference(input.diningSessionReference),
        operationReference: parseDiningReference(input.operationReference),
        observedAt: parseDiningInstant(input.observedAt),
      },
      expectedVersion = parsePositiveDiningVersion(input.expectedSessionVersion);
    if ((await options.authorize()) !== true) return fail();
    const store = createPostgresDiningTableReleaseStore({
      scope: options.scope,
      hashes,
      authorize: options.authorize,
    });
    const prior = await store.readReceipt(tx, query, options.authorize);
    if (prior) {
      if (prior.command.expectedSessionVersion !== expectedVersion) return fail();
      return store.commit(tx, prior);
    }
    const session = await createPostgresDiningClosingFence({
      scope: options.scope,
      authorize: options.authorize,
    })(tx, query);
    if (session.phase !== "Closed" || session.version !== expectedVersion) return fail();
    const table = await createPostgresDiningTableStore(
      { run: (work) => work(tx) },
      options.scope,
      hashes,
    ).loadTable(session.tableReference);
    if (!table) return fail();
    const afterTable = releaseClosedDiningSession(session, table, query.observedAt);
    const command = {
      ...query,
      tableReference: table.tableReference,
      expectedSessionVersion: session.version,
      expectedTableVersion: table.aggregateVersion,
    };
    const record = parseDiningTableReleaseRecord(
      {
        command,
        intentDigest: hashes.hashIntent(canonicalizeRfc8785({ ...options.scope, ...command })),
        session,
        beforeTable: table,
        afterTable,
        audit: {
          auditId: options.newReference(),
          brandId: options.scope.brandReference,
          storeId: options.scope.storeReference,
          actor: { type: "User", reference: parseDiningReference(options.actorReference) },
          actionCode: "DINING_TABLE_RELEASED",
          targetType: "DiningTable",
          targetId: table.tableReference,
          reasonCode: "CLOSED_SESSION_RELEASE",
          correlationId: query.operationReference,
          occurredAt: query.observedAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Restricted",
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        },
      },
      hashes,
    );
    if ((await options.authorize()) !== true) return fail();
    return store.commit(tx, record);
  };
}
