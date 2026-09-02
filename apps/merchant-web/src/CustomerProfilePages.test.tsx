import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  CustomerProfileDetail,
  CustomerProfileList,
  CustomerProfileState,
} from "./CustomerProfilePages.js";
import { CustomerProfileClientError, parseCustomerProfileView } from "./customer-profile-pages.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const permissions = (allowed = true) => ({
  mayViewContacts: allowed,
  mayViewTransactions: allowed,
  mayViewLoyalty: allowed,
  mayViewConsent: allowed,
  mayViewCommunications: allowed,
  mayViewPrivacyCases: allowed,
  mayViewServiceNotes: allowed,
  mayViewAudit: allowed,
  mayManage: true,
});
const row = (masked = false) => ({
  customerReference: id(5),
  displayName: "Synthetic Customer",
  maskedContact: masked ? null : "s***@example.invalid",
  relationshipStatus: "Active",
  loyaltyStatus: masked ? null : "Active",
  tierCode: masked ? null : "GOLD",
  lastInteractionAt: "2026-08-14T10:00:00.000Z",
  consentSummary: masked ? null : "Granted",
  openCase: masked ? null : true,
});
function list(masked = false) {
  return {
    projectionName: "customer_profile_v1",
    projectionVersion: 1,
    screenId: "CRM-CUSTOMER-LIST",
    brandLabel: "Synthetic Brand",
    asOfUtc: "2026-08-14T11:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: permissions(!masked),
    rows: [row(masked)],
    detail: null,
  };
}
function detail(masked = false) {
  return {
    ...list(masked),
    screenId: "CRM-CUSTOMER-DETAIL",
    detail: {
      customerReference: id(5),
      aggregateVersion: 3,
      displayName: "Synthetic Customer",
      preferredLocale: "en-CA",
      relationshipStatus: "Active",
      creationBasis: "ExplicitRetentionConsent",
      userLinked: true,
      verifiedContacts: masked
        ? null
        : [
            {
              contactReference: id(6),
              contactType: "Email",
              maskedValue: "s***@example.invalid",
              verifiedAt: "2026-08-14T09:00:00.000Z",
            },
          ],
      transactionReferences: masked
        ? null
        : [
            {
              transactionType: "Order",
              transactionReference: id(7),
              linkedAt: "2026-08-14T10:00:00.000Z",
            },
          ],
      loyaltyAccounts: masked ? null : [id(8)],
      consentSummary: masked ? null : "Granted",
      communicationCount: masked ? null : 2,
      privacyCaseReferences: masked ? null : [id(9)],
      serviceNotes: masked
        ? null
        : [
            {
              noteReference: id(10),
              categoryCode: "SERVICE",
              note: "Synthetic service note",
              occurredAt: "2026-08-14T10:00:00.000Z",
            },
          ],
      auditReference: masked ? null : id(11),
    },
  };
}
describe("Customer Profile pages", () => {
  it("strictly parses list/detail and rejects undeclared contact fields", () => {
    expect(parseCustomerProfileView(list())).toMatchObject({
      screenId: "CRM-CUSTOMER-LIST",
      rows: [{ maskedContact: "s***@example.invalid" }],
    });
    expect(parseCustomerProfileView(detail())).toMatchObject({
      screenId: "CRM-CUSTOMER-DETAIL",
      detail: { creationBasis: "ExplicitRetentionConsent" },
    });
    expect(() => parseCustomerProfileView({ ...list(), email: "raw@example.invalid" })).toThrow(
      CustomerProfileClientError,
    );
  });
  it("renders canonical list filters and purpose-scoped summaries", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerProfileList view={parseCustomerProfileView(list())} />
      </MemoryRouter>,
    );
    for (const value of [
      "CRM-CUSTOMER-LIST",
      "Exact authorized contact / name token",
      "Status / program / tier",
      "Consent / last interaction / open case",
      "s***@example.invalid",
      "View Customer",
      "purpose logged",
    ])
      expect(html).toContain(value);
  });
  it("renders verified references and guarded link without source rewrite", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerProfileDetail view={parseCustomerProfileView(detail())} />
      </MemoryRouter>,
    );
    for (const value of [
      "CRM-CUSTOMER-DETAIL",
      "Verified contacts",
      "Linked transactions",
      "Attach verified contact reference",
      "Link eligible Guest transaction with proof",
      "Real Email/Phone stays in Identity",
      "never rewrites an Order",
    ])
      expect(html).toContain(value);
  });
  it("omits restricted families and keeps stale data read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerProfileDetail
          view={parseCustomerProfileView({ ...detail(true), freshness: "Stale" })}
        />
      </MemoryRouter>,
    );
    for (const value of [
      "Verified contacts",
      "Linked transactions",
      "Loyalty accounts",
      "Consent Granted",
      "Communications",
      "Privacy / case summary",
      "Service notes",
      "Audit reference",
    ])
      expect(html).not.toContain(value);
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
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
      expect(renderToStaticMarkup(<CustomerProfileState state={state} />)).toContain("status");
  });
});
