import process from "node:process";
import { createHash } from "node:crypto";
import { createPostgresTaskStore } from "../../packages/bop/task/src/index.ts";
import {
  createPostgresDiningExceptionTaskCandidates,
  createPostgresDiningExceptionTaskSource,
  parseDiningReference,
  parseDiningInstant,
  parseDiningHash,
} from "../../packages/rms/dining/src/index.ts";
/** Current Task plus immutable Dining association, never a financial-clearance assertion. */
export function createInternalDiningExceptionPageRunner(resources, consume) {
  const deny = () => {
    throw Error("INTERNAL_DINING_EXCEPTIONS_UNAVAILABLE");
  };
  const binding = resources.publicProfile.binding;
  const scope = Object.freeze({
    tenantReference: String(parseDiningReference(binding.tenantReference)),
    brandReference: String(parseDiningReference(resources.scope.brandReference)),
    storeReference: String(parseDiningReference(resources.scope.storeReference)),
  });
  const until = parseDiningInstant(binding.validUntil);
  const active = () =>
    process.env.NODE_ENV === "development" && parseDiningInstant(resources.now()) < until;
  if (
    !active() ||
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return deny();
  const hashes = {
    hashIntent: (value) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  return async (input) => {
    if (!active()) return deny();
    return resources.transactions.run(async (tx) => {
      let open = true;
      const permitted = (t) => open && t === tx && active();
      const observedAt = parseDiningInstant(resources.now());
      const discover = createPostgresDiningExceptionTaskCandidates({
        scope,
        authorize: async (t, q) =>
          permitted(t) &&
          q.tenantReference === scope.tenantReference &&
          q.brandReference === scope.brandReference &&
          q.storeReference === scope.storeReference &&
          q.purpose === "ProjectOrderException",
      });
      try {
        const page = await discover(tx, input),
          items = [];
        for (const reference of page.items) {
          const tasks = createPostgresTaskStore({
            scope: {
              kind: "Store",
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            now: () => observedAt,
            transactions: {
              run: async (work) => {
                if (!permitted(tx)) return deny();
                return work(tx);
              },
            },
            authorizeAndFence: async (t, q) =>
              permitted(t) && q.operation === "Read" && q.taskReference === reference,
          });
          const task = await tasks.load(reference);
          if (
            !task ||
            task.taskReference !== reference ||
            task.scope.kind !== "Store" ||
            task.scope.brandReference !== scope.brandReference ||
            task.scope.storeReference !== scope.storeReference ||
            task.taskType !== "DINING_UNPAID_BATCH_EXCEPTION" ||
            task.source.sourceType !== "DINING_SESSION" ||
            task.updatedAt > observedAt
          )
            return deny();
          const source = createPostgresDiningExceptionTaskSource({
            scope,
            hashes,
            authorizeAndFence: async (t, value, at) =>
              permitted(t) && JSON.stringify(value) === JSON.stringify(task) && at === observedAt,
          });
          const association = await source.load(tx, { task, observedAt });
          if (
            !association ||
            association.taskReference !== reference ||
            association.taskVersion !== task.version ||
            association.tenantReference !== scope.tenantReference ||
            association.brandReference !== scope.brandReference ||
            association.storeReference !== scope.storeReference ||
            association.diningSessionReference !== task.source.sourceReference ||
            association.observedAt !== observedAt
          )
            return deny();
          items.push(Object.freeze({ task, association }));
        }
        if (!permitted(tx)) return deny();
        const result = Object.freeze({
          items: Object.freeze(items),
          nextAfterTaskReference: page.nextAfterTaskReference,
          observedAt,
        });
        const output = await consume({ tx, page: result, scope, authorize: () => permitted(tx) });
        if (!permitted(tx)) return deny();
        return output;
      } finally {
        open = false;
      }
    });
  };
}

/** Read-only wrapper; owner resolution may instead consume the retained transaction. */
export function createInternalDiningExceptions(resources) {
  return createInternalDiningExceptionPageRunner(resources, ({ page }) => page);
}
