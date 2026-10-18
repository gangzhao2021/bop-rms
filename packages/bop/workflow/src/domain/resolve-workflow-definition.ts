import { parseCanonicalInstant } from "@bop/tenant";
import {
  parseWorkflowDefinitionVersion,
  workflowReference,
  workflowUnavailable,
  type WorkflowDefinitionVersion,
} from "./workflow-definition.js";
/** Pure source selection; publication, override grants and action permissions still require owner validation. */
export function resolveWorkflowDefinition(
  input: Readonly<{
    versions: readonly unknown[];
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    purposeCode: string;
    applicabilityCode: string;
    observedAt: string;
  }>,
) {
  const tenant = workflowReference(input.tenantReference),
    brand = workflowReference(input.brandReference),
    store = workflowReference(input.storeReference),
    at = parseCanonicalInstant(input.observedAt);
  if (
    !Array.isArray(input.versions) ||
    input.versions.length > 1024 ||
    Reflect.ownKeys(input.versions).length !== input.versions.length + 1
  )
    return workflowUnavailable();
  const latest = new Map<string, WorkflowDefinitionVersion>(),
    ids = new Set<string>(),
    numbers = new Set<string>();
  for (let i = 0; i < input.versions.length; i++) {
    const d = Object.getOwnPropertyDescriptor(input.versions, String(i));
    if (!d?.enumerable || !("value" in d)) return workflowUnavailable();
    const v = parseWorkflowDefinitionVersion(d.value);
    if (
      v.tenantReference !== tenant ||
      v.brandReference !== brand ||
      (v.storeReference !== null && v.storeReference !== store) ||
      v.purposeCode !== input.purposeCode ||
      v.applicabilityCode !== input.applicabilityCode
    )
      return workflowUnavailable();
    const key = (v.storeReference ?? "Brand") + ":" + v.workflowReference;
    const number = key + ":" + v.versionNumber;
    if (ids.has(v.versionReference) || numbers.has(number)) return workflowUnavailable();
    ids.add(v.versionReference);
    numbers.add(number);
    if (v.lifecycle === "Draft" || v.createdAt > at || v.effectiveFrom > at) continue;
    const prior = latest.get(key);
    if (!prior || prior.versionNumber < v.versionNumber) latest.set(key, v);
  }
  const brandVersions = [...latest.values()].filter((v) => v.storeReference === null);
  const storeVersions = [...latest.values()].filter((v) => v.storeReference === store);
  if (brandVersions.length !== 1 || storeVersions.length > 1) return workflowUnavailable();
  const base = brandVersions[0];
  const active = (v: WorkflowDefinitionVersion) =>
    v.lifecycle === "Published" && (v.effectiveUntil === null || v.effectiveUntil > at);
  if (!base || !active(base)) return workflowUnavailable();
  const selected = storeVersions[0];
  if (!selected) return Object.freeze({ definition: base, brandDefinition: base });
  if (!active(selected) || selected.baseVersionReference !== base.versionReference)
    return workflowUnavailable();
  return Object.freeze({ definition: selected, brandDefinition: base });
}
