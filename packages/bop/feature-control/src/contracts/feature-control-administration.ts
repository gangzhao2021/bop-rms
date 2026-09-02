import { revalidateTenantContext } from "@bop/permission";
import {
  parseBrandReference,
  parseStoreReference,
  type CanonicalInstant,
  type TenantContext,
} from "@bop/tenant";
import {
  parseFeatureControlInstant,
  parseFeatureControlKey,
  parseFeatureControlOwnerReference,
  parseFeatureControlPurposeCode,
  parseFeatureControlReference,
  parseFeatureControlVersion,
  type FeatureControlKey,
  type FeatureControlOwnerReference,
  type FeatureControlPurposeCode,
  type FeatureControlReference,
  type FeatureControlScope,
  type FeatureControlVersion,
} from "./feature-control.js";

export const featureControlAdministrationLifecycles = [
  "Draft",
  "PendingApproval",
  "Approved",
  "Published",
  "Superseded",
  "Disabled",
] as const;
export type FeatureControlAdministrationLifecycle =
  (typeof featureControlAdministrationLifecycles)[number];
export type FeatureControlEffectiveValue = "Enabled" | "Disabled";
export type FeatureControlSource = "PlatformDefault" | "BrandOverride" | "StoreOverride";
export type FeatureControlDependencyKind =
  "RequiresCapability" | "ConflictsWithCapability" | "RequiresFutureTrigger";
export type FeatureControlDependencyStatus = "Satisfied" | "Unsatisfied" | "NotApplicable";

export interface FeatureControlDependency {
  readonly dependencyId: FeatureControlReference;
  readonly kind: FeatureControlDependencyKind;
  readonly targetKey: FeatureControlKey;
  readonly minimumCompatibleVersion: FeatureControlVersion;
  readonly status: FeatureControlDependencyStatus;
  readonly evidenceReference: FeatureControlReference | null;
  readonly evidenceVersion: FeatureControlVersion | null;
}
export interface FeatureControlAdministrationDefinition {
  readonly controlId: FeatureControlReference;
  readonly key: FeatureControlKey;
  readonly description: string;
  readonly version: FeatureControlVersion;
  readonly ownerReference: FeatureControlOwnerReference;
  readonly purposeCode: FeatureControlPurposeCode;
  readonly scope: FeatureControlScope;
  readonly source: FeatureControlSource;
  readonly defaultValue: FeatureControlEffectiveValue;
  readonly configuredValue: FeatureControlEffectiveValue;
  readonly lifecycle: FeatureControlAdministrationLifecycle;
  readonly temporary: boolean;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly reviewAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant | null;
  readonly dependencies: readonly FeatureControlDependency[];
  readonly authoredByReference: FeatureControlReference;
  readonly approvedByReference: FeatureControlReference | null;
  readonly approvalEvidenceReference: FeatureControlReference | null;
  readonly publicationReference: FeatureControlReference | null;
}
export class FeatureControlAdministrationError extends Error {
  constructor(
    readonly code: "FEATURE_CONTROL_ADMIN_INVALID" | "FEATURE_CONTROL_DEPENDENCY_BLOCKED",
  ) {
    super(
      code === "FEATURE_CONTROL_ADMIN_INVALID"
        ? "feature control administration input is invalid"
        : "feature control dependencies block publication",
    );
    this.name = "FeatureControlAdministrationError";
  }
}
const invalid = (): never => {
  throw new FeatureControlAdministrationError("FEATURE_CONTROL_ADMIN_INVALID");
};
const plain = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
};
const optionalInstant = (value: unknown) =>
  value === null ? null : parseFeatureControlInstant(value);
function parseScope(value: unknown): FeatureControlScope {
  const input = plain(value, ["kind", "brandReference", "storeReference"]);
  const brandReference = parseBrandReference(input.brandReference);
  const storeReference =
    input.storeReference === null ? null : parseStoreReference(input.storeReference);
  if (
    (input.kind !== "Brand" && input.kind !== "Store") ||
    (input.kind === "Brand") !== (storeReference === null)
  )
    return invalid();
  return Object.freeze({ kind: input.kind, brandReference, storeReference }) as FeatureControlScope;
}
function parseDependency(value: unknown): FeatureControlDependency {
  const input = plain(value, [
    "dependencyId",
    "kind",
    "targetKey",
    "minimumCompatibleVersion",
    "status",
    "evidenceReference",
    "evidenceVersion",
  ]);
  if (
    !["RequiresCapability", "ConflictsWithCapability", "RequiresFutureTrigger"].includes(
      String(input.kind),
    ) ||
    !["Satisfied", "Unsatisfied", "NotApplicable"].includes(String(input.status))
  )
    return invalid();
  const evidenceReference =
    input.evidenceReference === null ? null : parseFeatureControlReference(input.evidenceReference);
  const evidenceVersion =
    input.evidenceVersion === null ? null : parseFeatureControlVersion(input.evidenceVersion);
  if (
    (evidenceReference === null) !== (evidenceVersion === null) ||
    (input.status === "Satisfied") !== (evidenceReference !== null)
  )
    return invalid();
  return Object.freeze({
    dependencyId: parseFeatureControlReference(input.dependencyId),
    kind: input.kind,
    targetKey: parseFeatureControlKey(input.targetKey),
    minimumCompatibleVersion: parseFeatureControlVersion(input.minimumCompatibleVersion),
    status: input.status,
    evidenceReference,
    evidenceVersion,
  }) as FeatureControlDependency;
}
export function createFeatureControlAdministrationDefinition(
  value: unknown,
): FeatureControlAdministrationDefinition {
  const input = plain(value, [
    "controlId",
    "key",
    "description",
    "version",
    "ownerReference",
    "purposeCode",
    "scope",
    "source",
    "defaultValue",
    "configuredValue",
    "lifecycle",
    "temporary",
    "effectiveFrom",
    "effectiveUntil",
    "reviewAt",
    "expiresAt",
    "dependencies",
    "authoredByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "publicationReference",
  ]);
  if (
    typeof input.description !== "string" ||
    !/^[^\p{Cc}\p{Cf}]{1,240}$/u.test(input.description) ||
    !["BrandOverride", "StoreOverride"].includes(String(input.source)) ||
    !["Enabled", "Disabled"].includes(String(input.defaultValue)) ||
    !["Enabled", "Disabled"].includes(String(input.configuredValue)) ||
    !featureControlAdministrationLifecycles.includes(
      input.lifecycle as FeatureControlAdministrationLifecycle,
    ) ||
    typeof input.temporary !== "boolean" ||
    !Array.isArray(input.dependencies)
  )
    return invalid();
  const scope = parseScope(input.scope);
  if ((scope.kind === "Store") !== (input.source === "StoreOverride")) return invalid();
  const effectiveFrom = parseFeatureControlInstant(input.effectiveFrom);
  const effectiveUntil = optionalInstant(input.effectiveUntil);
  const reviewAt = parseFeatureControlInstant(input.reviewAt);
  const expiresAt = optionalInstant(input.expiresAt);
  if (
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(reviewAt) < Date.parse(effectiveFrom) ||
    (expiresAt !== null &&
      (Date.parse(expiresAt) <= Date.parse(effectiveFrom) ||
        Date.parse(reviewAt) > Date.parse(expiresAt))) ||
    input.temporary !== (expiresAt !== null)
  )
    return invalid();
  const dependencies = Object.freeze(input.dependencies.map(parseDependency));
  if (
    new Set(dependencies.map((item) => item.dependencyId)).size !== dependencies.length ||
    dependencies.some((item) => item.targetKey === input.key)
  )
    return invalid();
  const authoredByReference = parseFeatureControlReference(input.authoredByReference);
  const approvedByReference =
    input.approvedByReference === null
      ? null
      : parseFeatureControlReference(input.approvedByReference);
  const approvalEvidenceReference =
    input.approvalEvidenceReference === null
      ? null
      : parseFeatureControlReference(input.approvalEvidenceReference);
  const publicationReference =
    input.publicationReference === null
      ? null
      : parseFeatureControlReference(input.publicationReference);
  const approved = ["Approved", "Published", "Superseded", "Disabled"].includes(
    String(input.lifecycle),
  );
  if (
    (approvedByReference === null) !== (approvalEvidenceReference === null) ||
    approved !== (approvedByReference !== null) ||
    (approvedByReference !== null && approvedByReference === authoredByReference) ||
    ["Published", "Superseded", "Disabled"].includes(String(input.lifecycle)) !==
      (publicationReference !== null)
  )
    return invalid();
  return Object.freeze({
    ...input,
    controlId: parseFeatureControlReference(input.controlId),
    key: parseFeatureControlKey(input.key),
    version: parseFeatureControlVersion(input.version),
    ownerReference: parseFeatureControlOwnerReference(input.ownerReference),
    purposeCode: parseFeatureControlPurposeCode(input.purposeCode),
    scope,
    effectiveFrom,
    effectiveUntil,
    reviewAt,
    expiresAt,
    dependencies,
    authoredByReference,
    approvedByReference,
    approvalEvidenceReference,
    publicationReference,
  }) as FeatureControlAdministrationDefinition;
}
export function assertFeatureControlDependenciesPublishable(
  definition: FeatureControlAdministrationDefinition,
): void {
  if (
    definition.dependencies.some(
      (item) =>
        item.status !== "Satisfied" ||
        item.evidenceVersion === null ||
        item.evidenceVersion < item.minimumCompatibleVersion,
    )
  )
    throw new FeatureControlAdministrationError("FEATURE_CONTROL_DEPENDENCY_BLOCKED");
}
export interface EffectiveFeatureControlResolution {
  readonly definition: FeatureControlAdministrationDefinition | null;
  readonly effectiveValue: FeatureControlEffectiveValue;
  readonly source: FeatureControlSource;
  readonly available: boolean;
}
export function resolveEffectiveFeatureControl(input: {
  readonly tenantContext: TenantContext;
  readonly key: FeatureControlKey;
  readonly definitions: readonly FeatureControlAdministrationDefinition[];
  readonly at: CanonicalInstant;
  readonly platformDefault: FeatureControlEffectiveValue;
}): EffectiveFeatureControlResolution {
  const context = revalidateTenantContext(input.tenantContext);
  const candidates = input.definitions.filter(
    (item) =>
      Object.isFrozen(item) &&
      item.key === input.key &&
      item.lifecycle === "Published" &&
      item.scope.brandReference === context.brand.brandReference &&
      (item.scope.kind === "Brand" ||
        item.scope.storeReference === context.store?.storeReference) &&
      Date.parse(item.effectiveFrom) <= Date.parse(input.at) &&
      (item.effectiveUntil === null || Date.parse(input.at) < Date.parse(item.effectiveUntil)) &&
      (item.expiresAt === null || Date.parse(input.at) < Date.parse(item.expiresAt)),
  );
  const store = candidates.filter((item) => item.scope.kind === "Store");
  const brand = candidates.filter((item) => item.scope.kind === "Brand");
  const chosen =
    store.length === 1 ? store[0] : store.length === 0 && brand.length === 1 ? brand[0] : undefined;
  if (chosen === undefined)
    return Object.freeze({
      definition: null,
      effectiveValue: input.platformDefault,
      source: "PlatformDefault",
      available: candidates.length === 0,
    });
  return Object.freeze({
    definition: chosen,
    effectiveValue: chosen.configuredValue,
    source: chosen.source,
    available: true,
  });
}
