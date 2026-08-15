import {
  createPlatformTenantAdministrationInput,
  PlatformTenantAdministrationError,
  type PlatformTenantAdministrationVersion,
} from "../contracts/platform-tenant-administration.js";
import type {
  PlatformTenantAdministrationCommand,
  PlatformTenantAdministrationPorts,
} from "./ports/platform-tenant-administration-ports.js";
const fail = (code: ConstructorParameters<typeof PlatformTenantAdministrationError>[0]): never => {
  throw new PlatformTenantAdministrationError(code);
};
const dependency = () => fail("PLATFORM_TENANT_DEPENDENCY_UNAVAILABLE");
const highRisk = new Set<PlatformTenantAdministrationCommand>([
  "ApproveOnboarding",
  "ActivateTenant",
  "ApproveConfiguration",
  "ApproveSuspension",
  "RequestRestore",
]);
const transitions: Readonly<
  Record<
    PlatformTenantAdministrationCommand,
    readonly [
      PlatformTenantAdministrationVersion["status"] | null,
      PlatformTenantAdministrationVersion["status"],
    ]
  >
> = {
  CreateDraft: [null, "Draft"],
  SubmitOnboarding: ["Draft", "PendingApproval"],
  ApproveOnboarding: ["PendingApproval", "Approved"],
  ActivateTenant: ["Approved", "Active"],
  ProposeConfiguration: ["Active", "PendingApproval"],
  ApproveConfiguration: ["PendingApproval", "Active"],
  RequestSuspension: ["Active", "SuspensionPending"],
  ApproveSuspension: ["SuspensionPending", "Suspended"],
  RequestRestore: ["Suspended", "RestorePending"],
};
const sameConfiguration = (
  left: PlatformTenantAdministrationVersion,
  right: PlatformTenantAdministrationVersion,
) =>
  left.tenantReference === right.tenantReference &&
  left.regionCode === right.regionCode &&
  left.environment === right.environment &&
  left.planMetadataReference === right.planMetadataReference &&
  JSON.stringify(left.capabilityMetadataReferences) ===
    JSON.stringify(right.capabilityMetadataReferences) &&
  left.dataPolicyReference === right.dataPolicyReference &&
  left.retentionPolicyReference === right.retentionPolicyReference;
export function createPlatformTenantAdministrationService(
  ports: PlatformTenantAdministrationPorts,
) {
  return Object.freeze({
    execute: async (command: PlatformTenantAdministrationCommand, raw: unknown) => {
      let input;
      try {
        input = createPlatformTenantAdministrationInput(raw);
      } catch (error) {
        if (error instanceof PlatformTenantAdministrationError) throw error;
        return fail("PLATFORM_TENANT_INPUT_INVALID");
      }
      const auth = await ports.authorization
        .authorize({
          command,
          actorReference: input.actorReference,
          tenantReference: input.candidate.tenantReference,
          purposeCode: input.purposeCode,
          supportCaseReference: input.supportCaseReference,
          observedAt: input.occurredAt,
        })
        .catch(dependency);
      if (!auth.allowed || !auth.namedPlatformActor)
        return fail("PLATFORM_TENANT_PERMISSION_DENIED");
      if (!auth.purposeBound || !auth.supportCaseValid)
        return fail("PLATFORM_TENANT_PURPOSE_INVALID");
      if (highRisk.has(command) && !auth.recentMfa) return fail("PLATFORM_TENANT_MFA_REQUIRED");
      const digest = ports.references.hashIntent(JSON.stringify({ command, ...input })),
        existing = await ports.repository
          .resolveOperation(input.operationReference)
          .catch(dependency);
      if (existing) {
        if (!ports.references.equals(existing.intentDigest, digest))
          return fail("PLATFORM_TENANT_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, operation: existing });
      }
      const current = await ports.repository
          .loadLatest(input.candidate.tenantReference)
          .catch(dependency),
        [from, to] = transitions[command];
      if ((current?.version ?? 0) !== input.expectedVersion)
        return fail("PLATFORM_TENANT_VERSION_CONFLICT");
      if (
        (current?.status ?? null) !== from ||
        input.candidate.status !== to ||
        input.candidate.version !== input.expectedVersion + 1 ||
        (current !== null &&
          input.candidate.supersedesVersionReference !== current.versionReference) ||
        (current === null && input.candidate.supersedesVersionReference !== null)
      )
        return fail("PLATFORM_TENANT_LIFECYCLE_CONFLICT");
      const tenant = await ports.organization
        .loadTenant(input.candidate.tenantReference)
        .catch(dependency);
      if (!tenant) return fail("PLATFORM_TENANT_NOT_FOUND");
      if (
        command !== "CreateDraft" &&
        current &&
        !sameConfiguration(current, input.candidate) &&
        command !== "ProposeConfiguration"
      )
        return fail("PLATFORM_TENANT_LIFECYCLE_CONFLICT");
      if (
        command === "ProposeConfiguration" &&
        input.candidate.authoredByReference !== input.actorReference
      )
        return fail("PLATFORM_TENANT_APPROVAL_INVALID");
      if (
        ![
          input.candidate.planMetadataReference,
          input.candidate.dataPolicyReference,
          input.candidate.retentionPolicyReference,
        ].every(Boolean) ||
        !(await ports.references
          .validatePlan(input.candidate.planMetadataReference)
          .catch(dependency)) ||
        !(await ports.references
          .validatePolicy(input.candidate.dataPolicyReference)
          .catch(dependency)) ||
        !(await ports.references
          .validatePolicy(input.candidate.retentionPolicyReference)
          .catch(dependency)) ||
        !(
          await Promise.all(
            input.candidate.capabilityMetadataReferences.map((r) =>
              ports.references.validateCapability(r).catch(dependency),
            ),
          )
        ).every(Boolean)
      )
        return fail("PLATFORM_TENANT_REFERENCE_INVALID");
      if (["ApproveOnboarding", "ApproveConfiguration", "ApproveSuspension"].includes(command)) {
        if (
          input.candidate.approvedByReference !== input.actorReference ||
          input.candidate.approvalEvidenceReference === null ||
          input.candidate.authoredByReference === input.actorReference ||
          !(await ports.evidence
            .validateApproval(input.candidate.approvalEvidenceReference, input.occurredAt)
            .catch(dependency))
        )
          return fail("PLATFORM_TENANT_APPROVAL_INVALID");
      }
      if (
        command === "ApproveOnboarding" &&
        (input.candidate.onboardingEvidenceReference === null ||
          !(await ports.evidence
            .validateOnboarding(input.candidate.onboardingEvidenceReference, input.occurredAt)
            .catch(dependency)))
      )
        return fail("PLATFORM_TENANT_EVIDENCE_INVALID");
      if (
        ["RequestSuspension", "ApproveSuspension"].includes(command) &&
        (input.candidate.impactAssessmentReference === null ||
          !(await ports.evidence
            .validateImpact(input.candidate.impactAssessmentReference, input.occurredAt)
            .catch(dependency)))
      )
        return fail("PLATFORM_TENANT_EVIDENCE_INVALID");
      if (
        ["ActivateTenant", "ApproveSuspension", "RequestRestore"].includes(command) &&
        !(await ports.organization.validateLifecycle(input).catch(dependency))
      )
        return fail("PLATFORM_TENANT_EVIDENCE_INVALID");
      const operation = Object.freeze({
        command,
        operationReference: input.operationReference,
        tenantReference: input.candidate.tenantReference,
        intentDigest: digest,
        version: input.candidate.version,
        candidate: input.candidate,
      });
      const committed = await ports.repository
        .commit({
          operation,
          expectedVersion: input.expectedVersion,
          audit: {
            actorReference: input.actorReference,
            purposeCode: input.purposeCode,
            supportCaseReference: input.supportCaseReference,
            auditReference: input.auditReference,
            occurredAt: input.occurredAt,
          },
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, operation: committed });
    },
  });
}
