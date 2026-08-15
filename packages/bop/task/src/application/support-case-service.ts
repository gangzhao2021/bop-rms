import {
  createSupportCaseOperationInput,
  SupportCaseError,
  type DiagnosticAccessGrant,
  type SupportCaseStatus,
  type SupportCaseVersion,
} from "../contracts/support-case.js";
import type {
  DiagnosticAccessDecision,
  ResolveDiagnosticAccessInput,
  SupportCaseCommand,
  SupportCaseOperation,
  SupportCasePorts,
} from "./ports/support-case-ports.js";

const fail = (code: ConstructorParameters<typeof SupportCaseError>[0]): never => {
  throw new SupportCaseError(code);
};
const dependency = () => fail("SUPPORT_CASE_DEPENDENCY_UNAVAILABLE");
const transitions: Readonly<
  Record<SupportCaseCommand, readonly [SupportCaseStatus | null, SupportCaseStatus]>
> = {
  Create: [null, "Open"],
  Assign: ["Open", "Assigned"],
  RequestAccess: ["Assigned", "AccessPendingApproval"],
  GrantAccess: ["AccessPendingApproval", "AccessGranted"],
  RecordAction: ["AccessGranted", "AccessGranted"],
  RevokeAccess: ["AccessGranted", "Revoked"],
  Close: ["Revoked", "Closed"],
};
function sameCase(left: SupportCaseVersion, right: SupportCaseVersion): boolean {
  return (
    left.caseReference === right.caseReference &&
    left.tenantReference === right.tenantReference &&
    left.storeReference === right.storeReference &&
    left.caseType === right.caseType &&
    left.purposeCode === right.purposeCode &&
    left.requesterActorReference === right.requesterActorReference &&
    left.requesterVerificationEvidenceReference === right.requesterVerificationEvidenceReference &&
    left.dueAt === right.dueAt &&
    left.createdAt === right.createdAt
  );
}
function exactPayload(
  command: SupportCaseCommand,
  grant: unknown,
  action: unknown,
  grantRef: unknown,
) {
  const shape: Readonly<Record<SupportCaseCommand, readonly [boolean, boolean, boolean]>> = {
    Create: [false, false, false],
    Assign: [false, false, false],
    RequestAccess: [false, false, false],
    GrantAccess: [true, false, false],
    RecordAction: [false, true, true],
    RevokeAccess: [false, false, true],
    Close: [false, false, false],
  };
  const [hasGrant, hasAction, hasGrantRef] = shape[command];
  if (
    (grant !== null) !== hasGrant ||
    (action !== null) !== hasAction ||
    (grantRef !== null) !== hasGrantRef
  )
    fail("SUPPORT_CASE_INPUT_INVALID");
}
async function validateGrant(
  grant: DiagnosticAccessGrant,
  input: ReturnType<typeof createSupportCaseOperationInput>,
  ports: SupportCasePorts,
) {
  if (
    grant.caseReference !== input.candidate.caseReference ||
    grant.tenantReference !== input.candidate.tenantReference ||
    grant.storeReference !== input.candidate.storeReference ||
    grant.supportActorReference !== input.candidate.requesterActorReference ||
    grant.purposeCode !== input.candidate.purposeCode ||
    grant.purposeCode !== input.purposeCode ||
    grant.approvedByReference !== input.actorReference ||
    grant.grantedAt !== input.occurredAt
  )
    fail("SUPPORT_CASE_GRANT_INVALID");
  const auth = await ports.authorization
    .authorize({
      command: "GrantAccess",
      actorReference: input.actorReference,
      caseReference: input.candidate.caseReference,
      tenantReference: input.candidate.tenantReference,
      storeReference: input.candidate.storeReference,
      purposeCode: input.purposeCode,
      observedAt: input.occurredAt,
    })
    .catch(dependency);
  if (!auth.recentMfa) fail("SUPPORT_CASE_MFA_REQUIRED");
  if (!auth.approver || grant.requestedByReference === input.actorReference)
    fail("SUPPORT_CASE_APPROVAL_INVALID");
  if (
    !(await ports.evidence
      .validateApproval(grant.approvalEvidenceReference, input.occurredAt)
      .catch(dependency))
  )
    fail("SUPPORT_CASE_APPROVAL_INVALID");
  if (
    !(await ports.evidence
      .validateRecentMfa({
        actorReference: input.actorReference,
        evidenceReference: grant.recentMfaEvidenceReference,
        observedAt: input.occurredAt,
      })
      .catch(dependency))
  )
    fail("SUPPORT_CASE_MFA_REQUIRED");
  if (
    !(await ports.delegation
      .validate({
        caseReference: grant.caseReference,
        actorReference: grant.supportActorReference,
        permissions: grant.delegatedPermissions,
        maskingPolicyReference: grant.maskingPolicyReference,
      })
      .catch(dependency))
  )
    fail("SUPPORT_CASE_GRANT_INVALID");
}

export function createSupportCaseService(ports: SupportCasePorts) {
  return Object.freeze({
    execute: async (command: SupportCaseCommand, raw: unknown) => {
      let input;
      try {
        input = createSupportCaseOperationInput(raw);
      } catch (error) {
        if (error instanceof SupportCaseError) throw error;
        return fail("SUPPORT_CASE_INPUT_INVALID");
      }
      exactPayload(command, input.grant, input.action, input.grantReference);
      const auth = await ports.authorization
        .authorize({
          command,
          actorReference: input.actorReference,
          caseReference: input.candidate.caseReference,
          tenantReference: input.candidate.tenantReference,
          storeReference: input.candidate.storeReference,
          purposeCode: input.purposeCode,
          observedAt: input.occurredAt,
        })
        .catch(dependency);
      if (!auth.allowed || !auth.namedPlatformActor) fail("SUPPORT_CASE_PERMISSION_DENIED");
      if (
        !auth.purposeBound ||
        !auth.caseBound ||
        input.purposeCode !== input.candidate.purposeCode
      )
        fail("SUPPORT_CASE_PURPOSE_INVALID");
      if (
        !(await ports.scope
          .validateTenantStore({
            tenantReference: input.candidate.tenantReference,
            storeReference: input.candidate.storeReference,
          })
          .catch(dependency))
      )
        fail("SUPPORT_CASE_SCOPE_INVALID");
      if (
        !(await ports.evidence
          .validateRequester(
            input.candidate.requesterVerificationEvidenceReference,
            input.occurredAt,
          )
          .catch(dependency))
      )
        fail("SUPPORT_CASE_EVIDENCE_INVALID");
      const digest = ports.references.hashIntent(JSON.stringify({ command, ...input })),
        existing = await ports.repository
          .resolveOperation(input.operationReference)
          .catch(dependency);
      if (existing) {
        if (!ports.references.equals(existing.intentDigest, digest))
          fail("SUPPORT_CASE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, operation: existing });
      }
      const current = await ports.repository
          .loadLatest(input.candidate.caseReference)
          .catch(dependency),
        [from, to] = transitions[command];
      if ((current?.version ?? 0) !== input.expectedVersion) fail("SUPPORT_CASE_VERSION_CONFLICT");
      if (
        (current?.status ?? null) !== from ||
        input.candidate.status !== to ||
        input.candidate.version !== input.expectedVersion + 1 ||
        input.candidate.updatedAt !== input.occurredAt ||
        (current === null && input.candidate.createdAt !== input.occurredAt) ||
        (current === null) !== (input.candidate.supersedesVersionReference === null) ||
        (current !== null &&
          (!sameCase(current, input.candidate) ||
            input.candidate.supersedesVersionReference !== current.versionReference))
      )
        fail("SUPPORT_CASE_LIFECYCLE_CONFLICT");
      if (command === "Create" && input.candidate.requesterActorReference !== input.actorReference)
        fail("SUPPORT_CASE_PERMISSION_DENIED");
      if (command === "GrantAccess" && input.grant) await validateGrant(input.grant, input, ports);
      if (command === "RevokeAccess" && input.grantReference) {
        const grant = await ports.repository.loadGrant(input.grantReference).catch(dependency);
        if (
          !grant ||
          grant.caseReference !== input.candidate.caseReference ||
          grant.tenantReference !== input.candidate.tenantReference ||
          grant.storeReference !== input.candidate.storeReference ||
          (await ports.repository.isGrantRevoked(input.grantReference).catch(dependency))
        )
          fail("SUPPORT_CASE_GRANT_INVALID");
      }
      if (command === "RecordAction" && input.action && input.grantReference) {
        const grant = await ports.repository.loadGrant(input.grantReference).catch(dependency);
        const activeGrant = grant ?? fail("SUPPORT_CASE_GRANT_REVOKED");
        if (await ports.repository.isGrantRevoked(input.grantReference).catch(dependency))
          fail("SUPPORT_CASE_GRANT_REVOKED");
        if (Date.parse(input.occurredAt) >= Date.parse(activeGrant.expiresAt))
          fail("SUPPORT_CASE_GRANT_EXPIRED");
        if (
          input.action.caseReference !== input.candidate.caseReference ||
          input.action.grantReference !== activeGrant.grantReference ||
          input.action.supportActorReference !== input.actorReference ||
          activeGrant.supportActorReference !== input.actorReference ||
          !activeGrant.delegatedPermissions.includes(input.action.delegatedPermission)
        )
          fail("SUPPORT_CASE_GRANT_INVALID");
      }
      const operation: SupportCaseOperation = Object.freeze({
        command,
        operationReference: input.operationReference,
        caseReference: input.candidate.caseReference,
        version: input.candidate.version,
        intentDigest: digest,
        candidate: input.candidate,
        grant: input.grant,
        action: input.action,
        grantReference: input.grantReference,
      });
      const committed = await ports.repository
        .commit({
          operation,
          expectedVersion: input.expectedVersion,
          audit: {
            actorReference: input.actorReference,
            purposeCode: input.purposeCode,
            caseReference: input.candidate.caseReference,
            auditReference: input.auditReference,
            occurredAt: input.occurredAt,
          },
        })
        .catch(dependency);
      return Object.freeze({ status: "Applied" as const, operation: committed });
    },
  });
}

export function createDiagnosticAccessResolver(ports: SupportCasePorts) {
  return async (input: ResolveDiagnosticAccessInput): Promise<DiagnosticAccessDecision> => {
    try {
      const current = await ports.repository.loadLatest(input.caseReference),
        grant = await ports.repository.loadGrant(input.grantReference);
      if (
        !current ||
        current.status !== "AccessGranted" ||
        !grant ||
        (await ports.repository.isGrantRevoked(input.grantReference)) ||
        grant.caseReference !== input.caseReference ||
        grant.supportActorReference !== input.actorReference ||
        grant.tenantReference !== input.tenantReference ||
        grant.storeReference !== input.storeReference ||
        grant.purposeCode !== input.purposeCode ||
        !grant.delegatedPermissions.includes(input.delegatedPermission) ||
        Date.parse(input.observedAt) >= Date.parse(grant.expiresAt)
      )
        return Object.freeze({ allowed: false, reason: "Denied" });
      return Object.freeze({
        allowed: true,
        reason: "ActiveGrant",
        grantReference: grant.grantReference,
        expiresAt: grant.expiresAt,
        maskingPolicyReference: grant.maskingPolicyReference,
      });
    } catch {
      return Object.freeze({ allowed: false, reason: "Denied" });
    }
  };
}
