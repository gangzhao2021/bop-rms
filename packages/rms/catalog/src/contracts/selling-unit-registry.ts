import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
import {
  parseSellingUnitRegistryStructure,
  assertSellingUnitRegistrySuccessor,
  assertSellingUnitQuantity,
  assertSellingUnitRegistryBootstrap,
} from "../domain/selling-unit-registry.js";
export type {
  CatalogSellingUnitDefinition,
  CatalogSellingUnitRegistry,
} from "../domain/selling-unit-registry.js";
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
export function parseCatalogSellingUnitRegistry(value: unknown) {
  const registry = parseSellingUnitRegistryStructure(copyCategoryPersistenceValue(value));
  if (new TextEncoder().encode(canonicalizeRfc8785(registry)).byteLength > 1048576)
    return invalid();
  return registry;
}
export const catalogSellingUnitRegistryDigest = (value: unknown) =>
  hash(parseCatalogSellingUnitRegistry(value));
export function parseCatalogSellingUnitRegistryCommand(value: unknown) {
  const captured = copyCategoryPersistenceValue(value);
  const hasConfirmation =
    !!captured && typeof captured === "object" && Object.hasOwn(captured, "bootstrapConfirmation");
  const r = readClosedRecord(captured, [
      "purposeCode",
      "tenantReference",
      "brandReference",
      "actorReference",
      "actorKind",
      "operationReference",
      "expectedRegistryVersion",
      "occurredAt",
      "reasonCode",
      "registry",
      ...(hasConfirmation ? ["bootstrapConfirmation"] : []),
    ]),
    registry = parseCatalogSellingUnitRegistry(r.registry);
  if (
    r.purposeCode !== "CATALOG_SELLING_UNIT_REGISTRY" ||
    r.actorKind !== "User" ||
    !Number.isSafeInteger(r.expectedRegistryVersion) ||
    (r.expectedRegistryVersion as number) < 0 ||
    (r.expectedRegistryVersion as number) >= 2147483647
  )
    return invalid();
  const command = Object.freeze({
    purposeCode: "CATALOG_SELLING_UNIT_REGISTRY" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    actorKind: "User" as const,
    operationReference: parseCatalogReference(r.operationReference),
    expectedRegistryVersion: r.expectedRegistryVersion as number,
    occurredAt: parseCatalogInstant(r.occurredAt),
    reasonCode: parseCatalogCode(r.reasonCode),
    registry,
    ...(hasConfirmation
      ? {
          bootstrapConfirmation: parseCatalogSellingUnitBootstrapConfirmation(
            r.bootstrapConfirmation,
            registry,
          ),
        }
      : {}),
  });
  if (
    registry.tenantReference !== command.tenantReference ||
    registry.brandReference !== command.brandReference ||
    registry.registryVersion !== command.expectedRegistryVersion + 1 ||
    registry.registeredAt !== command.occurredAt ||
    (registry.registryVersion === 1) !== (registry.previousSnapshotDigest === null)
  )
    return invalid();
  return Object.freeze({ ...command, intentDigest: hash(command), snapshotDigest: hash(registry) });
}
export type CatalogSellingUnitRegistryCommand = ReturnType<
  typeof parseCatalogSellingUnitRegistryCommand
>;
export function assertCatalogSellingUnitRegistrySuccessor(
  previousValue: unknown | null,
  nextValue: unknown,
  assignedUnitCodes: readonly string[],
) {
  const previous = previousValue === null ? null : parseCatalogSellingUnitRegistry(previousValue),
    next = parseCatalogSellingUnitRegistry(nextValue);
  if (
    previous !== null &&
    next.previousSnapshotDigest !== catalogSellingUnitRegistryDigest(previous)
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  assertSellingUnitRegistrySuccessor(previous, next, assignedUnitCodes);
}
export function assertCatalogRegisteredSellingUnitQuantity(
  registryValue: unknown,
  brandReference: string,
  unitCode: unknown,
  quantity: unknown,
) {
  assertSellingUnitQuantity(
    parseCatalogSellingUnitRegistry(registryValue),
    brandReference,
    unitCode,
    quantity,
  );
}

export interface CatalogSellingUnitBootstrapConfirmation {
  readonly profile: "CatalogSellingUnitBootstrapConfirmationV1";
  readonly historyDigest: string;
  readonly definitionsDigest: string;
  readonly confirmations: readonly {
    readonly unitCode: string;
    readonly semanticDefinition: string;
    readonly confirmed: true;
  }[];
}
export const catalogSellingUnitDefinitionsDigest = (registryValue: unknown) =>
  hash(parseCatalogSellingUnitRegistry(registryValue).units);
export function parseCatalogSellingUnitBootstrapConfirmation(
  value: unknown,
  registryValue: unknown,
): CatalogSellingUnitBootstrapConfirmation {
  const registry = parseCatalogSellingUnitRegistry(registryValue);
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "historyDigest",
    "definitionsDigest",
    "confirmations",
  ]);
  if (
    r.profile !== "CatalogSellingUnitBootstrapConfirmationV1" ||
    typeof r.historyDigest !== "string" ||
    !r.historyDigest.startsWith("sha256:") ||
    r.definitionsDigest !== catalogSellingUnitDefinitionsDigest(registry) ||
    !Array.isArray(r.confirmations) ||
    r.confirmations.length < 1 ||
    r.confirmations.length > 1000 ||
    registry.registryVersion !== 1
  )
    return invalid();
  const confirmations = r.confirmations
    .map((value) => {
      const item = readClosedRecord(value, ["unitCode", "semanticDefinition", "confirmed"]),
        unitCode = parseCatalogCode(item.unitCode),
        unit = registry.units.find((unit) => unit.code === unitCode);
      if (!unit || item.confirmed !== true || item.semanticDefinition !== unit.semanticDefinition)
        return invalid();
      return Object.freeze({
        unitCode,
        semanticDefinition: unit.semanticDefinition,
        confirmed: true as const,
      });
    })
    .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
  if (new Set(confirmations.map((item) => item.unitCode)).size !== confirmations.length)
    return invalid();
  return Object.freeze({
    profile: r.profile,
    historyDigest: "sha256:" + parseCatalogHash(r.historyDigest.slice(7)),
    definitionsDigest: r.definitionsDigest as string,
    confirmations: Object.freeze(confirmations),
  });
}
export function assertCatalogSellingUnitRegistryBootstrap(
  nextValue: unknown,
  assignments: readonly { readonly unitCode: string; readonly unitQuantity: string }[],
  confirmationValue: unknown,
  actualHistoryDigest: string,
) {
  const registry = parseCatalogSellingUnitRegistry(nextValue),
    confirmation = parseCatalogSellingUnitBootstrapConfirmation(confirmationValue, registry);
  if (confirmation.historyDigest !== actualHistoryDigest)
    throw new CatalogError("CATALOG_VERSION_CONFLICT");
  assertSellingUnitRegistryBootstrap(registry, assignments, confirmation.confirmations);
}

export interface CatalogSellingUnitRegistrationResolutionCommand {
  readonly profile: "CatalogSellingUnitRegistrationResolutionCommandV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly action: "Create" | "ReplaceDraft";
  readonly operationReference: string;
  readonly expectedRegistryVersion: number;
}
export interface CatalogSellingUnitRegistrationResolution {
  readonly profile: "CatalogSellingUnitRegistrationResolutionV1";
  readonly outcome: "Committed" | "Abandoned";
  readonly command: CatalogSellingUnitRegistrationResolutionCommand;
  readonly registryReference: string | null;
  readonly versionReference: string | null;
  readonly registryVersion: number | null;
  readonly originalIntentDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly recordedAt: string;
  readonly digest: string;
}
export function parseCatalogSellingUnitRegistrationResolutionCommand(
  value: unknown,
): CatalogSellingUnitRegistrationResolutionCommand {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "tenantReference",
    "brandReference",
    "actorReference",
    "action",
    "operationReference",
    "expectedRegistryVersion",
  ]);
  if (
    r.profile !== "CatalogSellingUnitRegistrationResolutionCommandV1" ||
    (r.action !== "Create" && r.action !== "ReplaceDraft") ||
    !Number.isSafeInteger(r.expectedRegistryVersion) ||
    (r.expectedRegistryVersion as number) < 0 ||
    (r.expectedRegistryVersion as number) >= 2147483647
  )
    return invalid();
  return Object.freeze({
    profile: r.profile,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    action: r.action,
    operationReference: parseCatalogReference(r.operationReference),
    expectedRegistryVersion: r.expectedRegistryVersion as number,
  });
}
export function parseCatalogSellingUnitRegistrationResolution(
  value: unknown,
): CatalogSellingUnitRegistrationResolution {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
      "profile",
      "outcome",
      "command",
      "registryReference",
      "versionReference",
      "registryVersion",
      "originalIntentDigest",
      "snapshotDigest",
      "recordedAt",
      "digest",
    ]),
    command = parseCatalogSellingUnitRegistrationResolutionCommand(r.command);
  if (
    r.profile !== "CatalogSellingUnitRegistrationResolutionV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned")
  )
    return invalid();
  const registryReference =
      r.registryReference === null ? null : parseCatalogReference(r.registryReference),
    versionReference =
      r.versionReference === null ? null : parseCatalogReference(r.versionReference),
    recordedAt = parseCatalogInstant(r.recordedAt);
  if (r.outcome === "Abandoned") {
    if (
      registryReference !== null ||
      versionReference !== null ||
      r.registryVersion !== null ||
      r.originalIntentDigest !== null ||
      r.snapshotDigest !== null
    )
      return invalid();
  } else if (
    registryReference === null ||
    versionReference === null ||
    r.registryVersion !== command.expectedRegistryVersion + 1 ||
    typeof r.originalIntentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(r.originalIntentDigest) ||
    typeof r.snapshotDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(r.snapshotDigest)
  )
    return invalid();
  const body = {
    profile: r.profile,
    outcome: r.outcome,
    command,
    registryReference,
    versionReference,
    registryVersion: r.registryVersion as number | null,
    originalIntentDigest: r.originalIntentDigest as string | null,
    snapshotDigest: r.snapshotDigest as string | null,
    recordedAt,
  };
  if (r.digest !== hash(body)) return invalid();
  return Object.freeze({
    ...body,
    digest: r.digest as string,
  }) as CatalogSellingUnitRegistrationResolution;
}
export function buildCatalogSellingUnitRegistrationResolution(
  input: Omit<CatalogSellingUnitRegistrationResolution, "profile" | "digest">,
): CatalogSellingUnitRegistrationResolution {
  const body = { profile: "CatalogSellingUnitRegistrationResolutionV1" as const, ...input };
  return parseCatalogSellingUnitRegistrationResolution({ ...body, digest: hash(body) });
}
