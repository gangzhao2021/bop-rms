import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createLiveGateRecord,
  evaluateLiveGate,
  executeLiveGateMutation,
  LiveGateContractError,
  parsePublishingCode,
  parsePublishingInstant,
  parsePublishingReference,
} from "../index.js";
const id = (n: string) => `018f0000-0000-7000-8000-0000000000${n}`;
const at = parsePublishingInstant("2026-08-15T12:00:00.000Z");
const missing = {
  requirementId: id("10"),
  categoryCode: "LEGAL_STORE",
  requirementCode: "IDR_0037_PREMISES",
  ownerReference: id("11"),
  applicable: true,
  status: "Missing",
  evidenceReference: null,
  evidenceVersion: null,
  validUntil: null,
  blockingReasonCode: "EXTERNAL_EVIDENCE_MISSING",
} as const;
function gate(overrides: Record<string, unknown> = {}) {
  return createLiveGateRecord({
    gateReference: id("12"),
    gateId: "STORE-LIVE-GATE-CA-ON-TOR-001",
    version: 1,
    scope: {
      tenantReference: id("13"),
      brandReference: id("02"),
      storeReference: id("03"),
      environment: "Production",
    },
    state: "Blocked",
    ownerReference: id("11"),
    requirements: [missing],
    submittedByReference: null,
    approvedByReference: null,
    decisionEvidenceReference: null,
    lastReviewedAt: null,
    changedAt: at,
    ...overrides,
  });
}
function context() {
  const actor = {
    actorType: "User",
    accountKind: "Workforce",
    actorReference: id("01"),
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  } as const;
  const brand = createBrand({
    brandReference: id("02"),
    code: "SYNTH",
    displayName: "Synthetic",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id("03"),
    brandReference: id("02"),
    code: "STORE",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  return createTenantContext(actor as never, brand, store, at);
}
describe("WP-2194 Live Gate", () => {
  it("keeps the canonical Pilot gate blocked while external evidence is missing", () => {
    const value = gate();
    expect(evaluateLiveGate(value, at)).toMatchObject({
      status: "Blocked",
      blockingRequirementCodes: ["IDR_0037_PREMISES"],
    });
    expect(Object.isFrozen(value)).toBe(true);
  });
  it("rejects an Approved decision when any applicable evidence is missing", () => {
    expect(() =>
      gate({
        state: "Approved",
        submittedByReference: id("01"),
        approvedByReference: id("04"),
        decisionEvidenceReference: id("14"),
        lastReviewedAt: at,
      }),
    ).toThrow(LiveGateContractError);
  });
  it("enforces independent approval and atomically supplies Audit plus next version", async () => {
    const accepted = {
      ...missing,
      status: "Accepted",
      evidenceReference: id("15"),
      evidenceVersion: 1,
      validUntil: "2026-09-15T12:00:00.000Z",
      blockingReasonCode: null,
    } as const;
    const current = gate({
      state: "InReview",
      submittedByReference: id("01"),
      requirements: [accepted],
    });
    const next = gate({
      version: 2,
      state: "Approved",
      submittedByReference: id("01"),
      approvedByReference: id("04"),
      decisionEvidenceReference: id("14"),
      lastReviewedAt: at,
      requirements: [accepted],
    });
    const commits: unknown[] = [];
    await executeLiveGateMutation(
      {
        tenantContext: context(),
        operation: "Approve",
        expectedVersion: current.version,
        idempotencyKey: "wp2194.approve.0001",
        current,
        next,
        auditId: parsePublishingReference(id("16")),
        correlationId: parsePublishingReference(id("17")),
        sourceChannel: parsePublishingCode("MERCHANT_WEB"),
      },
      {
        authorization: {
          authorize: async (request) =>
            Object.freeze({
              effect: "Allow",
              action: request.action,
              scopeKind: "Store",
              reason: "EXPLICIT_ALLOW",
              source: "ExplicitAllow",
            }) as never,
        },
        unitOfWork: { commit: async (input) => void commits.push(input) },
      },
    );
    expect(commits).toHaveLength(1);
  });
});
