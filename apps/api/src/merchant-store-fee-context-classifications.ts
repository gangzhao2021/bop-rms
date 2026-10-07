import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord, BrowserSessionError } from "@bop/identity";
import {
  CatalogError,
  createPostgresProductTaxClassificationRegistryStore,
  taxClassificationRegistryFields,
  copyCategoryPersistenceValue,
  type ProductTaxClassificationRegistryStoreOptions,
} from "@rms/catalog";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { StoreSetupOperationError } from "@rms/store";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { parseTaxConfigClassificationChoices } from "./merchant-tax-config-workbench-values.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Brand registry authority, borrowed from the ordinary Store Setup request.
 * Registry entries establish recorded identity, never tax/legal qualification. */
export function createMerchantStoreFeeContextClassifications(options: {
  persistence: PersistentMerchantBffOptions;
  transaction: Parameters<
    ProductTaxClassificationRegistryStoreOptions["authority"]["holdUntilTransactionCompletes"]
  >[0];
  sessionCookie: unknown;
  sessionReference: string;
  scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
  }>;
  originalObservedAt: string;
  check(): string;
  deadline(): string;
  tighten(until: string): void;
  fresh(): Promise<void>;
  registerBeforeCommit: ProductTaxClassificationRegistryStoreOptions["registerBeforeCommit"];
}) {
  const {
    persistence,
    transaction: tx,
    scope,
    sessionCookie,
    sessionReference,
    originalObservedAt,
  } = options;
  const checkPort = options.check,
    deadlinePort = options.deadline,
    tightenPort = options.tighten,
    freshPort = options.fresh,
    registerPort = options.registerBeforeCommit,
    query = tx.query;
  const resolveBrand = createMerchantBrandScope(persistence);
  let active = false,
    finished = false,
    registered = false,
    failed = false;
  const fail = (
    code: StoreSetupOperationError["code"] = "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new StoreSetupOperationError(code);
  };
  const check = () => {
    if (
      failed ||
      options.persistence !== persistence ||
      options.transaction !== tx ||
      tx.query !== query ||
      options.scope !== scope ||
      options.sessionCookie !== sessionCookie ||
      options.sessionReference !== sessionReference ||
      options.originalObservedAt !== originalObservedAt ||
      options.check !== checkPort ||
      options.deadline !== deadlinePort ||
      options.tighten !== tightenPort ||
      options.fresh !== freshPort ||
      options.registerBeforeCommit !== registerPort
    )
      return fail();
    return checkPort();
  };
  const mapped = (error: unknown): never => {
    if (
      (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") ||
      (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_DENIED") ||
      (error instanceof Error &&
        ["BRAND_SERVICE_PERMISSION_DENIED", "STORE_SERVICE_PERMISSION_DENIED"].includes(
          error.message,
        )) ||
      (error instanceof StoreSetupOperationError &&
        error.code === "STORE_SETUP_OPERATION_PERMISSION_DENIED")
    )
      return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
    return fail();
  };
  const source = createPostgresProductTaxClassificationRegistryStore({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    actorReference: scope.actorReference,
    actorKind: "User",
    clock: { now: check },
    transactions: {
      async run(work) {
        check();
        return work(tx);
      },
    },
    async registerBeforeCommit(actual, guard, final) {
      if (actual !== tx || registered) return fail();
      registered = true;
      await registerPort(
        actual,
        async () => {
          try {
            await guard();
            check();
          } catch (error) {
            mapped(error);
          }
        },
        () => {
          try {
            final();
            check();
            finished = true;
          } catch (error) {
            mapped(error);
          }
        },
      );
      check();
    },
    authority: {
      async holdUntilTransactionCompletes(actual, packet) {
        try {
          check();
          readClosedRecord(packet, [
            "tenantReference",
            "brandReference",
            "actorReference",
            "actorKind",
            "purposeCode",
            "permission",
            "action",
            "mode",
            "registry",
            "requiredFields",
            "observedAt",
          ]);
          if (
            actual !== tx ||
            packet.tenantReference !== scope.tenantReference ||
            packet.brandReference !== scope.brandReference ||
            packet.actorReference !== scope.actorReference ||
            packet.actorKind !== "User" ||
            packet.permission !== "catalog.manage" ||
            packet.action !== "catalog.tax-classification.read" ||
            packet.mode !== "Read" ||
            packet.purposeCode !== "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" ||
            canonicalizeRfc8785(packet.requiredFields) !==
              canonicalizeRfc8785(taxClassificationRegistryFields) ||
            packet.observedAt < originalObservedAt ||
            packet.observedAt > check()
          )
            return fail();
          await freshPort();
          const brand = await resolveBrand(tx, sessionCookie, sessionReference);
          check();
          const batch = brand.authorizeActionsWithValidity;
          const actions = ["catalog.manage", "catalog.tax-classification.read"] as const;
          const decisions = await batch.call(brand, actions);
          check();
          if (
            brand.authorizeActionsWithValidity !== batch ||
            brand.tenantReference !== scope.tenantReference ||
            String(brand.actorReference) !== scope.actorReference ||
            String(brand.context.brand.brandReference) !== scope.brandReference ||
            String(brand.selectedStoreReference) !== scope.storeReference ||
            decisions === null
          )
            return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
          const envelope = readClosedRecord(decisions, ["decisions", "validUntil"]);
          const list = envelope.decisions;
          if (
            !Array.isArray(list) ||
            Object.getPrototypeOf(list) !== Array.prototype ||
            list.length !== actions.length ||
            Reflect.ownKeys(list).length !== actions.length + 1
          )
            return fail();
          const copied = copyCategoryPersistenceValue(list);
          if (!Array.isArray(copied)) return fail();
          for (let i = 0; i < actions.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
            if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
            const decision = readClosedRecord(copied[i], [
              "effect",
              "reason",
              "source",
              "action",
              "scopeKind",
              "policySnapshotReference",
              "policyVersion",
              "audit",
            ]);
            const audit = readClosedRecord(decision.audit, ["effect", "reason", "source"]);
            if (
              decision.action !== actions[i] ||
              decision.effect !== "Allow" ||
              decision.scopeKind !== "Brand" ||
              !(
                (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission") ||
                (decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow")
              ) ||
              audit.effect !== decision.effect ||
              audit.reason !== decision.reason ||
              audit.source !== decision.source
            )
              return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
            parseBusinessAction(decision.action);
            parsePolicyReference(decision.policySnapshotReference);
            parsePolicyVersion(decision.policyVersion);
          }
          if (envelope.validUntil !== null) {
            if (typeof envelope.validUntil !== "string") return fail();
            tightenPort(envelope.validUntil);
          }
          await freshPort();
          check();
        } catch (error) {
          try {
            mapped(error);
          } catch (known) {
            if (
              known instanceof StoreSetupOperationError &&
              known.code === "STORE_SETUP_OPERATION_PERMISSION_DENIED"
            )
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          }
        }
      },
    },
  });
  return Object.freeze({
    async read(intentDigest: string) {
      check();
      if (active || registered || finished) return fail();
      active = true;
      try {
        return await source.withCurrentRegistry(
          {
            originalIntentDigest: intentDigest,
            observedAt: originalObservedAt,
            validUntil: deadlinePort(),
          },
          async (value, actual) => {
            if (
              actual !== tx ||
              value.sourceAuthority !== "CurrentTransactionHeld" ||
              value.registry.tenantReference !== scope.tenantReference ||
              value.registry.brandReference !== scope.brandReference
            )
              return fail();
            tightenPort(value.observation.validUntil);
            check();
            return parseTaxConfigClassificationChoices({
              profile: "TaxConfigClassificationChoicesV1",
              ...scope,
              registryReference: value.registry.registryReference,
              versionReference: value.registry.versionReference,
              registryVersion: value.registry.registryVersion,
              snapshotDigest: value.snapshotDigest,
              defaultLocale: value.registry.defaultLocale,
              choices: value.registry.definitions,
              observedAt: check(),
              validUntil: deadlinePort(),
              sourceQualification: "NotEvaluated",
            });
          },
        );
      } catch (error) {
        return mapped(error);
      } finally {
        active = false;
      }
    },
    assertFinalized() {
      check();
      if (active || !registered || !finished) return fail();
      return deadlinePort();
    },
  });
}
export const merchantStoreFeeContextChoicesIntent = (scope: unknown) =>
  "sha256:" +
  sha256Hex(
    canonicalizeRfc8785({ scope, purpose: "STORE_SETUP_FEE_CONTEXT_CLASSIFICATION_CHOICES" }),
  );
