import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentPreferenceDetail, ConsentPreferenceState } from "./ConsentPreferencePage.js";
import { parseConsentPreferenceView } from "./consent-preference-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = (mayViewEvidence = true) => ({
  projectionName: "customer_consent_preference_v1",
  projectionVersion: 1,
  screenId: "CONSENT-PREFERENCE",
  brandLabel: "Demo Brand",
  customerReference: id(1),
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  aggregateVersion: 3,
  permissions: { mayManage: true, mayExportProof: true, mayViewEvidence },
  choices: [
    {
      consentReference: id(2),
      purpose: "Marketing",
      channel: "Email",
      status: "Granted",
      contactMethodReference: id(3),
      policyVersion: "policy-1",
      jurisdictionCode: "CA_ON",
      sourceCode: "CUSTOMER_PORTAL",
      actorReference: id(4),
      effectiveAt: "2026-08-14T10:00:00.000Z",
      recordedAt: "2026-08-14T10:00:00.000Z",
      evidenceReference: mayViewEvidence ? id(5) : null,
    },
  ],
  preference: {
    preferredLanguage: "en-CA",
    preferredChannel: "SMS",
    quietHours: { startMinute: 1320, endMinute: 480 },
    frequencyCode: "Reduced",
    storeReference: id(6),
    recordedAt: "2026-08-14T11:00:00.000Z",
  },
});
describe("CONSENT-PREFERENCE", () => {
  it("strictly parses and renders separate preference and consent evidence", () => {
    const html = renderToStaticMarkup(
      <ConsentPreferenceDetail view={parseConsentPreferenceView(view())} />,
    );
    expect(html).toContain("Consent and contact preference");
    expect(html).toContain("not authorization");
    expect(html).toContain("Withdraw with verified proof");
    expect(html).toContain("Export proof");
  });
  it("rejects evidence disclosed without evidence permission", () => {
    const value = view(false);
    const first = value.choices[0];
    if (!first) throw new Error("fixture missing");
    first.evidenceReference = id(9);
    expect(() => parseConsentPreferenceView(value)).toThrow();
  });
  it("becomes read-only when the projection is stale", () => {
    const html = renderToStaticMarkup(
      <ConsentPreferenceDetail
        view={parseConsentPreferenceView({ ...view(), freshness: "Stale" })}
      />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("renders fail-closed unavailable state", () => {
    expect(renderToStaticMarkup(<ConsentPreferenceState state="Unavailable" />)).toContain(
      "No Customer choice is inferred",
    );
  });
});
