import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseProductAggregate,
  createPostgresProductCategoryAssignmentAuthority,
  type ProductCategoryAssignmentAuthority,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
export type MerchantProductCategoryPolicy = Parameters<
  typeof createPostgresProductCategoryAssignmentAuthority
>[0]["holdPolicyUntilTransactionCompletes"];
/** Current independent fields/lifecycle policy is mandatory for classified reads/writes. */
export function createMerchantProductCategoryAssignments(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly now: () => string;
  readonly policy: MerchantProductCategoryPolicy | undefined;
  readonly registerBeforeCommit: ReturnType<
    typeof createMerchantCategoryTransactions
  >["registerBeforeCommit"];
}): ProductCategoryAssignmentAuthority | undefined {
  if (options.policy === undefined) return undefined;
  const delegate = createPostgresProductCategoryAssignmentAuthority({
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    actorReference: options.actorReference,
    clock: { now: options.now },
    holdPolicyUntilTransactionCompletes: options.policy,
  });
  const pending = new Map<
    string,
    Parameters<ProductCategoryAssignmentAuthority["holdUntilTransactionCompletes"]>[1]
  >();
  let registered = false;
  return Object.freeze({
    async holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      value: Parameters<ProductCategoryAssignmentAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      if (tx !== options.transaction) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), ["mode", "aggregate"]);
      if (raw.mode !== "Read" && raw.mode !== "Write")
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const input = Object.freeze({
        mode: raw.mode,
        aggregate: parseProductAggregate(raw.aggregate),
      });
      await delegate.holdUntilTransactionCompletes(tx, input);
      // Separate read/replay from mutation: a final Read must never discard held Write validation.
      pending.set(input.mode + ":" + input.aggregate.draft.versionReference, input);
      if (!registered) {
        await options.registerBeforeCommit(tx, async () => {
          for (const current of pending.values())
            await delegate.holdUntilTransactionCompletes(tx, current);
        });
        registered = true;
      }
    },
  });
}
