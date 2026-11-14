import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  parseProductLifecycle,
  productCategoryAssignmentFields,
  productEditorContentFields,
  type ProductCategoryAssignmentAuthority,
  type ProductEditorContentAuthority,
} from "@rms/catalog";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";
import type { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
type Intent = ReturnType<typeof resolveMerchantProductLifecycleIntent>;
interface Command {
  readonly productReference: string;
  readonly skuReference: string | null;
  readonly targetLifecycle: Intent["targetLifecycle"];
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const fieldsEqual = (value: unknown, expected: readonly string[]) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((field, index) => value[index] === field);

/** Fixed current lifecycle admission. Read holders authorize original
 * and resulting recorded content; they never reassess publication eligibility. */
export function createMerchantProductLifecycleRuntimeAuthority(options: {
  readonly transaction: Transaction;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly command: Command;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization>;
  readonly capability: ReturnType<typeof createMerchantProductStoreCapabilityGuard>;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}) {
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    register = options.registerBeforeCommit.bind(options),
    authorize = options.currentAuthorization.authorizeActions.bind(options.currentAuthorization),
    assertAuthorization = options.currentAuthorization.assertCurrent.bind(
      options.currentAuthorization,
    ),
    holdCapability = options.capability.holdUntilCommit.bind(options.capability),
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    product = parseCatalogReference(options.command.productReference),
    sku =
      options.command.skuReference === null
        ? null
        : parseCatalogReference(options.command.skuReference),
    target = parseProductLifecycle(options.command.targetLifecycle),
    kind = sku === null ? "Product" : "Sku",
    startedAt = parseCatalogInstant(now()),
    deadline = parseCatalogInstant(options.originalValidUntil);
  if (deadline <= startedAt || Date.parse(deadline) - Date.parse(startedAt) > 5000) return fail();
  let latest = startedAt,
    failed = false,
    active = false,
    registered = false,
    guardCompleted = false,
    committing = false,
    finalized = false;
  let intent: Intent | null = null;
  const versions = new Set<string>();
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return poison();
      assertAuthorization();
      latest = at;
      return at;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const current = async (read = false) => {
    check();
    await holdCapability();
    check();
    // The Brand authority is last: owning Catalog SQL must not inherit the
    // selected Store context used by the FeatureControl evaluation.
    if (
      (await authorize([
        "catalog.manage",
        "catalog.product.manage",
        ...(read ? ["catalog.product.read", "catalog.sku.read"] : []),
        ...(intent ? [intent.actionPermission] : []),
      ])) !== undefined
    )
      return poison();
    check();
  };
  const protectedHold = async (read = false) => {
    if (active || finalized) return poison();
    active = true;
    try {
      await current(read);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      active = false;
    }
  };
  const assertCurrent = () => {
    check();
    if (active) return poison();
  };
  const parseReadAggregate = (value: unknown) => {
    const aggregate = parseProductAggregate(value);
    if (aggregate.productReference !== product || aggregate.brandReference !== brand)
      return poison();
    versions.add(aggregate.draft.versionReference);
    return aggregate;
  };
  const editorContentAuthority = Object.freeze<ProductEditorContentAuthority>({
    async holdUntilTransactionCompletes(actual, value) {
      try {
        check();
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]);
        if (
          actual !== tx ||
          input.mode !== "Read" ||
          !fieldsEqual(input.requiredFields, productEditorContentFields) ||
          !fieldsEqual(input.requiredReferenceChecks, [])
        )
          return poison();
        parseReadAggregate(input.aggregate);
        await protectedHold(true);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
  const categoryPolicy: MerchantProductCategoryPolicy = async (actual, value) => {
    try {
      check();
      const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "productReference",
          "productVersionReference",
          "purposeCode",
          "permission",
          "referencedPermission",
          "requiredFields",
          "referencedFields",
          "observedAt",
        ]),
        at = parseCatalogInstant(input.observedAt);
      if (
        actual !== tx ||
        input.tenantReference !== tenant ||
        input.brandReference !== brand ||
        input.actorReference !== actor ||
        input.productReference !== product ||
        typeof input.productVersionReference !== "string" ||
        !versions.has(input.productVersionReference) ||
        input.purposeCode !== "CATALOG_PRODUCT_CATEGORY_ACCESS" ||
        input.permission !== "catalog.product.manage" ||
        input.referencedPermission !== "catalog.manage" ||
        !fieldsEqual(input.requiredFields, productCategoryAssignmentFields) ||
        !fieldsEqual(input.referencedFields, [
          "categoryReference",
          "brandReference",
          "lifecycle",
        ]) ||
        at < startedAt ||
        at > check()
      )
        return poison();
      await protectedHold(true);
      return Object.freeze({ allowedLifecycles: Object.freeze([]) });
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const categoryDelegate =
    createMerchantProductCategoryAssignments({
      transaction: tx,
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      now: check,
      policy: categoryPolicy,
      registerBeforeCommit: register,
    }) ?? fail();
  let categoryActive = false;
  const categoryAssignments = Object.freeze<ProductCategoryAssignmentAuthority>({
    async holdUntilTransactionCompletes(actual, value) {
      try {
        check();
        if (categoryActive || finalized || actual !== tx) return poison();
        categoryActive = true;
        const input = readClosedRecord(copyCategoryPersistenceValue(value), ["mode", "aggregate"]);
        if (input.mode !== "Read") return poison();
        const aggregate = parseReadAggregate(input.aggregate);
        if (aggregate.draft.categoryClassification === undefined) return poison();
        await categoryDelegate.holdUntilTransactionCompletes(actual, { mode: "Read", aggregate });
        check();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        categoryActive = false;
      }
    },
  });
  return Object.freeze({
    editorContentAuthority,
    categoryAssignments,
    assertCurrent,
    hold: () => protectedHold(),
    async bindIntent(value: unknown) {
      try {
        check();
        if (intent !== null || finalized) return poison();
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "kind",
            "action",
            "actionPermission",
            "beforeLifecycle",
            "targetLifecycle",
          ]),
          resolved = resolveMerchantProductLifecycleIntent(
            kind,
            input.beforeLifecycle,
            input.targetLifecycle,
          );
        if (
          input.kind !== kind ||
          input.targetLifecycle !== target ||
          input.action !== resolved.action ||
          input.actionPermission !== resolved.actionPermission
        )
          return poison();
        intent = resolved;
        await protectedHold();
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async holdAndRegister() {
      try {
        if (registered || finalized) return poison();
        registered = true;
        await register(
          tx,
          async () => {
            if (committing || intent === null || categoryActive) return poison();
            committing = true;
            await protectedHold(true);
            guardCompleted = true;
          },
          () => {
            assertCurrent();
            if (finalized || !guardCompleted || categoryActive || intent === null) return poison();
            finalized = true;
          },
        );
        await protectedHold();
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
}
