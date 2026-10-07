import {
  createRoleAdministrationVersion,
  type RoleAdministrationVersionRecord,
  type RolePermissionSelection,
} from "../contracts/role-administration.js";
import type { RoleAdministrationOperation } from "./role-administration-service.js";

/**
 * WP-2423: builds the candidate next version for one role administration command from the current
 * version, the acting administrator and the current Brand policy version. The service then
 * authorizes, validates the transition and commits it.
 */
export function planRoleAdministrationChange(input: {
  readonly operation: RoleAdministrationOperation;
  readonly current: RoleAdministrationVersionRecord;
  readonly actorReference: string;
  readonly policyVersion: number;
  readonly changedAt: string;
  readonly reasonCode: string;
  readonly nextReference: () => string;
  readonly draft: {
    readonly code?: string;
    readonly displayName: string;
    readonly description: string;
    readonly selections: readonly RolePermissionSelection[];
  } | null;
}): RoleAdministrationVersionRecord {
  const { current, draft } = input;
  const base = {
    ...current,
    version: current.version + 1,
    changedAt: input.changedAt,
    reasonCode: input.reasonCode,
    selections: current.selections.map((item) => ({ ...item })),
  };
  const fromDraft = () => {
    if (draft === null) throw new Error("ROLE_ADMIN_DRAFT_REQUIRED");
    return {
      displayName: draft.displayName,
      description: draft.description,
      selections: draft.selections.map((item) => ({ ...item })),
    };
  };
  switch (input.operation) {
    case "Duplicate":
      return createRoleAdministrationVersion({
        ...base,
        ...fromDraft(),
        administrationReference: input.nextReference(),
        roleReference: input.nextReference(),
        version: 1,
        code: draft?.code,
        roleType: "Custom",
        lifecycle: "Draft",
        sourcePolicyVersion: input.policyVersion,
        authoredByReference: input.actorReference,
        submittedByReference: null,
        approvedByReference: null,
        decisionEvidenceReference: null,
      });
    case "SaveDraft":
      return createRoleAdministrationVersion({
        ...base,
        ...fromDraft(),
        authoredByReference: input.actorReference,
      });
    case "Submit":
      return createRoleAdministrationVersion({
        ...base,
        lifecycle: "InReview",
        submittedByReference: input.actorReference,
      });
    case "Approve":
      return createRoleAdministrationVersion({
        ...base,
        lifecycle: "Approved",
        approvedByReference: input.actorReference,
        decisionEvidenceReference: input.nextReference(),
      });
    case "Reject":
      return createRoleAdministrationVersion({
        ...base,
        lifecycle: "Rejected",
        decisionEvidenceReference: input.nextReference(),
      });
    case "Activate":
      return createRoleAdministrationVersion({
        ...base,
        lifecycle: "Active",
        sourcePolicyVersion: input.policyVersion,
      });
    case "Deactivate":
      return createRoleAdministrationVersion({
        ...base,
        lifecycle: "Deactivated",
        sourcePolicyVersion: input.policyVersion,
      });
  }
}
