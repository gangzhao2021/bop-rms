import {
  parseBrandAdministrationContext,
  type BrandAdministrationContext,
  type BrandReference,
} from "@bop/tenant";
import {
  PermissionEvaluationContractError,
  parseBusinessAction,
  type PermissionEvaluationRequest,
} from "./permission-evaluation.js";

/** Administrative configuration actions only. This does not authorize creating
 * a Brand, provisioning access, or entering an operational Store context. */
export const brandAdministrationPermissionActions = [
  "organization.manage",
  "publishing.draft.create",
  "publishing.review.submit",
  "publishing.review.approve",
  "publishing.release.publish",
  "publishing.release.archive",
] as const;
export type BrandAdministrationPermissionAction =
  (typeof brandAdministrationPermissionActions)[number];

export function parseBrandAdministrationPermissionAction(value: unknown) {
  if (!brandAdministrationPermissionActions.some((action) => action === value))
    throw new PermissionEvaluationContractError("PERMISSION_REQUEST_INVALID");
  return parseBusinessAction(value);
}

export function revalidateBrandAdministrationPermissionContext(
  value: unknown,
): BrandAdministrationContext {
  try {
    if (!Object.isFrozen(value))
      throw new PermissionEvaluationContractError("PERMISSION_CONTEXT_INVALID");
    return parseBrandAdministrationContext(value);
  } catch {
    throw new PermissionEvaluationContractError("PERMISSION_CONTEXT_INVALID");
  }
}

export interface BrandAdministrationPermissionEvaluationRequest {
  readonly administrationContext: BrandAdministrationContext;
  readonly action: string;
  readonly resourceScope: {
    readonly kind: "Brand";
    readonly brandReference: BrandReference;
    readonly storeReference: null;
  };
  readonly policySnapshotReference: PermissionEvaluationRequest["policySnapshotReference"];
  readonly policyVersion: PermissionEvaluationRequest["policyVersion"];
  readonly evidence: PermissionEvaluationRequest["evidence"];
}
