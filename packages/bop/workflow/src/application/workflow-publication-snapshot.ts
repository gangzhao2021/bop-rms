import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseWorkflowDefinitionVersion,
  workflowUnavailable,
  type WorkflowDefinitionVersion,
} from "../domain/workflow-definition.js";
export function workflowDefinitionContent(definition: WorkflowDefinitionVersion) {
  return canonicalizeRfc8785({
    ...definition,
    versionReference: null,
    versionNumber: null,
    createdAt: null,
    lifecycle: null,
    publicationReference: null,
    approvalEvidenceReference: null,
  });
}
export function createWorkflowPublicationSnapshot(value: unknown) {
  const draft = parseWorkflowDefinitionVersion(value);
  if (draft.lifecycle !== "Draft") return workflowUnavailable();
  return Object.freeze({
    familyReference: draft.workflowReference,
    configurationType: "WORKFLOW_DEFINITION" as const,
    purposeCode: "WORKFLOW_PUBLICATION" as const,
    snapshotReference: draft.versionReference,
    snapshotDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(draft)),
    scope: Object.freeze({
      kind: draft.storeReference === null ? ("Brand" as const) : ("Store" as const),
      brandReference: draft.brandReference,
      storeReference: draft.storeReference,
    }),
  });
}
export function bindWorkflowPublicationSnapshot(publishedValue: unknown, draftValue: unknown) {
  const published = parseWorkflowDefinitionVersion(publishedValue),
    draft = parseWorkflowDefinitionVersion(draftValue);
  if (
    published.lifecycle !== "Published" ||
    published.versionNumber !== draft.versionNumber + 1 ||
    published.createdAt < draft.createdAt ||
    workflowDefinitionContent(published) !== workflowDefinitionContent(draft)
  )
    return workflowUnavailable();
  return createWorkflowPublicationSnapshot(draft);
}
