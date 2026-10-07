import { beforeEach, describe, expect, it, vi } from "vitest";
import * as identity from "@bop/identity";
import * as membership from "@bop/membership";
import * as permission from "@bop/permission";
import { createBrand } from "@bop/tenant";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createCognitoWorkforceOnboardingBrowser } from "./workforce-onboarding-browser.js";

const ports = vi.hoisted(() => ({
  protocol: vi.fn(),
  authorization: vi.fn(),
  invitation: vi.fn(),
  consume: vi.fn(),
  binding: vi.fn(),
  account: vi.fn(),
  session: vi.fn(),
  pending: vi.fn(),
  relationship: vi.fn(),
  member: vi.fn(),
  plan: vi.fn(),
  approval: vi.fn(),
  policy: vi.fn(),
  tenant: vi.fn(),
  audit: vi.fn(),
  platformAudit: vi.fn(),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createCognitoWorkforceOnboardingAuthentication: ports.protocol,
  createPostgresWorkforceOnboardingAuthorizationSource: ports.authorization,
  createPostgresWorkforceOnboardingInvitationSource: ports.invitation,
  createPostgresWorkforceInvitationStore: ports.consume,
  createPostgresWorkforceAccountBindingAcceptanceWriter: ports.binding,
  createPostgresWorkforceAuthenticationSource: ports.account,
  createPostgresWorkforceBrowserSessionStore: ports.session,
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<typeof import("@bop/membership")>()),
  createPostgresBrandAdministrationMembershipActivationSource: ports.pending,
  createFileCurrentWorkforceRelationshipSource: ports.relationship,
  createPostgresApprovedWorkforceMembershipStore: ports.member,
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createFileWorkforceOnboardingPlanSource: ports.plan,
  createFileWorkforceOnboardingApprovalSource: ports.approval,
  createPostgresApprovedWorkforcePolicyStore: ports.policy,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresBrandAdministrationOrganizationSource: ports.tenant,
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: ports.audit,
  appendPlatformAuditRecordInTransaction: ports.platformAudit,
}));

// These are composition-unit owner ports. Actual SQL, signatures and Provider
// transport are exercised separately; these fixtures do not prove external IAM.
const id = (n: number) => `0190ed60-0400-7000-8000-${String(n).padStart(12, "0")}`;
const origin = "2026-10-06T12:00:00.000Z",
  end = "2026-10-06T12:00:05.000Z",
  businessEnd = "2026-11-06T12:00:00.000Z";
const configuration = {
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
  clientId: "controlledclient",
  clientSecret: "synthetic-client-secret",
  managedLoginOrigin: "https://controlled.auth.ca-central-1.amazoncognito.com",
  redirectUri: "https://app.example.test/merchant/organization/brands/callback",
  logoutReturnUri: "https://app.example.test/app/organization/brands",
};
function fixture() {
  const scope = {
    environment: configuration.environment,
    issuer: configuration.issuer,
    clientId: configuration.clientId,
  };
  const plan = permission.deriveWorkforceOnboardingPlan({
    profile: "WorkforceOnboardingPlanV1",
    purposeCode: "WORKFORCE_ONBOARDING",
    configuration: scope,
    environmentReference: id(1),
    operationReference: id(2),
    operatorReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(5),
    brandReference: id(6),
    actorReference: id(7),
    membershipReference: id(8),
    workforceRelationshipReference: id(9),
    relationshipEvidenceReference: id(10),
    relationshipRevision: 2,
    effectiveFrom: origin,
    effectiveUntil: businessEnd,
    emailDigest: "a".repeat(64),
    policy: {
      profile: "ApprovedWorkforcePolicyV1",
      brandReference: id(6),
      actorReference: id(7),
      membershipReference: id(8),
      effectiveFrom: origin,
      effectiveUntil: businessEnd,
      roles: [
        {
          roleReference: id(11),
          roleCode: "invited_owner",
          effectiveFrom: origin,
          effectiveUntil: businessEnd,
          assignment: {
            assignmentReference: id(12),
            effectiveFrom: origin,
            effectiveUntil: businessEnd,
          },
          grants: [
            {
              grantReference: id(13),
              permissionReference: id(14),
              action: "organization.manage",
              effectiveFrom: origin,
              effectiveUntil: businessEnd,
            },
          ],
        },
      ],
    },
    expectedPolicy: null,
    policySnapshotReference: id(16),
    reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
  });
  const envelope = {
    algorithm: "SYNTHETIC_AES_256_GCM" as const,
    keyReference: "controlled-key",
    ciphertext: "c".repeat(64),
    encryptionContext: identity.workforceOnboardingSubjectContext(plan.original),
  };
  const record = identity.buildWorkforceOnboardingOperation(
    {
      profile: "WorkforceOnboardingOperationV1",
      original: plan.original,
      intentDigest: identity.workforceOnboardingIntent(plan.original, {
        canonicalize: canonicalizeRfc8785,
        hash: sha256Hex,
      }),
      version: 3,
      state: "ProviderObserved",
      invitationReference: id(20),
      selectorHash: "b".repeat(64),
      createdAt: origin,
      expiresAt: "2026-10-07T12:00:00.000Z",
      dispatchStartedAt: origin,
      provider: {
        subjectHash: "d".repeat(64),
        encryptedSubject: envelope,
        username: `bop_${id(7)}`,
        createdAt: origin,
        status: "CONFIRMED",
        enabled: true,
      },
      phaseOperationReference: id(21),
      phaseRequestDigest: `sha256:${"e".repeat(64)}`,
      previousSourceDigest: `sha256:${"f".repeat(64)}`,
      auditReference: id(22),
      occurredAt: origin,
    },
    { canonicalize: canonicalizeRfc8785, hash: sha256Hex },
  );
  const invitation = identity.createWorkforceInvitation({
    invitationReference: id(20),
    actorReference: id(7),
    inviterActorReference: id(3),
    membershipReference: id(8),
    storeAssignmentReferences: [],
    emailDigest: plan.original.emailDigest,
    selectorHash: record.selectorHash,
    status: "Pending",
    version: 1,
    createdAt: origin,
    expiresAt: record.expiresAt,
    consumedAt: null,
    providerEvidenceReference: null,
  });
  const binding = identity.parseWorkforceOnboardingInvitationBinding({
    configuration: scope,
    invitationReference: id(20),
    originalIntentDigest: record.intentDigest,
    selectorHash: record.selectorHash,
  });
  const evidence: identity.WorkforceOnboardingInvitationEvidence = {
    profile: "WorkforceOnboardingInvitationEvidenceV1",
    binding,
    record,
    invitation,
    observedAt: origin,
    validUntil: end,
  };
  const actor = identity.createIdentityActor({
    actorType: "User",
    actorReference: id(7),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: origin,
    recentMfaAt: origin,
  });
  const authorization = identity.createAuthorizationTransaction({
    transactionReference: identity.parseAuthorizationTransactionReference(id(23)),
    stateSelectorHash: identity.parseSelectorHash("1".repeat(64)),
    authCookieSelectorHash: identity.parseSelectorHash("2".repeat(64)),
    encryptedSecrets: envelope,
    redirectUri: configuration.redirectUri,
    postLoginPath: "/app/organization/brands",
    expiresAt: identity.parseCanonicalInstant("2026-10-06T12:10:00.000Z"),
    consumedAt: identity.parseCanonicalInstant(origin),
    version: identity.parseSessionVersion(2),
  });
  const request: Parameters<identity.WorkforceOidcProviderPort["exchangeCode"]>[0] = {
    issuer: scope.issuer,
    clientId: scope.clientId,
    redirectUri: configuration.redirectUri,
    code: "controlled-code",
    nonce: identity.parseRawBrowserCredential("n".repeat(43)),
    codeVerifier: identity.parseRawBrowserCredential("v".repeat(43)),
    prompt: "login",
    requireTotp: true,
    transactionReference: authorization.transactionReference,
  };
  const totp: identity.WorkforceTotpVerification = {
    method: "Totp",
    timestampPrecision: "Second",
    evidenceReference: id(24),
    actorReference: id(7),
    issuer: scope.issuer,
    clientId: scope.clientId,
    authorizationTransactionReference: authorization.transactionReference,
    nonce: identity.parseRawBrowserCredential(request.nonce),
    authenticatedAt: identity.parseCanonicalInstant(origin),
    verifiedAt: identity.parseCanonicalInstant(origin),
  };
  const session = identity.createAuthenticationSession({
    sessionReference: id(25),
    actor,
    status: "Active",
    policyCode: "Privileged",
    maxActiveSessions: 2,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 480,
    version: 1,
    authenticatedAt: origin,
    createdAt: origin,
    lastSeenAt: origin,
    idleExpiresAt: "2026-10-06T12:15:00.000Z",
    absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const sessionRecord = identity.createBrowserSessionRecord({
    session,
    sessionSelectorHash: "3".repeat(64),
    csrfSelectorHash: "4".repeat(64),
    encryptedSecrets: envelope,
  });
  const command: Parameters<identity.WorkforceOnboardingBrowserPort["complete"]>[0]["command"] = {
    sessionReference: session.sessionReference,
    actor,
    policyCode: "Privileged",
    sessionSelectorHash: sessionRecord.sessionSelectorHash,
    csrfSelectorHash: sessionRecord.csrfSelectorHash,
    encryptedSecrets: envelope,
    observedAt: identity.parseCanonicalInstant(origin),
  };
  const pending = membership.createApprovedPendingWorkforceMembership(
    {
      membershipReference: id(8),
      actorReference: id(7),
      brandReference: id(6),
      workforceRelationshipReference: id(9),
      lifecycle: "PendingActivation",
      effectiveFrom: origin,
      effectiveUntil: businessEnd,
      version: 1,
      createdAt: origin,
      updatedAt: origin,
    },
    id(7),
  );
  const brand = createBrand({
    brandReference: id(6),
    code: "SYNTHETIC",
    displayName: "Synthetic invitation Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: origin,
    updatedAt: origin,
  });
  const events: string[] = [],
    database = {
      invitation: "Pending",
      binding: false,
      member: "PendingActivation",
      session: false,
    },
    controls = {
      denied: false,
      providerDisabled: false,
      failSession: false,
      failCommit: false,
      lateWithdrawal: false,
      wrongPlan: false,
      wrongApprover: false,
      wrongEvidence: false,
      wrongAuthNonce: false,
    };
  let at = origin,
    allocations = 0,
    sealed = false,
    entered = false;
  const clock = { now: vi.fn(() => at) },
    proof: identity.CognitoWorkforceOnboardingAuthenticationProof = {
      actor,
      tokenBundle: "controlled-transient-bundle",
      subject: "controlled-opaque-subject",
      totp,
      observedAt: origin,
      validUntil: end,
      async assertCurrent() {
        events.push("ProviderCurrent");
        if (controls.providerDisabled || controls.denied || sealed)
          throw new Error("CONTROLLED_PROVIDER_DENIED");
      },
      assertFinalized() {
        events.push("ProviderSeal");
        if (controls.providerDisabled || controls.denied || at >= end || sealed)
          throw new Error("CONTROLLED_FINAL_REFUSED");
        sealed = true;
      },
    };
  const guarded = <T extends object>(
    name: string,
    options: {
      transaction: T;
      registerBeforeCommit(tx: T, guard: () => Promise<void>, final: () => void): Promise<void>;
    },
  ) => {
    let registered = false,
      final = false;
    return {
      async enter() {
        if (!registered) {
          registered = true;
          await options.registerBeforeCommit(
            options.transaction,
            async () => {
              events.push(`${name}Guard`);
              if (controls.denied) throw new Error("CONTROLLED_OWNER_WITHDRAWN");
            },
            () => {
              events.push(`${name}Seal`);
              final = true;
            },
          );
        }
      },
      assertFinalized() {
        expect(final).toBe(true);
        events.push(`${name}Finalized`);
      },
    };
  };
  const exchangeWire = vi.fn(async () => {
    events.push("SignedExchange");
    return proof;
  });
  ports.protocol.mockReturnValue({ exchangeCode: exchangeWire });
  ports.authorization.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceOnboardingAuthorizationSource>[0]) => {
      const g = guarded("Authorization", o);
      return {
        async hold() {
          await g.enter();
          events.push("ConsumedAuthorization");
          return {
            authorization,
            binding,
            nonce: controls.wrongAuthNonce ? "x".repeat(43) : request.nonce,
            codeVerifier: request.codeVerifier,
            observedAt: origin,
            validUntil: end,
          };
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.invitation.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceOnboardingInvitationSource>[0]) => {
      const g = guarded("Invitation", o);
      return {
        async hold() {
          await g.enter();
          if (o.access.kind === "AuthorizationTransaction")
            await o.access.hold(o.transaction, {
              authorizationTransactionReference: authorization.transactionReference,
              observedAt: origin,
              validUntil: end,
            });
          events.push("OriginalInvitation");
          return evidence;
        },
        async handoffAccepted(value: identity.WorkforceInvitation) {
          events.push("OwnAcceptHandoff");
          return { ...evidence, invitation: value };
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.plan.mockReturnValue({
    async read() {
      events.push("PlanRead");
      return {
        plan: controls.wrongPlan ? { ...plan.plan, reasonCode: "DIFFERENT" } : plan.plan,
        planDigest: plan.planDigest,
      };
    },
  });
  ports.approval.mockReturnValue({
    async withApproval(
      _expected: unknown,
      work: (lease: {
        approval: object;
        validUntil: string;
        assertCurrent(): Promise<void>;
        assertFinalized(): void;
      }) => Promise<unknown>,
    ) {
      events.push("SignedApproval");
      return work({
        approval: {
          ...plan.approvalExpected,
          approvedByReference: controls.wrongApprover ? id(99) : id(4),
          approvalEvidenceReference: controls.wrongEvidence ? id(99) : id(5),
        },
        validUntil: businessEnd,
        async assertCurrent() {
          events.push("ApprovalCurrent");
          if (controls.denied) throw new Error("CONTROLLED_APPROVAL_WITHDRAWN");
        },
        assertFinalized() {
          events.push("ApprovalSeal");
        },
      });
    },
  });
  ports.tenant.mockReturnValue({
    async getBrand() {
      events.push("ActualBrand");
      return brand;
    },
  });
  ports.pending.mockImplementation(() => ({
    async findMemberships() {
      events.push("ActualPendingReceipt");
      return [pending];
    },
  }));
  ports.relationship.mockImplementation(
    (o: Parameters<typeof membership.createFileCurrentWorkforceRelationshipSource>[0]) => {
      const g = guarded("Relationship", o);
      return {
        async hold() {
          await g.enter();
          await o.authority.hold(o.transaction, {
            expected: o.expected,
            observedAt: origin,
            validUntil: end,
          });
          return {
            profile: "CurrentWorkforceRelationshipQualificationV1",
            ...o.expected,
            issuerReference: id(26),
            revision: 2,
            relationshipEffectiveFrom: origin,
            relationshipEffectiveUntil: businessEnd,
            verifiedAt: origin,
            observedAt: origin,
            validUntil: end,
          };
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  const policy = {
    approvedPolicyDigest: plan.approvedMembership.approvedPolicyDigest,
    contentDigest: plan.approvedMembership.approvedPolicyDigest,
    policySnapshotReference: id(16),
    policyVersion: 1,
    observedAt: origin,
    validUntil: end,
  };
  ports.policy.mockImplementation(
    (o: Parameters<typeof permission.createPostgresApprovedWorkforcePolicyStore>[0]) => {
      const g = guarded("Policy", o);
      return {
        async holdApproved() {
          await g.enter();
          events.push("BrandFence");
          await o.authority.hold(o.transaction, {
            request: {
              profile: "HoldApprovedWorkforcePolicyV1",
              approval: plan.approvedMembership,
              policy: plan.plan.policy,
            },
            purposeCode: "WORKFORCE_ONBOARDING",
            requestDigest: `sha256:${"a".repeat(64)}`,
            observedAt: origin,
            validUntil: end,
          });
          return policy;
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.consume.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceInvitationStore>[0]) => {
      const g = guarded("Consume", o);
      return {
        async consumeInvitation(wanted: identity.WorkforceInvitationConsumeRequest) {
          await g.enter();
          await o.authority.hold(o.transaction, {
            binding: o.binding,
            requestDigest: `sha256:${"a".repeat(64)}`,
            observedAt: origin,
            validUntil: end,
          });
          database.invitation = "Accepted";
          events.push("ConsumeInvitation");
          const actualActorReference = actor.actorReference;
          if (actualActorReference === null) throw new Error("CONTROLLED_ACTOR_REQUIRED");
          await o.appendAudit(o.transaction, {
            operation: "InvitationAccepted",
            actorReference: actualActorReference,
            targetActorReference: actualActorReference,
            purposeCode: identity.parsePurposeCode("WORKFORCE_ONBOARDING"),
            correlationId: identity.parseCorrelationReference(o.binding.correlationReference),
            idempotencyKey: identity.parseIdempotencyReference(o.binding.operationReference),
            occurredAt: identity.parseCanonicalInstant(origin),
            resultCount: 1,
          });
          return identity.createWorkforceInvitation({
            ...invitation,
            status: "Accepted",
            version: 2,
            consumedAt: origin,
            providerEvidenceReference: wanted.providerEvidenceReference,
          });
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.binding.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceAccountBindingAcceptanceWriter>[0]) => {
      const g = guarded("Binding", o);
      return {
        async accept(value: unknown) {
          await g.enter();
          const parsed = identity.parseWorkforceAccountBindingAcceptanceCommand(value),
            original = identity.workforceAccountBindingAcceptanceOriginal(
              parsed,
              identity.parseSelectorHash("a".repeat(64)),
            );
          await o.authority.hold(o.transaction, {
            configuration: o.configuration,
            command: parsed,
            subjectHash: original.subjectHash,
            intentDigest: identity.workforceAccountBindingIntent(
              o.configuration,
              original,
              identity.workforceAccountBindingCodec,
            ),
            observedAt: origin,
            validUntil: end,
          });
          database.binding = true;
          events.push("AcceptanceBinding");
          return identity.buildWorkforceAccountBinding(
            {
              profile: "WorkforceAccountBindingV1",
              actorReference: parsed.actorReference,
              configuration: o.configuration,
              subjectHash: original.subjectHash,
              encryptedSubject: {
                ...envelope,
                encryptionContext: identity.workforceAccountSubjectContext(
                  o.configuration,
                  parsed.actorReference,
                ),
              },
              invitationReference: parsed.invitationReference,
              originalMembershipReference: parsed.originalMembershipReference,
              providerEvidenceReference: parsed.providerEvidenceReference,
              operationReference: parsed.operationReference,
              intentDigest: identity.workforceAccountBindingIntent(
                o.configuration,
                original,
                identity.workforceAccountBindingCodec,
              ),
              originalCommand: original,
              recordedByReference: parsed.recordedByReference,
              approvedByReference: parsed.approvedByReference,
              approvalEvidenceReference: parsed.approvalEvidenceReference,
              reasonCode: parsed.reasonCode,
              auditReference: id(35),
              recordedAt: origin,
              classification: "RestrictedSecurity",
            },
            identity.workforceAccountBindingCodec,
          );
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.account.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceAuthenticationSource>[0]) => {
      const g = guarded("Account", o);
      return {
        async currentActor(actual: object) {
          expect(actual).toBe(o.transaction);
          await g.enter();
          if (!database.binding || database.invitation !== "Accepted")
            throw new Error("CONTROLLED_ACCOUNT_ABSENT");
          events.push("CurrentAccount");
          return identity.createIdentityActor({
            ...actor,
            verificationLevel: "SingleFactor",
            recentMfaAt: null,
          });
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  ports.member.mockImplementation(
    (o: Parameters<typeof membership.createPostgresApprovedWorkforceMembershipStore>[0]) => {
      const g = guarded("Member", o);
      return {
        async activateApproved(value: unknown) {
          await g.enter();
          const request = membership.parseActivateApprovedMembership(value),
            facts = await o.authority.hold(o.transaction, {
              request,
              requestDigest: `sha256:${"a".repeat(64)}`,
              observedAt: origin,
              validUntil: end,
            });
          expect(facts.activation?.pendingMembership).toBe(pending);
          expect(facts.activation?.account).not.toHaveProperty("authenticatedAt");
          expect(facts.activation?.binding.originalCommand.profile).toBe(
            "WorkforceAccountBindingAcceptanceV1",
          );
          database.member = "Active";
          events.push("ActivateMember");
        },
        assertFinalized: g.assertFinalized,
      };
    },
  );
  const afterSession = vi.fn();
  ports.session.mockImplementation(
    (o: Parameters<typeof identity.createPostgresWorkforceBrowserSessionStore>[0]) => ({
      async createSession() {
        return o.transactions.run(async (actual) => {
          await o.currentActor(
            actual,
            id(7),
            identity.parseCanonicalInstant(origin),
            identity.parseCanonicalInstant(origin),
          );
          if (controls.failSession) throw new Error("CONTROLLED_SESSION_FAILURE");
          database.session = true;
          events.push("CreateStrongSession");
          afterSession();
          if (controls.lateWithdrawal) controls.providerDisabled = true;
          return sessionRecord;
        });
      },
    }),
  );
  ports.audit.mockResolvedValue(undefined);
  ports.platformAudit.mockResolvedValue(undefined);
  const tx = {
    async query<Row = Record<string, unknown>>() {
      const rows: Row[] = [];
      return { rows, rowCount: 0 };
    },
  };
  const transactions = {
    async run<T>(work: (actual: typeof tx) => Promise<T>): Promise<T> {
      entered = true;
      const before = { ...database };
      events.push("BEGIN");
      try {
        const result = await work(tx);
        if (controls.failCommit) throw new Error("CONTROLLED_COMMIT_FAILURE");
        events.push("COMMIT");
        return result;
      } catch {
        Object.assign(database, before);
        events.push("ROLLBACK");
        throw new Error("CONTROLLED_ROLLBACK");
      }
    },
  };
  const options = {
    transactions,
    configuration: { ...configuration },
    clock,
    hasher: {
      hash: () => identity.parseSelectorHash("a".repeat(64)),
      equals: (a: string, b: string) => a === b,
    },
    envelopes: {
      async encrypt() {
        return envelope;
      },
      async decrypt() {
        return "controlled-subject";
      },
    },
    nextReference: vi.fn(() => {
      allocations++;
      return id(100 + allocations);
    }),
    environmentReference: id(1),
    files: {
      planPath: "/controlled/plan.json",
      approvalPath: "/controlled/approval.json",
      approvalTrustPath: "/controlled/trust.json",
      relationshipPath: "/controlled/relationship.json",
      relationshipTrustPath: "/controlled/relationship-trust.json",
    },
    acceptanceRoleName: "controlled_acceptance",
    allowedPostLoginPaths: ["/app/organization/brands"],
  };
  const source = createCognitoWorkforceOnboardingBrowser(options);
  return {
    source,
    options,
    controls,
    events,
    database,
    binding,
    evidence,
    authorization,
    request,
    command,
    totp,
    proof,
    exchangeWire,
    afterSession,
    allocations: () => allocations,
    entered: () => entered,
    move(value: string) {
      at = value;
    },
    exchange: () => source.exchangeCode({ request, authorization, binding }),
    complete: (auth = authorization) =>
      source.complete({
        command,
        authorization: auth,
        binding,
        totp,
        providerObservedAt: origin,
        providerValidUntil: end,
      }),
  };
}
beforeEach(() => {
  for (const port of Object.values(ports)) port.mockReset();
});
describe("fixed actual-owner Workforce invitation composition", () => {
  it("constructs lazily without clock, SQL, Provider or allocation", () => {
    const f = fixture();
    expect(f.entered()).toBe(false);
    expect(f.events).toEqual([]);
    expect(f.allocations()).toBe(0);
    expect(f.options.clock.now).not.toHaveBeenCalled();
  });
  it("resolves only the invitation capability through a guarded readonly transaction", async () => {
    const f = fixture(),
      result = await f.source.resolveInvitation({
        secret: identity.parseRawBrowserCredential("s".repeat(43)),
        observedAt: origin,
        validUntil: end,
      });
    expect(result).toEqual({ binding: f.binding, observedAt: origin, validUntil: end });
    expect(f.events).toContain("COMMIT");
    expect(f.allocations()).toBe(0);
    expect(f.exchangeWire).not.toHaveBeenCalled();
  });
  it("checks consumed encrypted authorization before protocol and keeps its proof unsealed until the shared business COMMIT", async () => {
    const f = fixture();
    await f.exchange();
    expect(f.events.indexOf("ConsumedAuthorization")).toBeLessThan(
      f.events.indexOf("SignedExchange"),
    );
    expect(f.events).not.toContain("ProviderSeal");
    await expect(f.complete()).resolves.toHaveProperty(
      "session.sessionReference",
      f.command.sessionReference,
    );
    expect(f.database).toEqual({
      invitation: "Accepted",
      binding: true,
      member: "Active",
      session: true,
    });
    const ordered = [
      "BrandFence",
      "ActualPendingReceipt",
      "ConsumeInvitation",
      "OwnAcceptHandoff",
      "AcceptanceBinding",
      "ActivateMember",
      "CreateStrongSession",
      "ProviderSeal",
    ];
    for (let n = 1; n < ordered.length; n++) {
      const before = ordered[n - 1],
        after = ordered[n];
      if (!before || !after) throw new Error("CONTROLLED_EVENT_REQUIRED");
      expect(f.events.indexOf(before)).toBeLessThan(f.events.indexOf(after));
    }
    expect(f.events.lastIndexOf("ProviderSeal")).toBeLessThan(f.events.lastIndexOf("COMMIT"));
    expect(f.events.filter((e) => e === "ActualPendingReceipt")).toHaveLength(1);
    // Three explicit proof refreshes: readonly exchange, business admission,
    // last async pre-COMMIT. Initial protocol status and account-owner checks
    // are independent mandatory checks and are outside this port count.
    expect(f.events.filter((e) => e === "ProviderCurrent")).toHaveLength(3);
    await expect(f.complete()).rejects.toThrow();
  });
  it("refuses forged nonce before actual code exchange", async () => {
    const f = fixture();
    f.controls.wrongAuthNonce = true;
    await expect(f.exchange()).rejects.toThrow();
    expect(f.events).not.toContain("SignedExchange");
    expect(f.allocations()).toBe(0);
  });
  it("does not exchange the same consumed authorization concurrently", async () => {
    const f = fixture();
    let release: (() => void) | undefined, reached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
    f.exchangeWire.mockImplementation(async () => {
      reached?.();
      await gate;
      return f.proof;
    });
    const first = f.exchange();
    await entered;
    await expect(f.exchange()).rejects.toThrow();
    if (!release) throw new Error("CONTROLLED_RELEASE_REQUIRED");
    release();
    await first;
    expect(f.exchangeWire).toHaveBeenCalledTimes(1);
  });
  it.each(["wrongPlan", "wrongApprover", "wrongEvidence"] as const)(
    "rejects %s before any business transaction or allocation",
    async (failure) => {
      const f = fixture();
      await f.exchange();
      const begins = f.events.filter((e) => e === "BEGIN").length;
      f.controls[failure] = true;
      await expect(f.complete()).rejects.toThrow();
      expect(f.events.filter((e) => e === "BEGIN")).toHaveLength(begins);
      expect(f.allocations()).toBe(0);
    },
  );
  it("requires the exact consumed object, signed Actor/TOTP and original binding rather than a copied receipt", async () => {
    const f = fixture();
    await f.exchange();
    await expect(f.complete({ ...f.authorization })).rejects.toThrow();
    await expect(
      f.source.complete({
        command: f.command,
        authorization: f.authorization,
        binding: f.binding,
        totp: { ...f.totp, evidenceReference: id(99) },
        providerObservedAt: origin,
        providerValidUntil: end,
      }),
    ).rejects.toThrow();
    expect(f.allocations()).toBe(0);
    await expect(f.complete()).rejects.toThrow();
  });
  it.each(["failSession", "failCommit"] as const)(
    "rolls back invitation, binding, Member and Session on %s without fallback",
    async (failure) => {
      const f = fixture();
      await f.exchange();
      f.controls[failure] = true;
      await expect(f.complete()).rejects.toThrow();
      expect(f.database).toEqual({
        invitation: "Pending",
        binding: false,
        member: "PendingActivation",
        session: false,
      });
      expect(f.events).toContain("ROLLBACK");
      await expect(f.complete()).rejects.toThrow();
    },
  );
  it("rejects expired original proof and mutable captured configuration without renewing its window", async () => {
    const f = fixture();
    await f.exchange();
    f.move(end);
    await expect(f.complete()).rejects.toThrow();
    expect(f.allocations()).toBe(0);
    const g = fixture();
    await g.exchange();
    g.options.configuration.clientId = "different";
    await expect(g.complete()).rejects.toThrow();
    expect(g.allocations()).toBe(0);
  });
  it("rejects late authority withdrawal after all writes during owning guards and leaves no partial acceptance", async () => {
    const f = fixture();
    await f.exchange();
    f.controls.lateWithdrawal = true;
    await expect(f.complete()).rejects.toThrow();
    expect(f.events).toContain("CreateStrongSession");
    expect(f.database).toEqual({
      invitation: "Pending",
      binding: false,
      member: "PendingActivation",
      session: false,
    });
  });
  it.each(["expiry", "port"])(
    "rolls back all writes when original %s changes immediately before guards",
    async (kind) => {
      const f = fixture();
      await f.exchange();
      f.afterSession.mockImplementation(() => {
        if (kind === "expiry") f.move(end);
        else
          Object.defineProperty(f.options.hasher, "hash", {
            value: () => identity.parseSelectorHash("b".repeat(64)),
          });
      });
      await expect(f.complete()).rejects.toThrow();
      expect(f.events).toContain("CreateStrongSession");
      expect(f.database).toEqual({
        invitation: "Pending",
        binding: false,
        member: "PendingActivation",
        session: false,
      });
    },
  );
});
