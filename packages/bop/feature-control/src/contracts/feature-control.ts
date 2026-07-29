import { revalidateTenantContext } from "@bop/permission";
import type {
  BrandReference,
  CanonicalInstant,
  StoreReference,
  TenantContext,
  TenantScopeKind,
} from "@bop/tenant";
import { evaluateDomainFeatureControl } from "../domain/evaluate-feature-control.js";

export const featureControlErrorCodes = [
  "FEATURE_CONTROL_INPUT_INVALID",
  "FEATURE_CONTROL_CONTEXT_INVALID",
] as const;
export type FeatureControlErrorCode = (typeof featureControlErrorCodes)[number];

const safeMessages: Readonly<Record<FeatureControlErrorCode, string>> = {
  FEATURE_CONTROL_INPUT_INVALID: "feature control input is invalid",
  FEATURE_CONTROL_CONTEXT_INVALID: "feature control context is invalid",
};

export class FeatureControlContractError extends Error {
  readonly code: FeatureControlErrorCode;

  constructor(code: FeatureControlErrorCode) {
    super(safeMessages[code]);
    this.name = "FeatureControlContractError";
    this.code = code;
  }
}

export type FeatureControlReference = string & {
  readonly __featureControlReference: unique symbol;
};
export type FeatureControlKey = string & { readonly __featureControlKey: unique symbol };
export type FeatureControlVersion = number & { readonly __featureControlVersion: unique symbol };
export type RolloutBasisPoints = number & { readonly __rolloutBasisPoints: unique symbol };
export type RolloutBucket = number & { readonly __rolloutBucket: unique symbol };
export type FeatureControlOwnerReference = string & {
  readonly __featureControlOwnerReference: unique symbol;
};
export type FeatureControlPurposeCode = string & {
  readonly __featureControlPurposeCode: unique symbol;
};

export interface FeatureControlScope {
  readonly kind: TenantScopeKind;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
}

interface FeatureControlDefinitionBase {
  readonly controlId: FeatureControlReference;
  readonly key: FeatureControlKey;
  readonly version: FeatureControlVersion;
  readonly ownerReference: FeatureControlOwnerReference;
  readonly purposeCode: FeatureControlPurposeCode;
  readonly scope: FeatureControlScope;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly reviewAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant | null;
}

export const releaseFlagStates = ["Default", "Enabled", "Disabled"] as const;
export type ReleaseFlagState = (typeof releaseFlagStates)[number];

export interface ReleaseFlagDefinition extends FeatureControlDefinitionBase {
  readonly kind: "ReleaseFlag";
  readonly defaultEnabled: boolean;
  readonly state: ReleaseFlagState;
  readonly rolloutBasisPoints: RolloutBasisPoints;
}

export const killSwitchModes = ["BlockNew", "SafePause", "Terminate"] as const;
export type KillSwitchMode = (typeof killSwitchModes)[number];
export const inFlightPolicies = [
  "AllowToComplete",
  "ReachSafeCheckpoint",
  "CompensateAndStop",
] as const;
export type InFlightPolicy = (typeof inFlightPolicies)[number];
export const recoveryPolicies = ["Manual", "AutomaticAfterValidation", "Progressive"] as const;
export type RecoveryPolicy = (typeof recoveryPolicies)[number];

export type KillSwitchState =
  | { readonly phase: "Default" | "Inactive" | "Active" }
  | { readonly phase: "Recovering"; readonly rolloutBasisPoints: RolloutBasisPoints };

export interface KillSwitchDefinition extends FeatureControlDefinitionBase {
  readonly kind: "KillSwitch";
  readonly defaultActive: boolean;
  readonly mode: KillSwitchMode;
  readonly inFlightPolicy: InFlightPolicy;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly recoveryStages: readonly RolloutBasisPoints[];
  readonly state: KillSwitchState;
}

export type FeatureControlDefinition = ReleaseFlagDefinition | KillSwitchDefinition;

export const featureControlEvaluationReasons = [
  "RELEASE_ENABLED",
  "RELEASE_DISABLED",
  "KILL_INACTIVE",
  "KILL_ACTIVE",
  "KILL_RECOVERY_ALLOWED",
  "KILL_RECOVERY_BLOCKED",
  "CONTROL_UNAVAILABLE",
] as const;
export type FeatureControlEvaluationReason = (typeof featureControlEvaluationReasons)[number];

export interface FeatureControlEvaluationRecord {
  readonly key: FeatureControlKey;
  readonly kind: FeatureControlDefinition["kind"] | null;
  readonly version: FeatureControlVersion | null;
  readonly scopeKind: TenantScopeKind | null;
  readonly backendExecution: "Allow" | "Deny";
  readonly frontendVisibility: "Show" | "Hide";
  readonly reason: FeatureControlEvaluationReason;
  readonly killMode: KillSwitchMode | null;
  readonly evaluatedAt: CanonicalInstant;
}

export interface FeatureControlEvaluation {
  readonly effectiveControl: {
    readonly controlId: FeatureControlReference;
    readonly version: FeatureControlVersion;
    readonly scope: FeatureControlScope;
  } | null;
  readonly backendExecution: "Allow" | "Deny";
  readonly frontendVisibility: "Show" | "Hide";
  readonly reason: FeatureControlEvaluationReason;
  readonly killMode: KillSwitchMode | null;
  readonly inFlightPolicy: InFlightPolicy | null;
  readonly record: FeatureControlEvaluationRecord;
}

export interface EvaluateFeatureControlInput {
  readonly tenantContext: TenantContext;
  readonly key: FeatureControlKey;
  readonly definitions: readonly FeatureControlDefinition[];
  readonly rolloutBucket: RolloutBucket;
  readonly evaluatedAt: CanonicalInstant;
}

export const recoveryValidationResults = ["Pass"] as const;
export interface RecoveryValidationEvidence {
  readonly controlId: FeatureControlReference;
  readonly controlVersion: FeatureControlVersion;
  readonly scope: FeatureControlScope;
  readonly result: "Pass";
  readonly checkedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
  readonly checkCodes: readonly FeatureControlPurposeCode[];
  readonly targetBasisPoints: RolloutBasisPoints;
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keyPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,7}$/u;
const purposePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

function invalid(): never {
  throw new FeatureControlContractError("FEATURE_CONTROL_INPUT_INVALID");
}

function plain(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value;
}

export function parseFeatureControlReference(value: unknown): FeatureControlReference {
  return uuid(value) as FeatureControlReference;
}

export function parseFeatureControlOwnerReference(value: unknown): FeatureControlOwnerReference {
  return uuid(value) as FeatureControlOwnerReference;
}

export function parseFeatureControlKey(value: unknown): FeatureControlKey {
  if (typeof value !== "string" || value.length > 128 || !keyPattern.test(value)) return invalid();
  return value as FeatureControlKey;
}

export function parseFeatureControlPurposeCode(value: unknown): FeatureControlPurposeCode {
  if (typeof value !== "string" || !purposePattern.test(value)) return invalid();
  return value as FeatureControlPurposeCode;
}

export function parseFeatureControlVersion(value: unknown): FeatureControlVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as FeatureControlVersion;
}

export function parseRolloutBasisPoints(value: unknown): RolloutBasisPoints {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000)
    return invalid();
  return value as RolloutBasisPoints;
}

export function parseRolloutBucket(value: unknown): RolloutBucket {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 9_999)
    return invalid();
  return value as RolloutBucket;
}

export function parseFeatureControlInstant(value: unknown): CanonicalInstant {
  if (typeof value !== "string" || !value.endsWith("Z")) return invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return invalid();
  return value as CanonicalInstant;
}

function scope(value: unknown): FeatureControlScope {
  const input = plain(value, ["kind", "brandReference", "storeReference"]);
  if (input.kind !== "Brand" && input.kind !== "Store") return invalid();
  const brandReference = uuid(input.brandReference) as BrandReference;
  const storeReference =
    input.storeReference === null ? null : (uuid(input.storeReference) as StoreReference);
  if ((input.kind === "Brand") !== (storeReference === null)) return invalid();
  return Object.freeze({
    kind: input.kind,
    brandReference,
    storeReference,
  });
}

function state(value: unknown): KillSwitchState {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { phase?: unknown }).phase === "Recovering"
  ) {
    const input = plain(value, ["phase", "rolloutBasisPoints"]);
    return Object.freeze({
      phase: "Recovering",
      rolloutBasisPoints: parseRolloutBasisPoints(input.rolloutBasisPoints),
    });
  }
  const input = plain(value, ["phase"]);
  if (input.phase !== "Default" && input.phase !== "Inactive" && input.phase !== "Active")
    return invalid();
  return Object.freeze({ phase: input.phase });
}

function common(input: Record<string, unknown>) {
  const effectiveFrom = parseFeatureControlInstant(input.effectiveFrom);
  const effectiveUntil =
    input.effectiveUntil === null ? null : parseFeatureControlInstant(input.effectiveUntil);
  const reviewAt = parseFeatureControlInstant(input.reviewAt);
  const expiresAt = input.expiresAt === null ? null : parseFeatureControlInstant(input.expiresAt);
  if (
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    Date.parse(reviewAt) < Date.parse(effectiveFrom) ||
    (expiresAt !== null &&
      (Date.parse(expiresAt) <= Date.parse(effectiveFrom) ||
        Date.parse(reviewAt) > Date.parse(expiresAt)))
  )
    return invalid();
  return {
    controlId: parseFeatureControlReference(input.controlId),
    key: parseFeatureControlKey(input.key),
    version: parseFeatureControlVersion(input.version),
    ownerReference: parseFeatureControlOwnerReference(input.ownerReference),
    purposeCode: parseFeatureControlPurposeCode(input.purposeCode),
    scope: scope(input.scope),
    effectiveFrom,
    effectiveUntil,
    reviewAt,
    expiresAt,
  } as const;
}

function recoveryStages(value: unknown, policy: RecoveryPolicy): readonly RolloutBasisPoints[] {
  if (!Array.isArray(value)) return invalid();
  const stages = value.map(parseRolloutBasisPoints);
  if (
    (policy === "Progressive" &&
      (stages.length === 0 ||
        stages.at(0) === 0 ||
        stages.at(-1) !== 10_000 ||
        stages.some((item, index) => {
          const previous = stages.at(index - 1);
          return index > 0 && previous !== undefined && item <= previous;
        }))) ||
    (policy !== "Progressive" && stages.length !== 0)
  )
    return invalid();
  return Object.freeze(stages);
}

export function createFeatureControlDefinition(input: unknown): FeatureControlDefinition {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return invalid();
  const kind = (input as { kind?: unknown }).kind;
  if (kind === "ReleaseFlag") {
    const value = plain(input, [
      "controlId",
      "key",
      "version",
      "ownerReference",
      "purposeCode",
      "scope",
      "effectiveFrom",
      "effectiveUntil",
      "reviewAt",
      "expiresAt",
      "kind",
      "defaultEnabled",
      "state",
      "rolloutBasisPoints",
    ]);
    if (
      typeof value.defaultEnabled !== "boolean" ||
      !releaseFlagStates.includes(value.state as ReleaseFlagState)
    )
      return invalid();
    return Object.freeze({
      ...common(value),
      kind,
      defaultEnabled: value.defaultEnabled,
      state: value.state as ReleaseFlagState,
      rolloutBasisPoints: parseRolloutBasisPoints(value.rolloutBasisPoints),
    });
  }
  if (kind === "KillSwitch") {
    const value = plain(input, [
      "controlId",
      "key",
      "version",
      "ownerReference",
      "purposeCode",
      "scope",
      "effectiveFrom",
      "effectiveUntil",
      "reviewAt",
      "expiresAt",
      "kind",
      "defaultActive",
      "mode",
      "inFlightPolicy",
      "recoveryPolicy",
      "recoveryStages",
      "state",
    ]);
    if (
      typeof value.defaultActive !== "boolean" ||
      !killSwitchModes.includes(value.mode as KillSwitchMode) ||
      !inFlightPolicies.includes(value.inFlightPolicy as InFlightPolicy) ||
      !recoveryPolicies.includes(value.recoveryPolicy as RecoveryPolicy)
    )
      return invalid();
    const recoveryPolicy = value.recoveryPolicy as RecoveryPolicy;
    const parsedRecoveryStages = recoveryStages(value.recoveryStages, recoveryPolicy);
    const parsedState = state(value.state);
    if (
      parsedState.phase === "Recovering" &&
      ((recoveryPolicy === "Progressive" &&
        !parsedRecoveryStages.includes(parsedState.rolloutBasisPoints)) ||
        (recoveryPolicy !== "Progressive" && parsedState.rolloutBasisPoints !== 10_000))
    )
      return invalid();
    return Object.freeze({
      ...common(value),
      kind,
      defaultActive: value.defaultActive,
      mode: value.mode as KillSwitchMode,
      inFlightPolicy: value.inFlightPolicy as InFlightPolicy,
      recoveryPolicy,
      recoveryStages: parsedRecoveryStages,
      state: parsedState,
    });
  }
  return invalid();
}

export function createRecoveryValidationEvidence(input: unknown): RecoveryValidationEvidence {
  const value = plain(input, [
    "controlId",
    "controlVersion",
    "scope",
    "result",
    "checkedAt",
    "validUntil",
    "checkCodes",
    "targetBasisPoints",
  ]);
  if (value.result !== "Pass" || !Array.isArray(value.checkCodes) || value.checkCodes.length === 0)
    return invalid();
  const checkedAt = parseFeatureControlInstant(value.checkedAt);
  const validUntil = parseFeatureControlInstant(value.validUntil);
  if (Date.parse(validUntil) <= Date.parse(checkedAt)) return invalid();
  const checkCodes = value.checkCodes.map(parseFeatureControlPurposeCode);
  if (new Set(checkCodes).size !== checkCodes.length) return invalid();
  return Object.freeze({
    controlId: parseFeatureControlReference(value.controlId),
    controlVersion: parseFeatureControlVersion(value.controlVersion),
    scope: scope(value.scope),
    result: "Pass",
    checkedAt,
    validUntil,
    checkCodes: Object.freeze(checkCodes),
    targetBasisPoints: parseRolloutBasisPoints(value.targetBasisPoints),
  });
}

function unavailableEvaluation(
  key: FeatureControlKey,
  evaluatedAt: CanonicalInstant,
): FeatureControlEvaluation {
  const record = Object.freeze({
    key,
    kind: null,
    version: null,
    scopeKind: null,
    backendExecution: "Deny" as const,
    frontendVisibility: "Hide" as const,
    reason: "CONTROL_UNAVAILABLE" as const,
    killMode: null,
    evaluatedAt,
  });
  return Object.freeze({
    effectiveControl: null,
    backendExecution: "Deny",
    frontendVisibility: "Hide",
    reason: "CONTROL_UNAVAILABLE",
    killMode: null,
    inFlightPolicy: null,
    record,
  });
}

function evaluationResult(
  definition: FeatureControlDefinition,
  evaluatedAt: CanonicalInstant,
  backendExecution: "Allow" | "Deny",
  reason: FeatureControlEvaluationReason,
): FeatureControlEvaluation {
  const frontendVisibility = backendExecution === "Allow" ? "Show" : "Hide";
  const killMode = definition.kind === "KillSwitch" ? definition.mode : null;
  const inFlightPolicy = definition.kind === "KillSwitch" ? definition.inFlightPolicy : null;
  const record = Object.freeze({
    key: definition.key,
    kind: definition.kind,
    version: definition.version,
    scopeKind: definition.scope.kind,
    backendExecution,
    frontendVisibility,
    reason,
    killMode,
    evaluatedAt,
  });
  return Object.freeze({
    effectiveControl: Object.freeze({
      controlId: definition.controlId,
      version: definition.version,
      scope: definition.scope,
    }),
    backendExecution,
    frontendVisibility,
    reason,
    killMode,
    inFlightPolicy,
    record,
  });
}

export function evaluateFeatureControl(
  input: EvaluateFeatureControlInput,
): FeatureControlEvaluation {
  let context: ReturnType<typeof revalidateTenantContext>;
  try {
    context = revalidateTenantContext(input.tenantContext);
  } catch {
    throw new FeatureControlContractError("FEATURE_CONTROL_CONTEXT_INVALID");
  }
  const key = parseFeatureControlKey(input.key);
  const rolloutBucket = parseRolloutBucket(input.rolloutBucket);
  const evaluatedAt = parseFeatureControlInstant(input.evaluatedAt);
  if (!Array.isArray(input.definitions)) return unavailableEvaluation(key, evaluatedAt);

  let definitions: FeatureControlDefinition[];
  try {
    definitions = input.definitions.map((candidate) => {
      if (!Object.isFrozen(candidate))
        throw new FeatureControlContractError("FEATURE_CONTROL_INPUT_INVALID");
      return createFeatureControlDefinition(candidate);
    });
  } catch {
    return unavailableEvaluation(key, evaluatedAt);
  }

  const domainResult = evaluateDomainFeatureControl({
    brandReference: context.brand.brandReference,
    storeReference: context.store?.storeReference ?? null,
    key,
    definitions,
    rolloutBucket,
    evaluatedAt,
  });
  if (domainResult.definition === null) return unavailableEvaluation(key, evaluatedAt);
  const definition = definitions.find(
    (candidate) =>
      candidate.controlId === domainResult.definition?.controlId &&
      candidate.version === domainResult.definition.version &&
      candidate.kind === domainResult.definition.kind &&
      candidate.scope.kind === domainResult.definition.scope.kind &&
      candidate.scope.brandReference === domainResult.definition.scope.brandReference &&
      candidate.scope.storeReference === domainResult.definition.scope.storeReference,
  );
  if (definition === undefined) return unavailableEvaluation(key, evaluatedAt);
  return evaluationResult(
    definition,
    evaluatedAt,
    domainResult.backendExecution,
    domainResult.reason,
  );
}
