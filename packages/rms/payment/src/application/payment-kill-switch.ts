import {
  parseFeatureControlInstant,
  parseFeatureControlKey,
  parseFeatureControlReference,
  parseFeatureControlVersion,
  type FeatureControlEvaluationRecord,
  type InFlightPolicy,
  type KillSwitchMode,
} from "@bop/feature-control";

import type { PaymentInstant } from "./payment-intent-creation.js";

export const paymentProviderAdmissionKillSwitchKey = "payment.provider.admission" as const;

export interface PaymentProviderAdmissionExpectation {
  readonly action: "CreatePaymentIntent";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly evaluatedAt: PaymentInstant;
}

export interface PaymentProviderAdmissionEvidence {
  readonly action: "CreatePaymentIntent";
  readonly result: "Allow";
  readonly inFlightPolicy: InFlightPolicy;
  readonly record: FeatureControlEvaluationRecord;
}

const killModes: readonly KillSwitchMode[] = ["BlockNew", "SafePause", "Terminate"];
const inFlightPolicies: readonly InFlightPolicy[] = [
  "AllowToComplete",
  "ReachSafeCheckpoint",
  "CompensateAndStop",
];
const admissionReasons = ["KILL_INACTIVE", "KILL_RECOVERY_ALLOWED"] as const;

function exactFrozenObject(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !Object.isFrozen(value)
    )
      return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      fields.some((field) => {
        const descriptor = descriptors[field];
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    )
      return null;
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function exactScope(
  value: unknown,
  expected: PaymentProviderAdmissionExpectation,
): "Brand" | "Store" | null {
  const scope = exactFrozenObject(value, ["kind", "brandReference", "storeReference"]);
  if (scope === null || scope.brandReference !== expected.brandReference) return null;
  if (scope.kind === "Brand" && scope.storeReference === null) return "Brand";
  if (scope.kind === "Store" && scope.storeReference === expected.storeReference) return "Store";
  return null;
}

/**
 * Revalidates Feature Control's bounded evaluation at Payment's new-work boundary.
 * A null result is deliberately non-diagnostic: callers expose one disabled error for every
 * active, unavailable, inconsistent or malformed decision.
 */
export function verifyPaymentProviderAdmission(
  value: unknown,
  expected: PaymentProviderAdmissionExpectation,
): PaymentProviderAdmissionEvidence | null {
  try {
    const evaluation = exactFrozenObject(value, [
      "effectiveControl",
      "backendExecution",
      "frontendVisibility",
      "reason",
      "killMode",
      "inFlightPolicy",
      "record",
    ]);
    if (evaluation === null) return null;
    const effectiveControl = exactFrozenObject(evaluation.effectiveControl, [
      "controlId",
      "version",
      "scope",
    ]);
    const record = exactFrozenObject(evaluation.record, [
      "key",
      "kind",
      "version",
      "scopeKind",
      "backendExecution",
      "frontendVisibility",
      "reason",
      "killMode",
      "evaluatedAt",
    ]);
    if (effectiveControl === null || record === null) return null;

    parseFeatureControlReference(effectiveControl.controlId);
    const version = parseFeatureControlVersion(effectiveControl.version);
    const key = parseFeatureControlKey(record.key);
    const evaluatedAt = parseFeatureControlInstant(record.evaluatedAt);
    const scopeKind = exactScope(effectiveControl.scope, expected);
    if (
      key !== paymentProviderAdmissionKillSwitchKey ||
      record.kind !== "KillSwitch" ||
      record.version !== version ||
      scopeKind === null ||
      record.scopeKind !== scopeKind ||
      String(evaluatedAt) !== expected.evaluatedAt ||
      record.backendExecution !== evaluation.backendExecution ||
      record.frontendVisibility !== evaluation.frontendVisibility ||
      record.reason !== evaluation.reason ||
      record.killMode !== evaluation.killMode ||
      !killModes.includes(evaluation.killMode as KillSwitchMode) ||
      !inFlightPolicies.includes(evaluation.inFlightPolicy as InFlightPolicy)
    )
      return null;

    if (
      evaluation.backendExecution !== "Allow" ||
      evaluation.frontendVisibility !== "Show" ||
      !admissionReasons.includes(evaluation.reason as (typeof admissionReasons)[number])
    )
      return null;

    return Object.freeze({
      action: expected.action,
      result: "Allow",
      inFlightPolicy: evaluation.inFlightPolicy as InFlightPolicy,
      record: record as unknown as FeatureControlEvaluationRecord,
    });
  } catch {
    return null;
  }
}
