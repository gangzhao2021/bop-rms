import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";

import { createBundleService } from "../application/bundle-service.js";
import type {
  BundleOperationAction,
  BundleOperationRecord,
  BundlePorts,
} from "../application/ports/bundle-ports.js";
import type { BundleAggregate } from "../domain/bundle.js";

const id = (n: number) => `018fa000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  bundle: id(1),
  brand: id(2),
  actor: id(3),
  version: id(4),
  group: id(5),
  sku: id(6),
  operation: id(7),
  audit: id(8),
  correlation: id(9),
  policy: id(10),
} as const;
const at = "2026-08-13T15:00:00.000Z";
const later = "2026-08-13T15:01:00.000Z";
function hash(seed: string) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function context() {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: at,
      recentMfaAt: at,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "BUNDLE",
      displayName: "Bundle Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
function audit(action: BundleOperationAction, occurredAt = at) {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    actor: { type: "User" as const, reference: ids.actor },
    actionCode: `CATALOG_BUNDLE_${action.toUpperCase()}`,
    targetType: "CatalogBundle",
    targetId: ids.bundle,
    beforeSummary: {},
    afterSummary: {},
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: ids.correlation,
    occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}
function candidate(overrides: Record<string, unknown> = {}): BundleAggregate {
  return {
    bundleReference: ids.bundle as never,
    brandReference: ids.brand as never,
    internalCode: "LUNCH" as never,
    lifecycle: "Draft",
    aggregateVersion: 1,
    currentVersion: {
      versionReference: ids.version as never,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Lunch" },
      localizedDescriptions: { "en-CA": "Lunch bundle" },
      priceMode: "Fixed",
      fixedPrice: { currencyCode: "CAD" as never, amountMinor: "1299" },
      componentGroups: [
        {
          groupReference: ids.group as never,
          stableCode: "MAIN" as never,
          localizedNames: { "en-CA": "Main" },
          minimumSelection: 1,
          maximumSelection: 1,
          eligibleSellables: [
            { sellableReference: ids.sku as never, sellableType: "Sku", upgradePrice: null },
          ],
          optionSetVersionReference: null,
        },
      ],
      availabilityRuleReferences: [],
      validationDigest: null,
      createdAt: at as never,
      updatedAt: at as never,
      publishedAt: null,
    },
    createdAt: at as never,
    createdByActorReference: ids.actor as never,
    updatedAt: at as never,
    ...overrides,
  };
}
function fixture(
  options: { denied?: boolean; pricingDenied?: boolean; invalidFacts?: boolean } = {},
) {
  let aggregate: BundleAggregate | null = null;
  const operations = new Map<string, BundleOperationRecord>();
  const records: BundleOperationRecord[] = [];
  const ports: BundlePorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: context(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "catalog.bundle.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          pricingApproval: options.pricingDenied
            ? null
            : {
                effect: "Allow",
                reason: "ROLE_PERMISSION",
                source: "RolePermission",
                action: "pricing.bundle.approve",
                scopeKind: "Brand",
                policySnapshotReference: ids.policy,
                policyVersion: 1,
                audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
              },
          audit: audit(input.action, input.observedAt),
        } as never;
      },
    },
    references: {
      generate: () => id(99),
      hashIntent: (value) => hash(value),
      equals: (left, right) => left === right,
    },
    facts: {
      async validatePublishedReferences() {
        return !options.invalidFacts;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.bundleReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return true;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        records.push(input.record);
        return input.record;
      },
      async commit(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        records.push(input.record);
        return input.record;
      },
    },
  };
  return { service: createBundleService(ports), current: () => aggregate, records };
}

describe("Bundle command service", () => {
  it("creates atomically, emits a minimized event and replays the same intent", async () => {
    const state = fixture();
    const input = { candidate: candidate(), operationReference: ids.operation, requestedAt: at };
    await expect(state.service.create(input)).resolves.toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Draft" },
    });
    await expect(state.service.create(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.event).toEqual({
      eventType: "BundleDraftCreated",
      aggregateReference: ids.bundle,
      versionReference: ids.version,
      aggregateVersion: 1,
      brandReference: ids.brand,
      lifecycle: "Draft",
      validationDigest: null,
      occurredAt: at,
    });
    expect(JSON.stringify(state.records[0]?.event)).not.toContain("Lunch");
  });

  it("fails closed on denied authority and changed idempotent replay", async () => {
    await expect(
      fixture({ denied: true }).service.create({
        candidate: candidate(),
        operationReference: ids.operation,
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    const state = fixture();
    await state.service.create({
      candidate: candidate(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    await expect(
      state.service.create({
        candidate: candidate({ internalCode: "OTHER" }),
        operationReference: ids.operation,
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });

  it("requires Pricing approval and exact published reference validation", async () => {
    for (const state of [fixture({ pricingDenied: true }), fixture({ invalidFacts: true })]) {
      await state.service.create({
        candidate: candidate(),
        operationReference: ids.operation,
        requestedAt: at,
      });
      await expect(
        state.service.publish({
          bundleReference: ids.bundle,
          validationDigest: hash("valid"),
          expectedAggregateVersion: 1,
          operationReference: id(20),
          requestedAt: later,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/PERMISSION_DENIED|UNAVAILABLE/u) });
    }
  });

  it("publishes an immutable validated version with Expected Version and Outbox event", async () => {
    const state = fixture();
    await state.service.create({
      candidate: candidate(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    await expect(
      state.service.publish({
        bundleReference: ids.bundle,
        validationDigest: hash("valid"),
        expectedAggregateVersion: 1,
        operationReference: id(20),
        requestedAt: later,
      }),
    ).resolves.toMatchObject({
      status: "Applied",
      aggregate: {
        lifecycle: "Published",
        aggregateVersion: 2,
        currentVersion: { status: "Published", publishedAt: later },
      },
    });
    expect(state.records.at(-1)?.event.eventType).toBe("BundleVersionPublished");
  });

  it("enforces version conflicts and the published lifecycle graph", async () => {
    const state = fixture();
    await state.service.create({
      candidate: candidate(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    await expect(
      state.service.publish({
        bundleReference: ids.bundle,
        validationDigest: hash("valid"),
        expectedAggregateVersion: 2,
        operationReference: id(20),
        requestedAt: later,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
    await state.service.publish({
      bundleReference: ids.bundle,
      validationDigest: hash("valid"),
      expectedAggregateVersion: 1,
      operationReference: id(21),
      requestedAt: later,
    });
    await expect(
      state.service.changeLifecycle({
        bundleReference: ids.bundle,
        targetLifecycle: "Suspended",
        expectedAggregateVersion: 2,
        operationReference: id(22),
        requestedAt: "2026-08-13T15:02:00.000Z",
      }),
    ).resolves.toMatchObject({ aggregate: { lifecycle: "Suspended", aggregateVersion: 3 } });
  });
});
