import { createEffectivePeriod } from "@bop/effective-period";
import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createPriceBookService,
  PriceBookWorkflowError,
  type PriceBookOperationRecord,
  type PriceBookPorts,
} from "../index.js";
import {
  createCurrencyMetadataSnapshot,
  createMoney,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  type PriceBookSnapshot,
} from "../index.js";

const id = (n: number) => `018fd200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  brand: id(1),
  actor: id(2),
  author: id(3),
  book: id(4),
  version1: id(5),
  version2: id(6),
  entry: id(7),
  sellable: id(8),
  store: id(9),
  operation: id(10),
  operation2: id(11),
  audit: id(12),
  correlation: id(13),
  policy: id(14),
  currency: id(15),
};
const at = "2026-08-13T18:00:00.000Z";
const later = "2026-08-13T18:05:00.000Z";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
function snapshot(
  options: {
    lifecycle?: PriceBookSnapshot["lifecycle"];
    aggregateVersion?: number;
    versionNumber?: number;
    versionReference?: string;
    createdAt?: string;
    entries?: boolean;
  } = {},
): PriceBookSnapshot {
  return {
    priceBookReference: parsePricingReference(ids.book),
    versionReference: parsePricingReference(options.versionReference ?? ids.version1),
    brandReference: parsePricingReference(ids.brand),
    stableCode: parsePricingCode("CAD_BASE"),
    aggregateVersion: options.aggregateVersion ?? 1,
    versionNumber: options.versionNumber ?? 1,
    snapshotDigest: parsePricingDigest(sha(options.versionNumber === 2 ? "b" : "a")),
    lifecycle: options.lifecycle ?? "Draft",
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: parsePricingReference(ids.currency),
      metadataDigest: parsePricingDigest(sha("c")),
    }),
    entries: options.entries
      ? [
          {
            entryReference: parsePricingReference(ids.entry),
            sellableReference: parsePricingReference(ids.sellable),
            scopeKind: "Brand",
            scopeReference: null,
            channelCode: null,
            orderType: null,
            amount: createMoney({ amountMinor: 1299n, currencyCode: parseCurrencyCode("CAD") }),
            effectivePeriod: createEffectivePeriod({
              timeZone: "America/Toronto",
              effectiveFrom: {
                instant: "2026-08-01T04:00:00.000Z" as never,
                localDateTime: "2026-08-01T00:00:00.000",
                utcOffsetMinutes: -240,
              },
              effectiveUntil: null,
            }),
            reasonCode: parsePricingCode("SYNTHETIC_BASE"),
          },
        ]
      : [],
    createdAt: options.createdAt ?? at,
  };
}
function tenant(actor = ids.actor) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: actor,
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
function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
function fixture(options: { sameActorApproval?: boolean; denied?: boolean } = {}) {
  let aggregate: PriceBookSnapshot | null = null;
  const operations = new Map<string, PriceBookOperationRecord>();
  const ports: PriceBookPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "pricing.price-book.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          approvalPermission:
            input.action === "Publish"
              ? {
                  effect: "Allow",
                  reason: "ROLE_PERMISSION",
                  source: "RolePermission",
                  action: "pricing.price-book.approve",
                  scopeKind: "Brand",
                  policySnapshotReference: ids.policy,
                  policyVersion: 1,
                  audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
                }
              : null,
          draftAuthorActorReference:
            input.action === "Publish"
              ? options.sameActorApproval
                ? ids.actor
                : ids.author
              : null,
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `PRICING_PRICE_BOOK_${input.action.toUpperCase()}`,
            targetType: "PricingPriceBook",
            targetId: ids.book,
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
    references: { hashIntent: digest, equals: (left, right) => left === right },
    facts: {
      async validate() {
        return true;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.priceBookReference === reference ? aggregate : null;
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
  return {
    service: createPriceBookService(ports),
    operation: (reference: string) => operations.get(reference),
  };
}
const coverage = [
  {
    brandReference: parsePricingReference(ids.brand),
    storeReference: parsePricingReference(ids.store),
    storeGroupReference: null,
    regionReference: null,
    sellableReference: parsePricingReference(ids.sellable),
    channelCode: parsePricingCode("CUSTOMER_WEB"),
    orderType: "Pickup" as const,
    currencyCode: "CAD",
    evaluatedAt: later,
  },
];
describe("Price Book administration workflow", () => {
  it("creates and idempotently replays a Draft with an atomic event", async () => {
    const state = fixture();
    const input = { candidate: snapshot(), operationReference: ids.operation, requestedAt: at };
    await expect(state.service.createDraft(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(state.service.createDraft(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(state.operation(ids.operation)?.event.eventType).toBe("PriceBookDraftCreated");
  });
  it("requires an independent authorized approver and complete coverage to publish", async () => {
    const same = fixture({ sameActorApproval: true });
    await same.service.createDraft({
      candidate: snapshot(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    const input = {
      priceBookReference: ids.book,
      expectedAggregateVersion: 1,
      candidate: snapshot({
        lifecycle: "Published",
        aggregateVersion: 2,
        versionNumber: 2,
        versionReference: ids.version2,
        createdAt: later,
        entries: true,
      }),
      coverageContexts: coverage,
      operationReference: ids.operation2,
      requestedAt: later,
    };
    await expect(same.service.publish(input)).rejects.toMatchObject({
      code: "PRICE_BOOK_APPROVAL_REQUIRED",
    });
    const state = fixture();
    await state.service.createDraft({
      candidate: snapshot(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    await expect(state.service.publish(input)).resolves.toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Published", aggregateVersion: 2 },
    });
    expect(state.operation(ids.operation2)?.event.eventType).toBe("PriceBookVersionPublished");
  });
  it("fails closed on denied permission and stale Expected Version", async () => {
    await expect(
      fixture({ denied: true }).service.createDraft({
        candidate: snapshot(),
        operationReference: ids.operation,
        requestedAt: at,
      }),
    ).rejects.toBeInstanceOf(PriceBookWorkflowError);
    const state = fixture();
    await state.service.createDraft({
      candidate: snapshot(),
      operationReference: ids.operation,
      requestedAt: at,
    });
    await expect(
      state.service.replaceDraft({
        priceBookReference: ids.book,
        expectedAggregateVersion: 2,
        candidate: snapshot({
          aggregateVersion: 3,
          versionNumber: 2,
          versionReference: ids.version2,
          createdAt: later,
        }),
        operationReference: ids.operation2,
        requestedAt: later,
      }),
    ).rejects.toMatchObject({ code: "PRICE_BOOK_VERSION_CONFLICT" });
  });
});
