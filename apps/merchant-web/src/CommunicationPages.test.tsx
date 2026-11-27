import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CommunicationHistory,
  CommunicationHistoryUnavailable,
  CommunicationState,
  CommunicationTemplates,
} from "./CommunicationPages.js";
import {
  parseCommunicationHistoryView,
  parseCommunicationTemplateView,
} from "./communication-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const history = () => ({
  projectionName: "notification_communication_history_v1",
  projectionVersion: 1,
  screenId: "COMMS-HISTORY",
  brandLabel: "Demo Brand",
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayResendOperational: true, mayManageSuppression: true },
  rows: [
    {
      requestReference: id(1),
      sourceReference: id(2),
      classification: "Operational",
      recipientMasked: "e***@example.invalid",
      templateReference: id(3),
      templateVersion: 2,
      channel: "Email",
      providerState: "Unknown",
      suppressed: false,
      attemptedAt: "2026-08-14T11:00:00.000Z",
    },
  ],
});
const templates = () => ({
  projectionName: "notification_template_admin_v1",
  projectionVersion: 1,
  screenId: "COMMS-TEMPLATE-EDITOR",
  brandLabel: "Demo Brand",
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: { mayEdit: true, mayApprove: true, mayTest: true },
  templates: [
    {
      templateReference: id(3),
      templateKey: "ORDER_RECEIPT",
      displayName: "Order receipt",
      aggregateVersion: 3,
      current: {
        versionReference: id(4),
        sequence: 1,
        purpose: "Operational",
        locale: "en-CA",
        channel: "Email",
        requiredVariables: ["ORDER_NUMBER"],
        previewFixtureReference: id(5),
        previewEscaped: true,
        trackingProhibited: true,
        status: "InReview",
      },
    },
  ],
});
describe("Communication pages", () => {
  it("renders safe delivery fields without opaque references and keeps commands disabled", () => {
    const html = renderToStaticMarkup(
      <CommunicationHistory view={parseCommunicationHistoryView(history())} />,
    );
    expect(html).toContain("Source reference unavailable");
    expect(html).toContain("Version 2");
    expect(html).toContain("e***@example.invalid");
    expect(html).not.toContain(id(1));
    expect(html).not.toContain(id(2));
    expect(html).not.toContain(id(3));
    expect(html).toContain("Resend operational");
    expect(html).toContain("Manage suppression");
    expect(html).toContain("Communication commands are not connected");
    expect((html.match(/<button(?=[^>]* disabled)(?=[^>]*aria-describedby)/gu) ?? []).length).toBe(
      2,
    );
  });
  it("shows source-limited unavailable history instead of sample rows", () => {
    const html = renderToStaticMarkup(<CommunicationHistoryUnavailable state="FeatureDisabled" />);
    expect(html).toContain("History unavailable");
    expect(html).toContain("Source values unavailable");
    expect(html).toContain("disabled");
    expect(html).not.toContain("example.invalid");
  });
  it("rejects a Marketing row with an unsafe recipient value", () => {
    const value = history();
    const first = value.rows[0];
    if (!first) throw new Error("fixture missing");
    first.recipientMasked = "<script>";
    expect(() => parseCommunicationHistoryView(value)).toThrow();
  });
  it("renders escaped tracking-free Template governance actions", () => {
    const html = renderToStaticMarkup(
      <CommunicationTemplates view={parseCommunicationTemplateView(templates())} />,
    );
    expect(html).toContain("tracking prohibited");
    expect(html).toContain("Send test to approved sink");
    expect(html).toContain("Review / publish");
    expect(html).toContain("Communication commands are not connected");
    expect((html.match(/<button(?=[^>]* disabled)(?=[^>]*aria-describedby)/gu) ?? []).length).toBe(
      3,
    );
  });
  it("fails closed without Provider inference", () => {
    expect(renderToStaticMarkup(<CommunicationState state="Unavailable" />)).toContain(
      "No Provider outcome is inferred",
    );
  });
});
