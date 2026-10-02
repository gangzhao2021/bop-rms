import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyRequestList, PrivacyRequestState } from "./PrivacyRequestPage.js";
import { parsePrivacyRequestView } from "./privacy-request-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = (mayViewVerification = true) => ({
  projectionName: "privacy_request_v1",
  projectionVersion: 1,
  screenId: "PRIVACY-REQUEST",
  brandLabel: "Demo Brand",
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayIntake: true, mayVerify: true, mayFulfill: true, mayViewVerification },
  rows: [
    {
      requestReference: id(1),
      subjectReference: id(2),
      right: "AccessPortability",
      status: "InReview",
      verificationReference: mayViewVerification ? id(3) : null,
      ownerReference: id(4),
      dueAt: "2026-09-13T10:00:00.000Z",
      holdCount: 0,
      pendingOwnerCount: 0,
      completedOwnerCount: 3,
      exportExpiresAt: "2026-08-15T10:00:00.000Z",
      aggregateVersion: 7,
    },
  ],
});
describe("PRIVACY-REQUEST", () => {
  it("renders scoped workflow, encrypted export and preservation warning", () => {
    const html = renderToStaticMarkup(
      <PrivacyRequestList view={parsePrivacyRequestView(view())} />,
    );
    expect(html).toContain("Privacy Rights Requests");
    expect(html).toContain("Encrypted single-use export");
    expect(html).toContain("Fulfill / deny with approved reason");
    expect(html).toContain("preserve required financial");
  });
  it("keeps permissioned actions disabled until authenticated command composition exists", () => {
    const html = renderToStaticMarkup(
      <PrivacyRequestList view={parsePrivacyRequestView(view())} />,
    );
    const disabledButtons = html.match(/<button[^>]*disabled=""/gu) ?? [];
    expect(disabledButtons).toHaveLength(4);
    expect(html).toContain('aria-describedby="privacy-actions-unavailable"');
    expect(html).toContain("Authenticated privacy commands are not connected.");
    expect(html).toContain("no request or owner data will be changed here.");
  });
  it("rejects verification evidence disclosed without permission", () => {
    const value = view(false);
    const first = value.rows[0];
    if (!first) throw new Error("fixture missing");
    first.verificationReference = id(9);
    expect(() => parsePrivacyRequestView(value)).toThrow();
  });
  it("becomes read-only when stale", () => {
    const html = renderToStaticMarkup(
      <PrivacyRequestList view={parsePrivacyRequestView({ ...view(), freshness: "Stale" })} />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("keeps the Phase 3 feature gate explicit without showing case data", () => {
    const html = renderToStaticMarkup(<PrivacyRequestState state="FeatureDisabled" />);
    expect(html).toContain("PRIVACY-REQUEST · PHASE 3");
    expect(html).toContain("Privacy Request disabled");
    expect(html).toContain("Filters stay disabled while the Phase 3 capability is disabled.");
    for (const label of [
      "Case ref / verified contact",
      "Rights type",
      "Status",
      "Owner",
      "Due / overdue",
      "Brand",
    ])
      expect(html).toContain(label);
    expect(html).toContain("Requests are not available");
    expect(html).toContain("Owner actions disabled");
    expect(html).not.toContain("00000000-0000-7000");
    expect(html).not.toContain("Encrypted single-use export");
  });
});
