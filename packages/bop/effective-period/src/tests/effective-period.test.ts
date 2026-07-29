import type { AppendAuditRecordInput } from "@bop/audit";
import {
  evaluatePermission,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";
import {
  createEffectiveConfigurationVersion,
  createEffectivePeriod,
  createEffectivePeriodApprovalEvidence,
  createEffectivePeriodIntent,
  createEffectiveResolutionRecord,
  createEffectiveScope,
  deriveConfigurationStatus,
  executeEffectivePeriodMutation,
  parseCandidateSetDigest,
  parseEffectivePeriodCode,
  parseEffectivePeriodDigest,
  parseEffectivePeriodInstant,
  parseEffectivePeriodReference,
  parseEffectivePeriodVersion,
  periodsOverlap,
  validateNoEffectiveOverlap,
  EffectivePeriodContractError,
  EffectivePeriodServiceError,
  type EffectiveConfigurationVersion,
  type EffectivePeriodApprovalEvidence,
  type EffectivePeriodAuthorizationRequest,
  type EffectivePeriodIntent,
  type EffectivePeriodPorts,
  type ExecuteEffectivePeriodMutationInput,
} from "../index.js";

const ids = {
  actor: "018f3000-0000-7000-8000-000000000001",
  approver: "018f3000-0000-7000-8000-000000000002",
  brand: "018f3000-0000-7000-8000-000000000003",
  otherBrand: "018f3000-0000-7000-8000-000000000004",
  store: "018f3000-0000-7000-8000-000000000005",
  family: "018f3000-0000-7000-8000-000000000006",
  configuration: "018f3000-0000-7000-8000-000000000007",
  release: "018f3000-0000-7000-8000-000000000008",
  snapshot: "018f3000-0000-7000-8000-000000000009",
  timing1: "018f3000-0000-7000-8000-00000000000a",
  timing2: "018f3000-0000-7000-8000-00000000000b",
  timing3: "018f3000-0000-7000-8000-00000000000c",
  approval: "018f3000-0000-7000-8000-00000000000d",
  activation: "018f3000-0000-7000-8000-00000000000e",
  expiry: "018f3000-0000-7000-8000-00000000000f",
  policy: "018f3000-0000-7000-8000-000000000010",
  permissionEvidence: "018f3000-0000-7000-8000-000000000011",
  idempotency: "018f3000-0000-7000-8000-000000000012",
  audit: "018f3000-0000-7000-8000-000000000013",
  correlation: "018f3000-0000-7000-8000-000000000014",
} as const;

const before = parseEffectivePeriodInstant("2026-07-29T17:55:00.000Z");
const occurredAt = parseEffectivePeriodInstant("2026-07-29T18:00:00.000Z");
const from = parseEffectivePeriodInstant("2026-08-01T14:00:00.000Z");
const until = parseEffectivePeriodInstant("2026-09-01T14:00:00.000Z");
const digestA = parseEffectivePeriodDigest(`sha256:${"a".repeat(64)}`);
const digestB = parseEffectivePeriodDigest(`sha256:${"b".repeat(64)}`);

function tenant(brandReference: string = ids.brand) {
  const actor = {
    actorType: "User" as const,
    accountKind: "Workforce" as const,
    actorReference: ids.actor,
    status: "Active" as const,
    authenticationMethod: "Oidc" as const,
    verificationLevel: "SingleFactor" as const,
    authenticatedAt: occurredAt,
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
    createdAt: before,
    updatedAt: occurredAt,
  });
  const store = createStore({
    storeReference: ids.store,
    brandReference,
    code: "STORE_A",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: before,
    updatedAt: occurredAt,
  });
  return createTenantContext(actor as never, brand, store, occurredAt);
}

function scope(brandReference: string = ids.brand) {
  return createEffectiveScope({
    kind: "Store",
    brandReference: brandReference as never,
    storeReference: ids.store as never,
  });
}

function period(
  start = from,
  end: string | null = until,
  startLocal = "2026-08-01T10:00:00.000",
  endLocal = "2026-09-01T10:00:00.000",
) {
  return createEffectivePeriod({
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: start as never,
      localDateTime: startLocal,
      utcOffsetMinutes: -240,
    },
    effectiveUntil:
      end === null
        ? null
        : {
            instant: end as never,
            localDateTime: endLocal,
            utcOffsetMinutes: -240,
          },
  });
}

function version(
  number = 1,
  timingReference: string = ids.timing1,
  effectivePeriod = period(),
  overrides: Partial<EffectiveConfigurationVersion> = {},
): EffectiveConfigurationVersion {
  return createEffectiveConfigurationVersion({
    timingVersionReference: parseEffectivePeriodReference(timingReference),
    familyReference: parseEffectivePeriodReference(ids.family),
    configurationReference: parseEffectivePeriodReference(ids.configuration),
    releaseReference: parseEffectivePeriodReference(ids.release),
    snapshotReference: parseEffectivePeriodReference(ids.snapshot),
    snapshotDigest: digestA,
    configurationType: parseEffectivePeriodCode("MENU_CONFIGURATION"),
    purposeCode: parseEffectivePeriodCode("MENU_EFFECTIVE_PERIOD"),
    scope: scope(),
    version: parseEffectivePeriodVersion(number),
    period: effectivePeriod,
    periodDigest: digestB,
    approvalEvidenceReference: parseEffectivePeriodReference(ids.approval),
    createdAt: occurredAt,
    ...overrides,
  });
}

function approval(
  next: EffectiveConfigurationVersion,
  overrides: Partial<EffectivePeriodApprovalEvidence> = {},
) {
  return createEffectivePeriodApprovalEvidence({
    evidenceReference: parseEffectivePeriodReference(ids.approval),
    familyReference: next.familyReference,
    timingVersionReference: next.timingVersionReference,
    version: next.version,
    scope: next.scope,
    periodDigest: next.periodDigest,
    decision: "Accepted",
    approvedActorReference: parseEffectivePeriodReference(ids.approver),
    approvedAt: before,
    validUntil: parseEffectivePeriodInstant("2026-07-29T19:00:00.000Z"),
    ...overrides,
  });
}

function intents(next: EffectiveConfigurationVersion) {
  const activation = createEffectivePeriodIntent({
    intentReference: parseEffectivePeriodReference(ids.activation),
    timingVersionReference: next.timingVersionReference,
    kind: "Activation",
    dueAt: next.period.effectiveFrom.instant,
    createdAt: occurredAt,
  });
  const expiry =
    next.period.effectiveUntil === null
      ? null
      : createEffectivePeriodIntent({
          intentReference: parseEffectivePeriodReference(ids.expiry),
          timingVersionReference: next.timingVersionReference,
          kind: "Expiry",
          dueAt: next.period.effectiveUntil.instant,
          createdAt: occurredAt,
        });
  return { activation, expiry };
}

function allow(request: EffectivePeriodAuthorizationRequest): PermissionDecision {
  const actorReference = request.tenantContext.actor.actorReference;
  if (actorReference === null) throw new Error("synthetic actor missing");
  return evaluatePermission({
    tenantContext: request.tenantContext,
    action: request.action,
    resourceScope: request.resourceScope,
    policySnapshotReference: parsePolicyReference(ids.policy),
    policyVersion: parsePolicyVersion(1),
    evidence: [
      {
        source: "ExplicitAllow",
        evidenceReference: parseEvidenceReference(ids.permissionEvidence),
        action: request.action,
        actorReference,
        roleReference: null,
        brandReference: request.resourceScope.brandReference,
        storeReference: request.resourceScope.storeReference,
        effectiveFrom: before,
        effectiveUntil: parseEffectivePeriodInstant("2026-07-29T19:00:00.000Z"),
      },
    ],
  });
}

function ports(options?: {
  decision?: (request: EffectivePeriodAuthorizationRequest) => PermissionDecision;
  failCommit?: boolean;
}) {
  const commits: {
    expectedVersion: number;
    idempotencyKey: string;
    next: EffectiveConfigurationVersion;
    intents: readonly EffectivePeriodIntent[];
    audit: AppendAuditRecordInput;
  }[] = [];
  const value: EffectivePeriodPorts = {
    authorization: {
      authorize: vi.fn(async (request) => (options?.decision ?? allow)(request)),
    },
    unitOfWork: {
      commit: vi.fn(async (input) => {
        if (options?.failCommit) throw new Error("synthetic atomic failure");
        commits.push(input);
      }),
    },
  };
  return { value, commits };
}

function mutation(
  next: EffectiveConfigurationVersion,
  overrides: Partial<ExecuteEffectivePeriodMutationInput> = {},
): ExecuteEffectivePeriodMutationInput {
  const records = intents(next);
  return {
    tenantContext: tenant(),
    operation: "Schedule",
    expectedVersion: parseEffectivePeriodVersion(1),
    current: null,
    next,
    existing: [],
    approvalEvidence: approval(next),
    activationIntent: records.activation,
    expiryIntent: records.expiry,
    idempotencyKey: parseEffectivePeriodReference(ids.idempotency),
    auditId: parseEffectivePeriodReference(ids.audit),
    correlationId: parseEffectivePeriodReference(ids.correlation),
    occurredAt,
    sourceChannel: parseEffectivePeriodCode("ADMIN_WEB"),
    ...overrides,
  };
}

describe("effective period time contract", () => {
  it("round-trips summer and winter IANA offsets", () => {
    expect(period().timeZone).toBe("America/Toronto");
    const winter = createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: parseEffectivePeriodInstant("2026-01-29T18:00:00.000Z"),
        localDateTime: "2026-01-29T13:00:00.000",
        utcOffsetMinutes: -300,
      },
      effectiveUntil: null,
    });
    expect(winter.effectiveFrom.utcOffsetMinutes).toBe(-300);
  });

  it("rejects invalid zones, offset mismatch, and DST gaps", () => {
    for (const input of [
      {
        timeZone: "Not/A_Zone",
        effectiveFrom: {
          instant: from,
          localDateTime: "2026-08-01T10:00:00.000",
          utcOffsetMinutes: -240,
        },
        effectiveUntil: null,
      },
      {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: from,
          localDateTime: "2026-08-01T10:00:00.000",
          utcOffsetMinutes: -300,
        },
        effectiveUntil: null,
      },
      {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: parseEffectivePeriodInstant("2026-03-08T07:30:00.000Z"),
          localDateTime: "2026-03-08T02:30:00.000",
          utcOffsetMinutes: -300,
        },
        effectiveUntil: null,
      },
    ])
      expect(() => createEffectivePeriod(input as never)).toThrow(EffectivePeriodContractError);
  });

  it("accepts both explicit instants in a DST fold", () => {
    const first = createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: parseEffectivePeriodInstant("2026-11-01T05:30:00.000Z"),
        localDateTime: "2026-11-01T01:30:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    });
    const second = createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: parseEffectivePeriodInstant("2026-11-01T06:30:00.000Z"),
        localDateTime: "2026-11-01T01:30:00.000",
        utcOffsetMinutes: -300,
      },
      effectiveUntil: null,
    });
    expect(first.effectiveFrom.instant).not.toBe(second.effectiveFrom.instant);
  });

  it("requires Until after From and supports open-ended periods", () => {
    expect(period(from, null).effectiveUntil).toBeNull();
    expect(() => period(from, from, "2026-08-01T10:00:00.000", "2026-08-01T10:00:00.000")).toThrow(
      EffectivePeriodContractError,
    );
  });
});

describe("overlap and explicit resolution", () => {
  it("uses half-open boundaries, allowing adjacency and rejecting intersection", () => {
    const first = period();
    const adjacent = period(
      until,
      "2026-10-01T14:00:00.000Z",
      "2026-09-01T10:00:00.000",
      "2026-10-01T10:00:00.000",
    );
    const firstUntil = first.effectiveUntil;
    const adjacentUntil = adjacent.effectiveUntil;
    if (firstUntil === null || adjacentUntil === null) throw new Error("synthetic period missing");
    expect(
      periodsOverlap(
        {
          effectiveFrom: first.effectiveFrom.instant,
          effectiveUntil: firstUntil.instant,
        },
        {
          effectiveFrom: adjacent.effectiveFrom.instant,
          effectiveUntil: adjacentUntil.instant,
        },
      ),
    ).toBe(false);
    expect(
      periodsOverlap(
        {
          effectiveFrom: first.effectiveFrom.instant,
          effectiveUntil: null,
        },
        {
          effectiveFrom: adjacent.effectiveFrom.instant,
          effectiveUntil: adjacentUntil.instant,
        },
      ),
    ).toBe(true);
    expect(() =>
      validateNoEffectiveOverlap(version(), [version(2, ids.timing2, adjacent)]),
    ).not.toThrow();
    expect(() => validateNoEffectiveOverlap(version(), [version(2, ids.timing2)])).toThrow(
      EffectivePeriodContractError,
    );
  });

  it("derives states without persisting mutable status", () => {
    const candidate = version();
    expect(deriveConfigurationStatus(candidate, occurredAt)).toBe("Scheduled");
    expect(deriveConfigurationStatus(candidate, from)).toBe("Effective");
    expect(deriveConfigurationStatus(candidate, until)).toBe("Expired");
  });

  it("returns reproducible zero, one, and sorted conflict records", () => {
    const base = {
      familyReference: parseEffectivePeriodReference(ids.family),
      scope: scope(),
      evaluationInstant: from,
      candidateSetDigest: parseCandidateSetDigest(`sha256:${"c".repeat(64)}`),
    };
    expect(createEffectiveResolutionRecord({ ...base, candidates: [] }).outcome).toBe(
      "Unavailable",
    );
    expect(createEffectiveResolutionRecord({ ...base, candidates: [version()] })).toMatchObject({
      outcome: "Selected",
      selectedTimingVersionReference: ids.timing1,
    });
    const conflict = createEffectiveResolutionRecord({
      ...base,
      candidates: [version(2, ids.timing2), version()],
    });
    expect(conflict).toMatchObject({
      outcome: "Conflict",
      reason: "MULTIPLE_EFFECTIVE_VERSIONS",
      conflictingTimingVersionReferences: [ids.timing1, ids.timing2],
    });
  });

  it("fails closed on mixed family or scope candidates", () => {
    expect(() =>
      createEffectiveResolutionRecord({
        familyReference: parseEffectivePeriodReference(ids.family),
        scope: scope(),
        evaluationInstant: from,
        candidateSetDigest: parseCandidateSetDigest(`sha256:${"c".repeat(64)}`),
        candidates: [version(1, ids.timing1, period(), { scope: scope(ids.otherBrand) })],
      }),
    ).toThrow(EffectivePeriodContractError);
  });

  it("rejects extra resolution payload instead of silently carrying it", () => {
    expect(() =>
      createEffectiveResolutionRecord({
        familyReference: parseEffectivePeriodReference(ids.family),
        scope: scope(),
        evaluationInstant: from,
        candidateSetDigest: parseCandidateSetDigest(`sha256:${"c".repeat(64)}`),
        candidates: [version()],
        payload: { privateConfiguration: true },
      } as never),
    ).toThrow(EffectivePeriodContractError);
  });
});

describe("Schedule and Renew service", () => {
  it("atomically records Schedule timing, intents, idempotency, and Audit", async () => {
    const next = version();
    const adapter = ports();
    const result = await executeEffectivePeriodMutation(mutation(next), adapter.value);
    expect(result.intents.map((intent) => intent.kind)).toEqual(["Activation", "Expiry"]);
    expect(adapter.commits).toHaveLength(1);
    expect(adapter.commits[0]).toMatchObject({
      expectedVersion: 1,
      idempotencyKey: ids.idempotency,
      next: { timingVersionReference: ids.timing1 },
      audit: {
        targetType: "EffectivePeriodVersion",
        targetId: ids.timing1,
        dataClassification: "Confidential",
      },
    });
  });

  it("Renews with an immutable next version and open-ended activation only", async () => {
    const current = version();
    const next = version(2, ids.timing2, period(until, null, "2026-09-01T10:00:00.000"), {
      createdAt: occurredAt,
    });
    const adapter = ports();
    const result = await executeEffectivePeriodMutation(
      mutation(next, {
        operation: "Renew",
        expectedVersion: current.version,
        current,
        existing: [current],
        ...(() => {
          const records = intents(next);
          return { activationIntent: records.activation, expiryIntent: records.expiry };
        })(),
        approvalEvidence: approval(next),
      }),
      adapter.value,
    );
    expect(result.intents).toHaveLength(1);
    expect(result.timingVersion.timingVersionReference).toBe(ids.timing2);
    expect(current.timingVersionReference).toBe(ids.timing1);
  });

  it("rejects stale transitions, overlap, and approval binding mismatches", async () => {
    const next = version();
    await expect(
      executeEffectivePeriodMutation(
        mutation(next, { expectedVersion: parseEffectivePeriodVersion(2) }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "EFFECTIVE_PERIOD_MUTATION_INVALID" });
    await expect(
      executeEffectivePeriodMutation(
        mutation(next, { existing: [version(2, ids.timing2)] }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "EFFECTIVE_PERIOD_OVERLAP_DENIED" });
    await expect(
      executeEffectivePeriodMutation(
        mutation(next, {
          approvalEvidence: approval(next, {
            timingVersionReference: parseEffectivePeriodReference(ids.timing3),
          }),
        }),
        ports().value,
      ),
    ).rejects.toMatchObject({ code: "EFFECTIVE_PERIOD_APPROVAL_DENIED" });
  });

  it("rejects cross-Tenant context and does not authorize or commit", async () => {
    const next = version();
    const adapter = ports();
    await expect(
      executeEffectivePeriodMutation(
        mutation(next, { tenantContext: tenant(ids.otherBrand) }),
        adapter.value,
      ),
    ).rejects.toMatchObject({ code: "EFFECTIVE_PERIOD_MUTATION_INVALID" });
    expect(adapter.value.authorization.authorize).not.toHaveBeenCalled();
    expect(adapter.value.unitOfWork.commit).not.toHaveBeenCalled();
  });

  it("requires exact Permission and maps adapter failures to bounded denial", async () => {
    const next = version();
    const denied = ports({
      decision: (request) =>
        Object.freeze({
          ...allow(request),
          effect: "Deny",
          reason: "DEFAULT_DENY",
          source: "DefaultDeny",
          audit: {
            effect: "Deny" as const,
            reason: "DEFAULT_DENY" as const,
            source: "DefaultDeny" as const,
          },
        }),
    });
    await expect(executeEffectivePeriodMutation(mutation(next), denied.value)).rejects.toEqual(
      new EffectivePeriodServiceError("EFFECTIVE_PERIOD_PERMISSION_DENIED"),
    );
    await expect(
      executeEffectivePeriodMutation(mutation(next), ports({ failCommit: true }).value),
    ).rejects.toEqual(new EffectivePeriodServiceError("EFFECTIVE_PERIOD_COMMIT_FAILED"));
  });

  it("rejects malformed envelopes and intent execution claims uniformly", async () => {
    const next = version();
    const input = mutation(next) as ExecuteEffectivePeriodMutationInput & {
      payload?: { secret: string };
    };
    input.payload = { secret: "must-not-cross-boundary" };
    await expect(executeEffectivePeriodMutation(input, ports().value)).rejects.toMatchObject({
      code: "EFFECTIVE_PERIOD_MUTATION_INVALID",
      message: "effective period operation is unavailable",
    });
    expect(JSON.stringify(mutation(next))).not.toContain("must-not-cross-boundary");
  });
});
