import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
  type createPostgresTransactionCurrentPermissionPolicySource,
} from "@bop/permission";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "@rms/catalog";
import type { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createInitiallyAuthorizedMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Private server capability. The browser cookie never leaves this closure. */
export interface MerchantProductCurrentAuthorization {
  /** Observation only; never an Allow. Optional for legacy ports, mandatory for Option admission. */
  leaseDeadline?(): string;
  authorizeActions(actions: readonly string[]): Promise<void>;
  /** Fresh full owning evidence, detached from its source; not a cached grant. */
  authorizeActionsWithDecisions?(
    actions: readonly string[],
  ): Promise<readonly PermissionDecision[]>;
  withCurrentStoreScope<T>(
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly capabilityKey: string;
      readonly observedAt: string;
    },
    work: (context: TenantContext) => Promise<T>,
  ): Promise<T>;
}
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantBrandScope>>>;
type Transaction = Parameters<ReturnType<typeof createMerchantBrandScope>>[0];

/** Bind real session/selection and Brand policy reads to one original transaction
 * and deadline. Construction captures ports only; it performs no source reads. */
export function createMerchantProductCurrentAuthorization(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly transaction: Transaction;
  readonly scope: Scope;
  readonly sessionCookie: unknown;
  readonly sessionReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly permissionPolicy?: ReturnType<
    typeof createPostgresTransactionCurrentPermissionPolicySource
  >;
  readonly capabilityKey?:
    | "catalog.cat_product_list"
    | "catalog.cat_product_create"
    | "catalog.cat_product_detail"
    | "catalog.cat_product_edit"
    | "catalog.cat_optionset_list"
    | "catalog.cat_optionset_create"
    | "catalog.cat_optionset_detail"
    | "catalog.cat_optionset_edit"
    | "catalog.cat_sku_detail"
    | "pricing.price_book_list"
    | "pricing.price_book_editor";
}): MerchantProductCurrentAuthorization & {
  assertCurrent(): ReturnType<typeof parseCatalogInstant>;
} {
  const permissionPolicy = options.permissionPolicy;
  const tx = options.transaction,
    query = tx.query,
    now = options.clock.now.bind(options.clock),
    startedAt = parseCatalogInstant(now()),
    validUntil = parseCatalogInstant(options.originalValidUntil),
    sessionCookie = options.sessionCookie,
    sessionReference = parseCatalogReference(options.sessionReference),
    tenantReference = parseCatalogReference(options.scope.tenantReference),
    brandReference = parseCatalogReference(options.scope.context.brand.brandReference),
    actorReference = parseCatalogReference(options.scope.actorReference),
    storeReference = parseCatalogReference(options.scope.selectedStoreReference),
    capabilityKey = options.capabilityKey ?? "catalog.cat_product_edit",
    authorize = options.scope.authorizeActionsWithValidity?.bind(options.scope),
    merchant = Object.freeze({
      ...options.merchant,
      now: options.merchant.now?.bind(options.merchant),
      validateAssociation: options.merchant.validateAssociation?.bind(options.merchant),
      currentActor: options.merchant.currentActor?.bind(options.merchant),
    });
  let failed = false,
    latest = startedAt,
    deadline: string = validUntil,
    authorizationBusy = false;
  const fail = (
    code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new CatalogError(code);
  };
  if (
    ![
      "catalog.cat_product_list",
      "catalog.cat_product_create",
      "catalog.cat_product_detail",
      "catalog.cat_product_edit",
      "catalog.cat_optionset_list",
      "catalog.cat_optionset_create",
      "catalog.cat_optionset_detail",
      "catalog.cat_optionset_edit",
      "catalog.cat_sku_detail",
      "pricing.price_book_list",
      "pricing.price_book_editor",
    ].includes(capabilityKey) ||
    validUntil <= startedAt ||
    Date.parse(validUntil) - Date.parse(startedAt) > 5000
  )
    return fail();
  const assertCurrent = () => {
    try {
      const at = parseCatalogInstant(now());
      if (
        failed ||
        tx.query !== query ||
        options.permissionPolicy !== permissionPolicy ||
        at < latest ||
        at >= deadline
      )
        return fail();
      latest = at;
      return at;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const bindBoundary = (value: unknown) => {
    try {
      if (value !== null) {
        const boundary = parseCatalogInstant(value);
        if (boundary < deadline) deadline = boundary;
      }
      assertCurrent();
    } catch {
      return fail();
    }
  };
  const protect = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      assertCurrent();
      const value = await work();
      assertCurrent();
      return value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail(
        error instanceof BrowserSessionError ||
          (error instanceof Error &&
            ["STORE_SERVICE_PERMISSION_DENIED", "BRAND_SERVICE_PERMISSION_DENIED"].includes(
              error.message,
            ))
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
    }
  };
  function fullDecision(value: unknown, action: string): PermissionDecision {
    const row = readClosedRecord(value, [
        "effect",
        "reason",
        "source",
        "action",
        "scopeKind",
        "policySnapshotReference",
        "policyVersion",
        "audit",
      ]),
      audit = readClosedRecord(row.audit, ["effect", "reason", "source"]);
    if (row.effect !== "Allow" || row.scopeKind !== "Brand" || row.action !== action)
      return fail("CATALOG_PERMISSION_DENIED");
    if (row.reason !== "EXPLICIT_ALLOW" && row.reason !== "ROLE_PERMISSION") return fail();
    if (row.source !== "ExplicitAllow" && row.source !== "RolePermission") return fail();
    if ((row.reason === "EXPLICIT_ALLOW") !== (row.source === "ExplicitAllow")) return fail();
    const reason = row.reason,
      source = row.source;
    if (audit.effect !== row.effect || audit.reason !== reason || audit.source !== source)
      return fail();
    return Object.freeze({
      effect: "Allow",
      reason,
      source,
      action: parseBusinessAction(row.action),
      scopeKind: "Brand",
      policySnapshotReference: parsePolicyReference(row.policySnapshotReference),
      policyVersion: parsePolicyVersion(row.policyVersion),
      audit: Object.freeze({ effect: "Allow", reason, source }),
    });
  }
  const authorizeKernel = (
    actions: readonly string[],
    full: boolean,
  ): Promise<readonly PermissionDecision[]> =>
    protect(async () => {
      if (authorizationBusy) return fail();
      authorizationBusy = true;
      try {
        if (
          !authorize ||
          !Array.isArray(actions) ||
          Object.getPrototypeOf(actions) !== Array.prototype ||
          actions.length < 1 ||
          actions.length > 16 ||
          Reflect.ownKeys(actions).length !== actions.length + 1
        )
          return fail();
        const copied: string[] = [];
        for (let i = 0; i < actions.length; i++) {
          const field = Object.getOwnPropertyDescriptor(actions, String(i));
          if (
            !field?.enumerable ||
            !("value" in field) ||
            typeof field.value !== "string" ||
            field.value.length > 128 ||
            !/^[a-z][a-z0-9_.-]*$/.test(field.value) ||
            copied.includes(field.value)
          )
            return fail();
          copied.push(field.value);
        }
        const held = readClosedRecord(await authorize(Object.freeze(copied)), [
          "decisions",
          "validUntil",
        ]);
        bindBoundary(held.validUntil);
        const decisions = held.decisions;
        assertCurrent();
        if (
          !Array.isArray(decisions) ||
          Object.getPrototypeOf(decisions) !== Array.prototype ||
          decisions.length !== copied.length ||
          Reflect.ownKeys(decisions).length !== decisions.length + 1
        )
          return fail("CATALOG_PERMISSION_DENIED");
        const detached: PermissionDecision[] = [];
        for (let i = 0; i < copied.length; i++) {
          const field = Object.getOwnPropertyDescriptor(decisions, String(i));
          if (!field?.enumerable || !("value" in field)) return fail();
          const action = copied[i];
          if (!action) return fail();
          if (full) detached.push(fullDecision(field.value, action));
          else if (
            field.value?.effect !== "Allow" ||
            field.value?.scopeKind !== "Brand" ||
            field.value?.action !== action
          )
            return fail("CATALOG_PERMISSION_DENIED");
        }
        assertCurrent();
        return Object.freeze(detached);
      } finally {
        authorizationBusy = false;
      }
    });
  return Object.freeze({
    assertCurrent,
    leaseDeadline() {
      assertCurrent();
      return parseCatalogInstant(deadline);
    },
    async authorizeActions(actions: readonly string[]) {
      await authorizeKernel(actions, false);
    },
    authorizeActionsWithDecisions: (actions: readonly string[]) => authorizeKernel(actions, true),
    withCurrentStoreScope: <T>(
      input: Parameters<MerchantProductCurrentAuthorization["withCurrentStoreScope"]>[0],
      work: (context: TenantContext) => Promise<T>,
    ): Promise<T> =>
      protect(async () => {
        const request = readClosedRecord(input, [
          "brandReference",
          "storeReference",
          "capabilityKey",
          "observedAt",
        ]);
        const observedAt = parseCatalogInstant(request.observedAt);
        if (
          request.brandReference !== brandReference ||
          request.storeReference !== storeReference ||
          request.capabilityKey !== capabilityKey ||
          observedAt < startedAt ||
          observedAt > latest ||
          typeof work !== "function"
        )
          return fail();
        const current = await (
          permissionPolicy === undefined
            ? createInitiallyAuthorizedMerchantStoreScope(merchant)
            : createInitiallyAuthorizedMerchantStoreScope(merchant, permissionPolicy)
        )(tx, sessionCookie, sessionReference);
        const admit = async (initial: boolean) => {
          assertCurrent();
          if (
            current.selected.tenantReference !== tenantReference ||
            String(current.context.brand.brandReference) !== brandReference ||
            String(current.store.storeReference) !== storeReference ||
            String(current.actorReference) !== actorReference ||
            String(current.sessionReference) !== sessionReference ||
            (initial
              ? current.initialAuthorization?.effect !== "Allow" ||
                current.initialAuthorization.action !== "merchant.access"
              : !(await current.allowed()))
          )
            return fail("CATALOG_PERMISSION_DENIED");
          if (initial) {
            const initialObservedAt = parseCatalogInstant(current.initialObservedAt);
            if (
              initialObservedAt < startedAt ||
              initialObservedAt > latest ||
              initialObservedAt !== String(current.context.resolvedAt)
            )
              return fail();
          }
          if (typeof current.authorizationValidUntil !== "function") return fail();
          bindBoundary(current.authorizationValidUntil());
          assertCurrent();
        };
        await admit(true);
        const result = await work(
          createTenantContext(
            current.context.actor,
            current.context.brand,
            current.store,
            observedAt,
          ),
        );
        await admit(false);
        return result;
      }),
  });
}
