import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdentityActor,
  parseCurrentWorkforceAccount,
  parseSelectorHash,
  parseRawBrowserCredential,
  type CurrentWorkforceAccount,
} from "@bop/identity";
import { createInitialBrandMembership, hashInitialBrandMembershipRequest } from "@bop/membership";
import {
  deriveBrandInitialProvisioningRequests,
  parseBrandInitialProvisioningPlan,
  hashBrandInitialPolicyRequest,
} from "@bop/permission";
import {
  createAuthenticatedBrandInitialProvisioning,
  type AuthenticatedBrandInitialProvisioningOptions,
} from "./brand-initial-provisioning.js";
const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  account: vi.fn(),
  invitation: vi.fn(),
  relationship: vi.fn(),
  tenant: vi.fn(),
  membership: vi.fn(),
  policy: vi.fn(),
  approval: vi.fn(),
}));
vi.mock("@bop/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/identity")>();
  return {
    ...actual,
    createBrandInitialProvisioningOperatorSource: mocks.operator,
    createPostgresCurrentWorkforceAccountSource: mocks.account,
    createPostgresCurrentWorkforceInvitationSource: mocks.invitation,
  };
});
vi.mock("@bop/membership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/membership")>();
  return {
    ...actual,
    createFileCurrentWorkforceRelationshipSource: mocks.relationship,
    createPostgresInitialBrandMembershipStore: mocks.membership,
  };
});
vi.mock("@bop/permission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/permission")>();
  return {
    ...actual,
    createFileBrandProvisioningApprovalSource: mocks.approval,
    createPostgresBrandInitialPolicyStore: mocks.policy,
  };
});
vi.mock("@bop/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/tenant")>();
  return { ...actual, createPostgresBrandInitialCreationStore: mocks.tenant };
});
const id = (n: number) => `018f4f8a-9c2d-7a11-8d01-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  end = "2026-10-07T12:00:00.000Z";
function plan() {
  return parseBrandInitialProvisioningPlan({
    profile: "BrandInitialProvisioningPlanV1",
    purposeCode: "BRAND_INITIAL_PROVISIONING",
    environmentReference: id(1),
    operationReference: id(2),
    operatorReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(5),
    brand: {
      brandReference: id(6),
      code: "CONTROLLED",
      displayName: "Controlled test Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
    },
    brandAuditReference: id(7),
    membershipAuditReference: id(8),
    policyAuditReference: id(9),
    policySnapshotReference: id(10),
    recipients: [
      {
        actorReference: id(11),
        membershipReference: id(12),
        workforceRelationshipReference: id(13),
        relationshipEvidenceReference: id(14),
        invitationEvidenceReference: id(15),
        membershipEffectiveUntil: end,
        roleEffectiveUntil: end,
        roleReference: id(16),
        roleCode: "initial_admin",
        assignmentReference: id(17),
        grants: [
          { grantReference: id(18), permissionReference: id(19), action: "organization.manage" },
        ],
      },
    ],
  });
}
type AccountOptions = Parameters<
  typeof import("@bop/identity").createPostgresCurrentWorkforceAccountSource
>[0];
type OperatorOptions = Parameters<
  typeof import("@bop/identity").createBrandInitialProvisioningOperatorSource
>[0];
type InvitationOptions = Parameters<
  typeof import("@bop/identity").createPostgresCurrentWorkforceInvitationSource
>[0];
type RelationshipOptions = Parameters<
  typeof import("@bop/membership").createFileCurrentWorkforceRelationshipSource
>[0];
type MemberOptions = Parameters<
  typeof import("@bop/membership").createPostgresInitialBrandMembershipStore
>[0];
type PolicyOptions = Parameters<
  typeof import("@bop/permission").createPostgresBrandInitialPolicyStore
>[0];
/** Controlled owner factory packets test composition only. Native acceptance
 * exercises actual encrypted Sessions, Directory, SQL, SDK and owner writers. */
function fixture() {
  const p = plan(),
    derived = deriveBrandInitialProvisioningRequests(p, at),
    operator = createIdentityActor({
      actorType: "User",
      actorReference: id(3),
      accountKind: "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: at,
      recentMfaAt: at,
    });
  let observed = at,
    accountActive = true,
    wrongAccount = false,
    replay = false,
    commits = 0,
    rollbacks = 0,
    memberWrites = 0,
    policyWrites = 0,
    lateWithdrawal = false;
  const accountOptions: AccountOptions[] = [],
    memberPackets: CurrentWorkforceAccount[] = [],
    events: string[] = [];
  const transactions: AuthenticatedBrandInitialProvisioningOptions["transactions"] = {
    async run(work) {
      try {
        const answer = await work({
          async query() {
            return { rows: [], rowCount: 0 };
          },
        });
        commits++;
        return answer;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  };
  const hasher = {
      hash: () => parseSelectorHash("a".repeat(64)),
      equals: (a: string, b: string) => a === b,
    },
    envelopes = {
      async encrypt(text: string, context: string) {
        void text;
        return {
          algorithm: "SYNTHETIC_AES_256_GCM" as const,
          keyReference: "controlled-key",
          ciphertext: "A".repeat(80),
          encryptionContext: context,
        };
      },
      async decrypt() {
        throw Error("controlled owner mock does not decrypt");
      },
    };
  const options: AuthenticatedBrandInitialProvisioningOptions = {
    transactions,
    clock: { now: () => observed },
    approvalFiles: { approvalPath: "/controlled/approval", trustPath: "/controlled/trust" },
    operator: {
      configuration: {
        environment: "controlled",
        issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
        clientId: "client",
        redirectUri: "https://platform.invalid/callback",
        allowedPostLoginPaths: ["/platform/templates"],
      },
      hasher,
      envelopes,
      cookie: parseRawBrowserCredential("A".repeat(43)),
    },
    workforce: {
      configuration: {
        environment: "controlled",
        issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
        clientIds: ["client"],
      },
      hasher,
      envelopes,
      relationships: {
        trustPath: "/controlled/relationship-trust",
        qualifications: [
          { actorReference: id(11), qualificationPath: "/controlled/qualification" },
        ],
      },
    },
  };
  mocks.approval.mockImplementation(() => ({
    async withApproval(expected: unknown, work: (lease: unknown) => Promise<unknown>) {
      expect(expected).toMatchObject({ operatorReference: p.operatorReference });
      return work({
        approval: {
          approvedByReference: p.approvedByReference,
          approvalEvidenceReference: p.approvalEvidenceReference,
        },
        observedAt: at,
        validUntil: until,
        async assertCurrent() {
          return undefined;
        },
        assertFinalized() {
          return undefined;
        },
      });
    },
  }));
  mocks.operator.mockImplementation((o: OperatorOptions) => {
    let registered = false;
    return {
      async hold() {
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            o.transaction,
            async () => undefined,
            () => undefined,
          );
        }
        return { actor: operator, validUntil: until };
      },
      assertFinalized() {
        return undefined;
      },
    };
  });
  mocks.account.mockImplementation((o: AccountOptions) => {
    accountOptions.push(o);
    let registered = false;
    const inspect = async () => {
      const authority = await o.authority.hold(o.transaction, {
        actorReference: o.actorReference,
        purposeCode: "BRAND_INITIAL_PROVISIONING",
        observedAt: observed,
        validUntil: o.originalValidUntil,
      });
      expect(authority.actorReference).toBe(o.actorReference);
      if (!accountActive) throw Error("withdrawn");
      return parseCurrentWorkforceAccount({
        profile: "CurrentWorkforceAccountV1",
        actorType: "User",
        actorReference: wrongAccount ? id(99) : o.actorReference,
        accountKind: "Workforce",
        status: "Active",
        observedAt: o.originalObservedAt,
        validUntil: authority.validUntil,
      });
    };
    return {
      async hold() {
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            o.transaction,
            async () => {
              await inspect();
            },
            () => undefined,
          );
        }
        events.push("account");
        return inspect();
      },
      assertFinalized() {
        return undefined;
      },
    };
  });
  mocks.invitation.mockImplementation((o: InvitationOptions) => {
    let registered = false;
    return {
      async hold() {
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            o.transaction,
            async () => undefined,
            () => undefined,
          );
        }
        const authority = await o.authority.hold(o.transaction, {
          binding: o.binding,
          observedAt: observed,
          validUntil: o.originalValidUntil,
        });
        return {
          profile: "CurrentWorkforceInvitationEvidenceV1",
          invitationReference: id(15),
          actorReference: id(11),
          originalMembershipReference: id(90),
          providerEvidenceReference: id(91),
          status: "Accepted",
          version: 2,
          createdAt: at,
          expiresAt: end,
          consumedAt: at,
          observedAt: o.originalObservedAt,
          validUntil: authority.validUntil,
        };
      },
      assertFinalized() {
        return undefined;
      },
    };
  });
  mocks.relationship.mockImplementation((o: RelationshipOptions) => {
    let registered = false;
    return {
      async hold() {
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            o.transaction,
            async () => undefined,
            () => undefined,
          );
        }
        const authority = await o.authority.hold(o.transaction, {
          expected: o.expected,
          observedAt: observed,
          validUntil: o.originalValidUntil,
        });
        return {
          ...o.expected,
          relationshipEffectiveFrom: at,
          relationshipEffectiveUntil: end,
          observedAt: o.originalObservedAt,
          validUntil: authority.validUntil,
        };
      },
      assertFinalized() {
        return undefined;
      },
    };
  });
  mocks.tenant.mockImplementation(() => ({
    async resolveOperation() {
      events.push("original");
      return replay ? derived.brandOperation : null;
    },
    async commit() {
      events.push("brand");
      return derived.brandOperation;
    },
  }));
  mocks.membership.mockImplementation((o: MemberOptions) => ({
    async initialize(request: typeof derived.membershipRequest) {
      const held = await o.authority.hold(o.transaction, {
        request,
        requestDigest: hashInitialBrandMembershipRequest(request),
        observedAt: at,
        validUntil: until,
      });
      memberPackets.push(...held.members.map((m) => m.account));
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          await o.authority.hold(o.transaction, {
            request,
            requestDigest: hashInitialBrandMembershipRequest(request),
            observedAt: at,
            validUntil: until,
          });
        },
        () => undefined,
      );
      memberWrites++;
      return {
        memberships: request.members.map((m, i) => {
          const member = held.members[i];
          if (!member) throw Error("fixture missing member");
          return createInitialBrandMembership(
            {
              membershipReference: m.membershipReference,
              actorReference: m.actorReference,
              brandReference: request.brandReference,
              lifecycle: "Active",
              version: 1,
              createdAt: at,
              updatedAt: at,
              effectiveFrom: at,
              effectiveUntil: m.effectiveUntil,
              workforceRelationshipReference: m.workforceRelationshipReference,
            },
            member.account,
            at,
          );
        }),
      };
    },
    assertFinalized() {
      return undefined;
    },
  }));
  mocks.policy.mockImplementation((o: PolicyOptions) => ({
    async initialize(request: typeof derived.policyRequest) {
      await o.authority.hold(o.transaction, {
        request,
        requestDigest: hashBrandInitialPolicyRequest(request),
        observedAt: at,
        validUntil: until,
      });
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          await o.authority.hold(o.transaction, {
            request,
            requestDigest: hashBrandInitialPolicyRequest(request),
            observedAt: at,
            validUntil: until,
          });
        },
        () => undefined,
      );
      policyWrites++;
      if (lateWithdrawal) accountActive = false;
    },
    assertFinalized() {
      return undefined;
    },
  }));
  const source = createAuthenticatedBrandInitialProvisioning(options);
  return {
    source,
    options,
    p,
    accountOptions,
    memberPackets,
    events,
    get commits() {
      return commits;
    },
    get rollbacks() {
      return rollbacks;
    },
    get memberWrites() {
      return memberWrites;
    },
    get policyWrites() {
      return policyWrites;
    },
    set now(value: string) {
      observed = value;
    },
    set accountActive(value: boolean) {
      accountActive = value;
    },
    set wrongAccount(value: boolean) {
      wrongAccount = value;
    },
    set replay(value: boolean) {
      replay = value;
    },
    set lateWithdrawal(value: boolean) {
      lateWithdrawal = value;
    },
  };
}
beforeEach(() => vi.resetAllMocks());
describe("authenticated initial Brand concrete account composition", () => {
  it("constructs one actual owning account holder per transaction and Actor, before only fresh qualifications", async () => {
    const f = fixture();
    expect(await f.source.execute(f.p)).toMatchObject({ status: "Applied" });
    expect(f.accountOptions).toHaveLength(1);
    const o = f.accountOptions[0];
    if (!o) throw Error("missing source");
    expect(o.configuration).toEqual(f.options.workforce.configuration);
    expect(o.hasher).toBe(f.options.workforce.hasher);
    expect(o.envelopes).toBe(f.options.workforce.envelopes);
    expect(o.originalObservedAt).toBe(at);
    expect(o.originalValidUntil).toBe(until);
    expect(f.events.indexOf("original")).toBeLessThan(f.events.indexOf("account"));
    expect(f.memberPackets[0]).toMatchObject({ actorReference: id(11), accountKind: "Workforce" });
    expect(f.memberPackets[0]).not.toHaveProperty("authenticatedAt");
    expect(f.commits).toBe(1);
  });
  it("returns exact original before constructing account, invitation or relationship sources", async () => {
    const f = fixture();
    f.replay = true;
    f.accountActive = false;
    expect(await f.source.execute(f.p)).toMatchObject({ status: "AlreadyApplied" });
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.invitation).not.toHaveBeenCalled();
    expect(mocks.relationship).not.toHaveBeenCalled();
    expect(f.memberWrites).toBe(0);
    expect(f.policyWrites).toBe(0);
  });
  it("rejects a mismatched returned Actor rather than mapping another account by array position", async () => {
    const f = fixture();
    f.wrongAccount = true;
    await expect(f.source.execute(f.p)).rejects.toThrow();
    expect(f.commits).toBe(0);
    expect(f.rollbacks).toBe(1);
    expect(f.memberWrites).toBe(0);
  });
  it("refuses a withdrawn current account before target grants", async () => {
    const f = fixture();
    f.accountActive = false;
    await expect(f.source.execute(f.p)).rejects.toThrow();
    expect(f.policyWrites).toBe(0);
    expect(f.commits).toBe(0);
  });
  it.each(["configuration", "hash", "decrypt"] as const)(
    "captures workforce %s and refuses drift",
    async (kind) => {
      const f = fixture();
      if (kind === "configuration")
        Object.assign(f.options.workforce.configuration, { environment: "other" });
      if (kind === "hash")
        f.options.workforce.hasher.hash = () => parseSelectorHash("b".repeat(64));
      if (kind === "decrypt") f.options.workforce.envelopes.decrypt = async () => "";
      await expect(f.source.execute(f.p)).rejects.toThrow();
      expect(mocks.account).not.toHaveBeenCalled();
      expect(f.commits).toBe(0);
    },
  );
  it("keeps the account read authority bound to the actual captured transaction and target", async () => {
    const f = fixture();
    await f.source.execute(f.p);
    const o = f.accountOptions[0];
    if (!o) throw Error("missing source");
    await expect(
      o.authority.hold(
        { query: async () => ({ rows: [] }) },
        {
          actorReference: id(11),
          purposeCode: "BRAND_INITIAL_PROVISIONING",
          observedAt: at,
          validUntil: until,
        },
      ),
    ).rejects.toThrow();
    await expect(
      o.authority.hold(o.transaction, {
        actorReference: id(99),
        purposeCode: "BRAND_INITIAL_PROVISIONING",
        observedAt: at,
        validUntil: until,
      }),
    ).rejects.toThrow();
  });
  it("rechecks the same account holder before commit and rolls back late withdrawal", async () => {
    const f = fixture();
    f.lateWithdrawal = true;
    await expect(f.source.execute(f.p)).rejects.toThrow();
    expect(f.accountOptions).toHaveLength(1);
    expect(f.memberWrites).toBe(1);
    expect(f.policyWrites).toBe(1);
    expect(f.commits).toBe(0);
    expect(f.rollbacks).toBe(1);
  });
});
