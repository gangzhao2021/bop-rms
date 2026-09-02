import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CustomerMergeReview, CustomerMergeReviewState } from "./CustomerMergeReviewPage.js";
import {
  CustomerMergeReviewClientError,
  parseCustomerMergeReviewView,
} from "./customer-merge-review.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fixture = (visible = true) => ({
  projectionName: "customer_merge_review_v1",
  projectionVersion: 1,
  screenId: "CRM-MERGE-REVIEW",
  brandLabel: "Synthetic Brand",
  asOfUtc: "2026-08-14T11:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayViewEvidence: visible, mayReview: true, mayApprove: true },
  review: {
    reviewReference: id(1),
    aggregateVersion: 1,
    status: "PendingApproval",
    canonicalProfileReference: id(2),
    candidateProfileReference: id(3),
    canonicalProfileVersion: 3,
    candidateProfileVersion: 2,
    evidence: visible
      ? [
          {
            evidenceReference: id(4),
            kind: "VerifiedContact",
            verifiedAt: "2026-08-14T10:00:00.000Z",
          },
        ]
      : null,
    conflicts: [{ fieldCode: "DISPLAY_NAME", resolution: "KeepCanonical" }],
    linkedAccountReferences: [id(5)],
    linkedTransactionReferences: [id(6)],
    consentEvidenceReferences: visible ? [id(7)] : null,
    impactReference: id(8),
    rollbackReference: id(9),
    requestedBy: id(10),
    decidedBy: null,
    decisionEvidenceReference: null,
  },
});
describe("Customer merge review page", () => {
  it("strictly parses the contextual screen and rejects undeclared raw contact", () => {
    expect(parseCustomerMergeReviewView(fixture())).toMatchObject({
      screenId: "CRM-MERGE-REVIEW",
      review: { status: "PendingApproval" },
    });
    expect(() =>
      parseCustomerMergeReviewView({ ...fixture(), email: "raw-contact-prohibited" }),
    ).toThrow(CustomerMergeReviewClientError);
  });
  it("shows evidence, conflicts, impact, rollback and explicit decisions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerMergeReview view={parseCustomerMergeReviewView(fixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "CRM-MERGE-REVIEW",
      "Verified evidence",
      "Conflicting fields",
      "Linked accounts 1",
      "Impact reference",
      "Rollback reference",
      "Reject candidate",
      "Approve verified merge",
      "retains both Profile IDs",
      "never rewrites Order",
    ])
      expect(html).toContain(value);
  });
  it("omits evidence without field permission and makes stale review read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerMergeReview
          view={parseCustomerMergeReviewView({ ...fixture(false), freshness: "Stale" })}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Verified evidence");
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("covers every required contextual failure state", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<CustomerMergeReviewState state={state} />)).toContain("status");
  });
});
