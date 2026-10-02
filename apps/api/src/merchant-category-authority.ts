import {
  createTenantContext,
  createPostgresMerchantOrganizationSource,
  parseStoreReference,
  type TenantContext,
} from "@bop/tenant";
import { createPostgresCurrentMembershipSource, resolveActiveMembership } from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  copyCategoryPersistenceValue,
  parseCategoryOperationRecord,
  categoryPersistenceFields,
  categoryTreeViewFields,
  categoryTreeMenuViewFields,
  menuCategorySourceFields,
  type MenuCategorySourceAuthority,
  type CategoryPersistenceAuthority,
  type CategorySourceAuthority,
  type CategoryTreeViewAuthority,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type Transaction = Parameters<CategoryPersistenceAuthority["holdUntilTransactionCompletes"]>[0];
type Request =
  | Parameters<CategoryPersistenceAuthority["holdUntilTransactionCompletes"]>[1]
  | Parameters<CategorySourceAuthority["holdUntilTransactionCompletes"]>[1]
  | Parameters<CategoryTreeViewAuthority["holdUntilTransactionCompletes"]>[1]
  | Parameters<MenuCategorySourceAuthority["holdUntilTransactionCompletes"]>[1];
export interface MerchantCategoryFieldPhaseLease {
  readonly tenantReference: string;
  readonly storeContext: TenantContext;
  readonly brandContext: TenantContext;
  readonly purposeCode: Request["purposeCode"];
  readonly screenId: "CAT-CATEGORY-TREE";
  readonly capability: "catalog.cat_category_tree";
  readonly phase: "phase_1";
  readonly requiredFields:
    | typeof categoryPersistenceFields
    | typeof categoryTreeViewFields
    | typeof categoryTreeMenuViewFields
    | typeof menuCategorySourceFields;
  readonly referencedCapabilities: readonly [] | readonly ["catalog.cat_product_list"];
  readonly activeRoleCodes: readonly string[];
  readonly categoryReference: string | null;
  readonly observedAt: string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
function request(value: unknown): Request {
  const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("CATALOG_INPUT_INVALID");
  const write = raw.purposeCode === "CATALOG_CATEGORY_PERSISTENCE";
  const tree = raw.purposeCode === "CATALOG_CATEGORY_TREE_VIEW_READ";
  const menu = raw.purposeCode === "CATALOG_MENU_CATEGORY_SOURCE_READ";
  const extended =
    tree && JSON.stringify(raw.requiredFields) === JSON.stringify(categoryTreeMenuViewFields);
  const fields = menu
    ? menuCategorySourceFields
    : tree
      ? extended
        ? categoryTreeMenuViewFields
        : categoryTreeViewFields
      : categoryPersistenceFields;
  const keys = [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purposeCode",
    "permission",
    "capability",
    "requiredFields",
    "observedAt",
    ...(write ? ["domainPermission", "categoryReference", "record"] : []),
    ...(tree ? ["referencedCapability"] : []),
  ];
  if (
    Object.keys(raw).length !== keys.length ||
    Object.keys(raw).some((key) => !keys.includes(key)) ||
    (!write && !tree && !menu && raw.purposeCode !== "CATALOG_CATEGORY_SOURCE_READ") ||
    (tree && raw.referencedCapability !== "catalog.cat_product_list") ||
    raw.permission !== "catalog.manage" ||
    raw.capability !== "catalog.cat_category_tree" ||
    JSON.stringify(raw.requiredFields) !== JSON.stringify(fields)
  )
    return fail("CATALOG_INPUT_INVALID");
  const base = {
    tenantReference: parseCatalogReference(raw.tenantReference),
    brandReference: parseCatalogReference(raw.brandReference),
    actorReference: parseCatalogReference(raw.actorReference),
    permission: "catalog.manage" as const,
    capability: "catalog.cat_category_tree" as const,
    requiredFields: categoryPersistenceFields,
    observedAt: parseCatalogInstant(raw.observedAt),
  };
  if (tree)
    return Object.freeze({
      ...base,
      purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ",
      referencedCapability: "catalog.cat_product_list",
      requiredFields: extended ? categoryTreeMenuViewFields : categoryTreeViewFields,
    });
  if (menu)
    return Object.freeze({
      ...base,
      purposeCode: "CATALOG_MENU_CATEGORY_SOURCE_READ",
      requiredFields: menuCategorySourceFields,
    });
  if (!write) return Object.freeze({ ...base, purposeCode: "CATALOG_CATEGORY_SOURCE_READ" });
  if (raw.domainPermission !== "catalog.category.manage") return fail("CATALOG_INPUT_INVALID");
  const categoryReference =
      raw.categoryReference === null ? null : parseCatalogReference(raw.categoryReference),
    record = raw.record === null ? null : parseCategoryOperationRecord(raw.record);
  if (
    record &&
    (record.aggregate.brandReference !== base.brandReference ||
      record.aggregate.categoryReference !== categoryReference ||
      record.aggregate.updatedAt > base.observedAt)
  )
    return fail("CATALOG_PERMISSION_DENIED");
  return Object.freeze({
    ...base,
    purposeCode: "CATALOG_CATEGORY_PERSISTENCE",
    domainPermission: "catalog.category.manage",
    categoryReference,
    record,
  });
}
/** API composition only. Real owner readers hold session/selection/organization/
 * Membership/Permission locks in this same borrowed transaction. Fields/Phase
 * owner leases and host COMMIT validation are mandatory; neither has a default.
 * Host must execute registered checks before COMMIT and roll back on failure. */
export function createMerchantCategoryAuthority(options: {
  readonly source: PersistentMerchantBffOptions;
  readonly sessionCookie: unknown;
  readonly sessionReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  holdFieldsAndPhaseUntilCommit(
    tx: Transaction,
    input: MerchantCategoryFieldPhaseLease,
  ): Promise<void>;
  registerBeforeCommit(tx: Transaction, check: () => Promise<void>): Promise<void>;
}): CategoryPersistenceAuthority &
  CategorySourceAuthority &
  CategoryTreeViewAuthority &
  MenuCategorySourceAuthority {
  const tenant: string = parseCatalogReference(options.tenantReference),
    brand: string = parseCatalogReference(options.brandReference),
    store: string = parseCatalogReference(options.storeReference),
    actor: string = parseCatalogReference(options.actorReference),
    session: string = parseCatalogReference(options.sessionReference);
  if (
    typeof options.holdFieldsAndPhaseUntilCommit !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const resolveStore = createMerchantStoreScope(options.source),
    latest = new WeakMap<Transaction, Map<string, Request>>(),
    registered = new WeakSet<Transaction>();
  const evaluate = async (tx: Transaction, input: Request) => {
    if (
      input.tenantReference !== tenant ||
      input.brandReference !== brand ||
      input.actorReference !== actor
    )
      return fail("CATALOG_PERMISSION_DENIED");
    const selected = await resolveStore(tx, options.sessionCookie, "merchant.access", session);
    const selectedContext = selected.context;
    const actorReference = selectedContext.actor.actorReference;
    if (actorReference === null) return fail("CATALOG_PERMISSION_DENIED");
    if (
      selected.selected.tenantReference !== tenant ||
      selectedContext.brand.brandReference !== brand ||
      selectedContext.store?.storeReference !== store ||
      selected.actorReference !== actor ||
      selected.sessionReference !== session ||
      selectedContext.resolvedAt < input.observedAt ||
      !(await selected.allowed())
    )
      return fail("CATALOG_PERMISSION_DENIED");
    const currentAt = parseCatalogInstant(options.source.now());
    if (currentAt < parseCatalogInstant(selectedContext.resolvedAt) || currentAt < input.observedAt)
      return fail();
    const context = createTenantContext(
      selectedContext.actor,
      selectedContext.brand,
      selectedContext.store,
      currentAt,
    );
    const brandContext = createTenantContext(
      context.actor,
      context.brand,
      null,
      context.resolvedAt,
    );
    // Membership requires current Store context; Brand policy receives no Store assignment.
    const memberships = createPostgresCurrentMembershipSource(tx, context);
    const membership = resolveActiveMembership(
      await memberships.findMemberships(actorReference, context.brand.brandReference),
      actorReference,
      context.brand.brandReference,
      context.resolvedAt,
    );
    const policy = createPostgresCurrentPermissionPolicySource(tx);
    const authorize = async (action: string) => {
      const result = await policy.authorizeWithRoles({
        tenantContext: brandContext,
        membership,
        storeAssignment: null,
        action,
      });
      if (
        result.decision.effect !== "Allow" ||
        result.decision.scopeKind !== "Brand" ||
        result.decision.action !== action
      )
        return fail("CATALOG_PERMISSION_DENIED");
      return result;
    };
    const granted = await authorize("catalog.manage");
    if (input.purposeCode === "CATALOG_CATEGORY_PERSISTENCE")
      await authorize(input.domainPermission);
    else {
      await authorize("catalog.category.read");
      if (input.purposeCode === "CATALOG_CATEGORY_TREE_VIEW_READ")
        await authorize("catalog.product.read");
    }
    const categoryReference =
      input.purposeCode === "CATALOG_CATEGORY_PERSISTENCE" ? input.categoryReference : null;
    await options.holdFieldsAndPhaseUntilCommit(
      tx,
      Object.freeze({
        tenantReference: tenant,
        storeContext: context,
        brandContext,
        purposeCode: input.purposeCode,
        screenId: "CAT-CATEGORY-TREE",
        capability: "catalog.cat_category_tree",
        phase: "phase_1",
        requiredFields: input.requiredFields,
        referencedCapabilities:
          input.purposeCode === "CATALOG_CATEGORY_TREE_VIEW_READ"
            ? Object.freeze(["catalog.cat_product_list"] as const)
            : Object.freeze([] as const),
        activeRoleCodes: granted.activeRoleCodes,
        categoryReference,
        observedAt: context.resolvedAt,
      }),
    );
    if (input.purposeCode === "CATALOG_CATEGORY_PERSISTENCE" && input.record)
      for (const ref of input.record.aggregate.storeReferences) {
        const organizations = createPostgresMerchantOrganizationSource(tx, {
          brandReference: brand,
          storeReference: ref,
          observedAt: context.resolvedAt,
        });
        const target = await organizations.getStore(parseStoreReference(ref));
        if (
          !target ||
          target.brandReference !== brand ||
          String(target.storeReference) !== String(ref) ||
          target.lifecycle !== "Active"
        )
          return fail("CATALOG_PERMISSION_DENIED");
      }
  };
  return Object.freeze({
    async holdUntilTransactionCompletes(tx: Transaction, value: Request) {
      const input = request(value);
      try {
        await evaluate(tx, input);
        const scopes = latest.get(tx) ?? new Map<string, Request>();
        const key = JSON.stringify({ ...input, observedAt: null });
        if (!scopes.has(key) && scopes.size >= 64) return fail();
        scopes.set(key, input);
        latest.set(tx, scopes);
        if (!registered.has(tx)) {
          await options.registerBeforeCommit(tx, async () => {
            try {
              const scopes = latest.get(tx);
              if (!scopes) return fail();
              // Preserve every write purpose/target even if a later source read occurs.
              for (const pending of scopes.values())
                await evaluate(
                  tx,
                  request({ ...pending, observedAt: parseCatalogInstant(options.source.now()) }),
                );
            } catch (error) {
              if (error instanceof CatalogError) throw error;
              return fail();
            }
          });
          registered.add(tx);
        }
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
