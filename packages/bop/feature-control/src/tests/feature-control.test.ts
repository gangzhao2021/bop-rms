import type { AppendAuditRecordInput } from "@bop/audit";
import {
  evaluatePermission,
  parseBusinessAction,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";
import {
  createFeatureControlDefinition,
  createRecoveryValidationEvidence,
  evaluateFeatureControl,
  executeFeatureControlMutation,
  FeatureControlContractError,
  FeatureControlServiceError,
  parseFeatureControlInstant,
  parseFeatureControlKey,
  parseFeatureControlPurposeCode,
  parseFeatureControlReference,
  parseFeatureControlVersion,
  parseRolloutBucket,
  type FeatureControlAuthorizationRequest,
  type FeatureControlDefinition,
  type FeatureControlMutationPorts,
  type KillSwitchDefinition,
  type RecoveryValidationEvidence,
} from "../index.js";

const ids = {
  actor: "018f0000-0000-7000-8000-000000000001",
  brand: "018f0000-0000-7000-8000-000000000002",
  storeA: "018f0000-0000-7000-8000-000000000003",
  storeB: "018f0000-0000-7000-8000-000000000004",
  otherBrand: "018f0000-0000-7000-8000-000000000005",
  owner: "018f0000-0000-7000-8000-000000000006",
  brandControl: "018f0000-0000-7000-8000-000000000007",
  storeControl: "018f0000-0000-7000-8000-000000000008",
  killControl: "018f0000-0000-7000-8000-000000000009",
  policy: "018f0000-0000-7000-8000-00000000000a",
  evidence: "018f0000-0000-7000-8000-00000000000b",
  audit: "018f0000-0000-7000-8000-00000000000c",
  correlation: "018f0000-0000-7000-8000-00000000000d",
} as const;

const at = parseFeatureControlInstant("2026-07-29T14:00:00.000Z");
const until = parseFeatureControlInstant("2026-08-29T14:00:00.000Z");
const review = parseFeatureControlInstant("2026-08-01T14:00:00.000Z");
const key = parseFeatureControlKey("ordering.checkout.release");

function context(storeReference: string | null = ids.storeA, brandReference: string = ids.brand) {
  const actor = {
    actorType: "User" as const,
    accountKind: "Workforce" as const,
    actorReference: ids.actor,
    status: "Active" as const,
    authenticationMethod: "Oidc" as const,
    verificationLevel: "SingleFactor" as const,
    authenticatedAt: at,
    recentMfaAt: null,
  };
  const brand = createBrand({
    brandReference,
    code: brandReference === ids.brand ? "BRAND_A" : "BRAND_B",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store =
    storeReference === null
      ? null
      : createStore({
          storeReference,
          brandReference,
          code: storeReference === ids.storeA ? "STORE_A" : "STORE_B",
          displayName: "Synthetic Store",
          timeZone: "America/Toronto",
          locale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: at,
          updatedAt: at,
        });
  return createTenantContext(actor as never, brand, store, at);
}

function release(overrides: Partial<Record<string, unknown>> = {}): FeatureControlDefinition {
  return createFeatureControlDefinition({
    controlId: ids.brandControl,
    key,
    version: 1,
    ownerReference: ids.owner,
    purposeCode: "CHECKOUT_RELEASE",
    scope: {
      kind: "Brand",
      brandReference: ids.brand,
      storeReference: null,
    },
    effectiveFrom: at,
    effectiveUntil: until,
    reviewAt: review,
    expiresAt: until,
    kind: "ReleaseFlag",
    defaultEnabled: false,
    state: "Enabled",
    rolloutBasisPoints: 5_000,
    ...overrides,
  });
}

function kill(overrides: Partial<Record<string, unknown>> = {}): KillSwitchDefinition {
  return createFeatureControlDefinition({
    controlId: ids.killControl,
    key,
    version: 1,
    ownerReference: ids.owner,
    purposeCode: "CHECKOUT_SAFETY",
    scope: {
      kind: "Store",
      brandReference: ids.brand,
      storeReference: ids.storeA,
    },
    effectiveFrom: at,
    effectiveUntil: until,
    reviewAt: review,
    expiresAt: until,
    kind: "KillSwitch",
    defaultActive: false,
    mode: "SafePause",
    inFlightPolicy: "ReachSafeCheckpoint",
    recoveryPolicy: "Progressive",
    recoveryStages: [2_500, 5_000, 10_000],
    state: { phase: "Active" },
    ...overrides,
  }) as KillSwitchDefinition;
}

function evaluate(
  definitions: readonly FeatureControlDefinition[],
  rolloutBucket = 0,
  tenantContext = context(),
) {
  return evaluateFeatureControl({
    tenantContext,
    key,
    definitions,
    rolloutBucket: parseRolloutBucket(rolloutBucket),
    evaluatedAt: at,
  });
}

function allowDecision(request: FeatureControlAuthorizationRequest): PermissionDecision {
  const actorReference = request.tenantContext.actor.actorReference;
  if (actorReference === null) throw new Error("synthetic Workforce Actor reference missing");
  return evaluatePermission({
    tenantContext: request.tenantContext,
    action: request.action,
    resourceScope: request.resourceScope,
    policySnapshotReference: parsePolicyReference(ids.policy),
    policyVersion: parsePolicyVersion(1),
    evidence: [
      {
        source: "ExplicitAllow",
        evidenceReference: parseEvidenceReference(ids.evidence),
        action: request.action,
        actorReference,
        roleReference: null,
        brandReference: request.resourceScope.brandReference,
        storeReference: request.resourceScope.storeReference,
        effectiveFrom: at,
        effectiveUntil: until,
      },
    ],
  });
}

function ports(
  decision: (request: FeatureControlAuthorizationRequest) => PermissionDecision = allowDecision,
) {
  const commits: {
    current: FeatureControlDefinition;
    next: FeatureControlDefinition;
    audit: AppendAuditRecordInput;
  }[] = [];
  const value: FeatureControlMutationPorts = {
    authorization: {
      authorize: vi.fn(async (request) => decision(request)),
    },
    unitOfWork: {
      commit: vi.fn(async (input) => {
        commits.push(input);
      }),
    },
  };
  return { value, commits };
}

function mutation(
  current: FeatureControlDefinition,
  next: FeatureControlDefinition,
  operation: "Change" | "Activate" | "BeginRecovery" | "CompleteRecovery",
  recoveryEvidence?: RecoveryValidationEvidence,
) {
  return {
    tenantContext:
      current.scope.kind === "Brand" ? context(null) : context(current.scope.storeReference),
    operation,
    expectedVersion: parseFeatureControlVersion(current.version),
    current,
    next,
    ...(recoveryEvidence === undefined ? {} : { recoveryEvidence }),
    auditId: parseFeatureControlReference(ids.audit),
    correlationId: parseFeatureControlReference(ids.correlation),
    sourceChannel: parseFeatureControlPurposeCode("MERCHANT_WEB"),
  };
}

function recovery(
  current: KillSwitchDefinition,
  targetBasisPoints: number,
): RecoveryValidationEvidence {
  return createRecoveryValidationEvidence({
    controlId: current.controlId,
    controlVersion: current.version,
    scope: current.scope,
    result: "Pass",
    checkedAt: at,
    validUntil: "2026-07-29T14:05:00.000Z",
    checkCodes: ["DEPENDENCY_HEALTHY", "OPERATOR_CONFIRMED"],
    targetBasisPoints,
  });
}

describe("WP-0120 Feature Control contract", () => {
  it("creates strict closed immutable definitions", () => {
    const definition = release();
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.scope)).toBe(true);
    expect(() => release({ extra: true })).toThrow(FeatureControlContractError);
    expect(() => release({ key: "checkout" })).toThrow(FeatureControlContractError);
    expect(() => release({ version: 0 })).toThrow(FeatureControlContractError);
    expect(() => release({ ownerReference: "person@example.test" })).toThrow(
      FeatureControlContractError,
    );
    expect(() =>
      release({
        reviewAt: "2026-09-01T14:00:00.000Z",
        expiresAt: until,
      }),
    ).toThrow(FeatureControlContractError);
    expect(() => kill({ recoveryStages: [0, 10_000] })).toThrow(FeatureControlContractError);
    expect(() =>
      kill({
        recoveryPolicy: "Manual",
        recoveryStages: [],
        state: { phase: "Recovering", rolloutBasisPoints: 2_500 },
      }),
    ).toThrow(FeatureControlContractError);
  });

  it("uses explicit default and deterministic rollout boundaries", () => {
    expect(evaluate([release({ state: "Default", defaultEnabled: false })]).reason).toBe(
      "RELEASE_DISABLED",
    );
    expect(evaluate([release()], 4_999).backendExecution).toBe("Allow");
    expect(evaluate([release()], 5_000).backendExecution).toBe("Deny");
    expect(evaluate([release()], 4_999)).toEqual(evaluate([release()], 4_999));
  });

  it("gives an exact Store definition precedence only inside its Brand and Store", () => {
    const store = release({
      controlId: ids.storeControl,
      version: 1,
      scope: {
        kind: "Store",
        brandReference: ids.brand,
        storeReference: ids.storeA,
      },
      state: "Disabled",
      rolloutBasisPoints: 10_000,
    });
    expect(evaluate([release({ rolloutBasisPoints: 10_000 }), store]).reason).toBe(
      "RELEASE_DISABLED",
    );
    expect(
      evaluate([release({ rolloutBasisPoints: 10_000 }), store], 0, context(ids.storeB)).reason,
    ).toBe("RELEASE_ENABLED");
    expect(evaluate([store], 0, context(ids.storeA, ids.otherBrand)).reason).toBe(
      "CONTROL_UNAVAILABLE",
    );
  });

  it("fails closed for mutable, malformed, expired and ambiguous candidates", () => {
    const mutable = { ...release() } as FeatureControlDefinition;
    expect(evaluate([mutable]).reason).toBe("CONTROL_UNAVAILABLE");
    expect(evaluate([release(), release({ controlId: ids.storeControl, version: 2 })]).reason).toBe(
      "CONTROL_UNAVAILABLE",
    );
    expect(
      evaluate([
        release({
          effectiveFrom: "2026-07-01T14:00:00.000Z",
          effectiveUntil: "2026-07-29T13:59:59.000Z",
        }),
      ]).reason,
    ).toBe("CONTROL_UNAVAILABLE");
  });

  it("blocks new work for every active Kill Switch mode without exposing identifiers in record", () => {
    for (const mode of ["BlockNew", "SafePause", "Terminate"] as const) {
      const result = evaluate([kill({ mode })]);
      expect(result.backendExecution).toBe("Deny");
      expect(result.frontendVisibility).toBe("Hide");
      expect(result.reason).toBe("KILL_ACTIVE");
      expect(result.killMode).toBe(mode);
      expect(result.inFlightPolicy).toBe("ReachSafeCheckpoint");
      expect(JSON.stringify(result.record)).not.toContain(ids.actor);
      expect(JSON.stringify(result.record)).not.toContain(ids.brand);
      expect(JSON.stringify(result.record)).not.toContain(ids.killControl);
    }
  });

  it("supports deterministic bounded progressive recovery", () => {
    const recovering = kill({
      state: { phase: "Recovering", rolloutBasisPoints: 2_500 },
    });
    expect(evaluate([recovering], 2_499).reason).toBe("KILL_RECOVERY_ALLOWED");
    expect(evaluate([recovering], 2_500).reason).toBe("KILL_RECOVERY_BLOCKED");
  });

  it("uses the explicit inactive Kill Switch default without granting through a frontend hint", () => {
    const result = evaluate([kill({ defaultActive: false, state: { phase: "Default" } })]);
    expect(result.reason).toBe("KILL_INACTIVE");
    expect(result.backendExecution).toBe("Allow");
    expect(result.frontendVisibility).toBe("Show");
    expect(result.record.backendExecution).toBe(result.backendExecution);
  });

  it("activates a Kill Switch only through the exact scoped mutation path", async () => {
    const current = kill({ state: { phase: "Inactive" } });
    const next = kill({ version: 2, state: { phase: "Active" } });
    const adapter = ports();
    await executeFeatureControlMutation(mutation(current, next, "Activate"), adapter.value);
    expect(adapter.commits).toHaveLength(1);
    expect(adapter.commits.at(0)?.audit.actionCode).toBe("FEATURE_CONTROL_ACTIVATED");
  });

  it("requires exact Permission and atomically supplies state plus bounded Audit", async () => {
    const current = release({ rolloutBasisPoints: 10_000 });
    const next = release({
      version: 2,
      state: "Disabled",
      rolloutBasisPoints: 10_000,
    });
    const adapter = ports();
    const result = await executeFeatureControlMutation(
      mutation(current, next, "Change"),
      adapter.value,
    );
    expect(result.control).toStrictEqual(next);
    expect(adapter.commits).toHaveLength(1);
    const commit = adapter.commits.at(0);
    expect(commit).toBeDefined();
    if (commit === undefined) throw new Error("synthetic commit missing");
    expect(commit.current).toStrictEqual(current);
    expect(commit.next).toStrictEqual(next);
    expect(commit.audit.actionCode).toBe("FEATURE_CONTROL_CHANGED");
    expect(commit.audit).not.toHaveProperty("token");
  });

  it("rejects denied, mutable and mismatched Permission decisions without committing", async () => {
    const current = release();
    const next = release({ version: 2, state: "Disabled" });
    const denied = ports((request) =>
      evaluatePermission({
        tenantContext: request.tenantContext,
        action: request.action,
        resourceScope: request.resourceScope,
        policySnapshotReference: parsePolicyReference(ids.policy),
        policyVersion: parsePolicyVersion(1),
        evidence: [],
      }),
    );
    await expect(
      executeFeatureControlMutation(mutation(current, next, "Change"), denied.value),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_PERMISSION_DENIED" });
    expect(denied.commits).toHaveLength(0);

    const storeContext = context();
    if (storeContext.store === null) throw new Error("synthetic Store context missing");
    const storeReference = storeContext.store.storeReference;
    const forged = ports(
      () =>
        ({
          ...allowDecision({
            tenantContext: storeContext,
            action: parseBusinessAction("feature.control.change"),
            resourceScope: {
              kind: "Store",
              brandReference: storeContext.brand.brandReference,
              storeReference,
            },
            controlId: current.controlId,
            expectedVersion: current.version,
          }),
        }) as PermissionDecision,
    );
    await expect(
      executeFeatureControlMutation(mutation(current, next, "Change"), forged.value),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_PERMISSION_DENIED" });
    expect(forged.commits).toHaveLength(0);
  });

  it("denies cross-scope mutation before Permission or commit", async () => {
    const current = release();
    const next = release({ version: 2, state: "Disabled" });
    const adapter = ports();
    await expect(
      executeFeatureControlMutation(
        { ...mutation(current, next, "Change"), tenantContext: context() },
        adapter.value,
      ),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_MUTATION_INVALID" });
    expect(adapter.value.authorization.authorize).not.toHaveBeenCalled();
    expect(adapter.commits).toHaveLength(0);
  });

  it("rejects unknown mutation fields before Permission or commit", async () => {
    const current = release();
    const next = release({ version: 2, state: "Disabled" });
    const adapter = ports();
    await expect(
      executeFeatureControlMutation(
        {
          ...mutation(current, next, "Change"),
          unexpected: true,
        } as unknown as Parameters<typeof executeFeatureControlMutation>[0],
        adapter.value,
      ),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_MUTATION_INVALID" });
    expect(adapter.value.authorization.authorize).not.toHaveBeenCalled();
    expect(adapter.commits).toHaveLength(0);
  });

  it("validates each progressive recovery stage against exact scope and version", async () => {
    const current = kill();
    const next = kill({
      version: 2,
      state: { phase: "Recovering", rolloutBasisPoints: 2_500 },
    });
    const adapter = ports();
    await executeFeatureControlMutation(
      mutation(current, next, "BeginRecovery", recovery(current, 2_500)),
      adapter.value,
    );
    expect(adapter.commits).toHaveLength(1);

    const stale = recovery(current, 2_500);
    const bad = createRecoveryValidationEvidence({
      ...stale,
      controlVersion: 2,
    });
    const denied = ports();
    await expect(
      executeFeatureControlMutation(mutation(current, next, "BeginRecovery", bad), denied.value),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_RECOVERY_DENIED" });
    expect(denied.commits).toHaveLength(0);

    const skipped = kill({
      version: 2,
      state: { phase: "Recovering", rolloutBasisPoints: 5_000 },
    });
    await expect(
      executeFeatureControlMutation(
        mutation(current, skipped, "BeginRecovery", recovery(current, 5_000)),
        denied.value,
      ),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_RECOVERY_DENIED" });
    expect(denied.commits).toHaveLength(0);
  });

  it("requires the 10000-basis-point recovery checkpoint before completion", async () => {
    const current = kill({
      state: { phase: "Recovering", rolloutBasisPoints: 10_000 },
    });
    const next = kill({ version: 2, state: { phase: "Inactive" } });
    const adapter = ports();
    await executeFeatureControlMutation(
      mutation(current, next, "CompleteRecovery", recovery(current, 10_000)),
      adapter.value,
    );
    expect(adapter.commits).toHaveLength(1);
  });

  it("fails closed when the atomic unit of work rejects", async () => {
    const current = release();
    const next = release({ version: 2, state: "Disabled" });
    const adapter = ports();
    adapter.value.unitOfWork.commit = vi.fn(async () => {
      throw new Error("synthetic commit failure");
    });
    await expect(
      executeFeatureControlMutation(mutation(current, next, "Change"), adapter.value),
    ).rejects.toBeInstanceOf(FeatureControlServiceError);
    await expect(
      executeFeatureControlMutation(mutation(current, next, "Change"), adapter.value),
    ).rejects.toMatchObject({ code: "FEATURE_CONTROL_COMMIT_FAILED" });
  });
});
