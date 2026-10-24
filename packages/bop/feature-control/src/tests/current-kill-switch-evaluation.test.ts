import { expect, it } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  createCurrentKillSwitchEvaluationService,
  createFeatureControlDefinition,
  parseFeatureControlInstant,
  parseFeatureControlKey,
  type CurrentKillSwitchEvaluationPorts,
  type KillSwitchDefinition,
} from "../index.js";
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

function setup() {
  let now: string = at,
    reads = 0;
  const ports: CurrentKillSwitchEvaluationPorts = {
    clock: { now: () => now },
    context: {
      async resolveCurrent({ observedAt }) {
        const t = context();
        return createTenantContext(t.actor, t.brand, t.store, observedAt);
      },
    },
    definitions: {
      async loadCurrent() {
        reads++;
        return [kill({ state: { phase: "Inactive" } })];
      },
    },
  };
  const service = createCurrentKillSwitchEvaluationService(ports, {
    brandReference: ids.brand,
    storeReference: ids.storeA,
  });
  return {
    ports,
    service,
    reads: () => reads,
    setNow: (value: string) => {
      now = value;
    },
    evaluate: () => service.evaluate({ key, rolloutBucket: 0, evaluatedAt: at }),
  };
}
it("returns the existing inactive decision and in-flight policy", async () => {
  const f = setup();
  expect(await f.evaluate()).toMatchObject({
    backendExecution: "Allow",
    inFlightPolicy: "ReachSafeCheckpoint",
    reason: "KILL_INACTIVE",
  });
});
it("missing current definitions deny without inventing a default", async () => {
  const f = setup();
  f.ports.definitions.loadCurrent = async () => [];
  expect(await f.evaluate()).toMatchObject({
    backendExecution: "Deny",
    reason: "CONTROL_UNAVAILABLE",
  });
});
it("rejects revoked or wrong Store context before source lookup", async () => {
  for (const wrong of [false, true]) {
    const f = setup();
    f.ports.context.resolveCurrent = async () => (wrong ? context(ids.storeB) : null);
    await expect(f.evaluate()).rejects.toMatchObject({
      code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
    });
    expect(f.reads()).toBe(0);
  }
});
it("rejects revocation during source lookup", async () => {
  const f = setup();
  f.ports.definitions.loadCurrent = async () => {
    f.ports.context.resolveCurrent = async () => null;
    return [kill({ state: { phase: "Inactive" } })];
  };
  await expect(f.evaluate()).rejects.toMatchObject({
    code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
  });
});
it("rejects expiry or clock regression during a source await", async () => {
  for (const time of [until, "2026-07-29T13:59:59.999Z"]) {
    const f = setup();
    f.ports.definitions.loadCurrent = async () => {
      f.setNow(time);
      return [kill({ state: { phase: "Inactive" } })];
    };
    await expect(f.evaluate()).rejects.toMatchObject({
      code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
    });
  }
});
it("rejects future caller time without source lookup", async () => {
  const f = setup();
  f.setNow("2026-07-29T13:59:59.999Z");
  await expect(f.evaluate()).rejects.toMatchObject({
    code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
  });
  expect(f.reads()).toBe(0);
});
it("rejects another Actor after reading", async () => {
  const f = setup();
  let calls = 0;
  f.ports.context.resolveCurrent = async ({ observedAt }) => {
    const t = context(ids.storeA, ids.brand, ++calls === 1 ? ids.actor : ids.owner);
    return createTenantContext(t.actor, t.brand, t.store, observedAt);
  };
  await expect(f.evaluate()).rejects.toMatchObject({
    code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
  });
});
it("rejects duplicate scope definitions", async () => {
  const f = setup();
  f.ports.definitions.loadCurrent = async () => [kill(), kill({ version: 2 })];
  await expect(f.evaluate()).rejects.toMatchObject({
    code: "FEATURE_CONTROL_EVALUATION_UNAVAILABLE",
  });
});
