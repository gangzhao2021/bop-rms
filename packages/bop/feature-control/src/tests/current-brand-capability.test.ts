import { expect, it } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  createCurrentBrandCapabilityService,
  createFeatureControlAdministrationDefinition,
  organizationStoreCapabilityBindings,
  type CurrentBrandCapabilityPorts,
  type StoreCapabilityDependencyEvidence,
} from "../index.js";

const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T13:00:00.000Z";
const key = "organization.brand.detail",
  capability = "organization.org_brand_detail";
function context(withStore = false) {
  const actor = {
    actorType: "User",
    accountKind: "Workforce",
    actorReference: id(3),
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  };
  const brand = createBrand({
    brandReference: id(1),
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = withStore
    ? createStore({
        storeReference: id(2),
        brandReference: id(1),
        code: "SYNTHETIC",
        displayName: "Synthetic Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      })
    : null;
  return createTenantContext(actor as never, brand, store, at);
}
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(4),
    key,
    description: "Synthetic Brand page",
    version: 1,
    ownerReference: id(5),
    purposeCode: "BRAND_CONFIGURATION",
    scope: { kind: "Brand", brandReference: id(1), storeReference: null },
    source: "BrandOverride",
    defaultValue: "Disabled",
    configuredValue: "Enabled",
    lifecycle: "Published",
    temporary: false,
    effectiveFrom: at,
    effectiveUntil: null,
    reviewAt: until,
    expiresAt: null,
    dependencies: [],
    authoredByReference: id(6),
    approvedByReference: id(7),
    approvalEvidenceReference: id(8),
    publicationReference: id(9),
    ...overrides,
  });
}
function setup(definitions = [definition()]) {
  let now = at,
    held = 0,
    evidence: StoreCapabilityDependencyEvidence[] = [];
  const state = { context: context() };
  const source = {
    brandReference: id(1),
    storeReference: null,
    key,
    observedAt: at,
    dependencyCoverage: "Complete" as const,
    definitions,
  };
  const binding = organizationStoreCapabilityBindings[0];
  if (!binding) throw new Error("fixture");
  const hold = async <T>(work: () => Promise<T>) => {
    held++;
    try {
      return await work();
    } finally {
      held--;
    }
  };
  const ports: CurrentBrandCapabilityPorts = {
    clock: { now: () => now },
    authority: {
      withCurrentBrandScope: async (input, work) => {
        expect(input.storeReference).toBeNull();
        return hold(() => work(state.context));
      },
    },
    bindings: {
      withCurrentBinding: async (input, work) => {
        expect(input.storeReference).toBeNull();
        return hold(() => work(binding));
      },
    },
    definitions: {
      withCurrentDefinitions: async (input, work) => {
        expect(input.purposeCode).toBe("BRAND_CAPABILITY_EVALUATION");
        expect(input.actorReference).toBe(id(3));
        return hold(() => work(source));
      },
    },
    dependencies: {
      withCurrentEvidence: async (input, work) => {
        expect(input.storeReference).toBeNull();
        return hold(() => work(evidence));
      },
    },
  };
  const service = createCurrentBrandCapabilityService(ports, { brandReference: id(1) });
  const read = () =>
    service.withCurrentCapability(capability, async (decision) => {
      expect(held).toBeGreaterThanOrEqual(3);
      return decision;
    });
  return {
    state,
    source,
    ports,
    service,
    read,
    setTime: (value: string) => {
      now = value;
    },
    setEvidence: (value: StoreCapabilityDependencyEvidence[]) => {
      evidence = value;
    },
  };
}

it("uses the registered Brand page mapping with genuine Brand-only authority and held definitions", async () => {
  expect(await setup().read()).toMatchObject({
    capabilityKey: capability,
    controlKey: key,
    brandReference: id(1),
    storeReference: null,
    backendExecution: "Allow",
    frontendVisibility: "Show",
    reason: "Enabled",
    source: "BrandOverride",
  });
});
it("keeps missing, ambiguous, disabled and newer Draft controls unavailable", async () => {
  expect((await setup([]).read()).reason).toBe("Unavailable");
  expect((await setup([definition(), definition({ controlId: id(10) })]).read()).reason).toBe(
    "Unavailable",
  );
  expect(
    (
      await setup([
        definition(),
        definition({ version: 2, lifecycle: "Disabled", configuredValue: "Disabled" }),
      ]).read()
    ).reason,
  ).toBe("Disabled");
  expect(
    (
      await setup([
        definition(),
        definition({
          version: 2,
          lifecycle: "Draft",
          approvedByReference: null,
          approvalEvidenceReference: null,
          publicationReference: null,
        }),
      ]).read()
    ).reason,
  ).toBe("Unavailable");
});
it("does not substitute Store authority or consume Store override definitions", async () => {
  const x = setup();
  x.state.context = context(true);
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  const storeDefinition = definition({
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    source: "StoreOverride",
  });
  await expect(setup([storeDefinition]).read()).rejects.toHaveProperty(
    "code",
    "BRAND_CAPABILITY_UNAVAILABLE",
  );
});
it("rejects foreign scope, unconfirmed coverage and caller identity payloads", async () => {
  for (const change of [
    { brandReference: id(99) },
    { storeReference: id(2) },
    { dependencyCoverage: "Unconfirmed" },
  ]) {
    const x = setup();
    Object.assign(x.source, change);
    await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  }
  await expect(
    setup().service.withCurrentCapability(
      { capabilityKey: capability, allow: true },
      async (d) => d,
    ),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
it("requires genuine current dependency evidence rather than a stored Satisfied label", async () => {
  const dep = {
    dependencyId: id(30),
    kind: "RequiresFutureTrigger",
    targetKey: "organization.brand.readiness",
    minimumCompatibleVersion: 2,
    status: "Satisfied",
    evidenceReference: id(31),
    evidenceVersion: 2,
  };
  const x = setup([definition({ dependencies: [dep] })]);
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  x.setEvidence([
    {
      dependencyId: id(30),
      targetKey: "organization.brand.readiness",
      kind: "RequiresFutureTrigger",
      evidenceReference: id(31),
      evidenceVersion: 2,
      outcome: "Accepted",
      observedAt: at,
      validUntil: until,
    },
  ]);
  expect((await x.read()).reason).toBe("Enabled");
});
it("rechecks freshness after awaited work and refuses current authority withdrawal", async () => {
  const x = setup([definition({ effectiveUntil: "2026-10-06T12:00:01.000Z" })]);
  await expect(
    x.service.withCurrentCapability(capability, async () => {
      x.setTime("2026-10-06T12:00:01.000Z");
    }),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  const y = setup();
  await y.read();
  y.ports.authority.withCurrentBrandScope = async () => {
    throw new Error("synthetic denial");
  };
  await expect(y.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
