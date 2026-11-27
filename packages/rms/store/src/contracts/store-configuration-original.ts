import {
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  type StoreConfigurationVersion,
} from "./store-configuration-administration.js";

export type StoreConfigurationOrdinaryAction =
  "Materialize" | "Validate" | "Submit" | "Approve" | "Publish";
export class StoreConfigurationOriginalError extends Error {
  constructor(
    readonly code:
      | "STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"
      | "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED"
      | "STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT"
      | "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT"
      | "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Store configuration original operation is unavailable");
    this.name = "StoreConfigurationOriginalError";
  }
}
const invalid = (): never => {
  throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
};
function copy(value: unknown): unknown {
  let budget = 100000,
    textBudget = 2101248;
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 16) return invalid();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      textBudget -= new TextEncoder().encode(v).byteLength;
      return v.length <= 4096 && textBudget >= 0 ? v : invalid();
    }
    if (typeof v === "number") return Number.isFinite(v) ? v : invalid();
    if (!v || typeof v !== "object") return invalid();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return invalid();
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return invalid();
        return visit(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 64)
      return invalid();
    return Object.fromEntries(
      Reflect.ownKeys(v).map((key) => {
        if (typeof key !== "string") return invalid();
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d?.enumerable || !("value" in d)) return invalid();
        return [key, visit(d.value, depth + 1)];
      }),
    );
  };
  return visit(value, 0);
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const reference = (v: unknown) => parseStoreAdministrationReference(v);
const digest = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : invalid();
const version = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
const actions = ["Materialize", "Validate", "Submit", "Approve", "Publish"] as const;
const action = (v: unknown): StoreConfigurationOrdinaryAction =>
  typeof v === "string" && actions.includes(v as StoreConfigurationOrdinaryAction)
    ? (v as StoreConfigurationOrdinaryAction)
    : invalid();
export interface StoreConfigurationOriginalScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
function scope(r: Record<string, unknown>): StoreConfigurationOriginalScope {
  return {
    tenantReference: parsePlatformTenantReference(r.tenantReference),
    brandReference: parseBrandReference(r.brandReference),
    storeReference: parseStoreReference(r.storeReference),
    actorReference: reference(r.actorReference),
  };
}
export interface StoreConfigurationOrdinaryHead {
  readonly configurationReference: string | null;
  readonly configurationVersion: number;
  readonly contentDigest: string | null;
}
function head(value: unknown): StoreConfigurationOrdinaryHead {
  const r = closed(value, ["configurationReference", "configurationVersion", "contentDigest"]);
  const configurationVersion = version(r.configurationVersion),
    configurationReference =
      r.configurationReference === null ? null : reference(r.configurationReference),
    contentDigest = r.contentDigest === null ? null : digest(r.contentDigest);
  if (
    (configurationVersion === 0) !== (configurationReference === null) ||
    (configurationVersion === 0) !== (contentDigest === null)
  )
    return invalid();
  return Object.freeze({ configurationReference, configurationVersion, contentDigest });
}
export interface StoreConfigurationSetupSelector {
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
}
function selector(value: unknown): StoreConfigurationSetupSelector {
  const r = closed(value, ["setupDraftReference", "sourceRevision", "sourceSnapshotDigest"]);
  const sourceRevision = version(r.sourceRevision);
  if (sourceRevision < 1 || sourceRevision > 2147483647) return invalid();
  return Object.freeze({
    setupDraftReference: reference(r.setupDraftReference),
    sourceRevision,
    sourceSnapshotDigest: digest(r.sourceSnapshotDigest),
  });
}
interface Identity extends StoreConfigurationOriginalScope {
  readonly operationReference: string;
  readonly expectedHead: StoreConfigurationOrdinaryHead;
}
type OrdinaryBody = Readonly<
  Identity &
    (
      | {
          action: "Materialize";
          setupSelector: StoreConfigurationSetupSelector;
          reasonCode: string;
        }
      | { action: Exclude<StoreConfigurationOrdinaryAction, "Materialize"> }
    )
>;
export type StoreConfigurationOrdinaryCommand = Readonly<
  OrdinaryBody & { profile: "StoreConfigurationOrdinaryCommandV1" }
>;
export type StoreConfigurationOrdinaryResolve = Readonly<
  OrdinaryBody & { profile: "StoreConfigurationOrdinaryResolveV1"; intentDigest: string }
>;
function identity(r: Record<string, unknown>) {
  const selectedAction = action(r.action),
    expectedHead = head(r.expectedHead);
  if (selectedAction !== "Materialize" && expectedHead.configurationReference === null)
    return invalid();
  return {
    ...scope(r),
    operationReference: reference(r.operationReference),
    action: selectedAction,
    expectedHead,
  };
}
function commandBody(r: Record<string, unknown>): OrdinaryBody {
  const selected = identity(r);
  if (selected.action === "Materialize") {
    if (
      typeof r.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_.:-]{0,63}$/u.test(r.reasonCode) ||
      selected.expectedHead.configurationVersion === Number.MAX_SAFE_INTEGER
    )
      return invalid();
    return {
      ...selected,
      action: "Materialize",
      setupSelector: selector(r.setupSelector),
      reasonCode: r.reasonCode,
    };
  }
  return { ...selected, action: selected.action };
}
const keys = ["profile", ...scopeKeys, "operationReference", "action", "expectedHead"];
function commandParser(value: unknown): StoreConfigurationOrdinaryCommand {
  const copied = copy(value);
  const r = closed(
    copied,
    copied &&
      typeof copied === "object" &&
      Object.getOwnPropertyDescriptor(copied, "action")?.value === "Materialize"
      ? [...keys, "setupSelector", "reasonCode"]
      : keys,
  );
  if (r.profile !== "StoreConfigurationOrdinaryCommandV1") return invalid();
  return Object.freeze({ profile: r.profile, ...commandBody(r) });
}
function resolveParser(value: unknown): StoreConfigurationOrdinaryResolve {
  const copied = copy(value);
  const r = closed(
    copied,
    copied &&
      typeof copied === "object" &&
      Object.getOwnPropertyDescriptor(copied, "action")?.value === "Materialize"
      ? [...keys, "setupSelector", "reasonCode", "intentDigest"]
      : [...keys, "intentDigest"],
  );
  if (r.profile !== "StoreConfigurationOrdinaryResolveV1") return invalid();
  return Object.freeze({
    profile: r.profile,
    ...commandBody(r),
    intentDigest: digest(r.intentDigest),
  });
}
export interface StoreConfigurationOriginalOperation {
  readonly command: "SaveDraft" | "Validate" | "Submit" | "Approve" | "Publish";
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly intentDigest: string;
  readonly resultingVersion: number;
  readonly configuration: StoreConfigurationVersion;
}
export type StoreConfigurationOrdinaryReceipt = Readonly<
  OrdinaryBody & {
    profile: "StoreConfigurationOrdinaryReceiptV1";
    intentDigest: string;
    outcome: "Committed" | "Abandoned";
    operation: StoreConfigurationOriginalOperation | null;
    auditReference: string;
    occurredAt: string;
    dataClassification: "ConfigurationMetadata";
  }
>;
function receiptParser(value: unknown): StoreConfigurationOrdinaryReceipt {
  const copied = copy(value);
  const r = closed(copied, [
    ...keys,
    ...(copied &&
    typeof copied === "object" &&
    Object.getOwnPropertyDescriptor(copied, "action")?.value === "Materialize"
      ? ["setupSelector", "reasonCode"]
      : []),
    "intentDigest",
    "outcome",
    "operation",
    "auditReference",
    "occurredAt",
    "dataClassification",
  ]);
  if (
    r.profile !== "StoreConfigurationOrdinaryReceiptV1" ||
    r.dataClassification !== "ConfigurationMetadata" ||
    !["Committed", "Abandoned"].includes(String(r.outcome))
  )
    return invalid();
  const body = commandBody(r);
  let operation: StoreConfigurationOriginalOperation | null = null;
  if (r.outcome === "Committed") {
    const o = closed(r.operation, [
        "command",
        "operationReference",
        "brandReference",
        "storeReference",
        "intentDigest",
        "resultingVersion",
        "configuration",
      ]),
      configuration = createStoreConfigurationVersion(o.configuration);
    const mapped = body.action === "Materialize" ? "SaveDraft" : body.action;
    if (
      o.command !== mapped ||
      o.operationReference !== body.operationReference ||
      o.brandReference !== body.brandReference ||
      o.storeReference !== body.storeReference ||
      configuration.brandReference !== body.brandReference ||
      configuration.storeReference !== body.storeReference ||
      o.resultingVersion !== configuration.configurationVersion ||
      configuration.configurationVersion !==
        body.expectedHead.configurationVersion + (body.action === "Materialize" ? 1 : 0)
    )
      return invalid();
    if (body.action === "Materialize") {
      const basis = configuration.setupBasis;
      if (
        !basis ||
        basis.tenantReference !== body.tenantReference ||
        basis.setupDraftReference !== body.setupSelector.setupDraftReference ||
        basis.sourceRevision !== body.setupSelector.sourceRevision ||
        basis.sourceSnapshotDigest !== body.setupSelector.sourceSnapshotDigest ||
        configuration.supersedesConfigurationReference !==
          body.expectedHead.configurationReference ||
        configuration.reasonCode !== body.reasonCode ||
        configuration.authoredByReference !== body.actorReference
      )
        return invalid();
    } else if (configuration.configurationReference !== body.expectedHead.configurationReference)
      return invalid();
    const expectedState = {
      Materialize: "Draft",
      Validate: "Draft",
      Submit: "PendingApproval",
      Approve: "Approved",
      Publish: "Published",
    }[body.action];
    if (
      configuration.lifecycle !== expectedState ||
      configuration.updatedAt > parseCanonicalInstant(r.occurredAt) ||
      (body.action === "Approve" && configuration.approvedByReference !== body.actorReference)
    )
      return invalid();
    operation = Object.freeze({
      command: mapped,
      operationReference: reference(o.operationReference),
      brandReference: parseBrandReference(o.brandReference),
      storeReference: parseStoreReference(o.storeReference),
      intentDigest: digest(o.intentDigest),
      resultingVersion: configuration.configurationVersion,
      configuration,
    });
  } else if (r.operation !== null) return invalid();
  return Object.freeze({
    profile: "StoreConfigurationOrdinaryReceiptV1",
    ...body,
    intentDigest: digest(r.intentDigest),
    outcome: r.outcome as "Committed" | "Abandoned",
    operation,
    auditReference: reference(r.auditReference),
    occurredAt: parseCanonicalInstant(r.occurredAt),
    dataClassification: "ConfigurationMetadata",
  });
}

export function parseStoreConfigurationOrdinaryCommand(
  value: unknown,
): StoreConfigurationOrdinaryCommand {
  try {
    return commandParser(value);
  } catch {
    return invalid();
  }
}
export function parseStoreConfigurationOrdinaryResolve(
  value: unknown,
): StoreConfigurationOrdinaryResolve {
  try {
    return resolveParser(value);
  } catch {
    return invalid();
  }
}
export function parseStoreConfigurationOrdinaryReceipt(
  value: unknown,
): StoreConfigurationOrdinaryReceipt {
  try {
    return receiptParser(value);
  } catch {
    return invalid();
  }
}
