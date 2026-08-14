import { describe, expect, it, vi } from "vitest";
import {
  customerInstant,
  customerReference,
  executeCustomerMergeReview,
  queryCustomerMergeReviews,
} from "../index.js";

const id = (n: number) =>
  customerReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (hour: number) =>
  customerInstant(`2026-08-14T${String(hour).padStart(2, "0")}:00:00.000Z`);
const start = (overrides: Record<string, unknown> = {}) => ({
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  purpose: "CustomerDuplicateResolution",
  permission: "customer.merge.review",
  operationReference: id(4),
  occurredAt: at(10),
  action: "StartReview",
  payload: {
    reviewReference: id(5),
    canonicalProfileReference: id(6),
    candidateProfileReference: id(7),
    canonicalProfileVersion: 3,
    candidateProfileVersion: 2,
    evidenceReferences: [id(8)],
  },
  ...overrides,
});
const review = () => ({
  reviewReference: id(5),
  tenantReference: id(1),
  brandReference: id(2),
  canonicalProfileReference: id(6),
  candidateProfileReference: id(7),
  canonicalProfileVersion: 3,
  candidateProfileVersion: 2,
  evidence: [
    {
      evidenceReference: id(8),
      kind: "VerifiedContact" as const,
      profileReferences: [id(6), id(7)] as const,
      verifiedAt: at(9),
    },
  ],
  conflicts: [{ fieldCode: "DISPLAY_NAME" as const, resolution: "KeepCanonical" as const }],
  linkedAccountReferences: [id(11)],
  linkedTransactionReferences: [id(12)],
  consentEvidenceReferences: [id(13)],
  impactReference: id(14),
  rollbackReference: id(15),
  requestedBy: id(3),
  requestedAt: at(10),
  status: "PendingApproval" as const,
  decidedBy: null,
  decidedAt: null,
  decisionReasonCode: null,
  decisionEvidenceReference: null,
  aggregateVersion: 1,
});
const ports = () => ({
  authorization: {
    authorize: vi.fn(async () => ({
      authorized: true,
      mayViewEvidence: true,
      mayReview: true,
      mayApprove: true,
    })),
  },
  candidates: {
    validate: vi.fn(async () => ({
      valid: true,
      sameBrand: true,
      broadFuzzyMatchUsed: false,
      evidence: review().evidence,
      conflicts: review().conflicts,
      linkedAccountReferences: review().linkedAccountReferences,
      linkedTransactionReferences: review().linkedTransactionReferences,
      consentEvidenceReferences: review().consentEvidenceReferences,
      impactReference: id(14),
      rollbackReference: id(15),
    })),
  },
  approval: {
    validate: vi.fn(async () => ({
      approved: true,
      approvalReference: id(20),
      approverReference: id(9),
      approvedAt: at(10),
    })),
  },
  repository: {
    load: vi.fn(async () => review()),
    resolveOperation: vi.fn(async () => null),
    commit: vi.fn(async (record) => record),
  },
  projection: {
    query: vi.fn(async () => ({
      projectionName: "customer_merge_review_v1" as const,
      projectionVersion: 1 as const,
      tenantReference: id(1),
      brandReference: id(2),
      asOfUtc: at(10),
      freshness: "Current" as const,
      partial: false,
      permissions: { mayViewEvidence: true, mayReview: true, mayApprove: true },
      review: null,
    })),
  },
  audit: { create: vi.fn(async () => ({}) as never) },
  references: {
    hashIntent: vi.fn(() => "digest"),
    equals: vi.fn((a: string, b: string) => a === b),
  },
});

describe("Customer merge evidence review", () => {
  it("starts only from exact evidence and preserves an explicit rollback reference", async () => {
    const result = await executeCustomerMergeReview(start(), ports());
    expect(result.review).toMatchObject({
      status: "PendingApproval",
      canonicalProfileReference: id(6),
      candidateProfileReference: id(7),
      rollbackReference: id(15),
    });
  });
  it("fails closed for cross-Brand or broad fuzzy candidates", async () => {
    const dependencies = ports();
    dependencies.candidates.validate.mockResolvedValue({
      ...(await dependencies.candidates.validate()),
      sameBrand: false,
      broadFuzzyMatchUsed: true,
    });
    await expect(executeCustomerMergeReview(start(), dependencies)).rejects.toMatchObject({
      code: "CUSTOMER_PROFILE_PROOF_REQUIRED",
    });
  });
  it("requires a distinct approved actor and emits a non-rewriting merge fact", async () => {
    const command = {
      ...start(),
      actorReference: id(9),
      permission: "customer.merge.approve",
      operationReference: id(21),
      action: "Approve",
      payload: { reviewReference: id(5), expectedVersion: 1, reasonCode: "VERIFIED_DUPLICATE" },
    };
    const result = await executeCustomerMergeReview(command, ports());
    expect(result.mergedFact).toMatchObject({
      eventName: "CustomerProfilesMerged",
      retainedProfileReference: id(7),
      sourceFactsRewritten: false,
      historicalActorsRewritten: false,
    });
  });
  it("rejects self-approval even when the permission adapter allows it", async () => {
    const dependencies = ports();
    dependencies.approval.validate.mockResolvedValue({
      approved: true,
      approvalReference: id(20),
      approverReference: id(3),
      approvedAt: at(10),
    });
    const command = {
      ...start(),
      permission: "customer.merge.approve",
      operationReference: id(22),
      action: "Approve",
      payload: { reviewReference: id(5), expectedVersion: 1, reasonCode: "VERIFIED_DUPLICATE" },
    };
    await expect(executeCustomerMergeReview(command, dependencies)).rejects.toMatchObject({
      code: "CUSTOMER_PROFILE_PERMISSION_DENIED",
    });
  });
  it("authorizes before a purpose-scoped projection read", async () => {
    const dependencies = ports();
    const query = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      purpose: "CustomerDuplicateResolution" as const,
      permission: "customer.merge.review" as const,
      reviewReference: null,
      exactContactReference: id(8),
      exactProfileReference: null,
    };
    await queryCustomerMergeReviews(query, dependencies);
    expect(dependencies.authorization.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.projection.query.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("independently trims evidence when the Actor lacks field permission", async () => {
    const dependencies = ports();
    dependencies.authorization.authorize.mockResolvedValue({
      authorized: true,
      mayViewEvidence: false,
      mayReview: true,
      mayApprove: false,
    });
    dependencies.projection.query.mockResolvedValue({
      ...(await dependencies.projection.query()),
      review: {
        ...review(),
        evidence: review().evidence,
        consentEvidenceReferences: review().consentEvidenceReferences,
      },
    } as never);
    const result = await queryCustomerMergeReviews(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "CustomerDuplicateResolution",
        permission: "customer.merge.review",
        reviewReference: id(5),
        exactContactReference: null,
        exactProfileReference: null,
      },
      dependencies,
    );
    expect(result.review).toMatchObject({ evidence: null, consentEvidenceReferences: null });
    expect(result.permissions.mayApprove).toBe(false);
  });
});
