import { createEffectivePeriod } from "@bop/effective-period";
import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createPromotionService,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type PromotionBasket,
  type PromotionOperationRecord,
  type PromotionPorts,
  type PromotionSnapshot,
} from "../index.js";
const id = (n: number) => `018f9700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  brand: id(1),
  actor: id(2),
  author: id(3),
  promotion: id(4),
  v1: id(5),
  v2: id(6),
  operation: id(7),
  audit: id(8),
  correlation: id(9),
  policy: id(10),
  basket: id(11),
  line: id(12),
  sellable: id(13),
};
const at = "2026-08-13T18:00:00.000Z";
const ref = (value: string) => parsePricingReference(value);
const sha = (c: string) => `sha256:${c.repeat(64)}`;
function snapshot(published: boolean): PromotionSnapshot {
  return {
    promotionReference: ref(ids.promotion),
    versionReference: ref(published ? ids.v2 : ids.v1),
    brandReference: ref(ids.brand),
    stableCode: parsePricingCode("SYNTHETIC_LUNCH"),
    aggregateVersion: published ? 2 : 1,
    versionNumber: published ? 2 : 1,
    snapshotDigest: parsePricingDigest(sha(published ? "b" : "a")),
    lifecycle: published ? "Published" : "Draft",
    promotionType: "OrderPercentage",
    currencyCode: parseCurrencyCode("CAD"),
    eligibleSellableReferences: [],
    eligibleCategoryReferences: [],
    eligibleSegmentReference: null,
    thresholdMinor: null,
    benefit: {
      scope: "Order",
      calculation: "Percentage",
      value: "0.1",
      maximumDiscountMinor: null,
    },
    stacking: "Stackable",
    stackingGroupCode: null,
    priority: 1,
    budgetMinor: "100000",
    usageMinor: "0",
    usageCount: 0,
    redemptionLimit: 100,
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    }),
    customerCopyCode: parsePricingCode("SYNTHETIC_COPY"),
    createdAt: at,
  };
}
const basket: PromotionBasket = {
  basketReference: ref(ids.basket),
  brandReference: ref(ids.brand),
  currencyCode: parseCurrencyCode("CAD"),
  segmentReference: null,
  evaluatedAt: at,
  lines: [
    {
      lineReference: ref(ids.line),
      sellableReference: ref(ids.sellable),
      categoryReferences: [],
      amountMinor: "1000",
    },
  ],
};
function tenant() {
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
      code: "PRICING",
      displayName: "Pricing Brand",
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
function hash(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
function fixture(options: { sameActor?: boolean; stale?: boolean } = {}) {
  let aggregate: PromotionSnapshot | null = snapshot(false);
  const operations = new Map<string, PromotionOperationRecord>();
  const ports: PromotionPorts = {
    authorization: {
      async authorize(input) {
        return {
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "pricing.promotion.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          approvalPermission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "pricing.promotion.approve",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          draftAuthorActorReference: options.sameActor ? ids.actor : ids.author,
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `PRICING_PROMOTION_${input.action.toUpperCase()}`,
            targetType: "PricingPromotion",
            targetId: ids.promotion,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    facts: {
      async validate() {
        return true;
      },
      async representativeBaskets() {
        return [basket];
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        if (options.stale && aggregate !== null) return { ...aggregate, aggregateVersion: 3 };
        return aggregate?.promotionReference === reference ? aggregate : null;
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
  return { service: createPromotionService(ports), operation: () => operations.get(ids.operation) };
}
describe("Promotion administration service", () => {
  it("publishes with four-eyes approval, representative simulation and atomic Event", async () => {
    const target = fixture();
    const input = {
      action: "Publish" as const,
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 1,
      candidate: snapshot(true),
      occurredAt: at,
    };
    expect(await target.service.execute(input)).toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Published" },
    });
    expect(target.operation()?.event).toMatchObject({
      eventType: "PromotionPublished",
      aggregateVersion: 2,
    });
    expect(await target.service.execute(input)).toMatchObject({ status: "AlreadyApplied" });
  });
  it("rejects same-actor approval and stale Expected Version", async () => {
    const input = {
      action: "Publish" as const,
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 1,
      candidate: snapshot(true),
      occurredAt: at,
    };
    await expect(fixture({ sameActor: true }).service.execute(input)).rejects.toMatchObject({
      code: "PROMOTION_APPROVAL_REQUIRED",
    });
    await expect(fixture({ stale: true }).service.execute(input)).rejects.toMatchObject({
      code: "PROMOTION_VERSION_CONFLICT",
    });
  });
});
