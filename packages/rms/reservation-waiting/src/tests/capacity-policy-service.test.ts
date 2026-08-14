import { describe, expect, it, vi } from "vitest";

import {
  createCapacityPolicy,
  createCapacityPolicyService,
  parseReservationReference,
  type CapacityPolicyAction,
  type CapacityPolicyOperationRecord,
  type CapacityPolicyPorts,
  type CapacityPolicyVersion,
} from "../index.js";

const id = (n: number) => `018fa600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ref = (n: number) => parseReservationReference(id(n));
const at = (day: number, hour: number) =>
  `2026-09-${day.toString().padStart(2, "0")}T${hour.toString().padStart(2, "0")}:00:00.000Z`;

function policy(overrides: Record<string, unknown> = {}) {
  return createCapacityPolicy({
    policyReference: id(1),
    versionReference: id(2),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    areaReference: id(6),
    serviceCode: "DINNER",
    timeZone: "America/Toronto",
    policyVersion: 1,
    aggregateVersion: 1,
    lifecycle: "Draft",
    effectiveFrom: at(10, 10),
    effectiveUntil: at(30, 10),
    buckets: [
      {
        bucketReference: id(10),
        dayOfWeek: 4,
        startMinute: 1020,
        endMinute: 1200,
        capacitySeats: 30,
        onlineAllocationSeats: 20,
        overbookMode: "Disabled",
        overbookAllowanceSeats: 0,
        turnTimeMinutes: 90,
      },
    ],
    closures: [],
    depositPolicyReference: null,
    depositPolicyVersion: null,
    cancellationPolicyReference: null,
    cancellationPolicyVersion: null,
    noShowPolicyReference: null,
    noShowPolicyVersion: null,
    createdByActorReference: id(7),
    createdAt: at(1, 10),
    observedAt: at(1, 10),
    ...overrides,
  });
}

function fixture(
  options: { readonly denied?: boolean; readonly initial?: CapacityPolicyVersion } = {},
) {
  let current = options.initial ?? null;
  const versions = new Map<string, CapacityPolicyVersion>();
  if (current) versions.set(current.versionReference, current);
  const operations = new Map<string, CapacityPolicyOperationRecord>();
  const reads = vi.fn();
  const publication = vi.fn();
  const ports: CapacityPolicyPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantReference: ref(3),
          brandReference: ref(4),
          storeReference: ref(5),
          actorReference: ref(7),
          purpose: "reservation-capacity-management",
          permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
          audit: {
            auditId: id(70),
            brandId: id(4),
            storeId: id(5),
            actor: { type: "User", reference: id(7) },
            actionCode: `CAPACITY_POLICY_${input.action.toUpperCase()}`,
            targetType: "CapacityPolicy",
            targetId: id(1),
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: id(71),
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
    evidence: {
      async validatePublication(candidate, observedAt) {
        publication();
        return {
          policyReference: candidate.policyReference,
          versionReference: candidate.versionReference,
          evidenceReference: ref(72),
          blockingCodes: [],
          observedAt,
        };
      },
      async resolveSimulationScenario(candidate, _request, observedAt) {
        return {
          scenarioReference: ref(73),
          versionReference: candidate.versionReference,
          occursAt: observedAt,
          dayOfWeek: 4,
          localMinute: 1080,
          channel: "Customer",
          requestedPartySize: 2,
          confirmedSeats: 10,
          heldSeats: 2,
          diningCompatibleSeats: 30,
          storeOpen: true,
          pricingPolicyEvidence: "NotRequired",
          managerOverrideReference: null,
        };
      },
    },
    references: {
      hashIntent(value) {
        let state = 2166136261;
        for (const character of value) {
          state ^= character.charCodeAt(0);
          state = Math.imul(state, 16777619);
        }
        return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
      },
    },
    repository: {
      async findOperation(reference) {
        reads();
        return operations.get(reference) ?? null;
      },
      async getCurrent(reference) {
        reads();
        return current?.policyReference === reference ? current : null;
      },
      async getVersion(reference) {
        reads();
        return versions.get(reference) ?? null;
      },
      async commit(input) {
        current = input.policy;
        versions.set(input.policy.versionReference, input.policy);
        operations.set(input.operation.operationReference, input.operation);
      },
    },
  };
  return {
    service: createCapacityPolicyService(ports),
    current: () => current,
    reads,
    publication,
  };
}

function command(
  action: Exclude<CapacityPolicyAction, "Simulate">,
  candidate: CapacityPolicyVersion,
  overrides: Record<string, unknown> = {},
) {
  return {
    action,
    operationReference: id(80),
    expectedAggregateVersion: action === "SaveDraft" ? null : candidate.aggregateVersion,
    candidate,
    revisionEvidence: null,
    observedAt: candidate.observedAt,
    ...overrides,
  };
}

describe("Capacity Policy application service", () => {
  it("authorizes before repository reads and replays an identical draft command", async () => {
    const denied = fixture({ denied: true });
    await expect(denied.service.execute(command("SaveDraft", policy()))).rejects.toThrowError(
      expect.objectContaining({ code: "CAPACITY_POLICY_PERMISSION_DENIED" }),
    );
    expect(denied.reads).not.toHaveBeenCalled();

    const allowed = fixture();
    const input = command("SaveDraft", policy());
    const first = await allowed.service.execute(input);
    await expect(allowed.service.execute(input)).resolves.toEqual(first);
    expect(allowed.current()).toMatchObject({ lifecycle: "Draft", aggregateVersion: 1 });
  });

  it("requires publication evidence and commits a scheduled version", async () => {
    const current = policy({ observedAt: at(2, 10) });
    const context = fixture({ initial: current });
    await expect(
      context.service.execute(
        command("Schedule", current, {
          operationReference: id(81),
          expectedAggregateVersion: 1,
        }),
      ),
    ).resolves.toMatchObject({
      action: "Schedule",
      resultAggregateVersion: 2,
      publicationEvidenceReference: id(72),
    });
    expect(context.publication).toHaveBeenCalledOnce();
    expect(context.current()).toMatchObject({ lifecycle: "Scheduled", aggregateVersion: 2 });

    const publishContext = fixture({ initial: current });
    await expect(
      publishContext.service.execute(
        command("Publish", current, {
          operationReference: id(82),
          expectedAggregateVersion: 1,
          observedAt: at(10, 10),
        }),
      ),
    ).resolves.toMatchObject({ action: "Publish", resultAggregateVersion: 2 });
    expect(publishContext.current()).toMatchObject({ lifecycle: "Published" });
  });

  it("appends a new draft version instead of rewriting a published snapshot", async () => {
    const current = policy({ lifecycle: "Published" });
    const context = fixture({ initial: current });
    const candidate = policy({
      versionReference: id(90),
      policyVersion: 2,
      aggregateVersion: 2,
      createdAt: at(2, 10),
      observedAt: at(2, 10),
    });
    await expect(
      context.service.execute(
        command("Revise", candidate, {
          operationReference: id(83),
          expectedAggregateVersion: 1,
          revisionEvidence: { revisionReference: id(91), reasonCode: "CAPACITY_CORRECTION" },
        }),
      ),
    ).resolves.toMatchObject({
      action: "Revise",
      reasonCode: "CAPACITY_CORRECTION",
      resultAggregateVersion: 2,
    });
    expect(context.current()).toMatchObject({
      versionReference: id(90),
      policyVersion: 2,
      lifecycle: "Draft",
    });
  });

  it("simulates only after authorization using collaborator-issued current facts", async () => {
    const denied = fixture({ denied: true, initial: policy() });
    const request = {
      tenantReference: id(3),
      brandReference: id(4),
      storeReference: id(5),
      policyReference: id(1),
      versionReference: id(2),
      scenarioRequest: { safeScenarioReference: id(90) },
      observedAt: at(12, 18),
    };
    await expect(denied.service.simulate(request)).rejects.toThrowError(
      expect.objectContaining({ code: "CAPACITY_POLICY_PERMISSION_DENIED" }),
    );
    expect(denied.reads).not.toHaveBeenCalled();

    const context = fixture({ initial: policy() });
    await expect(context.service.simulate(request)).resolves.toMatchObject({
      effectiveCapacitySeats: 20,
      availableSeatsAfterRequest: 6,
      blockingCodes: [],
    });
  });
});
