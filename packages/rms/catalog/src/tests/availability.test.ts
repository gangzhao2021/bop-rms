import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import { createAvailabilityService } from "../application/availability-service.js";
import type {
  AvailabilityOperationRecord,
  AvailabilityPorts,
} from "../application/ports/availability-ports.js";
import { parseCatalogCode, parseCatalogReference, parseCatalogInstant } from "../domain/product.js";
import {
  parseAvailabilityRule,
  resolveStoreAvailability,
  type AvailabilityRuleAggregate,
} from "../domain/availability.js";

const id = (n: number) => `018f7000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  brand: id(1),
  store: id(2),
  sku: id(3),
  brandRule: id(4),
  storeRule: id(5),
  actor: id(6),
  operation: id(7),
  audit: id(8),
  correlation: id(9),
  policy: id(10),
  secondOperation: id(11),
};
const at = "2026-08-01T16:00:00.000Z";
function rule(
  options: {
    store?: string | null;
    decision?: "Available" | "Unavailable";
    priority?: number;
    reference?: string;
    lifecycle?: "Draft" | "Active" | "Inactive" | "Archived";
  } = {},
) {
  return parseAvailabilityRule({
    ruleReference: options.reference ?? ids.brandRule,
    brandReference: ids.brand,
    internalCode: options.store ? "STORE_RULE" : "BRAND_RULE",
    aggregateVersion: 1,
    lifecycle: options.lifecycle ?? "Active",
    sellableReference: ids.sku,
    sellableType: "Sku",
    storeReference: options.store ?? null,
    channelCodes: ["DINE_IN"],
    orderTypeCodes: ["TABLE_SERVICE"],
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: null,
    decision: options.decision ?? "Available",
    priority: options.priority ?? 10,
    reasonCode: options.decision === "Unavailable" ? "MANUAL_BLOCK" : "CATALOG_ALLOWED",
    createdAt: at,
    createdByActorReference: ids.actor,
    updatedAt: at,
  });
}
function resolve(rules: ReturnType<typeof rule>[], evidence: unknown[] = []) {
  return resolveStoreAvailability({
    brandReference: parseCatalogReference(ids.brand),
    storeReference: parseCatalogReference(ids.store),
    sellableReference: parseCatalogReference(ids.sku),
    channelCode: parseCatalogCode("DINE_IN"),
    orderTypeCode: parseCatalogCode("TABLE_SERVICE"),
    at: parseCatalogInstant(at),
    rules,
    safetyEvidence: evidence as never,
  });
}
function safety(kind: "KillSwitch" | "Inventory", status: string, reasonCode: string) {
  return {
    kind,
    brandReference: ids.brand,
    storeReference: ids.store,
    sellableReference: ids.sku,
    status,
    observedAt: "2026-08-01T15:59:00.000Z",
    expiresAt: "2026-08-01T16:05:00.000Z",
    reasonCode,
  };
}

function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
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
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "CATALOG",
      displayName: "Catalog Brand",
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
function audit(action: AvailabilityOperationRecord["action"]) {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    actor: { type: "User" as const, reference: ids.actor },
    actionCode: `CATALOG_AVAILABILITY_${action.toUpperCase()}`,
    targetType: "CatalogAvailabilityRule",
    targetId: ids.brandRule,
    beforeSummary: {},
    afterSummary: {},
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}
function createInput() {
  return {
    internalCode: " lunch_availability ",
    sellableReference: ids.sku,
    sellableType: "Sku",
    storeReference: ids.store,
    channelCodes: ["DINE_IN"],
    orderTypeCodes: ["TABLE_SERVICE"],
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: null,
    decision: "Available",
    priority: 20,
    reasonCode: "CATALOG_ALLOWED",
    operationReference: ids.operation,
    requestedAt: at,
  };
}
function serviceFixture(options: { denied?: boolean; invalidFacts?: boolean } = {}) {
  let aggregate: AvailabilityRuleAggregate | null = null;
  const operations = new Map<string, AvailabilityOperationRecord>();
  const ports: AvailabilityPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: context(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "catalog.availability.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: audit(input.action),
        } as never;
      },
    },
    references: {
      generate: () => ids.brandRule,
      hashIntent: (value) => digest(value) as never,
      equals: (left, right) => left === right,
    },
    facts: {
      async validate() {
        return !options.invalidFacts;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.ruleReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return true;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async commit(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return { service: createAvailabilityService(ports), current: () => aggregate };
}

describe("Store Availability Overlay", () => {
  it("prefers an exact Store overlay over the Brand default", () => {
    expect(
      resolve([
        rule(),
        rule({ store: ids.store, decision: "Unavailable", reference: ids.storeRule }),
      ]),
    ).toMatchObject({ status: "Unavailable", ruleReference: ids.storeRule });
  });
  it("uses priority within one scope and fails closed on equal-priority conflict", () => {
    expect(
      resolve([
        rule({ priority: 10 }),
        rule({ priority: 20, decision: "Unavailable", reference: ids.storeRule }),
      ]).status,
    ).toBe("Unavailable");
    expect(
      resolve([rule(), rule({ decision: "Unavailable", reference: ids.storeRule })]),
    ).toMatchObject({ status: "Indeterminate", reasonCode: "AMBIGUOUS_RULE" });
  });
  it("applies Kill Switch and Inventory safety evidence before configuration", () => {
    expect(resolve([rule()], [safety("KillSwitch", "Blocked", "SAFETY_BLOCK")])).toMatchObject({
      status: "Unavailable",
      reasonCode: "SAFETY_BLOCK",
    });
    expect(
      resolve([rule()], [safety("Inventory", "Indeterminate", "STOCK_UNKNOWN")]),
    ).toMatchObject({ status: "Indeterminate" });
  });
  it("rejects stale or wrong-scope evidence", () => {
    expect(
      resolve([rule()], [{ ...safety("Inventory", "Available", "STOCK_OK"), expiresAt: at }]),
    ).toMatchObject({ status: "Indeterminate", reasonCode: "EVIDENCE_INVALID" });
    expect(
      resolve([rule()], [{ ...safety("KillSwitch", "Clear", "CLEAR"), storeReference: id(99) }])
        .status,
    ).toBe("Indeterminate");
  });
  it("rejects invalid periods, targets and inactive/no effective rules", () => {
    expect(() => parseAvailabilityRule({ ...rule(), sellableType: "Bundle" })).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(() =>
      parseAvailabilityRule({ ...rule(), effectiveUntil: "2026-07-31T00:00:00.000Z" }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(resolve([rule({ lifecycle: "Inactive" })])).toMatchObject({
      status: "Indeterminate",
      reasonCode: "NO_EFFECTIVE_RULE",
    });
  });

  it("creates one Store overlay as Draft and idempotently replays it", async () => {
    const state = serviceFixture();
    await expect(state.service.create(createInput())).resolves.toMatchObject({
      status: "Applied",
      aggregate: {
        ruleReference: ids.brandRule,
        brandReference: ids.brand,
        internalCode: "LUNCH_AVAILABILITY",
        storeReference: ids.store,
        lifecycle: "Draft",
        aggregateVersion: 1,
      },
    });
    await expect(state.service.create(createInput())).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });

  it("fails closed on denied authority, changed replay and invalid facts", async () => {
    await expect(
      serviceFixture({ denied: true }).service.create(createInput()),
    ).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    await expect(
      serviceFixture({ invalidFacts: true }).service.create(createInput()),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
    const state = serviceFixture();
    await state.service.create(createInput());
    await expect(state.service.create({ ...createInput(), priority: 21 })).rejects.toMatchObject({
      code: "CATALOG_IDEMPOTENCY_CONFLICT",
    });
  });

  it("activates with optimistic concurrency and rejects a stale version", async () => {
    const state = serviceFixture();
    await state.service.create(createInput());
    await expect(
      state.service.changeLifecycle({
        ruleReference: ids.brandRule,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: ids.secondOperation,
        requestedAt: at,
      }),
    ).resolves.toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Active", aggregateVersion: 2 },
    });
    expect(state.current()).toMatchObject({ lifecycle: "Active", aggregateVersion: 2 });
    await expect(
      state.service.changeLifecycle({
        ruleReference: ids.brandRule,
        targetLifecycle: "Inactive",
        expectedAggregateVersion: 1,
        operationReference: id(12),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  });
});
