import {
  createBusinessFunctionAssignmentRequest,
  createOperatingEntityApprovalDecision,
  createOperatingEntityAuthoritySummary,
  createOperatingEntityProfileVersion,
  type OperatingEntityApprovalDecision,
} from "../contracts/operating-entity-administration.js";
import {
  createOperatingEntity,
  parseEvidenceReference,
  parseOperatingEntityReference,
  transitionOperatingEntity,
  type OperatingEntity,
  type OperatingEntityReference,
} from "../domain/operating-entity.js";
import type {
  OperatingEntityAdministrationArtifact,
  OperatingEntityAdministrationCommand,
  OperatingEntityAdministrationOperation,
  OperatingEntityAdministrationPorts,
} from "./ports/operating-entity-administration-ports.js";
import { parseCanonicalInstant, parseOrganizationVersion } from "@bop/tenant";

export type OperatingEntityAdministrationServiceErrorCode =
  | "ENTITY_ADMIN_INPUT_INVALID"
  | "ENTITY_ADMIN_PERMISSION_DENIED"
  | "ENTITY_ADMIN_RECENT_MFA_REQUIRED"
  | "ENTITY_ADMIN_NOT_FOUND"
  | "ENTITY_ADMIN_VERSION_CONFLICT"
  | "ENTITY_ADMIN_IDEMPOTENCY_CONFLICT"
  | "ENTITY_ADMIN_LIFECYCLE_CONFLICT"
  | "ENTITY_ADMIN_APPROVAL_INVALID"
  | "ENTITY_ADMIN_SEGREGATION_INVALID"
  | "ENTITY_ADMIN_ASSIGNMENT_OVERLAP"
  | "ENTITY_ADMIN_DEPENDENCY_UNAVAILABLE";
export class OperatingEntityAdministrationServiceError extends Error {
  constructor(readonly code: OperatingEntityAdministrationServiceErrorCode) {
    super("Operating Entity administration operation is unavailable");
    this.name = "OperatingEntityAdministrationServiceError";
  }
}
const fail = (code: OperatingEntityAdministrationServiceErrorCode): never => {
  throw new OperatingEntityAdministrationServiceError(code);
};
const dependency = (error: unknown): never => {
  if (error instanceof OperatingEntityAdministrationServiceError) throw error;
  throw new OperatingEntityAdministrationServiceError("ENTITY_ADMIN_DEPENDENCY_UNAVAILABLE");
};
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function inputRecord(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("ENTITY_ADMIN_INPUT_INVALID");
  const fields = [
    "operationReference",
    "actorReference",
    "purposeCode",
    "auditReference",
    "expectedVersion",
    "occurredAt",
    "artifact",
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("ENTITY_ADMIN_INPUT_INVALID");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.operationReference !== "string" ||
    !REF.test(raw.operationReference) ||
    typeof raw.actorReference !== "string" ||
    !REF.test(raw.actorReference) ||
    typeof raw.auditReference !== "string" ||
    !REF.test(raw.auditReference) ||
    typeof raw.purposeCode !== "string" ||
    !CODE.test(raw.purposeCode)
  )
    return fail("ENTITY_ADMIN_INPUT_INVALID");
  try {
    return Object.freeze({
      operationReference: raw.operationReference,
      actorReference: raw.actorReference,
      purposeCode: raw.purposeCode,
      auditReference: parseEvidenceReference(raw.auditReference),
      expectedVersion: parseOrganizationVersion(raw.expectedVersion),
      occurredAt: parseCanonicalInstant(raw.occurredAt),
      artifact: raw.artifact,
    });
  } catch {
    return fail("ENTITY_ADMIN_INPUT_INVALID");
  }
}
type ParsedInput = ReturnType<typeof inputRecord>;
function entityReferenceOf(
  artifact: OperatingEntityAdministrationArtifact,
): OperatingEntityReference {
  return parseOperatingEntityReference(artifact.operatingEntityReference);
}

export function createOperatingEntityAdministrationService(
  ports: OperatingEntityAdministrationPorts,
) {
  async function execute(
    command: OperatingEntityAdministrationCommand,
    rawInput: unknown,
    parseArtifact: (value: unknown) => OperatingEntityAdministrationArtifact,
    requireRecentMfa: boolean,
    validate: (
      input: ParsedInput,
      artifact: OperatingEntityAdministrationArtifact,
      current: OperatingEntity,
    ) => Promise<void>,
  ) {
    const input = inputRecord(rawInput);
    let artifact: OperatingEntityAdministrationArtifact;
    try {
      artifact = parseArtifact(input.artifact);
    } catch {
      return fail("ENTITY_ADMIN_INPUT_INVALID");
    }
    const operatingEntityReference = entityReferenceOf(artifact);
    const authorization = await ports.authorization
      .authorize({
        command,
        actorReference: input.actorReference,
        operatingEntityReference,
        purposeCode: input.purposeCode,
        occurredAt: input.occurredAt,
        requireRecentMfa,
      })
      .catch(dependency);
    if (!authorization.allowed) return fail("ENTITY_ADMIN_PERMISSION_DENIED");
    if (requireRecentMfa && !authorization.recentMfa)
      return fail("ENTITY_ADMIN_RECENT_MFA_REQUIRED");
    const digest = ports.references.hashIntent(JSON.stringify({ command, ...input }));
    const existing = await ports.repository
      .resolveOperation(input.operationReference)
      .catch(dependency);
    if (existing !== null) {
      if (!ports.references.equals(existing.intentDigest, digest))
        return fail("ENTITY_ADMIN_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ status: "AlreadyApplied" as const, operation: existing });
    }
    const current = await ports.repository.loadEntity(operatingEntityReference).catch(dependency);
    if (current === null) return fail("ENTITY_ADMIN_NOT_FOUND");
    if (current.version !== input.expectedVersion) return fail("ENTITY_ADMIN_VERSION_CONFLICT");
    await validate(input, artifact, current);
    const entityVersion =
      "kind" in artifact && typeof artifact.version === "number"
        ? parseOrganizationVersion(artifact.version)
        : current.version;
    const operation: OperatingEntityAdministrationOperation = Object.freeze({
      command,
      operationReference: input.operationReference,
      operatingEntityReference,
      intentDigest: digest,
      entityVersion,
      artifact,
    });
    const committed = await ports.repository
      .commit({
        operation,
        expectedVersion: input.expectedVersion,
        audit: {
          actorReference: input.actorReference,
          purposeCode: input.purposeCode,
          auditReference: input.auditReference,
          occurredAt: input.occurredAt,
        },
      })
      .catch(dependency);
    return Object.freeze({ status: "Applied" as const, operation: committed });
  }
  return Object.freeze({
    saveProfile: (input: unknown) =>
      execute(
        "SaveProfile",
        input,
        createOperatingEntityProfileVersion,
        true,
        async (_parsed, artifact, current) => {
          const profile = createOperatingEntityProfileVersion(artifact);
          if (current.lifecycle !== "Draft") return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          const latest = await ports.repository
            .loadLatestProfile(current.operatingEntityReference)
            .catch(dependency);
          if (profile.profileVersion !== (latest?.profileVersion ?? 0) + 1)
            return fail("ENTITY_ADMIN_VERSION_CONFLICT");
        },
      ),
    submitForApproval: (input: unknown) =>
      execute(
        "SubmitForApproval",
        input,
        createOperatingEntity,
        false,
        async (parsed, artifact, current) => {
          const next = createOperatingEntity(artifact);
          let expected: OperatingEntity;
          try {
            expected = transitionOperatingEntity(
              current,
              parsed.expectedVersion,
              "PendingExternalEvidence",
              parsed.occurredAt,
            );
          } catch {
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          }
          if (JSON.stringify(next) !== JSON.stringify(expected))
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
        },
      ),
    decideApproval: (input: unknown) =>
      execute(
        "DecideApproval",
        input,
        createOperatingEntityApprovalDecision,
        true,
        async (parsed, artifact, current) => {
          const decision = createOperatingEntityApprovalDecision(artifact);
          if (
            current.lifecycle !== "PendingExternalEvidence" ||
            decision.entityVersion !== current.version
          )
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          if (
            decision.decidedByReference !== parsed.actorReference ||
            decision.submittedByReference === parsed.actorReference
          )
            return fail("ENTITY_ADMIN_SEGREGATION_INVALID");
          if (
            !(await ports.approval
              .validate({
                operatingEntityReference: current.operatingEntityReference,
                approvalEvidenceReference: decision.approvalEvidenceReference,
                entityVersion: current.version,
                observedAt: parsed.occurredAt,
              })
              .catch(dependency))
          )
            return fail("ENTITY_ADMIN_APPROVAL_INVALID");
        },
      ),
    activateEntity: (input: unknown) =>
      execute(
        "ActivateEntity",
        input,
        createOperatingEntity,
        true,
        async (parsed, artifact, current) => {
          const next = createOperatingEntity(artifact);
          const decision = await ports.repository
            .loadLatestApprovalDecision(current.operatingEntityReference)
            .catch(dependency);
          if (decision === null) return fail("ENTITY_ADMIN_APPROVAL_INVALID");
          assertApprovedForActivation(current, decision);
          let expected: OperatingEntity;
          try {
            expected = transitionOperatingEntity(
              current,
              parsed.expectedVersion,
              "Active",
              parsed.occurredAt,
            );
          } catch {
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          }
          if (JSON.stringify(next) !== JSON.stringify(expected))
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
        },
      ),
    suspendEntity: (input: unknown) =>
      execute(
        "SuspendEntity",
        input,
        createOperatingEntity,
        true,
        async (parsed, artifact, current) => {
          const next = createOperatingEntity(artifact);
          let expected: OperatingEntity;
          try {
            expected = transitionOperatingEntity(
              current,
              parsed.expectedVersion,
              "Suspended",
              parsed.occurredAt,
            );
          } catch {
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          }
          if (JSON.stringify(next) !== JSON.stringify(expected))
            return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
        },
      ),
    recordAuthority: (input: unknown) =>
      execute(
        "RecordAuthority",
        input,
        createOperatingEntityAuthoritySummary,
        true,
        async (parsed, artifact, current) => {
          const authority = createOperatingEntityAuthoritySummary(artifact);
          if (
            !(await ports.approval
              .validate({
                operatingEntityReference: current.operatingEntityReference,
                approvalEvidenceReference: authority.approvalEvidenceReference,
                entityVersion: current.version,
                observedAt: parsed.occurredAt,
              })
              .catch(dependency))
          )
            return fail("ENTITY_ADMIN_APPROVAL_INVALID");
        },
      ),
    assignBusinessFunction: (input: unknown) =>
      execute(
        "AssignBusinessFunction",
        input,
        createBusinessFunctionAssignmentRequest,
        true,
        async (parsed, artifact, current) => {
          const assignment = createBusinessFunctionAssignmentRequest(artifact);
          if (current.lifecycle !== "Active") return fail("ENTITY_ADMIN_LIFECYCLE_CONFLICT");
          if (
            !(await ports.approval
              .validate({
                operatingEntityReference: current.operatingEntityReference,
                approvalEvidenceReference: assignment.approvalEvidenceReference,
                entityVersion: current.version,
                observedAt: parsed.occurredAt,
              })
              .catch(dependency))
          )
            return fail("ENTITY_ADMIN_APPROVAL_INVALID");
          if (await ports.assignments.hasOverlap(assignment).catch(dependency))
            return fail("ENTITY_ADMIN_ASSIGNMENT_OVERLAP");
        },
      ),
  });
}

export function assertApprovedForActivation(
  entity: OperatingEntity,
  decision: OperatingEntityApprovalDecision,
) {
  if (
    decision.operatingEntityReference !== entity.operatingEntityReference ||
    decision.entityVersion !== entity.version ||
    decision.decision !== "Approved"
  )
    return fail("ENTITY_ADMIN_APPROVAL_INVALID");
}
