import { expect, it, vi } from "vitest";
import {
  buildWorkforceAccountBinding,
  createIdentityActor,
  parseCanonicalInstant,
  parseCurrentWorkforceAccount,
  parseEvidenceReference,
  parseInvitationReference,
  parseMembershipEvidenceReference,
  parseSecurityVersion,
  parseSelectorHash,
  parseWorkforceAccountBindingAcceptanceOriginal,
  parseWorkforceAccountBindingOriginal,
  workforceAccountBindingCodec,
  workforceAccountBindingIntent,
  workforceAccountSubjectContext,
} from "@bop/identity";
import { createBrand } from "@bop/tenant";
import {
  createApprovedPendingWorkforceMembership,
  parseMembershipInstant,
} from "../domain/membership.js";
import { parseApprovedWorkforceMembership } from "../contracts/approved-workforce-membership.js";
import {
  createPostgresApprovedWorkforceMembershipStore,
  hashApprovedWorkforceMembershipRequest,
  type ApprovedWorkforceMembershipAuthority,
  type ApprovedWorkforceMembershipStoreOptions,
} from "../infrastructure/persistence/approved-workforce-membership-store.js";

// Controlled SQL/current-authority/Audit ports exercise the owning transaction
// protocol. They are not PostgreSQL, Provider or end-to-end onboarding evidence.
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  pendingAt = "2026-10-06T09:00:00.000Z",
  invitedAt = "2026-10-06T09:01:00.000Z",
  acceptedAt = "2026-10-06T09:59:59.000Z",
  end = "2026-10-07T10:00:00.000Z",
  lease = "2026-10-06T10:00:05.000Z";
function fixture(activate = false) {
  const approval = parseApprovedWorkforceMembership({
    profile: "ApprovedWorkforceMembershipV1",
    operationReference: id(1),
    planDigest: `sha256:${"a".repeat(64)}`,
    operatorReference: id(2),
    approvedByReference: id(3),
    approvalEvidenceReference: id(4),
    environmentReference: id(18),
    brandReference: id(5),
    membershipReference: id(6),
    actorReference: id(7),
    workforceRelationshipReference: id(8),
    relationshipEvidenceReference: id(9),
    relationshipRevision: 1,
    effectiveFrom: pendingAt,
    effectiveUntil: end,
    approvedPolicyDigest: `sha256:${"b".repeat(64)}`,
  });
  const request = activate
    ? {
        profile: "ActivateApprovedMembershipV1",
        operationReference: id(10),
        approval,
        expectedVersion: 1,
        pendingCreatedAt: pendingAt,
        invitationReference: id(11),
      }
    : { profile: "CreateApprovedPendingMembershipV1", approval };
  const original = createApprovedPendingWorkforceMembership(
    {
      membershipReference: id(6),
      actorReference: id(7),
      brandReference: id(5),
      workforceRelationshipReference: id(8),
      lifecycle: "PendingActivation",
      effectiveFrom: pendingAt,
      effectiveUntil: end,
      version: 1,
      createdAt: pendingAt,
      updatedAt: pendingAt,
    },
    id(7),
  );
  const configuration = {
    environment: "test",
    issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Test",
    clientIds: ["clientA"],
  };
  const bindingOriginal = parseWorkforceAccountBindingAcceptanceOriginal({
    profile: "WorkforceAccountBindingAcceptanceV1",
    operationReference: id(12),
    actorReference: id(7),
    invitationReference: id(11),
    originalMembershipReference: id(6),
    providerEvidenceReference: id(13),
    recordedByReference: id(7),
    approvedByReference: id(3),
    approvalEvidenceReference: id(4),
    reasonCode: "APPROVED_ONBOARDING",
    subjectHash: parseSelectorHash("a".repeat(64)),
  });
  const binding = buildWorkforceAccountBinding(
    {
      profile: "WorkforceAccountBindingV1",
      actorReference: id(7),
      configuration,
      subjectHash: bindingOriginal.subjectHash,
      encryptedSubject: {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic-key",
        ciphertext: "A".repeat(80),
        encryptionContext: workforceAccountSubjectContext(configuration, id(7)),
      },
      invitationReference: id(11),
      originalMembershipReference: id(6),
      providerEvidenceReference: id(13),
      operationReference: id(12),
      intentDigest: workforceAccountBindingIntent(
        configuration,
        bindingOriginal,
        workforceAccountBindingCodec,
      ),
      originalCommand: bindingOriginal,
      recordedByReference: id(7),
      approvedByReference: id(3),
      approvalEvidenceReference: id(4),
      reasonCode: bindingOriginal.reasonCode,
      auditReference: id(14),
      recordedAt: acceptedAt,
      classification: "RestrictedSecurity",
    },
    workforceAccountBindingCodec,
  );
  const authority: ApprovedWorkforceMembershipAuthority = {
    requestDigest: hashApprovedWorkforceMembershipRequest(request),
    approval,
    brand: createBrand({
      brandReference: id(5),
      code: "SYNTHETIC",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt: pendingAt,
      updatedAt: pendingAt,
    }),
    operator: createIdentityActor({
      actorType: "User",
      actorReference: activate ? id(7) : id(2),
      accountKind: activate ? "Workforce" : "Platform",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: acceptedAt,
      recentMfaAt: acceptedAt,
    }),
    relationship: {
      profile: "CurrentWorkforceRelationshipQualificationV1",
      environmentReference: id(18),
      actorReference: id(7),
      brandReference: id(5),
      workforceRelationshipReference: id(8),
      relationshipEvidenceReference: id(9),
      issuerReference: id(15),
      revision: 1,
      relationshipEffectiveFrom: pendingAt,
      relationshipEffectiveUntil: end,
      verifiedAt: pendingAt,
      observedAt: at,
      validUntil: lease,
    },
    activation: activate
      ? {
          pendingMembership: original,
          invitation: {
            profile: "CurrentWorkforceInvitationEvidenceV1",
            invitationReference: parseInvitationReference(id(11)),
            actorReference: id(7),
            originalMembershipReference: parseMembershipEvidenceReference(id(6)),
            providerEvidenceReference: parseEvidenceReference(id(13)),
            status: "Accepted",
            version: parseSecurityVersion(2),
            createdAt: parseCanonicalInstant(invitedAt),
            expiresAt: parseCanonicalInstant("2026-10-07T09:01:00.000Z"),
            consumedAt: parseCanonicalInstant(acceptedAt),
            observedAt: parseCanonicalInstant(at),
            validUntil: parseCanonicalInstant(lease),
          },
          account: parseCurrentWorkforceAccount({
            profile: "CurrentWorkforceAccountV1",
            actorType: "User",
            actorReference: id(7),
            accountKind: "Workforce",
            status: "Active",
            observedAt: at,
            validUntil: lease,
          }),
          binding,
          policy: {
            approvedPolicyDigest: approval.approvedPolicyDigest,
            contentDigest: approval.approvedPolicyDigest,
            policySnapshotReference: id(16),
            policyVersion: 1,
            observedAt: at,
            validUntil: lease,
          },
        }
      : null,
    observedAt: at,
    validUntil: lease,
  };
  const stored: Record<string, unknown>[] = activate
    ? [
        {
          membership_id: id(6),
          actor_id: id(7),
          brand_id: id(5),
          workforce_relationship_reference: id(8),
          lifecycle: "PendingActivation",
          effective_from: pendingAt,
          effective_until: end,
          version: 1,
          created_at: pendingAt,
          updated_at: pendingAt,
          precise: true,
        },
      ]
    : [];
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    audits: unknown[] = [];
  const state = {
    now: at,
    failAuthority: false,
    failAudit: false,
    failSql: false,
    transactionId: "123",
    isolation: "read committed",
    autoCommit: false,
    txReads: 0,
    refuseWrite: false,
    mapAuthority: (
      packet: ApprovedWorkforceMembershipAuthority,
    ): ApprovedWorkforceMembershipAuthority => packet,
    afterQuery: null as ((sql: string) => void) | null,
    onHold: null as (() => Promise<void>) | null,
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const tx = {
    async query(sql: string, values: readonly unknown[]) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      if (state.failSql) throw Error("synthetic private database detail");
      if (sql.startsWith("SELECT current_setting")) {
        state.txReads++;
        return {
          rows: [
            {
              isolation: state.isolation,
              transaction_id: state.autoCommit ? String(state.txReads) : state.transactionId,
            },
          ],
        };
      }
      if (sql.startsWith("INSERT")) {
        if (state.refuseWrite) return { rows: [] };
        stored.push({
          membership_id: values[0],
          actor_id: values[1],
          brand_id: values[2],
          workforce_relationship_reference: values[3],
          lifecycle: "PendingActivation",
          effective_from: values[4],
          effective_until: values[5],
          version: 1,
          created_at: values[6],
          updated_at: values[6],
          precise: true,
        });
        state.afterQuery?.(sql);
        return { rows: [{ membership_id: values[0] }] };
      }
      if (sql.startsWith("UPDATE")) {
        const row = stored[0];
        if (!row || state.refuseWrite) return { rows: [] };
        row.lifecycle = "Active";
        row.version = 2;
        row.updated_at = values[3];
        state.afterQuery?.(sql);
        return { rows: [{ membership_id: values[0] }] };
      }
      state.afterQuery?.(sql);
      return {
        rows: sql.includes("FROM bop_membership.membership") ? stored.map((r) => ({ ...r })) : [],
      };
    },
  };
  const hold = vi.fn<ApprovedWorkforceMembershipStoreOptions["authority"]["hold"]>(
    async (actual, input) => {
      expect(actual).toBe(tx);
      expect(input.request).toEqual(request);
      expect(input.requestDigest).toBe(hashApprovedWorkforceMembershipRequest(request));
      if (state.failAuthority) throw Error("synthetic approval withdrawn");
      await state.onHold?.();
      return state.mapAuthority({ ...authority, observedAt: input.observedAt });
    },
  );
  const appendAudit = vi.fn<ApprovedWorkforceMembershipStoreOptions["appendAudit"]>(
    async (actual, input) => {
      expect(actual).toBe(tx);
      if (state.failAudit) throw Error("synthetic private Audit detail");
      audits.push(input);
    },
  );
  const options: ApprovedWorkforceMembershipStoreOptions = {
    transaction: tx,
    clock: { now: () => state.now },
    originalObservedAt: at,
    originalValidUntil: lease,
    auditReference: id(17),
    authority: { hold },
    appendAudit,
    async registerBeforeCommit(actual, check, seal) {
      expect(actual).toBe(tx);
      guard = check;
      final = seal;
    },
  };
  const source = createPostgresApprovedWorkforceMembershipStore(options);
  return {
    request,
    approval,
    original,
    authority,
    state,
    calls,
    audits,
    stored,
    tx,
    hold,
    appendAudit,
    options,
    source,
    execute: () => (activate ? source.activateApproved(request) : source.createPending(request)),
    async guard() {
      if (!guard) throw Error("missing actual host registration");
      await guard();
    },
    final() {
      if (!final) throw Error("missing actual host seal");
      final();
    },
    async host(work: () => Promise<unknown>, beforeGuard = () => undefined) {
      const before = structuredClone(stored),
        beforeAudits = [...audits];
      try {
        const result = await work();
        beforeGuard();
        if (!guard || !final) throw Error("missing host guards");
        await guard();
        final();
        return result;
      } catch (error) {
        stored.splice(0, stored.length, ...before);
        audits.splice(0, audits.length, ...beforeAudits);
        throw error;
      }
    },
  };
}
it("creates approved Pending under current Brand/relationship authority and seals actual rows before commit", async () => {
  const f = fixture(),
    result = await f.host(f.execute);
  expect(result).toMatchObject({
    membership: { lifecycle: "PendingActivation", version: 1, createdAt: at },
    occurredAt: at,
  });
  expect(f.audits[0]).toMatchObject({
    actorReference: id(2),
    targetActorReference: id(7),
    beforeVersion: 0,
    afterVersion: 1,
  });
  expect(
    f.calls.filter((c) => c.sql.startsWith("SELECT current_setting")).length,
  ).toBeGreaterThanOrEqual(2);
  expect(f.calls.findIndex((c) => c.sql.startsWith("INSERT"))).toBeGreaterThan(1);
  expect(
    f.calls.every(
      (c) =>
        !c.sql.includes("bop_identity.") &&
        !c.sql.includes("bop_permission.") &&
        !c.sql.includes("store_assignment"),
    ),
  ).toBe(true);
  const calls = f.calls.length;
  f.state.now = end;
  f.source.assertFinalized();
  expect(f.calls.length).toBe(calls);
});
it("activates only the exact Pending v1 using the intended Actor, first binding, original invitation and approved policy", async () => {
  const f = fixture(true),
    result = await f.host(f.execute);
  expect(result).toMatchObject({
    membership: { lifecycle: "Active", version: 2, createdAt: pendingAt, updatedAt: at },
  });
  expect(f.audits[0]).toMatchObject({
    operationReference: id(10),
    originalOperationReference: id(1),
    actorReference: id(7),
    targetActorReference: id(7),
    beforeVersion: 1,
    afterVersion: 2,
  });
  f.source.assertFinalized();
  expect(f.hold).toHaveBeenCalledTimes(2);
});
it("does not accept accidental autocommit and produces zero writes or Audit", async () => {
  const f = fixture();
  f.state.autoCommit = true;
  await expect(f.execute()).rejects.toThrow("membership input is invalid");
  expect(f.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  expect(f.appendAudit).not.toHaveBeenCalled();
  await expect(f.guard()).rejects.toThrow();
});
it("rejects a coherently hashed Import binding in place of actual first acceptance", async () => {
  const f = fixture(true);
  f.state.mapAuthority = (p) => {
    const a = p.activation;
    if (!a) throw Error("missing controlled activation");
    const originalCommand = parseWorkforceAccountBindingOriginal({
      ...a.binding.originalCommand,
      profile: "WorkforceAccountBindingImportV1",
    });
    const { sourceDigest, ...body } = a.binding;
    void sourceDigest;
    const binding = buildWorkforceAccountBinding(
      {
        ...body,
        originalCommand,
        intentDigest: workforceAccountBindingIntent(
          body.configuration,
          originalCommand,
          workforceAccountBindingCodec,
        ),
      },
      workforceAccountBindingCodec,
    );
    return { ...p, activation: { ...a, binding } };
  };
  await expect(f.execute()).rejects.toThrow();
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
it("registers a poison guard before parsing and cannot commit a caught malformed request", async () => {
  const f = fixture();
  await expect(
    f.host(async () => {
      await expect(f.source.createPending({ ...f.request, permission: "Allow" })).rejects.toThrow();
    }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(f.audits).toHaveLength(0);
});
it.each([
  "approval",
  "relationship",
  "operator",
  "policy",
  "invitation",
  "binding",
  "original",
  "brand",
])("refuses mismatched current %s before mutation", async (field) => {
  const f = fixture(true);
  f.state.mapAuthority = (p) => {
    const activation = p.activation;
    if (!activation) throw Error("missing controlled activation");
    if (field === "approval")
      return { ...p, approval: { ...p.approval, planDigest: `sha256:${"c".repeat(64)}` } };
    if (field === "relationship") return { ...p, relationship: { ...p.relationship, revision: 2 } };
    if (field === "operator")
      return { ...p, operator: createIdentityActor({ ...p.operator, actorReference: id(2) }) };
    if (field === "policy")
      return {
        ...p,
        activation: {
          ...activation,
          policy: { ...activation.policy, contentDigest: `sha256:${"c".repeat(64)}` },
        },
      };
    if (field === "invitation")
      return {
        ...p,
        activation: {
          ...activation,
          invitation: {
            ...activation.invitation,
            originalMembershipReference: parseMembershipEvidenceReference(id(99)),
          },
        },
      };
    if (field === "binding")
      return {
        ...p,
        activation: {
          ...activation,
          binding: { ...activation.binding, sourceDigest: `sha256:${"c".repeat(64)}` },
        },
      };
    if (field === "original")
      return {
        ...p,
        activation: {
          ...activation,
          pendingMembership: {
            ...activation.pendingMembership,
            createdAt: parseMembershipInstant(invitedAt),
            updatedAt: parseMembershipInstant(invitedAt),
          },
        },
      };
    return { ...p, brand: createBrand({ ...p.brand, lifecycle: "Suspended" }) };
  };
  await expect(f.execute()).rejects.toThrow();
  expect(f.calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
});
it.each([
  "earlyMfa",
  "singleFactor",
  "lateMfa",
  "futureInvitation",
  "wrongWindow",
  "expiredAccount",
])("refuses invalid actual acceptance/MFA time %s", async (kind) => {
  const f = fixture(true);
  f.state.mapAuthority = (p) => {
    const a = p.activation;
    if (!a) throw Error("missing controlled activation");
    if (kind === "earlyMfa")
      return {
        ...p,
        operator: createIdentityActor({
          ...p.operator,
          authenticatedAt: pendingAt,
          recentMfaAt: pendingAt,
        }),
      };
    if (kind === "singleFactor")
      return {
        ...p,
        operator: createIdentityActor({
          ...p.operator,
          verificationLevel: "SingleFactor",
          recentMfaAt: null,
        }),
      };
    if (kind === "lateMfa")
      return {
        ...p,
        operator: createIdentityActor({ ...p.operator, authenticatedAt: end, recentMfaAt: end }),
      };
    if (kind === "futureInvitation")
      return {
        ...p,
        activation: {
          ...a,
          invitation: { ...a.invitation, consumedAt: parseCanonicalInstant(end) },
        },
      };
    if (kind === "wrongWindow")
      return {
        ...p,
        activation: {
          ...a,
          invitation: { ...a.invitation, expiresAt: parseCanonicalInstant(end) },
        },
      };
    return {
      ...p,
      activation: { ...a, account: { ...a.account, validUntil: parseCanonicalInstant(at) } },
    };
  };
  await expect(f.execute()).rejects.toThrow();
  expect(f.appendAudit).not.toHaveBeenCalled();
});
it.each(["missing", "duplicate", "active", "changedPeriod", "subMillisecond", "noCas"])(
  "refuses wrong persisted Pending/CAS %s",
  async (kind) => {
    const f = fixture(true),
      row = f.stored[0];
    if (!row) throw Error("missing controlled row");
    if (kind === "missing") f.stored.splice(0);
    if (kind === "duplicate") f.stored.push({ ...row, membership_id: id(99) });
    if (kind === "active") {
      row.lifecycle = "Active";
      row.version = 2;
    }
    if (kind === "changedPeriod") row.effective_until = "2026-10-08T10:00:00.000Z";
    if (kind === "subMillisecond") row.precise = false;
    if (kind === "noCas") f.state.refuseWrite = true;
    await expect(f.execute()).rejects.toThrow();
    expect(f.appendAudit).not.toHaveBeenCalled();
  },
);
it.each(["authority", "clock", "policy", "row", "transaction", "queryPort"])(
  "rolls back actual staged mutation when final %s changes",
  async (kind) => {
    const f = fixture(true);
    await expect(
      f.host(f.execute, () => {
        if (kind === "authority") f.state.failAuthority = true;
        if (kind === "clock") f.state.now = lease;
        if (kind === "policy")
          f.state.mapAuthority = (p) => {
            if (!p.activation) throw Error("missing activation");
            return {
              ...p,
              activation: { ...p.activation, policy: { ...p.activation.policy, policyVersion: 2 } },
            };
          };
        if (kind === "row") {
          const row = f.stored[0];
          if (row) row.version = 3;
        }
        if (kind === "transaction") f.state.transactionId = "456";
        if (kind === "queryPort") f.tx.query = async () => ({ rows: [] });
      }),
    ).rejects.toThrow();
    expect(f.stored[0]).toMatchObject({ lifecycle: "PendingActivation", version: 1 });
    expect(f.audits).toHaveLength(0);
    expect(() => f.source.assertFinalized()).toThrow();
  },
);
it("poisons caught reentry, Audit failure and a second invocation instead of reporting replay success", async () => {
  const f = fixture();
  f.state.onHold = async () => {
    await expect(f.source.createPending(f.request)).rejects.toThrow();
  };
  await expect(f.host(f.execute)).rejects.toThrow();
  expect(f.stored).toHaveLength(0);
  const g = fixture();
  g.state.failAudit = true;
  await expect(g.host(g.execute)).rejects.toThrow();
  expect(g.stored).toHaveLength(0);
  const h = fixture();
  await h.execute();
  await expect(h.execute()).rejects.toThrow();
  await expect(h.guard()).rejects.toThrow();
});
it("uses the shortest immutable original deadline and rejects expiry between async guard and synchronous final", async () => {
  const f = fixture();
  f.state.mapAuthority = (p) => ({ ...p, validUntil: "2026-10-06T10:00:02.000Z" });
  await f.execute();
  await f.guard();
  f.state.now = "2026-10-06T10:00:02.000Z";
  expect(() => f.final()).toThrow();
  expect(() => f.source.assertFinalized()).toThrow();
});
