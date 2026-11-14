import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createAuthenticationSession,
  createIdentityActor,
  parsePlatformSessionMfa,
  sessionPolicies,
} from "@bop/identity";
import {
  buildPlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  platformPermissionIntentDigest,
  type PlatformPermissionIdentityObservation,
} from "../contracts/platform-permission.js";
import {
  createPostgresPlatformPermissionSource,
  type PlatformPermissionSourceOptions,
  type PlatformPermissionTransaction,
} from "../infrastructure/persistence/platform-permission-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  until = "2026-10-06T13:00:00.000Z";
function fixture() {
  let time = at,
    withdrawn = false,
    missing = false,
    coherent = true;
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const c = parsePlatformPermissionProvisionCommand({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(2),
    expectedHead: null,
    content: {
      roleCode: "PlatformAdministrator",
      effectiveFrom: at,
      effectiveUntil: until,
      entries: [
        {
          evidenceReference: id(3),
          action: "platform.operate",
          effect: "Allow",
          effectiveFrom: at,
          effectiveUntil: until,
        },
        {
          evidenceReference: id(4),
          action: "platform.brand-template.manage",
          effect: "Allow",
          effectiveFrom: at,
          effectiveUntil: until,
        },
      ],
    },
    recordedByReference: id(5),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    reasonCode: "APPROVED_PROVISIONING",
  });
  let policy = buildPlatformPermissionPolicy({
    profile: "PlatformPermissionPolicyV1",
    actorReference: id(1),
    purposeCode: c.purposeCode,
    policyReference: id(8),
    revision: 1,
    supersedesPolicyReference: null,
    content: c.content,
    operationReference: c.operationReference,
    intentDigest: platformPermissionIntentDigest(c),
    originalCommand: c,
    recordedByReference: c.recordedByReference,
    approvedByReference: c.approvedByReference,
    approvalEvidenceReference: c.approvalEvidenceReference,
    reasonCode: c.reasonCode,
    auditReference: id(9),
    recordedAt: at,
    classification: "RestrictedSecurity",
  });
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Platform",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const session = createAuthenticationSession({
    sessionReference: id(11),
    actor,
    status: "Active",
    policyCode: "Privileged",
    maxActiveSessions: sessionPolicies.Privileged.maxActiveSessions,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 480,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: "2026-10-06T12:15:00.000Z",
    absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
    rotatedFromSessionReference: null,
    revokedAt: null,
    revocationReason: null,
  });
  let observation: PlatformPermissionIdentityObservation = {
    session,
    recentMfa: parsePlatformSessionMfa({
      sessionReference: id(11),
      actorReference: id(1),
      method: "Totp",
      evidenceReference: id(12),
      authorizationTransactionReference: id(13),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-10-06T12:15:00.000Z",
    }),
    observedAt: at,
    validUntil: deadline,
  };
  const tx: PlatformPermissionTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("AS isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.includes("JOIN bop_permission.platform_permission_policy_revision"))
        return {
          rows: missing
            ? []
            : [
                {
                  snapshot_text: canonicalizeRfc8785(policy),
                  source_digest: policy.sourceDigest,
                  coherent,
                },
              ],
        };
      return { rows: [] };
    },
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const options: PlatformPermissionSourceOptions = {
    transaction: tx,
    scope: { kind: "Platform", actorReference: id(1), purposeCode: c.purposeCode },
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    currentIdentity: async (actual) => {
      expect(actual).toBe(tx);
      if (withdrawn) throw new Error("PRIVATE_SESSION_REVOKED");
      return observation;
    },
    registerBeforeCommit: async (actual, g, f) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  };
  const source = createPostgresPlatformPermissionSource(options);
  return {
    source,
    options,
    tx,
    calls,
    setTime: (v: string) => {
      time = v;
    },
    withdraw: () => {
      withdrawn = true;
    },
    missing: () => {
      missing = true;
    },
    badTuple: () => {
      coherent = false;
    },
    setIdentity: (v: PlatformPermissionIdentityObservation) => {
      observation = v;
    },
    observation,
    replacePolicy: () => {
      const changed = parsePlatformPermissionProvisionCommand({
        ...c,
        content: { ...c.content, entries: [] },
      });
      const { sourceDigest: oldDigest, ...previous } = policy;
      expect(oldDigest).toBe(policy.sourceDigest);
      policy = buildPlatformPermissionPolicy({
        ...previous,
        content: changed.content,
        originalCommand: changed,
        intentDigest: platformPermissionIntentDigest(changed),
      });
    },
    finish: async () => {
      if (!guard || !final) throw new Error("missing final guards");
      await guard();
      final();
      source.assertFinalized();
    },
    runGuard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    runFinal: () => {
      if (!final) throw new Error("missing final");
      final();
    },
  };
}
describe("held Platform Permission source", () => {
  it("reads actual sameTX Session and exact policy, then seals before COMMIT", async () => {
    const f = fixture();
    const result = await f.source.authorize({ action: "platform.brand-template.manage" });
    expect(result.validUntil).toBe(deadline);
    expect(result.scope.actorReference).toBe(id(1));
    expect(f.calls.some((c) => c.sql.includes("platform_permission_policy_hold"))).toBe(true);
    await f.finish();
    const count = f.calls.length;
    f.setTime(until);
    f.source.assertFinalized();
    expect(f.calls).toHaveLength(count);
  });
  it("defaults missing policy/exact action to deny", async () => {
    const a = fixture();
    a.missing();
    await expect(
      a.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toMatchObject({ code: "PLATFORM_PERMISSION_DENIED" });
    const b = fixture();
    await expect(
      b.source.authorize({ action: "platform.brand-template.publish" }),
    ).rejects.toMatchObject({ code: "PLATFORM_PERMISSION_DENIED" });
  });
  it("refuses current Session withdrawal and legitimate rehashed policy drift before COMMIT", async () => {
    for (const revoke of [true, false]) {
      const f = fixture();
      await f.source.authorize({ action: "platform.brand-template.manage" });
      if (revoke) f.withdraw();
      else f.replacePolicy();
      await expect(f.runGuard()).rejects.toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    }
  });
  it("refuses final lease expiry after an async guard without postCOMMIT time reversal", async () => {
    const f = fixture();
    await f.source.authorize({ action: "platform.brand-template.manage" });
    await f.runGuard();
    f.setTime(deadline);
    expect(() => f.runFinal()).toThrow();
  });
  it("refuses mismatched SQL tuples, crossActor/MFA proof and query drift", async () => {
    const a = fixture();
    a.badTuple();
    await expect(
      a.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toThrow();
    const b = fixture();
    b.setIdentity({
      ...b.observation,
      recentMfa: { ...b.observation.recentMfa, actorReference: id(99) },
    });
    await expect(
      b.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toThrow();
    const c = fixture();
    c.tx.query = async () => ({ rows: [] });
    await expect(
      c.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toThrow();
    expect(c.calls).toHaveLength(0);
  });
  it("poisons reentry and refuses authorization after the final seal", async () => {
    const f = fixture();
    const pending = f.source.authorize({ action: "platform.brand-template.manage" });
    await expect(
      f.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toThrow();
    await expect(pending).rejects.toThrow();
    const g = fixture();
    await g.source.authorize({ action: "platform.brand-template.manage" });
    await g.finish();
    await expect(
      g.source.authorize({ action: "platform.brand-template.manage" }),
    ).rejects.toThrow();
  });
});
