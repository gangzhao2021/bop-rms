import { describe, expect, it, vi } from "vitest";
import {
  addQualificationVersion,
  createSupplier,
  executeSupplier,
  parseSupplierInstant,
  parseSupplierReference,
  querySuppliers,
  reviewQualification,
  transitionSupplier,
  type SupplierAggregate,
  type SupplierCommand,
  type SupplierPorts,
} from "../index.js";

const id = (n: number) =>
  parseSupplierReference(`018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (day: number) =>
  parseSupplierInstant(`2026-08-${day.toString().padStart(2, "0")}T10:00:00.000Z`);
const hash = `sha256:${"8".repeat(64)}`;
const contacts = Object.freeze([
  {
    contactReference: id(20),
    roleCode: "ORDERING",
    displayName: "Synthetic Purchasing Contact",
    email: "purchasing@example.invalid",
    phone: "+14165550199",
  },
]);
const addresses = Object.freeze([
  {
    addressReference: id(21),
    addressType: "Ordering" as const,
    addressSummary: "Synthetic Toronto business address",
    countryCode: "CA",
    regionCode: "ON",
  },
]);
function draft(): SupplierAggregate {
  return createSupplier({
    supplierReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    supplierCode: "SUP-001",
    legalName: "Synthetic Foods Incorporated",
    displayName: "Synthetic Foods",
    supplierType: "FOOD_DISTRIBUTOR",
    taxRegistrationReference: id(22),
    contacts,
    addresses,
    actorReference: id(3),
    occurredAt: at(1),
  });
}
function command(action: SupplierCommand["action"], expectedVersion = 1): SupplierCommand {
  const common = { supplierReference: id(10), expectedVersion, reasonCode: "CONTROLLED_CHANGE" };
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "SupplierManagement",
    permission:
      action === "ReviewQualification"
        ? "procurement.qualification.review"
        : "procurement.supplier.manage",
    operationReference: id(50 + expectedVersion),
    occurredAt: at(2),
    action,
    payload:
      action === "Create"
        ? {
            supplierCode: "SUP-001",
            legalName: "Synthetic Foods Incorporated",
            displayName: "Synthetic Foods",
            supplierType: "FOOD_DISTRIBUTOR",
            taxRegistrationReference: id(22),
            contacts,
            addresses,
          }
        : action === "Update"
          ? {
              ...common,
              legalName: "Synthetic Foods Incorporated",
              displayName: "Synthetic Foods Updated",
              supplierType: "FOOD_DISTRIBUTOR",
              taxRegistrationReference: id(22),
              contacts,
              addresses,
            }
          : {
              ...common,
              approvalReference:
                action === "Activate" || action === "RestoreToInactive" ? id(80) : null,
            },
  };
}
const audit = Object.freeze({
  auditId: id(90),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(3) },
  actionCode: "PROCUREMENT_SUPPLIER",
  targetType: "Supplier",
  targetId: id(10),
  reasonCode: "CONTROLLED_CHANGE",
  correlationId: id(51),
  occurredAt: at(2),
  sourceChannel: "MerchantWeb",
  dataClassification: "Restricted" as const,
  retentionPolicyCode: "PROCUREMENT",
  retentionPolicyVersion: 1,
});
function projection(masked = false) {
  return {
    projectionName: "procurement_supplier_v1" as const,
    projectionVersion: 1 as const,
    tenantReference: id(1),
    brandReference: id(2),
    asOfUtc: at(2),
    freshness: "Current" as const,
    partial: false,
    rows: [
      {
        supplierReference: id(10),
        supplierVersion: 1,
        supplierCode: "SUP-001",
        legalName: "Synthetic Foods Incorporated",
        displayName: "Synthetic Foods",
        supplierType: "FOOD_DISTRIBUTOR",
        status: "Draft" as const,
        qualificationStatus: "Current" as const,
        nextQualificationExpiry: at(28),
        offeringCount: 3,
        openPurchaseOrderCount: 1,
        performanceSummary: masked ? null : "Performance source current",
        performanceFlag: masked ? null : false,
      },
    ],
    detail: {
      supplierReference: id(10),
      taxRegistrationReference: masked ? null : id(22),
      contacts: [
        {
          contactReference: id(20),
          roleCode: "ORDERING",
          displayName: masked ? null : "Synthetic Purchasing Contact",
          email: masked ? null : "p***@example.invalid",
          phone: masked ? null : "+1 *** *** 0199",
        },
      ],
      addresses: [
        {
          addressReference: id(21),
          addressType: "Ordering",
          addressSummary: masked ? null : "Synthetic Toronto business address",
          countryCode: "CA",
          regionCode: "ON",
        },
      ],
      qualifications: [
        {
          qualificationReference: id(30),
          qualificationVersionReference: id(31),
          qualificationType: "FOOD_SAFETY",
          jurisdiction: "CA_ON",
          certificateNumber: masked ? null : "SYNTHETIC-CERT-001",
          issuer: masked ? null : "Synthetic Authority",
          effectivePeriod: { effectiveFrom: at(1), effectiveUntil: at(28) },
          documentReference: masked ? null : id(32),
          status: "Effective" as const,
          scopeKind: "Supplier" as const,
          scopeReference: id(10),
        },
      ],
      offeringReferences: [id(40)],
      openPurchaseOrderReferences: masked ? null : [id(41)],
      performanceReference: masked ? null : id(42),
      historyCount: 1,
      auditReference: masked ? null : id(43),
    },
    nextCursor: null,
  };
}
function ports(existing: SupplierAggregate | null = draft()): SupplierPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewContactFields: true,
        mayViewQualificationEvidence: true,
        mayViewPurchaseOrderReferences: true,
        mayViewPerformance: true,
        mayManageSupplier: true,
        mayReviewQualification: true,
      })),
    },
    projection: { query: vi.fn(async () => projection()) },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => existing),
      isCodeAvailable: vi.fn(async () => true),
      commit: vi.fn(async (record) => record),
    },
    qualificationPolicy: {
      evaluateActivation: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        supplierReference: id(10),
        supplierVersion: existing?.aggregateVersion ?? 1,
        eligible: true,
        blockingQualificationReferences: [],
        approvalReference: id(80),
        approvedAt: at(1),
      })),
    },
    impact: {
      inspect: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        supplierReference: id(10),
        supplierVersion: existing?.aggregateVersion ?? 1,
        offeringCount: 3,
        openPurchaseOrderCount: 1,
        historicalPurchaseOrdersMutated: false,
      })),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      generate: vi.fn(() => id(10)),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Supplier Aggregate", () => {
  it("keeps stable Brand identity and never exposes a physical-delete transition", () => {
    const active = transitionSupplier(draft(), {
      expectedVersion: 1,
      action: "Activate",
      reasonCode: "APPROVED",
      approvalReference: id(80),
      actorReference: id(3),
      occurredAt: at(2),
    });
    const inactive = transitionSupplier(active, {
      expectedVersion: 2,
      action: "Deactivate",
      reasonCode: "RELATIONSHIP_ENDED",
      approvalReference: null,
      actorReference: id(3),
      occurredAt: at(3),
    });
    const archived = transitionSupplier(inactive, {
      expectedVersion: 3,
      action: "Archive",
      reasonCode: "RETENTION_ONLY",
      approvalReference: null,
      actorReference: id(3),
      occurredAt: at(4),
    });
    const restored = transitionSupplier(archived, {
      expectedVersion: 4,
      action: "RestoreToInactive",
      reasonCode: "REVIEW_REQUIRED",
      approvalReference: id(81),
      actorReference: id(3),
      occurredAt: at(5),
    });
    expect(restored).toMatchObject({
      supplierReference: id(10),
      brandReference: id(2),
      status: "Inactive",
      aggregateVersion: 5,
    });
    expect(() =>
      transitionSupplier(archived, {
        expectedVersion: 4,
        action: "Activate",
        reasonCode: "INVALID_DIRECT_RESTORE",
        approvalReference: id(81),
        actorReference: id(3),
        occurredAt: at(5),
      }),
    ).toThrowError(expect.objectContaining({ code: "SUPPLIER_STATE_CONFLICT" }));
  });
  it("adds qualification versions without overwriting evidence and reviews the exact pending version", () => {
    const added = addQualificationVersion(draft(), {
      expectedVersion: 1,
      qualificationReference: id(30),
      qualificationVersionReference: id(31),
      qualificationType: "FOOD_SAFETY",
      jurisdiction: "CA_ON",
      certificateNumber: "SYNTHETIC-CERT-001",
      issuer: "Synthetic Authority",
      effectivePeriod: { effectiveFrom: at(1), effectiveUntil: at(28) },
      documentReference: id(32),
      scopeKind: "Supplier",
      scopeReference: id(10),
      reasonCode: "INITIAL_EVIDENCE",
      actorReference: id(3),
      occurredAt: at(2),
    });
    const reviewed = reviewQualification(added, {
      expectedVersion: 2,
      qualificationReference: id(30),
      qualificationVersionReference: id(31),
      decision: "Approved",
      reasonCode: "EVIDENCE_ACCEPTED",
      actorReference: id(4),
      occurredAt: at(3),
    });
    const renewed = addQualificationVersion(reviewed, {
      expectedVersion: 3,
      qualificationReference: id(30),
      qualificationVersionReference: id(33),
      qualificationType: "FOOD_SAFETY",
      jurisdiction: "CA_ON",
      certificateNumber: "SYNTHETIC-CERT-002",
      issuer: "Synthetic Authority",
      effectivePeriod: { effectiveFrom: at(28), effectiveUntil: null },
      documentReference: id(34),
      scopeKind: "Supplier",
      scopeReference: id(10),
      reasonCode: "RENEWAL",
      actorReference: id(3),
      occurredAt: at(4),
    });
    expect(renewed.qualifications[0]?.versions).toMatchObject([
      { version: 1, reviewStatus: "Approved", certificateNumber: "SYNTHETIC-CERT-001" },
      { version: 2, reviewStatus: "Pending", certificateNumber: "SYNTHETIC-CERT-002" },
    ]);
  });
});

describe("Supplier application", () => {
  it("authorizes before the named projection and validates sensitive detail", async () => {
    const adapter = ports();
    const result = await querySuppliers(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "SupplierRead",
        permission: "procurement.supplier.read",
        selectedSupplierReference: id(10),
        search: "SUP-001",
        approvedContactReference: id(20),
        status: "All",
        supplierType: null,
        qualification: "All",
        performanceFlag: "All",
        hasOpenPurchaseOrder: null,
        cursor: null,
      },
      adapter,
    );
    expect(result.detail).toMatchObject({
      supplierReference: id(10),
      contacts: [{ email: "p***@example.invalid" }],
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });
  it("requires sensitive fields to be masked when access is absent", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayViewContactFields: false,
      mayViewQualificationEvidence: false,
      mayViewPurchaseOrderReferences: false,
      mayViewPerformance: false,
    });
    vi.mocked(adapter.projection.query).mockResolvedValueOnce(projection(true));
    await expect(
      querySuppliers(
        {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(3),
          purpose: "SupplierRead",
          permission: "procurement.supplier.read",
          selectedSupplierReference: id(10),
          search: null,
          approvedContactReference: null,
          status: "All",
          supplierType: null,
          qualification: "All",
          performanceFlag: "All",
          hasOpenPurchaseOrder: null,
          cursor: null,
        },
        adapter,
      ),
    ).resolves.toMatchObject({
      detail: { contacts: [{ email: null }], openPurchaseOrderReferences: null },
    });
  });
  it("checks qualification eligibility before activation and fails closed when blocked", async () => {
    const adapter = ports();
    vi.mocked(adapter.qualificationPolicy.evaluateActivation).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      supplierReference: id(10),
      supplierVersion: 1,
      eligible: false,
      blockingQualificationReferences: [id(30)],
      approvalReference: id(80),
      approvedAt: at(1),
    });
    await expect(executeSupplier(command("Activate"), adapter)).rejects.toMatchObject({
      code: "SUPPLIER_QUALIFICATION_BLOCKED",
    });
    expect(adapter.repository.commit).not.toHaveBeenCalled();
  });
  it("records suspension impact without mutating historical purchase orders", async () => {
    const active = transitionSupplier(draft(), {
      expectedVersion: 1,
      action: "Activate",
      reasonCode: "APPROVED",
      approvalReference: id(80),
      actorReference: id(3),
      occurredAt: at(2),
    });
    const adapter = ports(active);
    const result = await executeSupplier(command("Suspend", 2), adapter);
    expect(result).toMatchObject({
      supplier: { status: "Suspended" },
      impact: {
        offeringCount: 3,
        openPurchaseOrderCount: 1,
        historicalPurchaseOrdersMutated: false,
      },
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.repository.commit as never);
  });
  it("returns an ownership-validated idempotent replay", async () => {
    const adapter = ports(null);
    const first = await executeSupplier(command("Create"), adapter);
    vi.mocked(adapter.repository.resolveOperation).mockResolvedValueOnce(first);
    const replay = await executeSupplier(command("Create"), adapter);
    expect(replay.outcome).toBe("AlreadyApplied");
    expect(adapter.repository.commit).toHaveBeenCalledTimes(1);
  });
});
