import { describe, expect, it, vi } from "vitest";
import {
  createConsentPreferenceRecord,
  customerInstant,
  customerReference,
  evaluateCommunicationPermission,
  executeConsentPreferenceCommand,
  latestConsent,
  recordConsentChoice,
  updateContactPreference,
  type ConsentPreferenceCommand,
} from "../index.js";
const id = (n: number) =>
  customerReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (h: number) => customerInstant(`2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z`);
const empty = () =>
  createConsentPreferenceRecord({
    tenantReference: id(1),
    brandReference: id(2),
    customerReference: id(3),
    occurredAt: at(8),
  });
const choice = (
  record = empty(),
  status: "Granted" | "Withdrawn" = "Granted",
  overrides: Record<string, unknown> = {},
) =>
  recordConsentChoice(record, {
    expectedVersion: record.aggregateVersion,
    consentReference: id(10 + record.aggregateVersion),
    purpose: "Marketing",
    channel: "Email",
    status,
    contactMethodReference: id(20),
    policyVersion: "policy-1",
    jurisdictionCode: "CA_ON",
    sourceCode: "CUSTOMER_PORTAL",
    actorReference: id(4),
    effectiveAt: at(9 + record.aggregateVersion),
    recordedAt: at(9 + record.aggregateVersion),
    evidenceReference: id(30 + record.aggregateVersion),
    ...overrides,
  });
describe("Consent and Contact Preference", () => {
  it("appends choices and derives the latest status without exposing a contact value", () => {
    const granted = choice(),
      withdrawn = choice(granted, "Withdrawn");
    expect(withdrawn.choices).toHaveLength(2);
    expect(latestConsent(withdrawn, "Marketing", "Email")?.status).toBe("Withdrawn");
    expect(JSON.stringify(withdrawn)).not.toContain("@");
  });
  it("withdrawal immediately blocks new Marketing while operational messages stay separate", () => {
    const record = choice(choice(), "Withdrawn");
    expect(
      evaluateCommunicationPermission({
        record,
        classification: "Marketing",
        purpose: "Marketing",
        channel: "Email",
      }),
    ).toMatchObject({ allowed: false, reason: "NO_CURRENT_GRANT" });
    expect(
      evaluateCommunicationPermission({
        record,
        classification: "Operational",
        purpose: "Marketing",
        channel: "Email",
      }),
    ).toMatchObject({ allowed: true, consentReference: null });
  });
  it("rejects an older-effective choice that would rewrite current status", () => {
    const record = choice();
    expect(() => choice(record, "Withdrawn", { effectiveAt: at(9), recordedAt: at(11) })).toThrow();
  });
  it("keeps preference distinct from authorization and validates quiet hours", () => {
    const record = choice(),
      updated = updateContactPreference(record, {
        expectedVersion: record.aggregateVersion,
        preferredLanguage: "en-CA",
        preferredChannel: "SMS",
        quietHours: { startMinute: 1320, endMinute: 480 },
        frequencyCode: "Reduced",
        storeReference: id(40),
        evidenceReference: id(41),
        actorReference: id(4),
        recordedAt: at(11),
      });
    expect(updated.preference).toMatchObject({
      preferredLanguage: "en-CA",
      frequencyCode: "Reduced",
    });
    expect(latestConsent(updated, "Marketing", "Email")?.status).toBe("Granted");
  });
  it("requires verified evidence and commits audit plus CustomerConsentChanged atomically", async () => {
    const before = empty();
    const command: ConsentPreferenceCommand = {
      type: "RecordChoice",
      tenantReference: id(1),
      brandReference: id(2),
      customerReference: id(3),
      actorReference: id(4),
      purpose: "ConsentAdministration",
      permission: "customer.consent.manage",
      operationReference: id(50),
      expectedVersion: 1,
      occurredAt: at(9),
      input: {
        consentReference: id(11),
        consentPurpose: "Marketing",
        channel: "Email",
        status: "Granted",
        contactMethodReference: id(20),
        policyVersion: "policy-1",
        jurisdictionCode: "CA_ON",
        sourceCode: "CUSTOMER_PORTAL",
        effectiveAt: at(9),
        evidenceReference: id(31),
      },
    };
    const ports = {
      authorization: {
        authorize: vi.fn(async () => ({
          authorized: true,
          mayManage: true,
          mayExportProof: true,
          mayViewEvidence: true,
        })),
      },
      evidence: {
        verify: vi.fn(async () => ({
          verified: true,
          identityContactValueDisclosed: false as const,
          customerReference: id(3),
          evidenceReference: id(31),
          policyApproved: true,
        })),
      },
      repository: {
        load: vi.fn(async () => before),
        resolveOperation: vi.fn(async () => null),
        commit: vi.fn(async (record) => record),
      },
      projections: { load: vi.fn(async () => ({}) as never) },
      audit: { create: vi.fn(async () => ({}) as never) },
      references: {
        hashIntent: vi.fn(() => "digest"),
        equals: vi.fn((a: string, b: string) => a === b),
      },
    };
    const result = await executeConsentPreferenceCommand(command, ports);
    expect(result.event).toMatchObject({ eventName: "CustomerConsentChanged", status: "Granted" });
    expect(result.after.choices).toHaveLength(1);
    expect(ports.repository.commit).toHaveBeenCalledOnce();
  });
  it("fails closed when proof is not verified", async () => {
    const command = {
      type: "UpdatePreference",
      tenantReference: id(1),
      brandReference: id(2),
      customerReference: id(3),
      actorReference: id(4),
      purpose: "ConsentAdministration",
      permission: "customer.consent.manage",
      operationReference: id(51),
      expectedVersion: 1,
      occurredAt: at(9),
      input: {
        preferredLanguage: "en-CA",
        preferredChannel: "Email",
        quietHours: null,
        frequencyCode: "Standard",
        storeReference: null,
        evidenceReference: id(31),
      },
    } as const;
    await expect(
      executeConsentPreferenceCommand(command, {
        authorization: { authorize: vi.fn(async () => ({ authorized: true, mayManage: true })) },
        evidence: {
          verify: vi.fn(async () => ({
            verified: false,
            identityContactValueDisclosed: false as const,
            customerReference: id(3),
            evidenceReference: id(31),
            policyApproved: false,
          })),
        },
        repository: {
          load: vi.fn(async () => empty()),
          resolveOperation: vi.fn(async () => null),
          commit: vi.fn(async (record) => record),
        },
        projections: { load: vi.fn(async () => ({}) as never) },
        audit: { create: vi.fn(async () => ({}) as never) },
        references: { hashIntent: vi.fn(() => "x"), equals: vi.fn(() => true) },
      } as never),
    ).rejects.toThrow();
  });
});
