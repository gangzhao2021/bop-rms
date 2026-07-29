import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSessionRevocationRequest,
  createWorkforceInvitation,
  createWorkforceMfaStatus,
  createWorkforceRecoveryCase,
  type EvidenceReference,
  type IdentitySecurityAuditDescriptor,
  type IdentitySecurityAuditPort,
  type IdentitySecurityCredentialPort,
  type IdentitySecuritySessionRotationPort,
  type RawBrowserCredential,
  type SecurityOperationContext,
  type SelectorHash,
  type WorkforceIdentityProviderPort,
  type WorkforceIdentitySecurityStorePort,
} from "../index.js";
import { WorkforceIdentitySecurityService } from "../application/workforce-identity-security-service.js";
import type {
  CompleteRecoveryCaseCommand,
  ConsumeWorkforceInvitationCommand,
  CreateRecoveryCaseCommand,
  IssueWorkforceInvitationCommand,
  RecordTotpVerifiedCommand,
  RevokeActorSessionsCommand,
} from "../application/ports/workforce-identity-security-port.js";

const uuid = (suffix: string) => `018f8f9a-ad3e-7a11-8d01-${suffix.padStart(12, "0")}`;
const ids = {
  actor: uuid("1"),
  admin: uuid("2"),
  membership: uuid("3"),
  store: uuid("4"),
  invitation: uuid("5"),
  evidence: uuid("6"),
  correlation: uuid("7"),
  idempotency: uuid("8"),
  session: uuid("9"),
  recovery: uuid("10"),
  approver: uuid("11"),
};
const AT = "2026-07-29T12:00:00.000Z";
const credential = (character: string) => character.repeat(43) as RawBrowserCredential;
const digest = (value: string) => createHash("sha256").update(value).digest("hex") as SelectorHash;

class MemoryStore implements WorkforceIdentitySecurityStorePort {
  invitation = null as ReturnType<typeof createWorkforceInvitation> | null;
  mfa = createWorkforceMfaStatus({
    actorReference: ids.actor,
    status: "Required",
    providerEvidenceReference: null,
    verifiedAt: null,
    resetAt: null,
    version: 1,
  });
  recovery = null as ReturnType<typeof createWorkforceRecoveryCase> | null;
  revocations = new Map<string, ReturnType<typeof createSessionRevocationRequest>>();

  async createInvitation(command: IssueWorkforceInvitationCommand) {
    this.invitation = createWorkforceInvitation({
      invitationReference: command.invitationReference,
      actorReference: command.actorReference,
      inviterActorReference: command.inviterActorReference,
      membershipReference: command.membershipReference,
      storeAssignmentReferences: command.storeAssignmentReferences,
      emailDigest: command.emailDigest,
      selectorHash: command.selectorHash,
      status: "Pending",
      createdAt: command.observedAt,
      expiresAt: new Date(Date.parse(command.observedAt) + 86_400_000).toISOString(),
      consumedAt: null,
      providerEvidenceReference: null,
      version: 1,
    });
    return this.invitation;
  }
  async consumeInvitation(command: ConsumeWorkforceInvitationCommand) {
    const current = this.invitation;
    if (
      current === null ||
      current.status !== "Pending" ||
      current.selectorHash !== command.selectorHash ||
      current.emailDigest !== command.emailDigest ||
      Date.parse(command.observedAt) >= Date.parse(current.expiresAt)
    )
      return null;
    this.invitation = createWorkforceInvitation({
      ...current,
      status: "Accepted",
      consumedAt: command.observedAt,
      providerEvidenceReference: command.providerEvidenceReference,
      version: current.version + 1,
    });
    return this.invitation;
  }
  async getMfaStatus() {
    return this.mfa;
  }
  async recordTotpVerified(command: RecordTotpVerifiedCommand) {
    if (command.expectedVersion !== this.mfa.version) throw new Error("conflict");
    this.mfa = createWorkforceMfaStatus({
      ...this.mfa,
      status: "TotpVerified",
      providerEvidenceReference: command.providerEvidenceReference,
      verifiedAt: command.observedAt,
      version: this.mfa.version + 1,
    });
    return this.mfa;
  }
  async createRecoveryCase(command: CreateRecoveryCaseCommand) {
    this.recovery = command.recovery;
    return command.recovery;
  }
  async getRecoveryCase() {
    return this.recovery;
  }
  async completeRecoveryCase(command: CompleteRecoveryCaseCommand) {
    if (this.recovery === null || this.recovery.version !== command.expectedVersion)
      throw new Error("conflict");
    this.recovery = createWorkforceRecoveryCase({
      ...this.recovery,
      status: "Completed",
      completedAt: command.completedAt,
      version: this.recovery.version + 1,
    });
    return this.recovery;
  }
  async revokeActorSessions(command: RevokeActorSessionsCommand) {
    const replay = this.revocations.get(command.idempotencyKey);
    if (replay) return replay;
    const result = createSessionRevocationRequest({
      idempotencyKey: command.idempotencyKey,
      actorReference: command.actorReference,
      reason: command.reason,
      purposeCode: command.purposeCode,
      correlationId: command.correlationId,
      sourceEvidenceReference: command.sourceEvidenceReference,
      cutoffAt: command.observedAt,
      completedAt: command.observedAt,
      revokedSessionReferences: [ids.session],
      version: 1,
    });
    this.revocations.set(command.idempotencyKey, result);
    return result;
  }
}

const operation = (
  overrides: Partial<SecurityOperationContext> = {},
): SecurityOperationContext => ({
  actingActorReference: ids.admin as never,
  purposeCode: "WORKFORCE_SECURITY" as never,
  correlationId: ids.correlation as never,
  idempotencyKey: ids.idempotency as never,
  ...overrides,
});

function harness(providerOutcome: "Issued" | "Unknown" = "Issued") {
  const store = new MemoryStore();
  const audits: IdentitySecurityAuditDescriptor[] = [];
  let nextUuid = 0;
  const credentials: IdentitySecurityCredentialPort = {
    generate: () => credential("A"),
    generateUuidV7: () => [ids.invitation, ids.recovery][nextUuid++] ?? uuid(`${20 + nextUuid}`),
    digest,
  };
  const provider: WorkforceIdentityProviderPort = {
    acceptInvitation: async () => ({ evidenceReference: ids.evidence as EvidenceReference }),
    verifyTotp: async () => ({ evidenceReference: ids.evidence as EvidenceReference }),
    issueOneTimeTemporaryCredential: async () => ({
      evidenceReference: ids.evidence as EvidenceReference,
      outcome: providerOutcome,
    }),
  };
  const sessions: IdentitySecuritySessionRotationPort = {
    rotateAfterMfa: async () => credential("B"),
  };
  const audit: IdentitySecurityAuditPort = {
    append: async (descriptor) => {
      audits.push(descriptor);
    },
  };
  const service = new WorkforceIdentitySecurityService({
    store,
    provider,
    credentials,
    sessions,
    audit,
    now: () => AT,
  });
  return { audits, service, store };
}

describe("WP-0108 workforce identity security", () => {
  it("issues a 24-hour hash-only invitation and consumes it once", async () => {
    const { audits, service, store } = harness();
    const issued = await service.issueInvitation({
      actorReference: ids.actor,
      membershipReference: ids.membership,
      storeAssignmentReferences: [ids.store],
      corporateEmail: "worker@example.invalid",
      operation: operation(),
    });
    expect(issued.selector).toBe(credential("A"));
    expect(issued.invitation.selectorHash).toBe(digest(credential("A")));
    expect(issued.invitation.emailDigest).toBe(digest("worker@example.invalid"));
    expect(JSON.stringify(issued.invitation)).not.toContain("worker@example.invalid");
    const accepted = await service.acceptInvitation({
      selector: issued.selector,
      corporateEmail: "worker@example.invalid",
      operation: operation({ actingActorReference: ids.actor as never }),
    });
    expect(accepted.status).toBe("Accepted");
    await expect(
      service.acceptInvitation({
        selector: issued.selector,
        corporateEmail: "worker@example.invalid",
        operation: operation({ actingActorReference: ids.actor as never }),
      }),
    ).rejects.toMatchObject({ code: "WORKFORCE_SECURITY_DENIED" });
    expect(store.invitation?.version).toBe(2);
    expect(audits.map((item) => item.operation)).toEqual([
      "InvitationIssued",
      "InvitationAccepted",
    ]);
  });

  it("rejects email mismatch without exposing account existence", async () => {
    const { service } = harness();
    const issued = await service.issueInvitation({
      actorReference: ids.actor,
      membershipReference: ids.membership,
      storeAssignmentReferences: [],
      corporateEmail: "worker@example.invalid",
      operation: operation(),
    });
    await expect(
      service.acceptInvitation({
        selector: issued.selector,
        corporateEmail: "other@example.invalid",
        operation: operation({ actingActorReference: ids.actor as never }),
      }),
    ).rejects.toMatchObject({
      code: "WORKFORCE_SECURITY_DENIED",
      message: "request denied",
    });
  });

  it("records only TOTP evidence and rotates the Session", async () => {
    const { audits, service, store } = harness();
    const result = await service.completeTotp({
      actorReference: ids.actor,
      challenge: credential("C"),
      sessionCredential: credential("D"),
      operation: operation({ actingActorReference: ids.actor as never }),
    });
    expect(result.mfa.status).toBe("TotpVerified");
    expect(result.nextSessionCredential).toBe(credential("B"));
    expect(JSON.stringify(store.mfa)).not.toContain(credential("C"));
    expect(audits.at(-1)?.operation).toBe("TotpVerified");
  });

  it("replays actor-wide revocation by idempotency key", async () => {
    const { service, store } = harness();
    const first = await service.revokeActorSessions({
      actorReference: ids.actor,
      reason: "GlobalLogout",
      sourceEvidenceReference: ids.evidence,
      operation: operation(),
    });
    const second = await service.revokeActorSessions({
      actorReference: ids.actor,
      reason: "GlobalLogout",
      sourceEvidenceReference: ids.evidence,
      operation: operation(),
    });
    expect(second).toBe(first);
    expect(store.revocations.size).toBe(1);
    expect(first.revokedSessionReferences).toEqual([ids.session]);
  });

  it("requires distinct approved recovery evidence", async () => {
    const { service } = harness();
    await expect(
      service.createRecovery({
        targetActorReference: ids.actor,
        approverActorReferences: [ids.admin],
        requiredApprovalCount: 1,
        proofEvidenceReference: ids.evidence,
        operation: operation(),
      }),
    ).rejects.toMatchObject({ code: "WORKFORCE_SECURITY_INPUT_INVALID" });
    const recovery = await service.createRecovery({
      targetActorReference: ids.actor,
      approverActorReferences: [ids.approver],
      requiredApprovalCount: 1,
      proofEvidenceReference: ids.evidence,
      operation: operation(),
    });
    expect(recovery.status).toBe("Approved");
  });

  it("revokes every local Session before completing recovery", async () => {
    const { audits, service, store } = harness();
    const recovery = await service.createRecovery({
      targetActorReference: ids.actor,
      approverActorReferences: [ids.approver],
      requiredApprovalCount: 1,
      proofEvidenceReference: ids.evidence,
      operation: operation(),
    });
    const result = await service.completeRecovery({
      recoveryReference: recovery.recoveryReference,
      operation: operation(),
    });
    expect(result.recovery.status).toBe("Completed");
    expect(result.revocation.reason).toBe("Recovery");
    expect(store.revocations.size).toBe(1);
    expect(audits.map((item) => item.operation)).toContain("RecoveryCompleted");
  });

  it("keeps local Sessions revoked when Provider recovery is unknown", async () => {
    const { service, store } = harness("Unknown");
    const recovery = await service.createRecovery({
      targetActorReference: ids.actor,
      approverActorReferences: [ids.approver],
      requiredApprovalCount: 1,
      proofEvidenceReference: ids.evidence,
      operation: operation(),
    });
    await expect(
      service.completeRecovery({
        recoveryReference: recovery.recoveryReference,
        operation: operation(),
      }),
    ).rejects.toMatchObject({ code: "WORKFORCE_SECURITY_DENIED" });
    expect(store.revocations.size).toBe(1);
    expect(store.recovery?.status).toBe("Approved");
  });

  it("rejects TOTP replay after verified status", async () => {
    const { service } = harness();
    const input = {
      actorReference: ids.actor,
      challenge: credential("C"),
      sessionCredential: credential("D"),
      operation: operation({ actingActorReference: ids.actor as never }),
    };
    await service.completeTotp(input);
    await expect(service.completeTotp(input)).rejects.toMatchObject({
      code: "WORKFORCE_SECURITY_DENIED",
    });
  });
});
