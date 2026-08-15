export type FeatureAdminErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class FeatureAdminError extends Error {
  constructor(readonly code: FeatureAdminErrorCode) {
    super("Feature control administration is unavailable");
    this.name = "FeatureAdminError";
  }
}
export interface FeatureAdminItem {
  readonly controlId: string;
  readonly key: string;
  readonly description: string;
  readonly scope: "Brand" | "Store";
  readonly source: "PlatformDefault" | "BrandOverride" | "StoreOverride";
  readonly effectiveValue: "Enabled" | "Disabled";
  readonly lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published" | "Disabled";
  readonly temporary: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly expiresAt: string | null;
  readonly owner: string;
  readonly dependencies: readonly {
    readonly key: string;
    readonly kind: "RequiresCapability" | "ConflictsWithCapability" | "RequiresFutureTrigger";
    readonly status: "Satisfied" | "Unsatisfied" | "NotApplicable";
  }[];
}
export interface FeatureAdminView {
  readonly screenId: "STORE-CAPABILITY" | "FEATURE-FLAG-LIST";
  readonly storeReference: string | null;
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly items: readonly FeatureAdminItem[];
  readonly mayManage: boolean;
}
export interface FeatureAdminClient {
  loadStoreCapabilities(storeReference: string): Promise<unknown>;
  loadFeatures(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const key = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,7}$/u;
const safe = /^[^\p{Cc}\p{Cf}]{1,240}$/u;
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    throw new Error("FEATURE_ADMIN_INVALID");
  return value as Record<string, unknown>;
}
const timestamp = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("FEATURE_ADMIN_INVALID");
  return value;
};
export function parseFeatureAdminRouteReference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("FEATURE_ADMIN_INVALID");
  return value;
}
function item(value: unknown): FeatureAdminItem {
  const input = closed(value, [
    "controlId",
    "key",
    "description",
    "scope",
    "source",
    "effectiveValue",
    "lifecycle",
    "temporary",
    "effectiveFrom",
    "effectiveUntil",
    "expiresAt",
    "owner",
    "dependencies",
  ]);
  if (
    typeof input.key !== "string" ||
    !key.test(input.key) ||
    typeof input.description !== "string" ||
    !safe.test(input.description) ||
    typeof input.owner !== "string" ||
    !safe.test(input.owner) ||
    !["Brand", "Store"].includes(String(input.scope)) ||
    !["PlatformDefault", "BrandOverride", "StoreOverride"].includes(String(input.source)) ||
    !["Enabled", "Disabled"].includes(String(input.effectiveValue)) ||
    !["Draft", "PendingApproval", "Approved", "Published", "Disabled"].includes(
      String(input.lifecycle),
    ) ||
    typeof input.temporary !== "boolean" ||
    !Array.isArray(input.dependencies)
  )
    throw new Error("FEATURE_ADMIN_INVALID");
  const dependencies = Object.freeze(
    input.dependencies.map((dependency) => {
      const row = closed(dependency, ["key", "kind", "status"]);
      if (
        typeof row.key !== "string" ||
        !key.test(row.key) ||
        !["RequiresCapability", "ConflictsWithCapability", "RequiresFutureTrigger"].includes(
          String(row.kind),
        ) ||
        !["Satisfied", "Unsatisfied", "NotApplicable"].includes(String(row.status))
      )
        throw new Error("FEATURE_ADMIN_INVALID");
      return Object.freeze(row) as FeatureAdminItem["dependencies"][number];
    }),
  );
  return Object.freeze({
    ...input,
    controlId: parseFeatureAdminRouteReference(input.controlId),
    effectiveFrom: timestamp(input.effectiveFrom),
    effectiveUntil: input.effectiveUntil === null ? null : timestamp(input.effectiveUntil),
    expiresAt: input.expiresAt === null ? null : timestamp(input.expiresAt),
    dependencies,
  }) as FeatureAdminItem;
}
export function parseFeatureAdminView(
  value: unknown,
  screenId: FeatureAdminView["screenId"],
): FeatureAdminView {
  const input = closed(value, [
    "screenId",
    "storeReference",
    "sourceAsOf",
    "freshness",
    "completeness",
    "items",
    "mayManage",
  ]);
  if (
    input.screenId !== screenId ||
    (screenId === "STORE-CAPABILITY") !== (input.storeReference !== null) ||
    !["Fresh", "Stale"].includes(String(input.freshness)) ||
    !["Complete", "Partial"].includes(String(input.completeness)) ||
    !Array.isArray(input.items) ||
    typeof input.mayManage !== "boolean"
  )
    throw new Error("FEATURE_ADMIN_INVALID");
  const items = Object.freeze(input.items.map(item));
  if (new Set(items.map((row) => row.controlId)).size !== items.length)
    throw new Error("FEATURE_ADMIN_INVALID");
  return Object.freeze({
    ...input,
    storeReference:
      input.storeReference === null ? null : parseFeatureAdminRouteReference(input.storeReference),
    sourceAsOf: timestamp(input.sourceAsOf),
    items,
  }) as FeatureAdminView;
}
export const unavailableFeatureAdminClient: FeatureAdminClient = {
  loadStoreCapabilities: async () => {
    throw new FeatureAdminError("Unavailable");
  },
  loadFeatures: async () => {
    throw new FeatureAdminError("Unavailable");
  },
};
