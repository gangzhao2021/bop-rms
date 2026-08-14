import { describe, expect, it, vi } from "vitest";
import {
  addCommunicationTemplateVersion,
  createCommunicationTemplate,
  mayResendCommunication,
  parseNotificationReference,
  queryCommunicationHistory,
  transitionCommunicationTemplate,
} from "../index.js";
const id = (n: number) =>
  parseNotificationReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (h: number) => `2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z`;
const draft = () =>
  addCommunicationTemplateVersion(
    createCommunicationTemplate({
      templateReference: id(1),
      brandReference: id(2),
      templateKey: "ORDER_RECEIPT",
      displayName: "Order receipt",
      occurredAt: at(8),
    }),
    {
      expectedVersion: 1,
      versionReference: id(3),
      purpose: "Operational",
      locale: "en-CA",
      channel: "Email",
      requiredVariables: ["ORDER_NUMBER", "TOTAL"],
      previewFixtureReference: id(4),
      previewEscaped: true,
      trackingProhibited: true,
      actorReference: id(5),
      occurredAt: at(9),
    },
  );
describe("Communication governance", () => {
  it("creates an escaped tracking-free immutable template version", () => {
    expect(draft().versions[0]).toMatchObject({
      status: "Draft",
      previewEscaped: true,
      trackingProhibited: true,
      sequence: 1,
    });
  });
  it("requires review and a distinct approver before publish", () => {
    const template = draft(),
      review = transitionCommunicationTemplate(template, {
        expectedVersion: 2,
        targetStatus: "InReview",
        actorReference: id(5),
        approvalEvidenceReference: null,
        occurredAt: at(10),
      });
    expect(() =>
      transitionCommunicationTemplate(review, {
        expectedVersion: 3,
        targetStatus: "Published",
        actorReference: id(5),
        approvalEvidenceReference: id(6),
        occurredAt: at(11),
      }),
    ).toThrow();
    expect(
      transitionCommunicationTemplate(review, {
        expectedVersion: 3,
        targetStatus: "Published",
        actorReference: id(7),
        approvalEvidenceReference: id(6),
        occurredAt: at(11),
      }).versions[0],
    ).toMatchObject({ status: "Published", approvedBy: id(7) });
  });
  it("blocks tracking or unescaped preview fixtures", () => {
    const template = createCommunicationTemplate({
      templateReference: id(1),
      brandReference: id(2),
      templateKey: "ORDER_RECEIPT",
      displayName: "Order receipt",
      occurredAt: at(8),
    });
    expect(() =>
      addCommunicationTemplateVersion(template, {
        expectedVersion: 1,
        versionReference: id(3),
        purpose: "Operational",
        locale: "en-CA",
        channel: "Email",
        requiredVariables: [],
        previewFixtureReference: id(4),
        previewEscaped: false,
        trackingProhibited: true,
        actorReference: id(5),
        occurredAt: at(9),
      }),
    ).toThrow();
  });
  it("allows authorized resend only for failed operational communication", () => {
    expect(
      mayResendCommunication({
        classification: "Operational",
        suppressed: false,
        providerState: "Unknown",
        authorized: true,
      }),
    ).toBe(true);
    expect(
      mayResendCommunication({
        classification: "Marketing",
        suppressed: false,
        providerState: "Unknown",
        authorized: true,
      }),
    ).toBe(false);
    expect(
      mayResendCommunication({
        classification: "Operational",
        suppressed: true,
        providerState: "Rejected",
        authorized: true,
      }),
    ).toBe(false);
  });
  it("permission-trims history query results", async () => {
    const query = {
      brandReference: id(2),
      actorReference: id(5),
      purpose: "CommunicationSupport",
      permission: "notification.history.read",
      sourceReference: null,
      recipientReference: null,
      classification: "All",
      channel: "All",
      state: "All",
      fromUtc: null,
    } as const;
    const ports = {
      authorize: {
        check: vi.fn(async () => ({
          authorized: true,
          mayResendOperational: false,
          mayManageSuppression: true,
          mayEdit: false,
          mayApprove: false,
          mayTest: false,
        })),
      },
      projections: {
        history: vi.fn(async () => ({
          projectionName: "notification_communication_history_v1" as const,
          projectionVersion: 1 as const,
          brandReference: id(2),
          asOfUtc: at(12),
          freshness: "Current" as const,
          partial: false,
          permissions: { mayResendOperational: true, mayManageSuppression: true },
          rows: [],
        })),
        templates: vi.fn(async () => ({}) as never),
      },
    };
    await expect(queryCommunicationHistory(query, ports)).resolves.toMatchObject({
      permissions: { mayResendOperational: false, mayManageSuppression: true },
    });
  });
});
