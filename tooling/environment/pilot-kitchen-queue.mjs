import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { createPostgresKitchenQueueReadModel } from "../../packages/rms/kitchen/src/index.ts";
export function createInternalKitchenQueue(resources, { actorReference }) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_KITCHEN_ONLY");
  const scope = resources.scope,
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const next = () => {
    const d = randomUUID().replaceAll("-", "");
    return (
      "0190fa36-" +
      d.slice(0, 4) +
      "-7" +
      d.slice(4, 7) +
      "-8" +
      d.slice(7, 10) +
      "-" +
      d.slice(10, 22)
    );
  };
  const refs = {
    next,
    derive: (purpose, identity) => {
      const d = hash(purpose + ":" + identity).slice(7);
      return (
        "0190fa35-" +
        d.slice(0, 4) +
        "-7" +
        d.slice(4, 7) +
        "-8" +
        d.slice(7, 10) +
        "-" +
        d.slice(10, 22)
      );
    },
  };
  const lock = async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      scope.brandReference + ":" + scope.storeReference + ":kitchen_work_queue_v1",
    ]);
  };
  return createPostgresKitchenQueueReadModel({
    source: {
      ...scope,
      maxTickets: 100,
      maxItemsPerTicket: 100,
      maxOperationsPerTicket: 1000,
      creationValidation: { references: refs, digests: { sha256: hash } },
      lifecycleValidation: { references: refs, digests: { sha256: hash } },
      nextSnapshotReference: next,
      authorize: async () => active(),
    },
    maxRows: 10000,
    nextRebuildReference: next,
    authorizeProjection: async () => active(),
    authorizeQuery: async () => active(),
    ports: {
      authorization: {
        authorize: async (input) =>
          active() &&
          input.brandReference === scope.brandReference &&
          input.storeReference === scope.storeReference,
      },
      trustedContext: {
        resolveQueryAuthority: async () => ({
          ...scope,
          actorReference: actorReference,
          observedAt: resources.now(),
        }),
      },
      transactions: {
        withTransaction: (work) =>
          resources.transactions.run(async (tx) => {
            await lock(tx);
            return work(tx);
          }),
      },
      tenantContext: {
        install: async (input) => {
          if (
            input.brandReference !== scope.brandReference ||
            input.storeReference !== scope.storeReference ||
            !active()
          )
            throw new Error("INTERNAL_KITCHEN_SCOPE_DENIED");
        },
      },
      locks: { acquireStoreProjection: async ({ transaction }) => lock(transaction) },
      references: { nextGenerationReference: next },
      clock: { now: resources.now },
    },
  });
}
