import { parseCanonicalInstant } from "@bop/tenant";
/**
 * Which rule refused, for the log only: a fixed word that never carries a reference or a fact and
 * never reaches a browser. The code and message stay the same for every rule, so no caller and no
 * customer answer can depend on it.
 */
export type WorkflowDefinitionRule =
  | "Malformed"
  | "ScopeMismatch"
  | "DuplicateVersion"
  | "TooManyVersions"
  | "NoBrandVersion"
  | "TwoBrandVersions"
  | "TwoStoreVersions"
  | "BrandVersionNotActive"
  | "StoreVersionNotActive"
  | "StoreVersionBaseMismatch"
  | "ResourceRefused"
  | "ExpectedVersionChanged"
  | "NoTransition"
  | "PublicationRefused"
  | "ActionRefused"
  | "RuleRefused"
  | "OperationReused"
  | "VersionSequence"
  | "FamilyAlreadyExists"
  | "Dependency";
export class WorkflowDefinitionError extends Error {
  readonly code = "WORKFLOW_DEFINITION_UNAVAILABLE";
  readonly rule: WorkflowDefinitionRule | undefined;
  constructor(rule?: WorkflowDefinitionRule, options?: { readonly cause?: unknown }) {
    super("Workflow definition is unavailable", options);
    this.name = "WorkflowDefinitionError";
    this.rule = rule;
  }
}
export function workflowUnavailable(rule?: WorkflowDefinitionRule, cause?: unknown): never {
  throw new WorkflowDefinitionError(rule, cause === undefined ? undefined : { cause });
}
/**
 * A catch-all keeps a refusal as it is and names anything else as a failed dependency, with what
 * failed as its cause. Read by code: tooling loads this package's source and the API its build, so
 * one refusal can cross two copies of this class.
 */
export function rethrowWorkflowFailure(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === "WORKFLOW_DEFINITION_UNAVAILABLE") throw error;
  return workflowUnavailable("Dependency", error);
}
export function workflowReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return workflowUnavailable("Malformed");
  return value;
}
function code(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value))
    return workflowUnavailable();
  return value;
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return workflowUnavailable();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return workflowUnavailable();
    result[field] = d.value;
  }
  return result;
}
function list(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return workflowUnavailable();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return workflowUnavailable();
    return d.value;
  });
}
const referenceOrNull = (v: unknown) => (v === null ? null : workflowReference(v));
export function parseWorkflowDefinitionVersion(value: unknown) {
  try {
    const raw = closed(value, [
      "schemaVersion",
      "workflowReference",
      "versionReference",
      "versionNumber",
      "tenantReference",
      "brandReference",
      "storeReference",
      "purposeCode",
      "applicabilityCode",
      "lifecycle",
      "baseVersionReference",
      "overrideAuthorizationReference",
      "effectiveFrom",
      "effectiveUntil",
      "publicationReference",
      "approvalEvidenceReference",
      "authoredByReference",
      "createdAt",
      "transitions",
    ]);
    if (
      raw.schemaVersion !== 1 ||
      !Number.isSafeInteger(raw.versionNumber) ||
      Number(raw.versionNumber) < 1 ||
      !["Draft", "Published", "Withdrawn"].includes(String(raw.lifecycle))
    )
      return workflowUnavailable();
    const storeReference = referenceOrNull(raw.storeReference);
    const baseVersionReference = referenceOrNull(raw.baseVersionReference);
    const overrideAuthorizationReference = referenceOrNull(raw.overrideAuthorizationReference);
    const publicationReference = referenceOrNull(raw.publicationReference);
    const approvalEvidenceReference = referenceOrNull(raw.approvalEvidenceReference);
    const effectiveFrom = parseCanonicalInstant(raw.effectiveFrom);
    const effectiveUntil =
      raw.effectiveUntil === null ? null : parseCanonicalInstant(raw.effectiveUntil);
    if (
      (storeReference === null) !== (baseVersionReference === null) ||
      (storeReference === null) !== (overrideAuthorizationReference === null) ||
      (raw.lifecycle === "Draft") !== (publicationReference === null) ||
      (raw.lifecycle === "Draft") !== (approvalEvidenceReference === null) ||
      (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
    )
      return workflowUnavailable();
    const transitionKeys = new Set<string>(),
      transitionIds = new Set<string>();
    const transitions = list(raw.transitions, 256).map((value) => {
      const t = closed(value, [
        "transitionReference",
        "currentState",
        "action",
        "nextState",
        "permissionCode",
        "ruleReferences",
        "effects",
      ]);
      const transitionReference = workflowReference(t.transitionReference);
      const currentState = code(t.currentState),
        action = code(t.action);
      const key = JSON.stringify([currentState, action]);
      if (transitionKeys.has(key) || transitionIds.has(transitionReference))
        return workflowUnavailable();
      transitionKeys.add(key);
      transitionIds.add(transitionReference);
      const ruleReferences = list(t.ruleReferences, 64).map(workflowReference);
      if (new Set(ruleReferences).size !== ruleReferences.length) return workflowUnavailable();
      const effects = list(t.effects, 64).map((value) => {
        const effect = closed(value, ["ownerModule", "commandCode"]);
        return Object.freeze({
          ownerModule: code(effect.ownerModule),
          commandCode: code(effect.commandCode),
        });
      });
      if (
        new Set(effects.map((effect) => JSON.stringify([effect.ownerModule, effect.commandCode])))
          .size !== effects.length
      )
        return workflowUnavailable();
      return Object.freeze({
        transitionReference,
        currentState,
        action,
        nextState: code(t.nextState),
        permissionCode: code(t.permissionCode),
        ruleReferences: Object.freeze(ruleReferences),
        effects: Object.freeze(effects),
      });
    });
    if (transitions.length === 0) return workflowUnavailable();
    return Object.freeze({
      schemaVersion: 1 as const,
      workflowReference: workflowReference(raw.workflowReference),
      versionReference: workflowReference(raw.versionReference),
      versionNumber: Number(raw.versionNumber),
      tenantReference: workflowReference(raw.tenantReference),
      brandReference: workflowReference(raw.brandReference),
      storeReference,
      purposeCode: code(raw.purposeCode),
      applicabilityCode: code(raw.applicabilityCode),
      lifecycle: raw.lifecycle as "Draft" | "Published" | "Withdrawn",
      baseVersionReference,
      overrideAuthorizationReference,
      effectiveFrom,
      effectiveUntil,
      publicationReference,
      approvalEvidenceReference,
      authoredByReference: workflowReference(raw.authoredByReference),
      createdAt: parseCanonicalInstant(raw.createdAt),
      transitions: Object.freeze(transitions),
    });
  } catch {
    return workflowUnavailable("Malformed");
  }
}
export type WorkflowDefinitionVersion = ReturnType<typeof parseWorkflowDefinitionVersion>;

/** Parse an action request before invoking trusted owner capabilities. */
export function parseWorkflowActionRequest(value: unknown) {
  try {
    const raw = closed(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "resourceReference",
      "resourceVersion",
      "purposeCode",
      "applicabilityCode",
      "expectedVersionReference",
      "currentState",
      "action",
      "observedAt",
    ]);
    if (!Number.isSafeInteger(raw.resourceVersion) || Number(raw.resourceVersion) < 0)
      return workflowUnavailable();
    return Object.freeze({
      tenantReference: workflowReference(raw.tenantReference),
      brandReference: workflowReference(raw.brandReference),
      storeReference: workflowReference(raw.storeReference),
      actorReference: workflowReference(raw.actorReference),
      resourceReference: workflowReference(raw.resourceReference),
      resourceVersion: Number(raw.resourceVersion),
      purposeCode: code(raw.purposeCode),
      applicabilityCode: code(raw.applicabilityCode),
      expectedVersionReference: workflowReference(raw.expectedVersionReference),
      currentState: code(raw.currentState),
      action: code(raw.action),
      observedAt: parseCanonicalInstant(raw.observedAt),
    });
  } catch {
    return workflowUnavailable("Malformed");
  }
}
export type WorkflowActionRequest = ReturnType<typeof parseWorkflowActionRequest>;
