import { mkdtemp, writeFile, rm, rename, chmod, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { hashWorkforceOnboardingPlan } from "../contracts/workforce-onboarding-plan.js";
import { createFileWorkforceOnboardingPlanSource } from "../infrastructure/workforce-onboarding-plan-files.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
function input() {
  return {
    profile: "WorkforceOnboardingPlanV1",
    purposeCode: "WORKFORCE_ONBOARDING",
    configuration: {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
    },
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
    effectiveFrom: "2026-10-06T12:00:00.000Z",
    effectiveUntil: "2026-11-06T12:00:00.000Z",
    emailDigest: "a".repeat(64),
    policy: {
      profile: "ApprovedWorkforcePolicyV1",
      brandReference: id(6),
      actorReference: id(7),
      membershipReference: id(8),
      effectiveFrom: "2026-10-06T12:00:00.000Z",
      effectiveUntil: "2026-11-06T12:00:00.000Z",
      roles: [
        {
          roleReference: id(11),
          roleCode: "invited_reviewer",
          effectiveFrom: "2026-10-01T00:00:00.000Z",
          effectiveUntil: "2026-12-01T00:00:00.000Z",
          assignment: {
            assignmentReference: id(12),
            effectiveFrom: "2026-10-06T12:00:00.000Z",
            effectiveUntil: "2026-11-06T12:00:00.000Z",
          },
          grants: [
            {
              grantReference: id(13),
              permissionReference: id(14),
              action: "publishing.review.approve",
              effectiveFrom: "2026-10-01T00:00:00.000Z",
              effectiveUntil: "2026-12-01T00:00:00.000Z",
            },
          ],
        },
      ],
    },
    expectedPolicy: { snapshotReference: id(15), version: 4 },
    policySnapshotReference: id(16),
    reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
  };
}
function expected() {
  const p = input();
  return {
    configuration: p.configuration,
    environmentReference: p.environmentReference,
    operationReference: p.operationReference,
    brandReference: p.brandReference,
    actorReference: p.actorReference,
    membershipReference: p.membershipReference,
    operatorReference: p.operatorReference,
  };
}
describe("configured private Workforce onboarding plan content", () => {
  let directory: string, planPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bop-onboarding-plan-"));
    planPath = join(directory, "plan.json");
    await writeFile(planPath, JSON.stringify(input()), { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("reopens actual private JSON and accepts equal canonical expected values and content", async () => {
    const source = createFileWorkforceOnboardingPlanSource({ planPath }),
      a = await source.read(expected());
    await writeFile(
      planPath,
      JSON.stringify(Object.fromEntries(Object.entries(input()).reverse())),
    );
    const b = await source.read(structuredClone(expected()));
    expect(b).toEqual(a);
    expect(a.planDigest).toBe(hashWorkforceOnboardingPlan(input()));
    expect(Object.isFrozen(a.plan.configuration)).toBe(true);
  });
  it("keeps actual first Owner file content in the complete digest and pins its creation material", async () => {
    const base = input(), role = base.policy.roles[0];
    if (!role) throw new Error("Controlled owner role missing");
    const first = {
      ...base, profile: "FirstOwnerCreationPlanV1", expectedPolicy: null,
      policy: { ...base.policy, roles: [{ ...role, roleCode: "owner" }] },
      creation: { brand: { brandReference: base.brandReference, code: "FIRST", displayName: "Controlled first Brand", defaultLocale: "en-CA", currencyCode: "CAD" }, brandAuditReference: id(40), membershipAuditReference: id(41), policyAuditReference: id(42) },
      operatingEntityQualification: { operatingEntityReference: id(43), entityVersion: 1, entityDigest: `sha256:${"b".repeat(64)}`, entityEvidenceReference: id(44), reviewEvidenceReference: id(45), materialDigest: `sha256:${"c".repeat(64)}` },
      corporateEmailQualification: { evidenceReference: id(46), operatingEntityReference: id(43), emailDigest: base.emailDigest, materialDigest: `sha256:${"d".repeat(64)}` },
    };
    await writeFile(planPath, JSON.stringify(first));
    const source = createFileWorkforceOnboardingPlanSource({ planPath }), packet = await source.read(expected());
    expect(packet.plan).toEqual(first);
    expect(packet.planDigest).toBe(hashWorkforceOnboardingPlan(first));
    if (packet.plan.profile !== "FirstOwnerCreationPlanV1") throw new Error("Variant missing");
    expect(Object.isFrozen(packet.plan.creation.brand)).toBe(true);
    await writeFile(planPath, JSON.stringify({ ...first, creation: { ...first.creation, brand: { ...first.creation.brand, displayName: "Replaced content" } } }));
    await expect(source.read(expected())).rejects.toThrow();
    await writeFile(planPath, JSON.stringify(first));
    await expect(source.read(expected())).rejects.toThrow();
  });
  it("observes atomic replacement with changed approved content and permanently poisons that holder", async () => {
    const source = createFileWorkforceOnboardingPlanSource({ planPath });
    await source.read(expected());
    const replacement = join(directory, "replacement.json");
    await writeFile(
      replacement,
      JSON.stringify({ ...input(), reasonCode: "CHANGED_APPROVED_REASON" }),
      { mode: 0o600 },
    );
    await rename(replacement, planPath);
    await expect(source.read(expected())).rejects.toThrow("plan is unavailable");
    await writeFile(planPath, JSON.stringify(input()));
    await expect(source.read(expected())).rejects.toThrow();
  });
  it.each([
    "environmentReference",
    "operationReference",
    "brandReference",
    "actorReference",
    "membershipReference",
    "operatorReference",
  ] as const)("refuses the wrong bound %s even on first read", async (key) => {
    await expect(
      createFileWorkforceOnboardingPlanSource({ planPath }).read({ ...expected(), [key]: id(99) }),
    ).rejects.toThrow();
  });
  it("rejects foreign configured identity and drift of the captured deployment path", async () => {
    await expect(
      createFileWorkforceOnboardingPlanSource({ planPath }).read({
        ...expected(),
        configuration: { ...expected().configuration, clientId: "foreign" },
      }),
    ).rejects.toThrow();
    const options = { planPath },
      source = createFileWorkforceOnboardingPlanSource(options);
    await source.read(expected());
    options.planPath = join(directory, "foreign.json");
    await expect(source.read(expected())).rejects.toThrow();
  });
  it("poisons a caught invalid expected preflight and does not execute its getter", async () => {
    const source = createFileWorkforceOnboardingPlanSource({ planPath });
    await source.read(expected());
    let calls = 0;
    const invalid = { ...expected() };
    Object.defineProperty(invalid, "operationReference", {
      enumerable: true,
      get: () => {
        calls++;
        return id(2);
      },
    });
    await expect(source.read(invalid)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(source.read(expected())).rejects.toThrow();
  });
  it.each(["permissions", "symlink", "hardlink", "empty", "oversized", "invalidJson", "withdrawn"])(
    "refuses unsafe/currently unavailable file %s",
    async (mode) => {
      const source = createFileWorkforceOnboardingPlanSource({ planPath });
      await source.read(expected());
      if (mode === "permissions") await chmod(planPath, 0o644);
      if (mode === "symlink") {
        const target = join(directory, "target.json");
        await rename(planPath, target);
        await symlink(target, planPath);
      }
      if (mode === "hardlink") await link(planPath, join(directory, "link.json"));
      if (mode === "empty") await writeFile(planPath, "");
      if (mode === "oversized") await writeFile(planPath, "x".repeat(65537));
      if (mode === "invalidJson") await writeFile(planPath, "{");
      if (mode === "withdrawn") await rm(planPath);
      await expect(source.read(expected())).rejects.toThrow("plan is unavailable");
    },
  );
  it("rejects concurrent reentry and keeps the pending actual file read poisoned", async () => {
    const source = createFileWorkforceOnboardingPlanSource({ planPath });
    const pending = source.read(expected());
    await expect(source.read(expected())).rejects.toThrow();
    await expect(pending).rejects.toThrow();
  });
  it("uses only explicit deployment paths and does not execute options getters", () => {
    let calls = 0;
    const options = {
      get planPath() {
        calls++;
        return planPath;
      },
    };
    expect(() => createFileWorkforceOnboardingPlanSource(options)).toThrow();
    expect(calls).toBe(0);
    expect(() => createFileWorkforceOnboardingPlanSource({ planPath: "relative.json" })).toThrow();
    const extra = { planPath, extra: true };
    expect(() => createFileWorkforceOnboardingPlanSource(extra)).toThrow();
  });
});
