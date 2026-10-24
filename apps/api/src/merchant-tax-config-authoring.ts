import {
  createPostgresTaxRegistrantSource,
  TaxRegistrantSourceError,
  taxRegistrantSourceRequiredFields,
} from "@bop/operating-entity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { createPostgresTransactionCurrentPermissionPolicySource } from "@bop/permission";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  CatalogError,
  createPostgresProductTaxClassificationRegistryStore,
  taxClassificationRegistryFields,
} from "@rms/catalog";
import {
  createPostgresTaxConfigAuthoringStore,
  createPostgresTaxConfigMaterialStore,
  createPostgresTaxConfigCandidateStore,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  parseTaxConfigCandidateOperation,
  taxConfigCandidateRequiredFields,
  taxConfigCandidateIntentDigest,
  type TaxConfigCandidateStoreOptions,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialContent,
  taxConfigMaterialRequiredFields,
  type TaxConfigMaterialStoreOptions,
  type TaxConfigMaterialKind,
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  taxConfigAuthoringIntentDigest,
  taxConfigAuthoringRequiredFields,
  TaxConfigWorkflowError,
  simulateDraftTaxFixture,
  compareTaxConfigCandidateFixtureSuite,
  TaxFixtureSimulationError,
  TaxConfigurationError,
  MoneyTaxContractError,
  type CurrencyMetadataSnapshot,
  type TaxConfigAuthoringStoreOptions,
} from "@rms/pricing";
import {
  parseTaxConfigClassificationChoices,
  parseTaxConfigAuthoringSimulation,
  parseMerchantTaxConfigSimulationCommand,
  parseMerchantTaxConfigMaterialComparisonCommand,
  parseTaxConfigMaterialComparison,
} from "./merchant-tax-config-workbench-values.js";
import {
  createMerchantTaxConfigCapability,
  merchantTaxConfigCapabilityRequiredFields,
} from "./merchant-tax-config-capability.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import {
  bindMerchantTaxConfigAuthoringCommand,
  bindMerchantTaxConfigAuthoringResolve,
  parseMerchantTaxConfigAuthoringScope,
} from "./merchant-tax-config-authoring-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export interface MerchantTaxConfigAuthoringOptions {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly nextReference: () => string;
  readonly currencyMetadata?: CurrencyMetadataSnapshot;
}
export interface MerchantTaxConfigAuthoringRead {
  readonly sessionCookie: unknown;
  readonly expectedStoreReference: unknown;
  readonly expectedScope?: unknown;
}
export interface MerchantTaxConfigAuthoringWrite {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
  readonly command: unknown;
}
const fail = (
  code: TaxConfigWorkflowError["code"] = "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new TaxConfigWorkflowError(code);
};
function reference(value: unknown) {
  try {
    return parsePricingReference(value);
  } catch {
    return fail("TAX_CONFIG_INPUT_INVALID");
  }
}
const same = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
function bounded(error: unknown): never {
  if (error instanceof TaxConfigWorkflowError) throw error;
  if (error instanceof TaxRegistrantSourceError) {
    return fail(
      error.code === "TAX_REGISTRANT_PERMISSION_DENIED"
        ? "TAX_CONFIG_PERMISSION_DENIED"
        : error.code === "TAX_REGISTRANT_INPUT_INVALID"
          ? "TAX_CONFIG_INPUT_INVALID"
          : "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    );
  }
  if (
    error instanceof BrowserSessionError ||
    (error instanceof Error &&
      ["STORE_SERVICE_PERMISSION_DENIED", "BRAND_SERVICE_PERMISSION_DENIED"].includes(
        error.message,
      )) ||
    (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
  )
    return fail("TAX_CONFIG_PERMISSION_DENIED");
  if (
    error instanceof TaxFixtureSimulationError ||
    (error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID")
  )
    return fail("TAX_CONFIG_INPUT_INVALID");
  return fail();
}
/** Genuine Session/current policy, immutable Pricing originals and a borrowed
 * owning Catalog registry. Registered sources retain the original request lease. */
export function createMerchantTaxConfigAuthoring(options: MerchantTaxConfigAuthoringOptions) {
  const persistence = options.persistence,
    authentication = options.authentication,
    runner = persistence.transactions,
    identity = persistence.identity;
  const now = persistence.now,
    run = runner.run,
    authenticate = authentication.authorize,
    generate = options.nextReference,
    hasher = identity.hasher,
    actor = persistence.currentActor,
    association = persistence.validateAssociation;
  const currencyDescriptor = Object.getOwnPropertyDescriptor(options, "currencyMetadata");
  if (currencyDescriptor && (!("value" in currencyDescriptor) || !currencyDescriptor.enumerable))
    return fail();
  const currencyOwner = currencyDescriptor?.value;
  let currency: CurrencyMetadataSnapshot | undefined;
  function currentCurrency() {
    if (currencyOwner === undefined) return fail();
    const parsed = createCurrencyMetadataSnapshot(currencyOwner);
    if (currency !== undefined && !same(parsed, currency)) return fail();
    currency = parsed;
    return parsed;
  }
  const host = createMerchantCategoryTransactions(runner);
  if (
    [now, run, authenticate, generate, actor, association].some(
      (port) => typeof port !== "function",
    )
  )
    return fail();
  function capture() {
    const configured = Object.getOwnPropertyDescriptor(options, "currencyMetadata");
    if (configured && (!("value" in configured) || !configured.enumerable)) return fail();
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      options.nextReference !== generate ||
      Object.getOwnPropertyDescriptor(options, "currencyMetadata")?.value !== currencyOwner ||
      persistence.now !== now ||
      persistence.transactions !== runner ||
      runner.run !== run ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      persistence.currentActor !== actor ||
      persistence.validateAssociation !== association ||
      authentication.authorize !== authenticate
    )
      return fail();
  }
  async function perform(
    mode:
      | "Current"
      | "Roster"
      | "Execute"
      | "Resolve"
      | "Classifications"
      | "Simulate"
      | "TaxRegistrant"
      | "MaterialCompare"
      | "MaterialCurrent"
      | "MaterialVersion"
      | "MaterialRoster"
      | "MaterialExecute"
      | "MaterialResolve"
      | "CandidateCurrent"
      | "CandidateRoster"
      | "CandidatePrepare"
      | "CandidateResolve",
    input: MerchantTaxConfigAuthoringRead | MerchantTaxConfigAuthoringWrite,
    selector?: unknown,
  ) {
    try {
      capture();
      const origin = String(parseCanonicalInstant(now.call(persistence)));
      const originalDeadline = new Date(Date.parse(origin) + 5000).toISOString();
      let latest = origin,
        deadline = originalDeadline,
        failed = false;
      const check = () => {
        capture();
        const at = String(parseCanonicalInstant(now.call(persistence)));
        if (failed || at < latest || at >= deadline) return fail();
        latest = at;
        return at;
      };
      const tighten = (value: unknown) => {
        const until = String(parseCanonicalInstant(value));
        if (until < deadline) deadline = until;
        check();
      };
      const material = mode.startsWith("Material");
      const candidate = mode.startsWith("Candidate");
      const candidateBody =
        mode === "CandidatePrepare"
          ? parseTaxConfigCandidateCommand((input as MerchantTaxConfigAuthoringWrite).command)
          : mode === "CandidateResolve"
            ? parseTaxConfigCandidateResolve((input as MerchantTaxConfigAuthoringWrite).command)
            : null;
      const write =
        mode === "Execute" ||
        mode === "Resolve" ||
        mode === "Simulate" ||
        mode === "MaterialCompare" ||
        mode === "MaterialExecute" ||
        mode === "MaterialResolve" ||
        mode === "CandidatePrepare" ||
        mode === "CandidateResolve";
      const materialBody =
        mode === "MaterialExecute"
          ? parseTaxConfigMaterialCommand((input as MerchantTaxConfigAuthoringWrite).command)
          : mode === "MaterialResolve"
            ? parseTaxConfigMaterialResolve((input as MerchantTaxConfigAuthoringWrite).command)
            : null;
      const comparisonCommand =
        mode === "MaterialCompare"
          ? parseMerchantTaxConfigMaterialComparisonCommand(
              (input as MerchantTaxConfigAuthoringWrite).command,
            )
          : null;
      const simulationCommand =
        mode === "Simulate"
          ? parseMerchantTaxConfigSimulationCommand(
              (input as MerchantTaxConfigAuthoringWrite).command,
            )
          : null;
      const body =
        write && mode !== "Simulate" && !material && !candidate
          ? mode === "Execute"
            ? bindMerchantTaxConfigAuthoringCommand(
                (input as MerchantTaxConfigAuthoringWrite).command,
              )
            : bindMerchantTaxConfigAuthoringResolve(
                (input as MerchantTaxConfigAuthoringWrite).command,
              )
          : null;
      const expected =
        input.expectedScope === undefined && !write
          ? null
          : parseMerchantTaxConfigAuthoringScope(input.expectedScope);
      const target = write
        ? null
        : reference((input as MerchantTaxConfigAuthoringRead).expectedStoreReference);
      const selected =
        write || mode === "Classifications" || mode === "TaxRegistrant" || material || candidate
          ? null
          : selector === null
            ? null
            : reference(selector);
      const authenticated = write
        ? await authenticate.call(authentication, {
            sessionCookie: input.sessionCookie,
            csrf: (input as MerchantTaxConfigAuthoringWrite).csrf,
          })
        : null;
      check();
      let finish: (() => string) | undefined;
      const result = await host.transactions.run(async (tx) => {
        const queryPort = tx.query,
          capturedQuery = queryPort.bind(tx),
          policy = createPostgresTransactionCurrentPermissionPolicySource(tx);
        const resolveStore = createMerchantStoreScope(persistence, policy),
          resolveBrand = createMerchantBrandScope(persistence, policy);
        const initial = await resolveStore(
          tx,
          input.sessionCookie,
          "pricing.tax-config.manage",
          authenticated?.sessionReference,
        );
        check();
        const scope = parseMerchantTaxConfigAuthoringScope({
          tenantReference: initial.selected.tenantReference,
          brandReference: initial.context.brand.brandReference,
          storeReference: initial.store.storeReference,
          actorReference: initial.actorReference,
        });
        const sessionReference = initial.sessionReference;
        if (
          (expected !== null && !same(scope, expected)) ||
          (target !== null && target !== scope.storeReference)
        )
          return fail("TAX_CONFIG_PERMISSION_DENIED");
        const childFinals: (() => void)[] = [];
        const childGuards = new Set<() => Promise<void>>();
        let finalsRan = false,
          authorityActive = false;
        let factsActive = false;
        function checkTx() {
          check();
          if (tx.query !== queryPort) return fail();
        }
        async function bareFresh(
          mode: "Read" | "Write" | "Resolve",
          action: "pricing.tax-config.manage" | "organization.manage" = "pricing.tax-config.manage",
        ) {
          if (authorityActive) return fail();
          authorityActive = true;
          try {
            checkTx();
            const current = await resolveStore(tx, input.sessionCookie, action, sessionReference);
            checkTx();
            const allowed = current.authorizeAction,
              lease = current.authorizationValidUntil;
            const identityCheck = () => {
              checkTx();
              if (
                current.authorizeAction !== allowed ||
                current.authorizationValidUntil !== lease ||
                current.sessionReference !== sessionReference ||
                current.selected.tenantReference !== scope.tenantReference ||
                String(current.context.brand.brandReference) !== scope.brandReference ||
                String(current.store.storeReference) !== scope.storeReference ||
                String(current.actorReference) !== scope.actorReference ||
                String(current.context.actor.actorReference) !== scope.actorReference ||
                String(current.context.store?.storeReference) !== scope.storeReference
              )
                return fail("TAX_CONFIG_PERMISSION_DENIED");
            };
            identityCheck();
            const permission = await allowed.call(current, action);
            identityCheck();
            if (
              permission?.effect !== "Allow" ||
              permission.action !== action ||
              permission.scopeKind !== "Store"
            )
              return fail("TAX_CONFIG_PERMISSION_DENIED");
            const until = lease.call(current);
            identityCheck();
            if (until === null) return fail();
            tighten(until);
            if (mode === "Write" && !material) {
              const metadata = currentCurrency();
              if (
                current.context.brand.currencyCode !== metadata.currencyCode ||
                current.store.currencyCode !== metadata.currencyCode
              )
                return fail("TAX_CONFIG_INPUT_INVALID");
            }
            return { scope, tenantContext: current.context, permission, validUntil: deadline };
          } finally {
            authorityActive = false;
          }
        }
        const capability = createMerchantTaxConfigCapability({
          transaction: tx,
          scope,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: (actual, guard, final) => {
            if (actual !== tx) return fail();
            return host.registerBeforeCommit(tx, guard, final);
          },
          async holdCurrentTaxAuthority(actual, request) {
            checkTx();
            if (
              actual !== tx ||
              !same(request.scope, scope) ||
              request.permission !== "pricing.tax-config.manage" ||
              request.purposeCode !== "STORE_CAPABILITY_EVALUATION" ||
              !same(request.requiredFields, merchantTaxConfigCapabilityRequiredFields) ||
              request.observedAt < origin ||
              request.observedAt > check() ||
              request.validUntil > originalDeadline
            )
              return fail();
            tighten(request.validUntil);
            return bareFresh("Read");
          },
        });
        async function fresh(mode: "Read" | "Write" | "Resolve") {
          const authority = await bareFresh(mode);
          await capability.holdUntilCommit();
          checkTx();
          tighten(capability.leaseDeadline());
          return { ...authority, validUntil: deadline };
        }
        await fresh("Read");
        await host.registerBeforeCommit(
          tx,
          async () => {
            await fresh("Read");
            checkTx();
          },
          () => {
            if (finalsRan) return fail();
            finalsRan = true;
            for (const final of childFinals) {
              final();
              checkTx();
            }
            checkTx();
          },
        );
        const ownerTx: TaxConfigAuthoringStoreOptions["transaction"] = {
          async query<Row>(sql: string, values: readonly unknown[]) {
            checkTx();
            const value = await capturedQuery<Row>(sql, values);
            checkTx();
            if (value.rowCount === undefined) return fail();
            return { rows: value.rows, rowCount: value.rowCount };
          },
        };
        const sourceClock = { now: check };
        const sourceRegister: TaxConfigAuthoringStoreOptions["registerBeforeCommit"] = (
          actual,
          guard,
          final,
        ) => {
          if (actual !== ownerTx) return fail();
          return host.registerBeforeCommit(tx, guard, final);
        };
        const sourceWindow = {
          transaction: ownerTx,
          scope,
          originalObservedAt: origin,
          originalValidUntil: deadline,
          clock: sourceClock,
          registerBeforeCommit: sourceRegister,
        };
        // Register the parent before any owning child. Child callbacks are reused
        // only while their real borrowed host remains in Work/Checks.
        let registrant: ReturnType<typeof createPostgresTaxRegistrantSource> | undefined;
        async function readRegistrant() {
          if (!registrant) {
            registrant = createPostgresTaxRegistrantSource({
              ...scope,
              originalObservedAt: origin,
              originalValidUntil: deadline,
              clock: { now: check },
              registerBeforeCommit(actual, guard, final) {
                if (actual !== ownerTx) return fail();
                return host.registerBeforeCommit(tx, guard, final);
              },
              authority: {
                async holdUntilTransactionCompletes(actual, request) {
                  readClosedRecord(request, [
                    "tenantReference",
                    "brandReference",
                    "storeReference",
                    "actorReference",
                    "actorKind",
                    "permission",
                    "purposeCode",
                    "businessFunction",
                    "effectiveAt",
                    "requiredFields",
                    "observedAt",
                    "validUntil",
                  ]);
                  if (
                    actual !== ownerTx ||
                    Object.entries(scope).some(
                      ([key, value]) => Reflect.get(request, key) !== value,
                    ) ||
                    request.actorKind !== "User" ||
                    request.permission !== "organization.manage" ||
                    request.purposeCode !== "TAX_REGISTRANT_SOURCE" ||
                    request.businessFunction !== "TaxRegistrant" ||
                    request.effectiveAt !== origin ||
                    !same(request.requiredFields, taxRegistrantSourceRequiredFields) ||
                    request.observedAt < origin ||
                    request.observedAt > check() ||
                    request.validUntil > deadline
                  )
                    return fail();
                  await fresh("Read");
                  const actualAuthority = await bareFresh("Read", "organization.manage");
                  checkTx();
                  return actualAuthority;
                },
              },
            });
          }
          try {
            return await registrant.resolve({ transaction: ownerTx, effectiveAt: origin });
          } catch (error) {
            return bounded(error);
          }
        }
        if (mode === "TaxRegistrant") {
          const value = await readRegistrant();
          finish = () => {
            if (!finalsRan || !registrant) return fail();
            tighten(registrant.assertFinalized(ownerTx));
            tighten(capability.assertFinalized());
            checkTx();
            return deadline;
          };
          return value;
        }
        const materialOptions: TaxConfigMaterialStoreOptions = {
          ...sourceWindow,
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              readClosedRecord(packet, [
                "scope",
                "mode",
                "permission",
                "purposeCode",
                "requiredFields",
                "command",
                "observedAt",
                "validUntil",
              ]);
              if (
                actual !== ownerTx ||
                !same(packet.scope, scope) ||
                packet.permission !== "pricing.tax-config.manage" ||
                packet.purposeCode !== "PRICING_TAX_CONFIG_MATERIAL" ||
                !same(packet.requiredFields, taxConfigMaterialRequiredFields) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > deadline
              )
                return fail();
              if (packet.command !== null) {
                if (!materialBody) return fail();
                const { content: ignored, ...pins } =
                  mode === "MaterialExecute"
                    ? parseTaxConfigMaterialCommand(materialBody)
                    : { ...parseTaxConfigMaterialResolve(materialBody), content: null };
                void ignored;
                const actualPins = readClosedRecord(packet.command, [
                  "action",
                  "operationReference",
                  "materialReference",
                  "expectedRevision",
                  "materialKind",
                ]);
                for (const key of [
                  "action",
                  "operationReference",
                  "materialReference",
                  "expectedRevision",
                  "materialKind",
                ] as const)
                  if (actualPins[key] !== pins[key]) return fail();
              }
              return fresh(packet.mode);
            },
          },
          facts: {
            async validateMaterial(actual, packet) {
              if (
                actual !== ownerTx ||
                mode !== "MaterialExecute" ||
                materialBody === null ||
                !same(packet.command, materialBody) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > deadline
              )
                return fail();
              if (packet.command.materialKind !== "RegistrationApplicability") {
                await validateCandidateMaterial(
                  packet.command.content,
                  packet.command.materialKind,
                );
                return;
              }
              const content = parseTaxConfigMaterialContent(
                packet.command.content,
                "RegistrationApplicability",
              );
              if (!("operatingEntityProfileVersionReference" in content)) return fail();
              const current = await readRegistrant();
              if (current === null) return fail("TAX_CONFIG_VERSION_CONFLICT");
              if (
                content.operatingEntityProfileVersionReference !==
                  current.operatingEntityProfileVersionReference ||
                content.operatingEntityTaxReference !== current.taxRegistrationReference ||
                content.jurisdictionCode !== current.jurisdictionCode
              )
                return fail("TAX_CONFIG_VERSION_CONFLICT");
              checkTx();
            },
          },
          references: {
            generate() {
              checkTx();
              const value = reference(generate.call(options));
              checkTx();
              return value;
            },
          },
          audit: {
            create(packet) {
              if (
                !same(packet.scope, scope) ||
                packet.occurredAt < origin ||
                packet.occurredAt > check()
              )
                return fail();
              return validateAuditRecord(
                {
                  auditId: packet.auditReference,
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "User", reference: scope.actorReference },
                  actionCode:
                    packet.mode === "Abandon"
                      ? "PRICING_TAX_MATERIAL_RESOLVE"
                      : "PRICING_TAX_MATERIAL_" + packet.command.action.toUpperCase(),
                  targetType:
                    packet.mode === "Abandon"
                      ? "PricingTaxMaterialOperation"
                      : "PricingTaxConfigMaterial",
                  targetId: packet.materialReference ?? packet.command.operationReference,
                  afterSummary: { intentDigest: packet.intentDigest },
                  reasonCode: "AUTHORIZED_OPERATION",
                  correlationId: packet.command.operationReference,
                  occurredAt: packet.occurredAt,
                  sourceChannel: "API",
                  dataClassification: "Confidential",
                  retentionPolicyCode: "OPERATIONAL",
                  retentionPolicyVersion: 1,
                },
                Date.parse(check()),
              );
            },
          },
        };
        async function readRegistry(digest: string) {
          if (factsActive) return fail();
          factsActive = true;
          try {
            let child: { guard: () => Promise<void>; final: () => void } | undefined;
            const source = createPostgresProductTaxClassificationRegistryStore({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              actorKind: "User",
              clock: { now: check },
              transactions: { run: (work) => work(tx) },
              registerBeforeCommit: async (actual, guard, final) => {
                checkTx();
                if (
                  actual !== tx ||
                  child ||
                  typeof guard !== "function" ||
                  typeof final !== "function" ||
                  childFinals.length >= 32 ||
                  childGuards.has(guard) ||
                  childFinals.includes(final)
                )
                  return fail();
                childGuards.add(guard);
                child = { guard, final };
              },
              authority: {
                async holdUntilTransactionCompletes(actual, request) {
                  try {
                    if (
                      actual !== tx ||
                      request.tenantReference !== scope.tenantReference ||
                      request.brandReference !== scope.brandReference ||
                      request.actorReference !== scope.actorReference ||
                      request.actorKind !== "User" ||
                      request.permission !== "catalog.manage" ||
                      request.action !== "catalog.tax-classification.read" ||
                      request.mode !== "Read" ||
                      request.purposeCode !== "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY" ||
                      !same(request.requiredFields, taxClassificationRegistryFields)
                    )
                      return fail();
                    checkTx();
                    const brand = await resolveBrand(tx, input.sessionCookie, sessionReference);
                    checkTx();
                    if (
                      brand.tenantReference !== scope.tenantReference ||
                      String(brand.actorReference) !== scope.actorReference ||
                      String(brand.context.brand.brandReference) !== scope.brandReference ||
                      String(brand.selectedStoreReference) !== scope.storeReference
                    )
                      return fail("TAX_CONFIG_PERMISSION_DENIED");
                    const batch = brand.authorizeActionsWithValidity;
                    const actions = ["catalog.manage", "catalog.tax-classification.read"] as const;
                    const decisions = await batch.call(brand, actions);
                    checkTx();
                    if (
                      brand.authorizeActionsWithValidity !== batch ||
                      brand.tenantReference !== scope.tenantReference ||
                      String(brand.actorReference) !== scope.actorReference ||
                      String(brand.context.brand.brandReference) !== scope.brandReference ||
                      String(brand.selectedStoreReference) !== scope.storeReference
                    )
                      return fail("TAX_CONFIG_PERMISSION_DENIED");
                    if (
                      decisions === null ||
                      decisions.decisions.length !== actions.length ||
                      decisions.decisions.some(
                        (decision, i) =>
                          decision.effect !== "Allow" ||
                          decision.scopeKind !== "Brand" ||
                          decision.action !== actions[i],
                      )
                    )
                      return fail("TAX_CONFIG_PERMISSION_DENIED");
                    if (decisions.validUntil !== null) tighten(decisions.validUntil);
                  } catch (error) {
                    if (
                      (error instanceof TaxConfigWorkflowError &&
                        error.code === "TAX_CONFIG_PERMISSION_DENIED") ||
                      error instanceof BrowserSessionError ||
                      (error instanceof Error &&
                        [
                          "STORE_SERVICE_PERMISSION_DENIED",
                          "BRAND_SERVICE_PERMISSION_DENIED",
                        ].includes(error.message))
                    )
                      throw new CatalogError("CATALOG_PERMISSION_DENIED");
                    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
                  }
                },
              },
            });
            const current = await source.withCurrentRegistry(
              { originalIntentDigest: digest, observedAt: origin, validUntil: deadline },
              async (value, actual) => {
                checkTx();
                if (
                  actual !== tx ||
                  value.sourceAuthority !== "CurrentTransactionHeld" ||
                  value.registry.tenantReference !== scope.tenantReference ||
                  value.registry.brandReference !== scope.brandReference
                )
                  return fail();
                return value;
              },
            );
            if (!child) return fail();
            await child.guard();
            checkTx();
            childFinals.push(child.final);
            tighten(current.observation.validUntil);
            return current;
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            factsActive = false;
          }
        }
        const storeOptions: TaxConfigAuthoringStoreOptions = {
          ...sourceWindow,
          references: {
            generate() {
              checkTx();
              const value = parsePricingReference(generate.call(options));
              checkTx();
              return value;
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              readClosedRecord(packet, [
                "scope",
                "mode",
                "permission",
                "purposeCode",
                "requiredFields",
                "command",
                "observedAt",
                "validUntil",
              ]);
              if (
                actual !== ownerTx ||
                packet.permission !== "pricing.tax-config.manage" ||
                packet.purposeCode !== "PRICING_TAX_CONFIG_AUTHORING" ||
                !same(packet.scope, scope) ||
                !same(packet.requiredFields, taxConfigAuthoringRequiredFields) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > deadline
              )
                return fail();
              return fresh(packet.mode);
            },
          },
          currency: {
            async readCurrent(actual) {
              if (actual !== ownerTx) return fail();
              await fresh("Write");
              return currentCurrency();
            },
          },
          facts: {
            async validateDraft(actual, packet) {
              if (
                actual !== ownerTx ||
                body === null ||
                mode !== "Execute" ||
                !same(packet.command, body) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > deadline ||
                packet.snapshot.registrationEvidence !== null ||
                packet.snapshot.professionalEvidence !== null
              )
                return fail();
              const current = await readRegistry(
                taxConfigAuthoringIntentDigest(scope, packet.command),
              );
              if (
                !packet.snapshot.rules.every((rule) =>
                  current.registry.definitions.some(
                    (d) =>
                      d.classificationReference === rule.taxClassificationReference &&
                      d.lifecycle === "Active",
                  ),
                )
              )
                return fail("TAX_CONFIG_INPUT_INVALID");
            },
          },
          audit: {
            create(packet) {
              checkTx();
              if (
                !same(packet.scope, scope) ||
                packet.occurredAt < origin ||
                packet.occurredAt > check()
              )
                return fail();
              return validateAuditRecord(
                {
                  auditId: packet.auditReference,
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
                  actor: { type: "User", reference: scope.actorReference },
                  actionCode:
                    packet.mode === "Abandon"
                      ? "PRICING_TAX_CONFIG_RESOLVE"
                      : "PRICING_TAX_CONFIG_" + packet.command.action.toUpperCase(),
                  targetType:
                    packet.mode === "Abandon"
                      ? "PricingTaxAuthoringOperation"
                      : "PricingTaxConfiguration",
                  targetId:
                    packet.mode === "Abandon"
                      ? packet.command.operationReference
                      : (packet.configurationReference ?? fail()),
                  afterSummary: { intentDigest: packet.intentDigest },
                  reasonCode: "AUTHORIZED_OPERATION",
                  correlationId: packet.command.operationReference,
                  occurredAt: packet.occurredAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: "OPERATIONAL",
                  retentionPolicyVersion: 1,
                },
                Date.parse(check()),
              );
            },
          },
        };
        let cachedCandidateOptions: TaxConfigCandidateStoreOptions | undefined;
        let candidateReadSource:
          ReturnType<typeof createPostgresTaxConfigCandidateStore> | undefined;
        let materialHistorySource:
          ReturnType<typeof createPostgresTaxConfigMaterialStore> | undefined;
        function getCandidateOptions(): TaxConfigCandidateStoreOptions {
          return (cachedCandidateOptions ??= {
            ...sourceWindow,
            draftSource: storeOptions,
            materialSource: materialOptions,
            authority: {
              async holdUntilTransactionCompletes(actual, packet) {
                readClosedRecord(packet, [
                  "scope",
                  "mode",
                  "permission",
                  "purposeCode",
                  "requiredFields",
                  "command",
                  "observedAt",
                  "validUntil",
                ]);
                if (
                  actual !== ownerTx ||
                  !same(packet.scope, scope) ||
                  packet.permission !== "pricing.tax-config.manage" ||
                  packet.purposeCode !== "PRICING_TAX_CONFIG_CANDIDATE" ||
                  !same(packet.requiredFields, taxConfigCandidateRequiredFields) ||
                  packet.observedAt < origin ||
                  packet.observedAt > check() ||
                  packet.validUntil > deadline
                )
                  return fail();
                if (packet.command !== null) {
                  if (!candidateBody) return fail();
                  const original = parseTaxConfigCandidateCommand({
                    action: candidateBody.action,
                    operationReference: candidateBody.operationReference,
                    configurationReference: candidateBody.configurationReference,
                    expectedDraft: candidateBody.expectedDraft,
                    registrationMaterial: candidateBody.registrationMaterial,
                  });
                  if (!same(packet.command, original)) return fail();
                }
                return fresh(packet.mode);
              },
            },
            references: storeOptions.references,
            audit: {
              create(packet) {
                if (
                  !same(packet.scope, scope) ||
                  !candidateBody ||
                  !same(
                    packet.command,
                    parseTaxConfigCandidateCommand({
                      action: candidateBody.action,
                      operationReference: candidateBody.operationReference,
                      configurationReference: candidateBody.configurationReference,
                      expectedDraft: candidateBody.expectedDraft,
                      registrationMaterial: candidateBody.registrationMaterial,
                    }),
                  ) ||
                  packet.intentDigest !== taxConfigCandidateIntentDigest(scope, packet.command) ||
                  packet.occurredAt < origin ||
                  packet.occurredAt > check()
                )
                  return fail();
                return validateAuditRecord(
                  {
                    auditId: packet.auditReference,
                    brandId: scope.brandReference,
                    storeId: scope.storeReference,
                    actor: { type: "User", reference: scope.actorReference },
                    actionCode:
                      packet.mode === "Abandon"
                        ? "PRICING_TAX_CANDIDATE_RESOLVE"
                        : "PRICING_TAX_CANDIDATE_PREPARE",
                    targetType:
                      packet.mode === "Abandon"
                        ? "PricingTaxCandidateOperation"
                        : "PricingTaxConfigCandidate",
                    targetId: packet.targetVersionReference ?? packet.command.operationReference,
                    afterSummary: { intentDigest: packet.intentDigest },
                    reasonCode: "AUTHORIZED_OPERATION",
                    correlationId: packet.command.operationReference,
                    occurredAt: packet.occurredAt,
                    sourceChannel: "API",
                    dataClassification: "Confidential",
                    retentionPolicyCode: "OPERATIONAL",
                    retentionPolicyVersion: 1,
                  },
                  Date.parse(check()),
                );
              },
            },
          });
        }
        function getCandidateSource() {
          return (candidateReadSource ??=
            createPostgresTaxConfigCandidateStore(getCandidateOptions()));
        }
        async function readMaterialSource(
          kind: "RegistrationApplicability" | "FixtureSuite",
          pin: { materialReference?: string; versionReference: string; contentDigest: string },
        ) {
          materialHistorySource ??= createPostgresTaxConfigMaterialStore(materialOptions);
          const value = parseTaxConfigMaterialCurrent(
            await materialHistorySource.readVersion({
              materialKind: kind,
              versionReference: pin.versionReference,
            }),
          );
          checkTx();
          tighten(value.validUntil);
          if (
            !same(
              {
                tenantReference: value.tenantReference,
                brandReference: value.brandReference,
                storeReference: value.storeReference,
                actorReference: value.actorReference,
              },
              scope,
            ) ||
            !value.version ||
            value.version.materialKind !== kind ||
            (pin.materialReference !== undefined &&
              value.version.materialReference !== pin.materialReference) ||
            value.version.versionReference !== pin.versionReference ||
            value.version.contentDigest !== pin.contentDigest
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
          return value.version;
        }
        async function readCandidateSource(
          configurationReference: string,
          pin: { versionReference: string; contentDigest: string },
        ) {
          const value = parseTaxConfigCandidateCurrent(
            await getCandidateSource().readCurrent({
              configurationReference,
              targetVersionReference: pin.versionReference,
            }),
          );
          checkTx();
          tighten(value.validUntil);
          if (
            !same(
              {
                tenantReference: value.tenantReference,
                brandReference: value.brandReference,
                storeReference: value.storeReference,
                actorReference: value.actorReference,
              },
              scope,
            ) ||
            value.configurationReference !== configurationReference ||
            value.targetVersionReference !== pin.versionReference ||
            !value.record ||
            value.record.candidate.content.targetVersionReference !== pin.versionReference ||
            value.record.candidate.content.configurationReference !== configurationReference ||
            value.record.candidate.contentDigest !== pin.contentDigest
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
          return value.record;
        }
        async function validateCandidateMaterial(
          raw: unknown,
          kind: "ProfessionalReport" | "FixtureSuite",
        ) {
          const content = parseTaxConfigMaterialContent(raw, kind);
          if ("cases" in content) {
            const first = content.cases[0];
            if (!first) return fail();
            const record = await readCandidateSource(
              first.expected.configurationReference,
              content.targetPublicationCandidate,
            );
            if (
              !same(content.currencyMetadata, record.candidate.content.currencyMetadata) ||
              content.cases.some(
                (c) =>
                  c.expected.configurationReference !==
                  record.candidate.content.configurationReference,
              )
            )
              return fail("TAX_CONFIG_VERSION_CONFLICT");
            return;
          }
          if (!("fixtureSuiteMaterial" in content)) return fail();
          const suite = await readMaterialSource("FixtureSuite", content.fixtureSuiteMaterial);
          const suiteContent = parseTaxConfigMaterialContent(suite.content, "FixtureSuite");
          if (!("cases" in suiteContent)) return fail();
          const first = suiteContent.cases[0];
          if (
            !first ||
            !same(suiteContent.targetPublicationCandidate, content.targetPublicationCandidate)
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
          const record = await readCandidateSource(
            first.expected.configurationReference,
            content.targetPublicationCandidate,
          );
          const registration = await readMaterialSource(
            "RegistrationApplicability",
            content.registrationMaterial,
          );
          if (
            !same(suiteContent.currencyMetadata, record.candidate.content.currencyMetadata) ||
            !same(record.candidate.content.registrationMaterial, {
              materialReference: registration.materialReference,
              versionReference: registration.versionReference,
              contentDigest: registration.contentDigest,
            })
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
        }
        if (mode === "MaterialCompare") {
          if (!comparisonCommand) return fail();
          const suite = await readMaterialSource(
            "FixtureSuite",
            comparisonCommand.fixtureSuiteMaterial,
          );
          const record = await readCandidateSource(
            comparisonCommand.configurationReference,
            comparisonCommand.targetPublicationCandidate,
          );
          const suiteContent = parseTaxConfigMaterialContent(suite.content, "FixtureSuite");
          if (
            !("cases" in suiteContent) ||
            !same(
              suiteContent.targetPublicationCandidate,
              comparisonCommand.targetPublicationCandidate,
            ) ||
            !same(suiteContent.currencyMetadata, record.candidate.content.currencyMetadata) ||
            suiteContent.cases.some(
              (row) =>
                row.expected.configurationReference !== comparisonCommand.configurationReference,
            )
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
          const comparison = (() => {
            try {
              return compareTaxConfigCandidateFixtureSuite(record, suite);
            } catch (error) {
              if (
                error instanceof TaxFixtureSimulationError ||
                error instanceof TaxConfigurationError ||
                error instanceof MoneyTaxContractError
              )
                return fail("TAX_CONFIG_INPUT_INVALID");
              throw error;
            }
          })();
          checkTx();
          finish = () => {
            if (!finalsRan || !materialHistorySource || !candidateReadSource) return fail();
            tighten(materialHistorySource.assertFinalized());
            tighten(candidateReadSource.assertFinalized());
            tighten(capability.assertFinalized());
            checkTx();
            return deadline;
          };
          return parseTaxConfigMaterialComparison({
            profile: "TaxConfigMaterialComparisonV1",
            ...scope,
            comparison,
            observedAt: origin,
            validUntil: deadline,
            referenceEligibility: "NotEvaluated",
          });
        }
        if (material) {
          const source = createPostgresTaxConfigMaterialStore(materialOptions);
          finish = () => {
            if (!finalsRan) return fail();
            tighten(source.assertFinalized());
            if (candidateReadSource) tighten(candidateReadSource.assertFinalized());
            if (materialHistorySource) tighten(materialHistorySource.assertFinalized());
            if (registrant) tighten(registrant.assertFinalized(ownerTx));
            tighten(capability.assertFinalized());
            checkTx();
            return deadline;
          };
          if (mode === "MaterialCurrent") return source.readCurrent(selector);
          if (mode === "MaterialVersion") return source.readVersion(selector);
          if (mode === "MaterialRoster") return source.readRoster(selector);
          if (materialBody === null) return fail();
          return mode === "MaterialExecute"
            ? source.execute(materialBody)
            : source.resolveOriginal(materialBody);
        }
        if (candidate) {
          const source = getCandidateSource();
          finish = () => {
            if (!finalsRan) return fail();
            tighten(source.assertFinalized());
            tighten(capability.assertFinalized());
            checkTx();
            return deadline;
          };
          if (mode === "CandidateCurrent" || mode === "CandidateRoster") {
            const requested = readClosedRecord(
              selector,
              mode === "CandidateCurrent"
                ? ["configurationReference", "targetVersionReference"]
                : ["configurationReference", "afterCandidate"],
            );
            const value =
              mode === "CandidateCurrent"
                ? parseTaxConfigCandidateCurrent(await source.readCurrent(selector))
                : parseTaxConfigCandidateRoster(await source.readRoster(selector));
            if (
              !same(
                {
                  tenantReference: value.tenantReference,
                  brandReference: value.brandReference,
                  storeReference: value.storeReference,
                  actorReference: value.actorReference,
                },
                scope,
              ) ||
              value.configurationReference !== requested.configurationReference ||
              (value.profile === "TaxConfigCandidateCurrentV1"
                ? requested.targetVersionReference !== null &&
                  value.targetVersionReference !== requested.targetVersionReference
                : value.afterCandidate !== requested.afterCandidate)
            )
              return fail();
            return value;
          }
          if (!candidateBody) return fail();
          const value = parseTaxConfigCandidateOperation(
            await (mode === "CandidatePrepare"
              ? source.prepare(candidateBody)
              : source.resolveOriginal(candidateBody)),
          );
          if (
            !same(
              {
                tenantReference: value.tenantReference,
                brandReference: value.brandReference,
                storeReference: value.storeReference,
                actorReference: value.actorReference,
              },
              scope,
            ) ||
            !same(
              parseTaxConfigCandidateCommand({
                action: value.action,
                operationReference: value.operationReference,
                configurationReference: value.configurationReference,
                expectedDraft: value.expectedDraft,
                registrationMaterial: value.registrationMaterial,
              }),
              parseTaxConfigCandidateCommand({
                action: candidateBody.action,
                operationReference: candidateBody.operationReference,
                configurationReference: candidateBody.configurationReference,
                expectedDraft: candidateBody.expectedDraft,
                registrationMaterial: candidateBody.registrationMaterial,
              }),
            ) ||
            value.intentDigest !==
              taxConfigCandidateIntentDigest(
                scope,
                parseTaxConfigCandidateCommand({
                  action: candidateBody.action,
                  operationReference: candidateBody.operationReference,
                  configurationReference: candidateBody.configurationReference,
                  expectedDraft: candidateBody.expectedDraft,
                  registrationMaterial: candidateBody.registrationMaterial,
                }),
              )
          )
            return fail();
          return value;
        }
        const owner = createPostgresTaxConfigAuthoringStore(storeOptions);
        finish = () => {
          checkTx();
          if (!finalsRan) return fail();
          const until = owner.assertFinalized();
          tighten(capability.assertFinalized());
          checkTx();
          return until < deadline ? until : deadline;
        };
        if (mode === "Classifications") {
          const digest =
            "sha256:" +
            sha256Hex(
              canonicalizeRfc8785({ scope, purpose: "PRICING_TAX_CLASSIFICATION_CHOICES" }),
            );
          const current = await readRegistry(digest);
          await owner.readCurrent(null);
          return parseTaxConfigClassificationChoices({
            profile: "TaxConfigClassificationChoicesV1",
            ...scope,
            registryReference: current.registry.registryReference,
            versionReference: current.registry.versionReference,
            registryVersion: current.registry.registryVersion,
            snapshotDigest: current.snapshotDigest,
            defaultLocale: current.registry.defaultLocale,
            choices: current.registry.definitions,
            observedAt: origin,
            validUntil: deadline,
            sourceQualification: "NotEvaluated",
          });
        }
        if (mode === "Simulate") {
          if (!simulationCommand) return fail();
          const current = await owner.readCurrent(simulationCommand.configurationReference);
          const snapshot = current.state?.snapshot;
          if (
            !snapshot ||
            snapshot.versionReference !== simulationCommand.expectedVersionReference ||
            snapshot.snapshotDigest !== simulationCommand.expectedSnapshotDigest
          )
            return fail("TAX_CONFIG_VERSION_CONFLICT");
          const simulation = (() => {
            try {
              return simulateDraftTaxFixture(snapshot, simulationCommand.fixture);
            } catch (error) {
              if (
                error instanceof TaxFixtureSimulationError ||
                error instanceof TaxConfigurationError ||
                error instanceof MoneyTaxContractError
              )
                return fail("TAX_CONFIG_INPUT_INVALID");
              throw error;
            }
          })();
          checkTx();
          return parseTaxConfigAuthoringSimulation({
            profile: "TaxConfigAuthoringSimulationV1",
            ...scope,
            configurationReference: snapshot.configurationReference,
            versionReference: snapshot.versionReference,
            snapshotDigest: snapshot.snapshotDigest,
            simulation,
            observedAt: origin,
            validUntil: deadline,
            referenceEligibility: "NotEvaluated",
          });
        }
        if (mode === "Current") return owner.readCurrent(selected);
        if (mode === "Roster") return owner.readRoster(selected);
        if (body === null) return fail();
        return mode === "Execute" ? owner.execute(body) : owner.resolve(body);
      });
      if (!finish) return fail();
      const until = finish();
      if (result === null) return null;
      if (result.profile === "TaxRegistrantCurrentSourceV1")
        return Object.freeze({ ...result, validUntil: until });
      if (result.profile === "TaxConfigCandidateCurrentV1")
        return parseTaxConfigCandidateCurrent({ ...result, validUntil: until });
      if (result.profile === "TaxConfigCandidateRosterV1")
        return parseTaxConfigCandidateRoster({ ...result, validUntil: until });
      if (result.profile === "TaxConfigMaterialComparisonV1")
        return parseTaxConfigMaterialComparison({ ...result, validUntil: until });
      if (result.profile === "TaxConfigMaterialCurrentV1")
        return parseTaxConfigMaterialCurrent({ ...result, validUntil: until });
      if (result.profile === "TaxConfigMaterialRosterV1")
        return parseTaxConfigMaterialRoster({ ...result, validUntil: until });
      if (result.profile === "TaxConfigAuthoringCurrentV1")
        return parseTaxConfigAuthoringCurrent({ ...result, validUntil: until });
      if (result.profile === "TaxConfigAuthoringRosterV1")
        return parseTaxConfigAuthoringRoster({ ...result, validUntil: until });
      if (result.profile === "TaxConfigClassificationChoicesV1")
        return parseTaxConfigClassificationChoices({ ...result, validUntil: until });
      if (result.profile === "TaxConfigAuthoringSimulationV1")
        return parseTaxConfigAuthoringSimulation({ ...result, validUntil: until });
      return result;
    } catch (error) {
      return bounded(error);
    }
  }
  return Object.freeze({
    async materialCompare(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("MaterialCompare", input);
      if (!result || result.profile !== "TaxConfigMaterialComparisonV1") return fail();
      return parseTaxConfigMaterialComparison(result);
    },
    async candidateCurrent(
      input: MerchantTaxConfigAuthoringRead & {
        configurationReference: unknown;
        targetVersionReference: unknown;
      },
    ) {
      const result = await perform("CandidateCurrent", input, {
        configurationReference: input.configurationReference,
        targetVersionReference: input.targetVersionReference,
      });
      if (!result || result.profile !== "TaxConfigCandidateCurrentV1") return fail();
      return parseTaxConfigCandidateCurrent(result);
    },
    async candidateRoster(
      input: MerchantTaxConfigAuthoringRead & {
        configurationReference: unknown;
        afterCandidate: unknown;
      },
    ) {
      const result = await perform("CandidateRoster", input, {
        configurationReference: input.configurationReference,
        afterCandidate: input.afterCandidate,
      });
      if (!result || result.profile !== "TaxConfigCandidateRosterV1") return fail();
      return parseTaxConfigCandidateRoster(result);
    },
    async candidatePrepare(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("CandidatePrepare", input);
      if (!result || result.profile !== "TaxConfigCandidateOperationV1") return fail();
      return parseTaxConfigCandidateOperation(result);
    },
    async candidateResolve(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("CandidateResolve", input);
      if (!result || result.profile !== "TaxConfigCandidateOperationV1") return fail();
      return parseTaxConfigCandidateOperation(result);
    },
    async taxRegistrant(input: MerchantTaxConfigAuthoringRead) {
      const result = await perform("TaxRegistrant", input);
      if (result !== null && result.profile !== "TaxRegistrantCurrentSourceV1") return fail();
      return result;
    },
    async materialCurrent(
      input: MerchantTaxConfigAuthoringRead & {
        materialKind: TaxConfigMaterialKind;
        materialReference: unknown;
      },
    ) {
      const result = await perform("MaterialCurrent", input, {
        materialKind: input.materialKind,
        materialReference: input.materialReference,
      });
      if (result === null || result.profile !== "TaxConfigMaterialCurrentV1") return fail();
      return parseTaxConfigMaterialCurrent(result);
    },
    async materialVersion(
      input: MerchantTaxConfigAuthoringRead & {
        materialKind: TaxConfigMaterialKind;
        versionReference: unknown;
      },
    ) {
      const result = await perform("MaterialVersion", input, {
        materialKind: input.materialKind,
        versionReference: input.versionReference,
      });
      if (result === null || result.profile !== "TaxConfigMaterialCurrentV1") return fail();
      return parseTaxConfigMaterialCurrent(result);
    },
    async materialRoster(
      input: MerchantTaxConfigAuthoringRead & {
        materialKind: TaxConfigMaterialKind;
        afterMaterial: unknown;
      },
    ) {
      const result = await perform("MaterialRoster", input, {
        materialKind: input.materialKind,
        afterMaterial: input.afterMaterial,
      });
      if (result === null || result.profile !== "TaxConfigMaterialRosterV1") return fail();
      return parseTaxConfigMaterialRoster(result);
    },
    async materialExecute(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("MaterialExecute", input);
      if (result === null || result.profile !== "TaxConfigMaterialOperationV1") return fail();
      return parseTaxConfigMaterialOperation(result);
    },
    async materialResolve(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("MaterialResolve", input);
      if (result === null || result.profile !== "TaxConfigMaterialOperationV1") return fail();
      return parseTaxConfigMaterialOperation(result);
    },
    async classifications(input: MerchantTaxConfigAuthoringRead) {
      const result = await perform("Classifications", input);
      if (result === null || result.profile !== "TaxConfigClassificationChoicesV1") return fail();
      return parseTaxConfigClassificationChoices(result);
    },
    async simulate(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("Simulate", input);
      if (result === null || result.profile !== "TaxConfigAuthoringSimulationV1") return fail();
      return parseTaxConfigAuthoringSimulation(result);
    },
    async current(input: MerchantTaxConfigAuthoringRead & { configurationReference: unknown }) {
      const result = await perform("Current", input, input.configurationReference);
      if (result === null || result.profile !== "TaxConfigAuthoringCurrentV1") return fail();
      return parseTaxConfigAuthoringCurrent(result);
    },
    async roster(input: MerchantTaxConfigAuthoringRead & { afterConfiguration: unknown }) {
      const result = await perform("Roster", input, input.afterConfiguration);
      if (result === null || result.profile !== "TaxConfigAuthoringRosterV1") return fail();
      return parseTaxConfigAuthoringRoster(result);
    },
    async execute(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("Execute", input);
      if (result === null || result.profile !== "TaxConfigAuthoringOperationV1") return fail();
      return parseTaxConfigAuthoringOperation(result);
    },
    async resolve(input: MerchantTaxConfigAuthoringWrite) {
      const result = await perform("Resolve", input);
      if (result === null || result.profile !== "TaxConfigAuthoringOperationV1") return fail();
      return parseTaxConfigAuthoringOperation(result);
    },
  });
}
