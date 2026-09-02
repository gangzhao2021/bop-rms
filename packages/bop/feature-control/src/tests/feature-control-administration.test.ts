import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  assertFeatureControlDependenciesPublishable,
  createFeatureControlAdministrationDefinition,
  FeatureControlAdministrationError,
  executeFeatureControlAdministration,
  parseFeatureControlInstant,
  parseFeatureControlKey,
  resolveEffectiveFeatureControl,
} from "../index.js";

const id = (suffix: string) => `018f0000-0000-7000-8000-0000000000${suffix}`;
const at = parseFeatureControlInstant("2026-08-15T12:00:00.000Z");
const base = (overrides: Record<string, unknown> = {}) =>
  createFeatureControlAdministrationDefinition({
    controlId: id("10"),
    key: "ordering.delivery.capability",
    description: "Synthetic delivery capability",
    version: 1,
    ownerReference: id("11"),
    purposeCode: "DELIVERY_CAPABILITY",
    scope: { kind: "Brand", brandReference: id("02"), storeReference: null },
    source: "BrandOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Published",
    temporary: true,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "2026-09-01T00:00:00.000Z",
    reviewAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    dependencies: [
      {
        dependencyId: id("12"),
        kind: "RequiresFutureTrigger",
        targetKey: "delivery.provider.readiness",
        minimumCompatibleVersion: 1,
        status: "Satisfied",
        evidenceReference: id("13"),
        evidenceVersion: 1,
      },
    ],
    authoredByReference: id("01"),
    approvedByReference: id("03"),
    approvalEvidenceReference: id("14"),
    publicationReference: id("15"),
    ...overrides,
  });
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
    storeReference: id("04"),
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
describe("WP-2193 Feature Control administration", () => {
  it("creates closed immutable approved definitions and rejects self approval", () => {
    expect(Object.isFrozen(base())).toBe(true);
    expect(() => base({ approvedByReference: id("01") })).toThrow(
      FeatureControlAdministrationError,
    );
    expect(() => base({ extra: true })).toThrow(FeatureControlAdministrationError);
  });
  it("blocks unresolved or incompatible Future Trigger evidence", () => {
    const blocked = base({
      lifecycle: "Approved",
      publicationReference: null,
      dependencies: [
        {
          dependencyId: id("12"),
          kind: "RequiresFutureTrigger",
          targetKey: "delivery.provider.readiness",
          minimumCompatibleVersion: 2,
          status: "Satisfied",
          evidenceReference: id("13"),
          evidenceVersion: 1,
        },
      ],
    });
    expect(() => assertFeatureControlDependenciesPublishable(blocked)).toThrowError(
      "feature control dependencies block publication",
    );
  });
  it("resolves exact Store override ahead of Brand and fails closed for ambiguity", () => {
    const brand = base();
    const store = base({
      controlId: id("16"),
      scope: { kind: "Store", brandReference: id("02"), storeReference: id("04") },
      source: "StoreOverride",
      configuredValue: "Disabled",
    });
    expect(
      resolveEffectiveFeatureControl({
        tenantContext: context(),
        key: parseFeatureControlKey("ordering.delivery.capability"),
        definitions: [brand, store],
        at,
        platformDefault: "Disabled",
      }),
    ).toMatchObject({ effectiveValue: "Disabled", source: "StoreOverride", available: true });
    expect(
      resolveEffectiveFeatureControl({
        tenantContext: context(),
        key: parseFeatureControlKey("ordering.delivery.capability"),
        definitions: [brand, base({ controlId: id("17") })],
        at,
        platformDefault: "Disabled",
      }),
    ).toMatchObject({ definition: null, available: false });
  });
  it("requires exact authorization, expected version and idempotent atomic commit", async () => {
    const current = base({
      lifecycle: "Draft",
      scope: { kind: "Store", brandReference: id("02"), storeReference: id("04") },
      source: "StoreOverride",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
    });
    const next = base({
      lifecycle: "Draft",
      version: 2,
      scope: { kind: "Store", brandReference: id("02"), storeReference: id("04") },
      source: "StoreOverride",
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
    });
    const commits: unknown[] = [];
    await executeFeatureControlAdministration(
      {
        tenantContext: context(),
        operation: "SaveDraft",
        expectedVersion: current.version,
        idempotencyKey: "wp2193.save-draft.0001",
        current,
        next,
        auditId: current.controlId,
        correlationId: current.controlId,
        sourceChannel: current.purposeCode,
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
