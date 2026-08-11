import { isProxy } from "node:util/types";

import {
  canonicalizeKitchenWorkLifecycle as canonicalizeDomainValue,
  createKitchenCapturedExpoBinding as createDomainCapturedExpoBinding,
  createKitchenReadyWorkItemsBinding as createDomainReadyWorkItemsBinding,
  createKitchenWorkLifecycleIntentBinding as createDomainIntentBinding,
  KitchenWorkLifecycleError,
  parseKitchenCapturedExpoDecision as parseDomainCapturedExpoDecision,
  parseKitchenExpoPolicyDecision as parseDomainExpoPolicyDecision,
  parseKitchenStartAdmissionDecision as parseDomainStartAdmissionDecision,
  parseKitchenWorkLifecycleAuthority as parseDomainAuthority,
  parseKitchenWorkLifecycleCommand as parseDomainCommand,
  parseKitchenWorkLifecycleCorrelation as parseDomainCorrelation,
  parseKitchenWorkLifecycleResult as parseDomainResult,
  parseKitchenWorkLifecycleSource as parseDomainSource,
} from "../domain/kitchen-work-lifecycle.js";

export {
  kitchenVersionText,
  kitchenWorkLifecycleAuditRetentionPolicyCode,
  kitchenWorkLifecycleAuditRetentionPolicyVersion,
  kitchenWorkLifecycleErrorCodes,
  kitchenWorkLifecyclePermission,
  kitchenWorkLifecycleProjectionName,
  KitchenWorkLifecycleError,
  type AcceptKitchenWorkItemCommand,
  type CompleteKitchenWorkItemCommand,
  type KitchenCapturedExpoDecision,
  type KitchenExpoPolicyDecision,
  type KitchenLifecyclePredecessorOperation,
  type KitchenLifecycleSourceWorkItem,
  type KitchenLifecycleWorkItemStatus,
  type KitchenOrderItemReadyResultProof,
  type KitchenReadyWorkItemVersion,
  type KitchenStartAdmissionDecision,
  type KitchenTicketReadinessEntry,
  type KitchenWorkLifecycleAction,
  type KitchenWorkLifecycleAuthority,
  type KitchenWorkLifecycleCommand,
  type KitchenWorkLifecycleCorrelation,
  type KitchenWorkLifecycleErrorCode,
  type KitchenWorkLifecycleOutcome,
  type KitchenWorkLifecyclePurpose,
  type KitchenWorkLifecycleResult,
  type KitchenWorkLifecycleSource,
  type MarkKitchenOrderItemReadyCommand,
  type StartKitchenWorkItemCommand,
} from "../domain/kitchen-work-lifecycle.js";

function rejectUnsafeObjectGraph(
  value: unknown,
  code: "KITCHEN_WORK_INPUT_INVALID" | "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
  seen = new WeakSet<object>(),
  active = new WeakSet<object>(),
): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  const object = value as object;
  if (isProxy(object) || active.has(object)) throw new KitchenWorkLifecycleError(code);
  if (seen.has(object)) return;
  seen.add(object);
  active.add(object);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
        throw new KitchenWorkLifecycleError(code);
      rejectUnsafeObjectGraph(descriptor.value, code, seen, active);
    }
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleError) throw error;
    throw new KitchenWorkLifecycleError(code);
  } finally {
    active.delete(object);
  }
}

export function parseKitchenWorkLifecycleCommand(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_INPUT_INVALID");
  return parseDomainCommand(value);
}

export function parseKitchenWorkLifecycleSource(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainSource(value);
}

export function parseKitchenWorkLifecycleAuthority(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainAuthority(value);
}

export function parseKitchenWorkLifecycleCorrelation(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainCorrelation(value);
}

export function parseKitchenStartAdmissionDecision(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainStartAdmissionDecision(value);
}

export function parseKitchenExpoPolicyDecision(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainExpoPolicyDecision(value);
}

export function parseKitchenCapturedExpoDecision(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainCapturedExpoDecision(value);
}

export function parseKitchenWorkLifecycleResult(value: unknown) {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return parseDomainResult(value);
}

export function canonicalizeKitchenWorkLifecycle(value: unknown): string {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return canonicalizeDomainValue(value);
}

export function createKitchenWorkLifecycleIntentBinding(value: unknown): string {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_INPUT_INVALID");
  return createDomainIntentBinding(value);
}

export function createKitchenReadyWorkItemsBinding(value: unknown): string {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return createDomainReadyWorkItemsBinding(value);
}

export function createKitchenCapturedExpoBinding(value: unknown): string {
  rejectUnsafeObjectGraph(value, "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
  return createDomainCapturedExpoBinding(value);
}
