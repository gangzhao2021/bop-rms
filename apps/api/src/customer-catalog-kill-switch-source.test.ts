import { expect, it, vi } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  createFeatureControlDefinition,
  parseFeatureControlInstant,
  parseFeatureControlKey,
  type KillSwitchDefinition,
} from "@bop/feature-control";
import { parseCatalogReference, parseCatalogCode, parseCatalogInstant } from "@rms/catalog";
import { createCustomerCatalogKillSwitchSource } from "./customer-catalog-kill-switch-source.js";

const ids = {
  actor: "018f0000-0000-7000-8000-000000000001",
  brand: "018f0000-0000-7000-8000-000000000002",
  storeA: "018f0000-0000-7000-8000-000000000003",
  storeB: "018f0000-0000-7000-8000-000000000004",
  otherBrand: "018f0000-0000-7000-8000-000000000005",
  owner: "018f0000-0000-7000-8000-000000000006",
  brandControl: "018f0000-0000-7000-8000-000000000007",
  storeControl: "018f0000-0000-7000-8000-000000000008",
  killControl: "018f0000-0000-7000-8000-000000000009",
  policy: "018f0000-0000-7000-8000-00000000000a",
  evidence: "018f0000-0000-7000-8000-00000000000b",
  audit: "018f0000-0000-7000-8000-00000000000c",
  correlation: "018f0000-0000-7000-8000-00000000000d",
} as const;

const at = parseFeatureControlInstant("2026-07-29T14:00:00.000Z");
const until = parseFeatureControlInstant("2026-08-29T14:00:00.000Z");
const review = parseFeatureControlInstant("2026-08-01T14:00:00.000Z");
const key = parseFeatureControlKey("ordering.checkout.release");

function context(
  storeReference: string | null = ids.storeA,
  brandReference: string = ids.brand,
  actorReference: string = ids.actor,
) {
  const actor = {
    actorType: "User" as const,
    accountKind: "Workforce" as const,
    actorReference,
    status: "Active" as const,
    authenticationMethod: "Oidc" as const,
    verificationLevel: "SingleFactor" as const,
    authenticatedAt: at,
    recentMfaAt: null,
  };
  const brand = createBrand({
    brandReference,
    code: brandReference === ids.brand ? "BRAND_A" : "BRAND_B",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store =
    storeReference === null
      ? null
      : createStore({
          storeReference,
          brandReference,
          code: storeReference === ids.storeA ? "STORE_A" : "STORE_B",
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

function kill(overrides: Partial<Record<string, unknown>> = {}): KillSwitchDefinition {
  return createFeatureControlDefinition({
    controlId: ids.killControl,
    key,
    version: 1,
    ownerReference: ids.owner,
    purposeCode: "CHECKOUT_SAFETY",
    scope: {
      kind: "Store",
      brandReference: ids.brand,
      storeReference: ids.storeA,
    },
    effectiveFrom: at,
    effectiveUntil: until,
    reviewAt: review,
    expiresAt: until,
    kind: "KillSwitch",
    defaultActive: false,
    mode: "SafePause",
    inFlightPolicy: "ReachSafeCheckpoint",
    recoveryPolicy: "Progressive",
    recoveryStages: [2_500, 5_000, 10_000],
    state: { phase: "Active" },
    ...overrides,
  }) as KillSwitchDefinition;
}

function fixture() {
  let definitions: readonly KillSwitchDefinition[] = [kill({ state: { phase: "Inactive" } })];
  let authorized = true,
    now: string = at;
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT DISTINCT")
      ? definitions.map((definition) => ({ definition, recorded_at: at }))
      : [],
  }));
  const resolveCurrent = vi.fn(async ({ observedAt }: { observedAt: string }) => {
    const t = context();
    return authorized ? createTenantContext(t.actor, t.brand, t.store, observedAt) : null;
  });
  const source = createCustomerCatalogKillSwitchSource({
    scope: {
      brandReference: ids.brand,
      storeReference: ids.storeA,
      channelCode: "QR",
      orderTypeCode: "DINE_IN",
    },
    transactions: { run: (work) => work({ query }) },
    context: { resolveCurrent },
    clock: { now: () => now },
    key,
    rolloutBucket: 0,
    evidenceLifetimeMilliseconds: 1000,
  });
  const input = {
    brandReference: parseCatalogReference(ids.brand),
    storeReference: parseCatalogReference(ids.storeA),
    sellableReference: parseCatalogReference(ids.evidence),
    channelCode: parseCatalogCode("QR"),
    orderTypeCode: parseCatalogCode("DINE_IN"),
    observedAt: parseCatalogInstant(at),
  };
  return {
    source,
    input,
    query,
    resolveCurrent,
    setDefinitions: (value: readonly KillSwitchDefinition[]) => {
      definitions = value;
    },
    revoke: () => {
      authorized = false;
    },
    setNow: (value: string) => {
      now = value;
    },
  };
}
it("reads current owner definitions on every call and follows actual kill changes", async () => {
  const f = fixture();
  expect(await f.source.loadEvidence(f.input)).toMatchObject({
    kind: "KillSwitch",
    status: "Clear",
    reasonCode: "KILL_INACTIVE",
    brandReference: ids.brand,
    storeReference: ids.storeA,
    observedAt: at,
    expiresAt: "2026-07-29T14:00:01.000Z",
  });
  f.setDefinitions([kill()]);
  expect(await f.source.loadEvidence(f.input)).toMatchObject({
    status: "Blocked",
    reasonCode: "KILL_ACTIVE",
  });
  expect(f.query.mock.calls.filter(([sql]) => sql.includes("SELECT DISTINCT"))).toHaveLength(2);
});
it("does not turn a missing control into permission to sell", async () => {
  const f = fixture();
  f.setDefinitions([]);
  expect(await f.source.loadEvidence(f.input)).toMatchObject({
    status: "Indeterminate",
    reasonCode: "CONTROL_UNAVAILABLE",
  });
});
it("rejects other scopes or channels before reading owner data", async () => {
  const f = fixture();
  for (const field of [
    "brandReference",
    "storeReference",
    "channelCode",
    "orderTypeCode",
  ] as const) {
    await expect(
      f.source.loadEvidence({
        ...f.input,
        [field]: field.endsWith("Reference") ? ids.otherBrand : "OTHER",
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  }
  expect(f.query).not.toHaveBeenCalled();
});
it("fails closed after authority withdrawal and does not expose storage errors", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.source.loadEvidence(f.input)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  g.query.mockRejectedValue(new Error("private SQL detail"));
  await expect(g.source.loadEvidence(g.input)).rejects.toThrow("catalog is unavailable");
});
it("discards expired evidence instead of extending its original observation", async () => {
  const f = fixture();
  f.setNow("2026-07-29T14:00:01.000Z");
  expect(await f.source.loadEvidence(f.input)).toBeNull();
});
