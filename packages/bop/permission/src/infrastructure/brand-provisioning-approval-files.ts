import { createSignedBrandProvisioningApprovalSource } from "./brand-provisioning-approval-source.js";
import {
  configuredPrivateApprovalPath,
  readPrivateApprovalJson,
} from "./read-private-approval-json.js";

const unavailable = (): never => {
  throw new Error("BRAND_PROVISIONING_APPROVAL_FILE_UNAVAILABLE");
};

/** Concrete file producer for the owner signature verifier. Possessing an
 * approval does not authenticate its operator or qualify a Workforce relation.
 * Those facts, the complete plan and the immutable original receipt remain
 * mandatory in the controlled provisioning composition before any owner write.
 */
export function createFileBrandProvisioningApprovalSource(options: {
  readonly approvalPath: string;
  readonly trustPath: string;
  readonly clock: () => string;
}) {
  if (
    !options ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Reflect.ownKeys(options).length !== 3
  )
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const name of ["approvalPath", "trustPath", "clock"]) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
  }
  const approvalPath = configuredPrivateApprovalPath(descriptors.approvalPath?.value, unavailable);
  const trustPath = configuredPrivateApprovalPath(descriptors.trustPath?.value, unavailable);
  const clock: unknown = descriptors.clock?.value;
  if (approvalPath === trustPath || typeof clock !== "function") return unavailable();
  return createSignedBrandProvisioningApprovalSource({
    clock: { now: () => clock() as string },
    readApproval: () => readPrivateApprovalJson(approvalPath, unavailable),
    readTrust: () => readPrivateApprovalJson(trustPath, unavailable),
  });
}
