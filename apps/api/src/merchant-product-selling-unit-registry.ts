import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogLocale,
  parseLocalizedNames,
  parseCatalogSellingUnitRegistryCommand,
  catalogSellingUnitDefinitionsDigest,
  createPostgresSellingUnitRegistryStore,
  sellingUnitRegistryFields,
  sellingUnitRegistrationResolutionFields,
  parseCatalogSellingUnitRegistrationResolutionCommand,
  parseCatalogSellingUnitRegistrationResolution,
  type CatalogSellingUnitRegistrationResolution,
  type CatalogSellingUnitInspection,
  type CatalogSellingUnitDefinition,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import {
  bindMerchantProductCommandScope,
  parseMerchantProductCommandScope,
} from "./merchant-product-command-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const fullPermissions = Object.freeze([
  "catalog.manage",
  "catalog.product.read",
  "catalog.product.history.read",
  "catalog.sku.read",
]);
const managePermissions = Object.freeze(["catalog.manage"]);
function identity(operation: string, brand: string, purpose: string) {
  const digest = sha256Hex("CatalogSellingUnitHttp:" + brand + ":" + purpose + ":" + operation);
  return parseCatalogReference(
    operation.slice(0, 14) +
      "7" +
      digest.slice(0, 3) +
      "-8" +
      digest.slice(3, 6) +
      "-" +
      digest.slice(6, 18),
  );
}
export interface MerchantProductSellingUnitRegistryOptions {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly auditReference: (operationReference: string) => string;
}
interface Request {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly command: unknown;
  readonly expectedScope: unknown;
}
export interface MerchantProductSellingUnitRegistryView {
  readonly profile: "CatalogProductSellingUnitRegistryViewV1";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly presence: "Absent" | "Present";
  readonly registryVersion: number;
  readonly defaultLocale: string | null;
  readonly units: readonly CatalogSellingUnitDefinition[];
  readonly assignedHistory: readonly {
    readonly unitCode: string;
    readonly currentSkuCount: number;
    readonly historicalAssignmentCount: number;
    readonly quantities: readonly string[];
  }[];
  readonly historyDigest: string;
  readonly definitionsDigest: string | null;
  readonly inspectionDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantProductSellingUnitRegistryResult {
  readonly profile: "CatalogProductSellingUnitRegistryResultV1";
  readonly status: "Applied" | "Replayed";
  readonly operationReference: string;
  readonly registryVersion: number;
  readonly snapshotDigest: string;
}
export interface MerchantSellingUnitRegistrationContext {
  readonly profile: "CatalogSellingUnitRegistrationContextV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly action: "Create" | "ReplaceDraft";
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface MerchantSellingUnitRegistrationResolutionResult {
  readonly profile: "CatalogSellingUnitRegistrationResolutionResultV1";
  readonly storeReference: string;
  readonly resolution: CatalogSellingUnitRegistrationResolution;
}
type Mode = "Inspect" | "Register" | "Context" | "Resolve";
type Result =
  | MerchantProductSellingUnitRegistryView
  | MerchantProductSellingUnitRegistryResult
  | MerchantSellingUnitRegistrationContext
  | MerchantSellingUnitRegistrationResolutionResult;
function decode(value: unknown, mode: Mode) {
  try {
    if (mode === "Resolve") {
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
        "profile",
        "tenantReference",
        "actorReference",
        "action",
        "operationReference",
        "expectedRegistryVersion",
      ]);
      if (
        raw.profile !== "CatalogSellingUnitRegistrationResolutionRequestV1" ||
        (raw.action !== "Create" && raw.action !== "ReplaceDraft") ||
        !Number.isSafeInteger(raw.expectedRegistryVersion) ||
        (raw.expectedRegistryVersion as number) < 0 ||
        (raw.expectedRegistryVersion as number) >= 2147483647
      )
        return fail("CATALOG_INPUT_INVALID");
      return Object.freeze({
        mode: "Resolve",
        action: raw.action,
        tenantReference: parseCatalogReference(raw.tenantReference),
        actorReference: parseCatalogReference(raw.actorReference),
        operationReference: parseCatalogReference(raw.operationReference),
        expectedRegistryVersion: raw.expectedRegistryVersion as number,
      });
    }
    const copied = copyCategoryPersistenceValue(value),
      hasConfirmation =
        mode === "Register" &&
        copied !== null &&
        typeof copied === "object" &&
        Object.hasOwn(copied, "bootstrapConfirmation"),
      raw = readClosedRecord(
        copied,
        mode === "Inspect" || mode === "Context"
          ? ["action"]
          : [
              "action",
              "operationReference",
              "expectedRegistryVersion",
              "defaultLocale",
              "units",
              ...(hasConfirmation ? ["bootstrapConfirmation"] : []),
            ],
      );
    if (raw.action !== "Create" && raw.action !== "ReplaceDraft")
      return fail("CATALOG_INPUT_INVALID");
    const action = raw.action;
    if (mode === "Inspect") return Object.freeze({ mode: "Inspect", action });
    if (mode === "Context") return Object.freeze({ mode: "Context", action });
    if (
      !Number.isSafeInteger(raw.expectedRegistryVersion) ||
      (raw.expectedRegistryVersion as number) < 0 ||
      (raw.expectedRegistryVersion as number) >= 2147483647 ||
      !Array.isArray(raw.units) ||
      raw.units.length < 1 ||
      raw.units.length > 1000
    )
      return fail("CATALOG_INPUT_INVALID");
    const defaultLocale = parseCatalogLocale(raw.defaultLocale),
      units = raw.units.map((value) => {
        const unit = readClosedRecord(value, [
          "unitReference",
          "code",
          "semanticDefinition",
          "quantityDecimalPlaces",
          "localizedNames",
          "lifecycle",
        ]);
        if (
          typeof unit.semanticDefinition !== "string" ||
          !Number.isSafeInteger(unit.quantityDecimalPlaces) ||
          (unit.quantityDecimalPlaces as number) < 0 ||
          (unit.quantityDecimalPlaces as number) > 6 ||
          !["Active", "Inactive", "Retired"].includes(unit.lifecycle as string)
        )
          return fail("CATALOG_INPUT_INVALID");
        return Object.freeze({
          unitReference:
            unit.unitReference === null ? null : parseCatalogReference(unit.unitReference),
          code: parseCatalogCode(unit.code),
          semanticDefinition: unit.semanticDefinition,
          quantityDecimalPlaces: unit.quantityDecimalPlaces as number,
          localizedNames: parseLocalizedNames(unit.localizedNames, defaultLocale),
          lifecycle: unit.lifecycle as "Active" | "Inactive" | "Retired",
        });
      });
    let bootstrapConfirmation:
      | {
          readonly historyDigest: string;
          readonly confirmations: readonly {
            readonly unitCode: string;
            readonly semanticDefinition: string;
            readonly confirmed: true;
          }[];
        }
      | undefined;
    if (hasConfirmation) {
      const confirmation = readClosedRecord(raw.bootstrapConfirmation, [
        "historyDigest",
        "confirmations",
      ]);
      if (
        typeof confirmation.historyDigest !== "string" ||
        !confirmation.historyDigest.startsWith("sha256:") ||
        !Array.isArray(confirmation.confirmations) ||
        confirmation.confirmations.length < 1 ||
        confirmation.confirmations.length > 1000
      )
        return fail("CATALOG_INPUT_INVALID");
      bootstrapConfirmation = Object.freeze({
        historyDigest: "sha256:" + parseCatalogHash(confirmation.historyDigest.slice(7)),
        confirmations: Object.freeze(
          confirmation.confirmations.map((value) => {
            const item = readClosedRecord(value, ["unitCode", "semanticDefinition", "confirmed"]);
            if (item.confirmed !== true || typeof item.semanticDefinition !== "string")
              return fail("CATALOG_INPUT_INVALID");
            return Object.freeze({
              unitCode: parseCatalogCode(item.unitCode),
              semanticDefinition: item.semanticDefinition,
              confirmed: true as const,
            });
          }),
        ),
      });
    }
    return Object.freeze({
      mode: "Register",
      action,
      operationReference: parseCatalogReference(raw.operationReference),
      expectedRegistryVersion: raw.expectedRegistryVersion as number,
      defaultLocale,
      units: Object.freeze(units),
      ...(bootstrapConfirmation ? { bootstrapConfirmation } : {}),
    });
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}
function view(
  source: CatalogSellingUnitInspection,
  storeReference: string,
): MerchantProductSellingUnitRegistryView {
  const grouped = new Map<
    string,
    {
      unitCode: string;
      currentSkuCount: number;
      historicalAssignmentCount: number;
      quantities: Set<string>;
    }
  >();
  for (const assignment of source.assignments) {
    let item = grouped.get(assignment.unitCode);
    if (!item) {
      item = {
        unitCode: assignment.unitCode,
        currentSkuCount: 0,
        historicalAssignmentCount: 0,
        quantities: new Set(),
      };
      grouped.set(assignment.unitCode, item);
    }
    if (assignment.source === "CurrentSku") item.currentSkuCount++;
    else item.historicalAssignmentCount++;
    item.quantities.add(assignment.unitQuantity);
  }
  return Object.freeze({
    profile: "CatalogProductSellingUnitRegistryViewV1",
    brandReference: source.brandReference,
    storeReference,
    presence: source.presence,
    registryVersion: source.registry?.registryVersion ?? 0,
    defaultLocale: source.registry?.defaultLocale ?? null,
    units: source.registry?.units ?? Object.freeze([]),
    assignedHistory: Object.freeze(
      [...grouped.values()]
        .sort((a, b) => a.unitCode.localeCompare(b.unitCode))
        .map((item) =>
          Object.freeze({
            unitCode: item.unitCode,
            currentSkuCount: item.currentSkuCount,
            historicalAssignmentCount: item.historicalAssignmentCount,
            quantities: Object.freeze([...item.quantities].sort()),
          }),
        ),
    ),
    historyDigest: source.historyDigest,
    definitionsDigest:
      source.registry === null ? null : catalogSellingUnitDefinitionsDigest(source.registry),
    inspectionDigest: source.inspectionDigest,
    observedAt: source.observation.observedAt,
    validUntil: source.observation.validUntil,
  });
}
/** Contextual ordinary authoring entry. Real persisted identity/current authority
 * and owner SQL run on one original five-second transaction; no caller grants. */
export function createMerchantProductSellingUnitRegistry(
  options: MerchantProductSellingUnitRegistryOptions,
) {
  if (
    typeof options.merchant?.transactions?.run !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.authentication?.authorize !== "function" ||
    typeof options.auditReference !== "function"
  )
    return fail();
  const run = options.merchant.transactions.run.bind(options.merchant.transactions),
    clock = options.merchant.now.bind(options.merchant),
    authenticate = options.authentication.authorize.bind(options.authentication),
    auditReference = options.auditReference.bind(options),
    merchant = Object.freeze({
      ...options.merchant,
      transactions: { run },
      now: clock,
      ...(options.merchant.validateAssociation
        ? { validateAssociation: options.merchant.validateAssociation.bind(options.merchant) }
        : {}),
      ...(options.merchant.currentActor
        ? { currentActor: options.merchant.currentActor.bind(options.merchant) }
        : {}),
    }),
    resolve = createMerchantBrandScope(merchant),
    host = createMerchantCategoryTransactions({ run });
  async function execute(request: Request, mode: Mode): Promise<Result> {
    const command = decode(request.command, mode),
      expected = parseMerchantProductCommandScope(request.expectedScope),
      sessionCookie = request.sessionCookie,
      csrf = request.csrf;
    let latest = parseCatalogInstant(clock()),
      failed = false;
    const startedAt = latest,
      deadline = new Date(Date.parse(startedAt) + 5000).toISOString();
    const reject = (): never => {
      failed = true;
      return fail();
    };
    const now = () => {
      try {
        const at = parseCatalogInstant(clock());
        if (failed || at < latest || at >= deadline) return reject();
        latest = at;
        return at;
      } catch {
        return reject();
      }
    };
    const session = await authenticate({ sessionCookie, csrf }).catch((error: unknown) =>
      fail(
        error instanceof BrowserSessionError
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
      ),
    );
    now();
    let calls = 0,
      completed: Result | undefined;
    const result = await host.transactions.run(async (tx) => {
      if (++calls !== 1) return reject();
      const query = tx.query;
      let ready = false,
        assertCurrent: (() => void) | undefined,
        rehold: (() => Promise<void>) | undefined,
        permissions: readonly string[] = managePermissions;
      const check = () => {
        now();
        if (tx.query !== query) return reject();
        assertCurrent?.();
      };
      await host.registerBeforeCommit(
        tx,
        async () => {
          if (!ready || !rehold) return reject();
          await rehold();
          check();
        },
        () => {
          if (!ready) return reject();
          check();
        },
      );
      try {
        const scope = await resolve(tx, sessionCookie, session.sessionReference);
        check();
        const selected = bindMerchantProductCommandScope(
            {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.selectedStoreReference,
            },
            expected,
          ),
          tenantReference = parseCatalogReference(scope.tenantReference),
          actorReference = parseCatalogReference(scope.actorReference),
          capabilityKey =
            command.action === "Create"
              ? ("catalog.cat_product_create" as const)
              : ("catalog.cat_product_edit" as const),
          current = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: session.sessionReference,
            clock: { now },
            originalValidUntil: deadline,
            capabilityKey,
          }),
          capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference,
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
            actorReference,
            clock: { now },
            originalValidUntil: deadline,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: current,
            capabilityKey,
          });
        assertCurrent = current.assertCurrent;
        rehold = async () => {
          check();
          await capability.holdUntilCommit();
          check();
          await current.authorizeActions(permissions);
          check();
        };
        let sourceRuns = 0;
        const store = createPostgresSellingUnitRegistryStore({
          tenantReference,
          brandReference: selected.brandReference,
          actorReference,
          actorKind: "User",
          clock: { now },
          transactions: {
            async run(work) {
              if (++sourceRuns > (mode === "Register" ? 2 : 1)) return reject();
              check();
              const value = await work(tx);
              check();
              return value;
            },
          },
          async registerBeforeCommit(actual, guard, finalAssert) {
            if (actual !== tx) return reject();
            await host.registerBeforeCommit(actual, guard, finalAssert);
            check();
          },
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              const expectedPermissions =
                packet.mode === "Inspect" || packet.mode === "Register"
                  ? fullPermissions
                  : managePermissions;
              if (
                actual !== tx ||
                packet.tenantReference !== tenantReference ||
                packet.brandReference !== selected.brandReference ||
                packet.actorReference !== actorReference ||
                packet.actorKind !== "User" ||
                packet.purposeCode !== "CATALOG_SELLING_UNIT_REGISTRY" ||
                packet.permission !== "catalog.manage" ||
                packet.action !== "catalog.manage" ||
                !(
                  mode === "Inspect"
                    ? ["Inspect"]
                    : mode === "Resolve"
                      ? ["Resolve"]
                      : ["Intent", "Replay", "Register"]
                ).includes(packet.mode) ||
                canonicalizeRfc8785(packet.requiredPermissions) !==
                  canonicalizeRfc8785(expectedPermissions) ||
                canonicalizeRfc8785(packet.requiredFields) !==
                  canonicalizeRfc8785(
                    packet.mode === "Resolve"
                      ? sellingUnitRegistrationResolutionFields
                      : sellingUnitRegistryFields,
                  ) ||
                packet.observedAt < startedAt ||
                packet.observedAt > now()
              )
                return reject();
              if (expectedPermissions === fullPermissions) permissions = fullPermissions;
              if (!rehold) return reject();
              await rehold();
            },
          },
          audit: {
            create(value) {
              return {
                auditId: parseCatalogReference(auditReference(value.operationReference)),
                brandId: selected.brandReference,
                actor: { type: "User", reference: actorReference },
                actionCode: "CATALOG_SELLING_UNIT_REGISTRY_RECORDED",
                targetType: "CatalogSellingUnitRegistry",
                targetId: value.registry.registryReference,
                reasonCode: value.reasonCode,
                correlationId: value.operationReference,
                occurredAt: value.occurredAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
            createAbandonment({ command: original, resolution }) {
              return {
                auditId: parseCatalogReference(auditReference(original.operationReference)),
                brandId: selected.brandReference,
                actor: { type: "User", reference: actorReference },
                actionCode: "CATALOG_SELLING_UNIT_REGISTRATION_ABANDONED",
                targetType: "SellingUnitRegistrationOperation",
                targetId: original.operationReference,
                reasonCode: "ORIGINAL_OPERATION_ABANDONED",
                correlationId: original.operationReference,
                occurredAt: resolution.recordedAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
        });
        const observation = Object.freeze({
          originalIntentDigest:
            "sha256:" +
            sha256Hex(
              canonicalizeRfc8785({
                mode,
                command,
                tenantReference,
                brandReference: selected.brandReference,
                actorReference,
              }),
            ),
          observedAt: startedAt,
          validUntil: deadline,
        });
        if (command.mode === "Context") {
          await rehold();
          completed = Object.freeze({
            profile: "CatalogSellingUnitRegistrationContextV1",
            tenantReference,
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
            actorReference,
            action: command.action,
            observedAt: startedAt,
            validUntil: deadline,
          });
        } else if (command.mode === "Resolve") {
          if (
            !("tenantReference" in command) ||
            command.tenantReference !== tenantReference ||
            command.actorReference !== actorReference
          )
            return fail("CATALOG_PERMISSION_DENIED");
          const original = parseCatalogSellingUnitRegistrationResolutionCommand({
              profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
              tenantReference,
              brandReference: selected.brandReference,
              actorReference,
              action: command.action,
              operationReference: command.operationReference,
              expectedRegistryVersion: command.expectedRegistryVersion,
            }),
            resolution = parseCatalogSellingUnitRegistrationResolution(
              await store.resolveRegistrationOperation(original),
            );
          check();
          if (
            canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(original) ||
            resolution.recordedAt > now()
          )
            return reject();
          completed = Object.freeze({
            profile: "CatalogSellingUnitRegistrationResolutionResultV1",
            storeReference: selected.storeReference,
            resolution,
          });
        } else if (command.mode === "Inspect") {
          completed = await store.withCurrentInspection(observation, async (source, actual) => {
            check();
            if (
              actual !== tx ||
              source.tenantReference !== tenantReference ||
              source.brandReference !== selected.brandReference ||
              source.actorReference !== actorReference ||
              canonicalizeRfc8785(source.observation) !== canonicalizeRfc8785(observation) ||
              source.sourceAuthority !== "CurrentTransactionHeld"
            )
              return reject();
            return view(source, selected.storeReference);
          });
        } else {
          const operationReference = command.operationReference,
            units = command.units,
            expectedRegistryVersion = command.expectedRegistryVersion,
            defaultLocale = command.defaultLocale;
          let preparations = 0;
          const prepared = await store.withRegistrationOperation(
            { ...observation, operationReference: operationReference },
            async (original, registry, actual) => {
              check();
              if (
                ++preparations !== 1 ||
                actual !== tx ||
                (original && original.actorReference !== actorReference)
              )
                return reject();
              if (original && expectedRegistryVersion !== original.expectedRegistryVersion)
                return fail("CATALOG_IDEMPOTENCY_CONFLICT");
              if (!original && (registry?.registryVersion ?? 0) !== expectedRegistryVersion)
                return fail("CATALOG_VERSION_CONFLICT");
              if (
                !original &&
                units.some(
                  (unit) =>
                    unit.unitReference !== null &&
                    !registry?.units.some(
                      (existing) => existing.unitReference === unit.unitReference,
                    ),
                )
              )
                return fail("CATALOG_INPUT_INVALID");
              const occurredAt = original?.occurredAt ?? startedAt,
                registryValue = {
                  profile: "CatalogSellingUnitRegistryV1",
                  tenantReference,
                  brandReference: selected.brandReference,
                  registryReference:
                    registry?.registryReference ??
                    identity(operationReference, selected.brandReference, "REGISTRY"),
                  versionReference:
                    original?.registry.versionReference ??
                    identity(operationReference, selected.brandReference, "VERSION"),
                  registryVersion: expectedRegistryVersion + 1,
                  previousSnapshotDigest: original
                    ? original.registry.previousSnapshotDigest
                    : registry === null
                      ? null
                      : "sha256:" + sha256Hex(canonicalizeRfc8785(registry)),
                  registeredAt: occurredAt,
                  defaultLocale,
                  units: units.map((unit) => ({
                    ...unit,
                    unitReference:
                      unit.unitReference ??
                      identity(operationReference, selected.brandReference, "UNIT:" + unit.code),
                  })),
                },
                candidate = parseCatalogSellingUnitRegistryCommand({
                  purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
                  tenantReference,
                  brandReference: selected.brandReference,
                  actorReference,
                  actorKind: "User",
                  operationReference,
                  expectedRegistryVersion,
                  occurredAt,
                  reasonCode:
                    command.action === "Create" ? "PRODUCT_CREATE_UNITS" : "PRODUCT_DRAFT_UNITS",
                  registry: registryValue,
                  ...("bootstrapConfirmation" in command && command.bootstrapConfirmation
                    ? {
                        bootstrapConfirmation: {
                          profile: "CatalogSellingUnitBootstrapConfirmationV1",
                          ...command.bootstrapConfirmation,
                          definitionsDigest: catalogSellingUnitDefinitionsDigest(registryValue),
                        },
                      }
                    : {}),
                });
              if (original && canonicalizeRfc8785(candidate) !== canonicalizeRfc8785(original))
                return fail("CATALOG_IDEMPOTENCY_CONFLICT");
              return candidate;
            },
          );
          if (preparations !== 1) return reject();
          const { intentDigest, snapshotDigest, ...payload } = prepared;
          void intentDigest;
          void snapshotDigest;
          const written = await store.execute(payload);
          check();
          completed = Object.freeze({
            profile: "CatalogProductSellingUnitRegistryResultV1",
            status: written.status,
            operationReference: written.operationReference,
            registryVersion: written.registry.registryVersion,
            snapshotDigest: written.snapshotDigest,
          });
        }
        check();
        if (sourceRuns !== (mode === "Context" ? 0 : mode === "Register" ? 2 : 1)) return reject();
        ready = true;
        return completed;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (calls !== 1 || !completed || result !== completed) return reject();
    now();
    return result;
  }
  return Object.freeze({
    context: (request: Request) =>
      execute(request, "Context") as Promise<MerchantSellingUnitRegistrationContext>,
    resolve: (request: Request) =>
      execute(request, "Resolve") as Promise<MerchantSellingUnitRegistrationResolutionResult>,
    inspect: (request: Request) =>
      execute(request, "Inspect") as Promise<MerchantProductSellingUnitRegistryView>,
    register: (request: Request) =>
      execute(request, "Register") as Promise<MerchantProductSellingUnitRegistryResult>,
  });
}
