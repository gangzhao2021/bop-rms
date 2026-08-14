import { createEffectivePeriod } from "@bop/effective-period";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createCurrencyMetadataSnapshot,
  createTaxConfigService,
  parsePricingDigest,
  parsePricingReference,
  type TaxConfigOperationRecord,
  type TaxConfigPorts,
  type TaxConfigurationSnapshot,
} from "../index.js";

const id = (n: number) => `018f9300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  brand: id(1),
  store: id(2),
  actor: id(3),
  author: id(4),
  config: id(5),
  v1: id(6),
  v2: id(7),
  rule: id(8),
  classification: id(9),
  currency: id(10),
  operation: id(11),
  audit: id(12),
  correlation: id(13),
  policy: id(14),
  fixture: id(15),
  evidence: id(16),
  review: id(17),
  registration: id(18),
  entity: id(19),
  jurisdiction: id(20),
};
const at = "2026-08-13T18:00:00.000Z";
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const ref = (value: string) => parsePricingReference(value);

function snapshot(published: boolean): TaxConfigurationSnapshot {
  const versionReference = ref(published ? ids.v2 : ids.v1);
  const snapshotDigest = parsePricingDigest(sha(published ? "b" : "a"));
  return {
    configurationReference: ref(ids.config),
    versionReference,
    brandReference: ref(ids.brand),
    storeReference: ref(ids.store),
    stableCode: "PILOT_STORE_TAX" as never,
    aggregateVersion: published ? 2 : 1,
    versionNumber: published ? 2 : 1,
    snapshotDigest,
    lifecycle: published ? "Published" : "Draft",
    jurisdictionCode: "CA-ON" as never,
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: "CAD" as never,
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: ref(ids.currency),
      metadataDigest: parsePricingDigest(sha("c")),
    }),
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    }),
    registrationEvidence: published
      ? {
          applicabilityReference: ref(ids.registration),
          operatingEntityTaxReference: ref(ids.entity),
          jurisdictionProfileReference: ref(ids.jurisdiction),
          status: "Verified",
          validUntil: "2026-10-01T04:00:00.000Z",
        }
      : null,
    professionalEvidence: published
      ? {
          evidenceReference: ref(ids.evidence),
          snapshotReference: versionReference,
          snapshotDigest,
          professionalReviewReference: ref(ids.review),
          fixtureSuiteReference: ref(ids.fixture),
          fixtureSuiteDigest: parsePricingDigest(sha("d")),
          result: "Pass",
          reviewedAt: "2026-08-12T18:00:00.000Z",
          validUntil: "2026-10-01T04:00:00.000Z",
        }
      : null,
    rules: published
      ? [
          {
            ruleReference: ref(ids.rule),
            taxClassificationReference: ref(ids.classification),
            orderType: "Pickup",
            chargeType: "Sellable",
            taxComponentCode: "SYNTHETIC_COMPONENT" as never,
            treatment: "Taxable",
            rate: "0.13" as never,
            priceInclusion: "Exclusive",
            roundingMode: "HalfUp",
            calculationOrder: 1,
            compoundOnPriorTax: false,
            exceptionEvidenceReference: null,
            receiptPresentationCode: "SYNTHETIC_TAX" as never,
          },
        ]
      : [],
    createdAt: at,
  };
}

function context() {
  const brand = createBrand({
    brandReference: ids.brand,
    code: "PRICING",
    displayName: "Pricing Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: ids.store,
    brandReference: ids.brand,
    code: "TAX-1",
    displayName: "Tax Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
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
    brand,
    store,
    at,
  );
}
function hash(value: string) {
  let state = 2166136261;
  for (const char of value) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}

function fixture(sameActor = false) {
  let aggregate: TaxConfigurationSnapshot | null = snapshot(false);
  const operations = new Map<string, TaxConfigOperationRecord>();
  const ports: TaxConfigPorts = {
    authorization: {
      async authorize(input) {
        return {
          tenantContext: context(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "pricing.tax-config.manage",
            scopeKind: "Store",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          approvalPermission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "pricing.tax-config.approve",
            scopeKind: "Store",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          draftAuthorActorReference: sameActor ? ids.actor : ids.author,
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "User", reference: ids.actor },
            actionCode: `PRICING_TAX_CONFIG_${input.action.toUpperCase()}`,
            targetType: "PricingTaxConfiguration",
            targetId: ids.config,
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
      async validateApprovedFixtures() {
        return true;
      },
      async requiredCoverage() {
        return [
          {
            taxClassificationReference: ref(ids.classification),
            orderType: "Pickup",
            chargeType: "Sellable",
          },
        ];
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.configurationReference === reference ? aggregate : null;
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
  return { service: createTaxConfigService(ports), operation: () => operations.get(ids.operation) };
}

describe("Tax Configuration administration service", () => {
  it("publishes approved fixtures with four-eyes authorization and an atomic minimal event", async () => {
    const target = fixture();
    const result = await target.service.execute({
      action: "Publish",
      operationReference: ref(ids.operation),
      expectedAggregateVersion: 1,
      candidate: snapshot(true),
      occurredAt: at,
    });
    expect(result.status).toBe("Applied");
    expect(target.operation()?.event).toMatchObject({
      eventType: "TaxConfigPublished",
      configurationReference: ids.config,
      storeReference: ids.store,
      aggregateVersion: 2,
    });
    expect(
      await target.service.execute({
        action: "Publish",
        operationReference: ref(ids.operation),
        expectedAggregateVersion: 1,
        candidate: snapshot(true),
        occurredAt: at,
      }),
    ).toMatchObject({ status: "AlreadyApplied" });
  });
  it("rejects same-actor approval without persisting", async () => {
    await expect(
      fixture(true).service.execute({
        action: "Publish",
        operationReference: ref(ids.operation),
        expectedAggregateVersion: 1,
        candidate: snapshot(true),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_APPROVAL_REQUIRED" });
  });
  it("rejects extra command fields at the application boundary", async () => {
    await expect(
      fixture().service.execute({
        action: "Publish",
        operationReference: ref(ids.operation),
        expectedAggregateVersion: 1,
        candidate: snapshot(true),
        occurredAt: at,
        injected: "ignored",
      } as never),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
  });
});
