import { describe, expect, it } from "vitest";
import {
  ProviderIntegrationProjectionError,
  authorizeProviderAdminAction,
  buildProviderIntegrationProjection,
  parseProviderIntegrationSource,
} from "./provider-integration-admin.js";
const id = (n: number) => `018f9995-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const source = () => ({
  integrationReference: id(1),
  tenantReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  providerCode: "STRIPE_CANADA",
  adapterCode: "STRIPE_PAYMENT_V1",
  ownerModule: "@rms/payment",
  capabilityCodes: ["PAYMENT", "WEBHOOK"],
  environment: "Sandbox",
  status: "Disabled",
  aggregateVersion: 2,
  contractVersionCode: "PAYMENT_PROVIDER_V1",
  regionCode: "CA",
  lastSuccessAt: null,
  lastSafeErrorCode: "PROVIDER_UNAVAILABLE",
  credentialIssuedAt: "2026-07-15T10:00:00.000Z",
  credentialExpiresAt: "2026-09-15T10:00:00.000Z",
  webhookHealth: "Unknown",
  endpointHealth: "Unknown",
  rateLimitPerMinute: 100,
  quotaRemaining: null,
  retryCount: 2,
  deadLetterCount: 1,
  eligibleInboxReference: id(5),
  evidenceReferences: [id(6)],
  requiredEvidenceSatisfied: true,
  killSwitchState: "Open",
  sourceAsOf: at,
});
const projection = () =>
  buildProviderIntegrationProjection({
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    checkpointReference: id(7),
    projectedAt: at,
    freshnessStatus: "Fresh",
    completeness: "Complete",
    sources: [source()],
  });
describe("WP-2182 Provider integration admin projection", () => {
  it("builds safe accepted Provider metadata", () => {
    const row = projection().rows[0];
    expect(row).toMatchObject({
      providerCode: "STRIPE_CANADA",
      ownerModule: "@rms/payment",
      effectiveEnablement: "Blocked",
      credentialExpiryDisposition: "Current",
    });
    expect(JSON.stringify(row)).not.toMatch(/endpointUrl|secret|rawPayload|accountId/u);
  });
  it("rejects Provider-owner and scope mismatch", () => {
    expect(() =>
      parseProviderIntegrationSource({ ...source(), ownerModule: "@bop/notification" }),
    ).toThrow(ProviderIntegrationProjectionError);
    expect(() =>
      buildProviderIntegrationProjection({
        tenantReference: id(2),
        brandReference: id(99),
        storeReference: id(4),
        checkpointReference: id(7),
        projectedAt: at,
        freshnessStatus: "Fresh",
        completeness: "Complete",
        sources: [source()],
      }),
    ).toThrow("Provider integration administration is unavailable");
  });
  it("rejects live enablement without evidence and restricted extras", () => {
    expect(() =>
      parseProviderIntegrationSource({
        ...source(),
        environment: "Live",
        status: "Enabled",
        requiredEvidenceSatisfied: false,
      }),
    ).toThrow();
    expect(() =>
      parseProviderIntegrationSource({ ...source(), rawProviderPayload: "forbidden" }),
    ).toThrow();
  });
  it("routes sandbox, replay and disable intents to the owner", () => {
    const row = projection().rows[0];
    if (row === undefined) throw new Error("synthetic Provider row missing");
    expect(
      authorizeProviderAdminAction({
        row,
        action: "TestSandbox",
        actorReference: id(8),
        actorPermissions: ["integration.provider.test-sandbox"],
        purposeCode: "PROVIDER_ADMIN",
        expectedVersion: 2,
        idempotencyReference: id(9),
        auditReference: id(10),
      }),
    ).toMatchObject({
      owningModule: "@rms/payment",
      commandName: "TestSandboxProviderIntegration",
    });
    expect(
      authorizeProviderAdminAction({
        row,
        action: "ReplayInbox",
        actorReference: id(8),
        actorPermissions: ["integration.provider.replay-inbox"],
        purposeCode: "PROVIDER_ADMIN",
        expectedVersion: 2,
        idempotencyReference: id(9),
        auditReference: id(10),
      }).eligibleInboxReference,
    ).toBe(id(5));
  });
  it("blocks missing permission, stale version and invalid action state", () => {
    const row = projection().rows[0];
    if (row === undefined) throw new Error("synthetic Provider row missing");
    for (const input of [
      { action: "Enable", actorPermissions: [] },
      { action: "Enable", actorPermissions: ["integration.provider.enable"], expectedVersion: 1 },
      {
        action: "RotateCredential",
        actorPermissions: ["integration.provider.rotate-credential"],
        row: { ...row, credentialIssuedAt: null, credentialExpiresAt: null },
      },
    ] as const)
      expect(() =>
        authorizeProviderAdminAction({
          row: input.row ?? row,
          action: input.action,
          actorReference: id(8),
          actorPermissions: input.actorPermissions,
          purposeCode: "PROVIDER_ADMIN",
          expectedVersion: input.expectedVersion ?? 2,
          idempotencyReference: id(9),
          auditReference: id(10),
        }),
      ).toThrow();
  });
  it("supports bounded initialized-empty rebuild", () =>
    expect(
      buildProviderIntegrationProjection({
        tenantReference: id(2),
        brandReference: id(3),
        storeReference: null,
        checkpointReference: id(7),
        projectedAt: at,
        freshnessStatus: "Stale",
        completeness: "Partial",
        sources: [],
      }).initializedEmpty,
    ).toBe(true));
});
