import { describe, expect, it, vi } from "vitest";
import type { OfferingCommand, OfferingProjection } from "../contracts/offering.js";
import { executeOffering, queryOfferings } from "../application/offering-service.js";
import type { OfferingPorts } from "../application/ports/offering-ports.js";
import {
  appendOfferingVersion,
  appendPriceVersion,
  createOffering,
  resolvePrice,
  transitionOffering,
  type OfferingReference,
  type SupplierItemOffering,
} from "../domain/aggregates/offering.js";

const id = (n: number) =>
  `018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as OfferingReference;
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const config = {
  versionReference: id(20),
  supplierItemCode: "SUP-CASE-01",
  supplierItemName: "Synthetic Case",
  purchaseUnit: "CASE",
  packQuantity: "1",
  baseUnit: "EA",
  baseQuantity: "24",
  minimumOrderQuantity: "2",
  orderMultiple: "1",
  leadTimeDays: 3,
  orderingRestrictions: ["CUTOFF_1200"],
} as const;
function draft(): SupplierItemOffering {
  return createOffering({
    offeringReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    supplierReference: id(3),
    inventoryItemReference: id(4),
    ...config,
    createdBy: id(5),
    createdAt: at(1),
  });
}
function withPrice(
  value = draft(),
  source: "Contract" | "Default" = "Contract",
  record = 30,
  unitCost = "12.50",
) {
  return appendPriceVersion(value, {
    expectedVersion: value.aggregateVersion,
    priceRecordReference: id(record),
    priceVersionReference: id(record + 1),
    currency: "CAD",
    unitCost,
    priceUnit: "CASE",
    quantityTiers: [{ minimumQuantity: "10", unitCost: "11.25" }],
    effectivePeriod: { effectiveFrom: at(1), effectiveUntil: null },
    source,
    scope: "Brand",
    scopeReference: id(2),
    approvalReference: id(80),
    createdBy: id(5),
    createdAt: at(2),
  });
}
function projection(masked = false): OfferingProjection {
  const offering = withPrice();
  return {
    projectionName: "procurement_offering_v1",
    projectionVersion: 1,
    asOfUtc: at(10),
    stale: false,
    partial: false,
    tenantReference: id(1),
    brandReference: id(2),
    permissions: {
      mayManage: true,
      mayApprove: true,
      mayPublish: true,
      mayViewCost: !masked,
      mayViewQualification: !masked,
      mayViewHistory: !masked,
    },
    items: [
      {
        offeringReference: id(10),
        supplierReference: id(3),
        supplierName: "Synthetic Supplier",
        inventoryItemReference: id(4),
        inventoryItemName: "Synthetic Item",
        supplierItemCode: "SUP-CASE-01",
        purchaseUnit: "CASE",
        packSummary: "1 CASE = 24 EA",
        leadTimeDays: 3,
        minimumOrderQuantity: "2",
        orderMultiple: "1",
        currentUnitCost: masked ? null : "12.50",
        currency: masked ? null : "CAD",
        priceEffectiveUntil: null,
        qualificationStatus: "Current",
        lifecycle: "Draft",
        sourceReference: id(10),
      },
    ],
    detail: {
      offeringReference: offering.offeringReference,
      offeringVersion: offering.aggregateVersion,
      lifecycle: offering.lifecycle,
      configVersions: offering.configVersions,
      priceRecords: offering.priceRecords.map((record) => ({
        priceRecordReference: record.priceRecordReference,
        versions: record.versions.map((version) => ({
          priceVersionReference: version.priceVersionReference,
          currency: masked ? null : version.currency,
          unitCost: masked ? null : version.unitCost,
          priceUnit: version.priceUnit,
          quantityTiers: masked ? null : version.quantityTiers,
          effectiveFrom: version.effectivePeriod.effectiveFrom,
          effectiveUntil: version.effectivePeriod.effectiveUntil,
          source: version.source,
          scope: version.scope,
          scopeReference: version.scopeReference,
        })),
      })),
      supplierSummary: "Synthetic Supplier",
      inventoryItemSummary: "Synthetic Item",
      qualificationReferences: masked ? null : [id(90)],
      historyReferences: masked ? null : [id(20)],
      validationIssues: [],
      sourceReference: id(10),
    },
    nextCursor: null,
  };
}
function command(action: OfferingCommand["action"], expectedVersion = 1): OfferingCommand {
  const permission =
    action === "Approve"
      ? "procurement.offering.approve"
      : action === "Publish"
        ? "procurement.offering.publish"
        : "procurement.offering.manage";
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: action === "Approve" ? id(6) : id(5),
    purpose: "OfferingManagement",
    permission,
    operationReference: id(70),
    occurredAt: at(10),
    action,
    payload:
      action === "Create"
        ? { supplierReference: id(3), inventoryItemReference: id(4), ...config }
        : {
            offeringReference: id(10),
            expectedVersion,
            approvalReference: ["Approve", "Publish"].includes(action) ? id(80) : null,
            reasonCode: "APPROVED_CHANGE",
          },
  };
}
function ports(existing: SupplierItemOffering | null = draft()): OfferingPorts {
  let current = existing;
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true,
        mayManage: true,
        mayApprove: true,
        mayPublish: true,
        mayViewCost: true,
        mayViewQualification: true,
        mayViewHistory: true,
      })),
    },
    projection: { query: vi.fn(async () => projection()) },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => current),
      identityAvailable: vi.fn(async () => true),
      commit: vi.fn(async (record) => {
        current = record.offering;
        return record;
      }),
    },
    publicationPolicy: {
      validate: vi.fn(async ({ command: input, offering }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        offeringReference: id(10),
        offeringVersion: offering.aggregateVersion,
        supplierReference: id(3),
        inventoryItemReference: id(4),
        supplierActive: true,
        itemPurchasable: true,
        baseUnit: "EA",
        conversionValid: true,
        qualificationEligible: true,
        approvedPriceAvailable: true,
        approvalReference: input.payload.approvalReference as OfferingReference,
        approvedAt: at(9),
        blockers: [],
      })),
    },
    priceApproval: {
      validate: vi.fn(async ({ command: input, offering }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        offeringReference: id(10),
        offeringVersion: offering.aggregateVersion,
        priceRecordReference: input.payload.priceRecordReference as OfferingReference,
        priceVersionReference: input.payload.priceVersionReference as OfferingReference,
        approvalReference: input.payload.approvalReference as OfferingReference,
        approvedAt: at(1),
        approved: true,
      })),
    },
    impact: {
      inspect: vi.fn(async ({ offering }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        offeringReference: id(10),
        offeringVersion: offering.aggregateVersion,
        openPurchaseOrderCount: 2,
        historicalPurchaseOrdersMutated: false as const,
      })),
    },
    audit: { create: vi.fn(async () => ({ auditReference: id(99) })) },
    references: {
      generate: vi.fn(() => id(10)),
      hashIntent: vi.fn(() => "hash"),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Supplier Item Offering Aggregate", () => {
  it("appends purchasing configuration without replacing the stable mapping", () => {
    const revised = appendOfferingVersion(draft(), {
      expectedVersion: 1,
      ...config,
      versionReference: id(21),
      baseQuantity: "12.5",
      createdBy: id(5),
      createdAt: at(2),
    });
    expect(revised).toMatchObject({
      offeringReference: id(10),
      supplierReference: id(3),
      inventoryItemReference: id(4),
      lifecycle: "Draft",
      aggregateVersion: 2,
    });
    expect(revised.configVersions.map((version) => version.baseQuantity)).toEqual(["24", "12.5"]);
    expect(() =>
      appendOfferingVersion(draft(), {
        expectedVersion: 1,
        ...config,
        versionReference: id(21),
        baseQuantity: 12.5 as never,
        createdBy: id(5),
        createdAt: at(2),
      }),
    ).toThrowError();
  });
  it("enforces submitter and approver segregation", () => {
    const submitted = transitionOffering(withPrice(), {
      expectedVersion: 2,
      action: "Submit",
      actorReference: id(5),
      occurredAt: at(3),
      approvalReference: null,
    });
    expect(() =>
      transitionOffering(submitted, {
        expectedVersion: 3,
        action: "Approve",
        actorReference: id(5),
        occurredAt: at(4),
        approvalReference: id(80),
      }),
    ).toThrowError(expect.objectContaining({ code: "OFFERING_SEGREGATION_REQUIRED" }));
    expect(
      transitionOffering(submitted, {
        expectedVersion: 3,
        action: "Approve",
        actorReference: id(6),
        occurredAt: at(4),
        approvalReference: id(80),
      }).lifecycle,
    ).toBe("Approved");
  });
  it("resolves source precedence and quantity tier deterministically", () => {
    const priced = withPrice(withPrice(draft(), "Default", 40, "13.00"), "Contract", 30, "12.50");
    expect(
      resolvePrice({
        offering: priced,
        atUtc: at(10),
        currency: "CAD",
        quantity: "12",
        allowedScopes: [id(2)],
      }),
    ).toEqual({
      priceRecordReference: id(30),
      priceVersionReference: id(31),
      unitCost: "11.25",
      basis: "Contract",
    });
    const conflict = withPrice(priced, "Contract", 50, "12.00");
    expect(() =>
      resolvePrice({
        offering: conflict,
        atUtc: at(10),
        currency: "CAD",
        quantity: "2",
        allowedScopes: [id(2)],
      }),
    ).toThrowError();
  });
  it("keeps an effective price version selectable while its revision is scheduled", () => {
    const priced = withPrice();
    const scheduled = appendPriceVersion(priced, {
      expectedVersion: 2,
      priceRecordReference: id(30),
      priceVersionReference: id(32),
      currency: "CAD",
      unitCost: "10.50",
      priceUnit: "CASE",
      quantityTiers: [],
      effectivePeriod: { effectiveFrom: at(20), effectiveUntil: null },
      source: "Contract",
      scope: "Brand",
      scopeReference: id(2),
      approvalReference: id(81),
      createdBy: id(5),
      createdAt: at(3),
    });
    expect(
      resolvePrice({
        offering: scheduled,
        atUtc: at(10),
        currency: "CAD",
        quantity: "2",
        allowedScopes: [id(2)],
      }).priceVersionReference,
    ).toBe(id(31));
  });
});

describe("Offering application", () => {
  it("authorizes before projection and masks restricted fields", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayManage: true,
      mayApprove: true,
      mayPublish: true,
      mayViewCost: false,
      mayViewQualification: false,
      mayViewHistory: false,
    });
    vi.mocked(adapter.projection.query).mockResolvedValueOnce(projection(true));
    await expect(
      queryOfferings(
        {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(5),
          purpose: "OfferingRead",
          permission: "procurement.offering.read",
          selectedOfferingReference: id(10),
          search: "SUP-CASE-01",
          supplierReference: null,
          inventoryItemReference: null,
          status: "All",
          currency: null,
          storeCoverageReference: null,
          expiringPrice: null,
          qualificationIssue: null,
          cursor: null,
        },
        adapter,
      ),
    ).resolves.toMatchObject({
      items: [{ currentUnitCost: null }],
      detail: { qualificationReferences: null },
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });
  it("publishes only after exact public eligibility validation", async () => {
    const submitted = transitionOffering(withPrice(), {
      expectedVersion: 2,
      action: "Submit",
      actorReference: id(5),
      occurredAt: at(3),
      approvalReference: null,
    });
    const approved = transitionOffering(submitted, {
      expectedVersion: 3,
      action: "Approve",
      actorReference: id(6),
      occurredAt: at(4),
      approvalReference: id(80),
    });
    const adapter = ports(approved);
    const result = await executeOffering(command("Publish", 4), adapter);
    expect(result.offering.lifecycle).toBe("Published");
    expect(adapter.publicationPolicy.validate).toHaveBeenCalledBefore(
      adapter.audit.create as never,
    );
  });
  it("fails closed on qualification or conversion blockers", async () => {
    const submitted = transitionOffering(withPrice(), {
      expectedVersion: 2,
      action: "Submit",
      actorReference: id(5),
      occurredAt: at(3),
      approvalReference: null,
    });
    const approved = transitionOffering(submitted, {
      expectedVersion: 3,
      action: "Approve",
      actorReference: id(6),
      occurredAt: at(4),
      approvalReference: id(80),
    });
    const adapter = ports(approved);
    vi.mocked(adapter.publicationPolicy.validate).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      offeringReference: id(10),
      offeringVersion: 4,
      supplierReference: id(3),
      inventoryItemReference: id(4),
      supplierActive: true,
      itemPurchasable: true,
      baseUnit: "EA",
      conversionValid: false,
      qualificationEligible: false,
      approvedPriceAvailable: true,
      approvalReference: id(80),
      approvedAt: at(9),
      blockers: ["CONVERSION_INVALID"],
    });
    await expect(executeOffering(command("Publish", 4), adapter)).rejects.toMatchObject({
      code: "OFFERING_PUBLICATION_BLOCKED",
    });
    expect(adapter.repository.commit).not.toHaveBeenCalled();
  });
  it("requires an exact approved price decision before appending a price version", async () => {
    const adapter = ports(draft());
    vi.mocked(adapter.priceApproval.validate).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      offeringReference: id(10),
      offeringVersion: 1,
      priceRecordReference: id(30),
      priceVersionReference: id(31),
      approvalReference: id(80),
      approvedAt: at(1),
      approved: false,
    });
    await expect(
      executeOffering(
        {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(5),
          purpose: "OfferingManagement",
          permission: "procurement.offering.manage",
          operationReference: id(70),
          occurredAt: at(10),
          action: "AddPriceVersion",
          payload: {
            offeringReference: id(10),
            expectedVersion: 1,
            priceRecordReference: id(30),
            priceVersionReference: id(31),
            currency: "CAD",
            unitCost: "12.50",
            priceUnit: "CASE",
            quantityTiers: [],
            effectiveFrom: at(1),
            effectiveUntil: null,
            source: "Contract",
            scope: "Brand",
            scopeReference: id(2),
            approvalReference: id(80),
            reasonCode: "APPROVED_CONTRACT_PRICE",
          },
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "OFFERING_PUBLICATION_BLOCKED" });
    expect(adapter.repository.commit).not.toHaveBeenCalled();
  });
  it("checks lifecycle before dependency impact and preserves historical POs", async () => {
    const adapter = ports(draft());
    await expect(executeOffering(command("Suspend"), adapter)).rejects.toMatchObject({
      code: "OFFERING_STATE_CONFLICT",
    });
    expect(adapter.impact.inspect).not.toHaveBeenCalled();
  });
});
