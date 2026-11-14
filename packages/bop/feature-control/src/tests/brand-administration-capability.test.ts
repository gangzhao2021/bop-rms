import { expect, it } from "vitest";
import { parseBrandAdministrationContext, createTenantContext } from "@bop/tenant";
import {
  createCurrentBrandAdministrationCapabilityService,
  createCurrentBrandCapabilityService,
  createFeatureControlAdministrationDefinition,
  organizationStoreCapabilityBindings,
  type CurrentBrandAdministrationCapabilityPorts,
  type StoreCapabilityDependencyEvidence,
} from "../index.js";

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T13:00:00.000Z";
const capability = "organization.org_brand_detail",
  key = "organization.brand.detail";
function context(lifecycle = "Draft") {
  return parseBrandAdministrationContext({
    profile: "BrandAdministrationContextV1",
    purposeCode: "BRAND_ADMINISTRATION",
    store: null,
    resolvedAt: at,
    actor: {
      actorType: "User",
      accountKind: "Workforce",
      actorReference: id(3),
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    },
    brand: {
      brandReference: id(1),
      code: "SYNTHETIC",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle,
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  });
}
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(4),
    key,
    description: "Synthetic Brand detail",
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
function setup(definitions = [definition()], screen: "List" | "Detail" = "Detail") {
  const selectedCapability = screen === "List" ? "organization.org_brand_list" : capability;
  const selectedKey = screen === "List" ? "organization.brand.list" : key;
  let now = at,
    held = 0;
  const registered = organizationStoreCapabilityBindings.find(
    (entry) => entry.capabilityKey === selectedCapability,
  );
  if (!registered) throw new Error("fixture binding missing");
  const state = {
    context: context(),
    binding: { ...registered },
    evidence: [] as StoreCapabilityDependencyEvidence[],
  };
  const source = {
    brandReference: id(1),
    storeReference: null,
    key: selectedKey,
    observedAt: at,
    dependencyCoverage: "Complete" as const,
    definitions,
  };
  const hold = async <T>(work: () => Promise<T>) => {
    held++;
    try {
      return await work();
    } finally {
      held--;
    }
  };
  const ports: CurrentBrandAdministrationCapabilityPorts = {
    clock: { now: () => now },
    authority: {
      withCurrentBrandAdministrationScope: async (input, work) => {
        expect(input.storeReference).toBeNull();
        return hold(() => work(state.context));
      },
    },
    bindings: {
      withCurrentBinding: async (input, work) => {
        expect(input.capabilityKey).toBe(selectedCapability);
        return hold(() => work(state.binding));
      },
    },
    definitions: {
      withCurrentDefinitions: async (input, work) => {
        expect(input.purposeCode).toBe("BRAND_ADMINISTRATION");
        expect(input.actorReference).toBe(id(3));
        return hold(() => work(source));
      },
    },
    dependencies: {
      withCurrentEvidence: async (input, work) => {
        expect(input.storeReference).toBeNull();
        return hold(() => work(state.evidence));
      },
    },
  };
  const service = createCurrentBrandAdministrationCapabilityService(
    ports,
    {
      brandReference: id(1),
    },
    screen,
  );
  const read = () =>
    service.withCurrentCapability(selectedCapability, async (decision) => {
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
  };
}
it.each(["Draft", "Active", "Suspended", "Archived"])(
  "observes actual %s Brand through held administrative authority",
  async (lifecycle) => {
    const x = setup();
    x.state.context = context(lifecycle);
    expect(await x.read()).toMatchObject({
      reason: "Enabled",
      backendExecution: "Allow",
      frontendVisibility: "Show",
      storeReference: null,
      source: "BrandOverride",
      controlReference: id(4),
      controlVersion: 1,
    });
    expect(x.state.context.brand.lifecycle).toBe(lifecycle);
  },
);
it("preserves latest version, Disabled and missing configuration semantics", async () => {
  expect((await setup([]).read()).reason).toBe("Unavailable");
  expect((await setup([definition({ configuredValue: "Disabled" })]).read()).reason).toBe(
    "Disabled",
  );
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
it("does not treat stored dependency qualification as current evidence", async () => {
  const x = setup([
    definition({
      dependencies: [
        {
          dependencyId: id(30),
          kind: "RequiresFutureTrigger",
          targetKey: "organization.brand.readiness",
          minimumCompatibleVersion: 2,
          status: "Satisfied",
          evidenceReference: id(31),
          evidenceVersion: 2,
        },
      ],
    }),
  ]);
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  x.state.evidence = [
    {
      dependencyId: id(30),
      kind: "RequiresFutureTrigger",
      targetKey: "organization.brand.readiness",
      evidenceReference: id(31),
      evidenceVersion: 2,
      outcome: "Accepted",
      observedAt: at,
      validUntil: until,
    },
  ];
  expect((await x.read()).reason).toBe("Enabled");
});
it("rejects other capabilities and substituted registered control mappings", async () => {
  const x = setup();
  await expect(
    x.service.withCurrentCapability("organization.org_brand_list", async () => true),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  x.state.binding.controlKey = "organization.brand.other";
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
it.each([
  { brandReference: id(99) },
  { storeReference: id(2) },
  { dependencyCoverage: "Unconfirmed" },
  { observedAt: until },
])("rejects foreign or noncurrent definition source %j", async (change) => {
  const x = setup();
  Object.assign(x.source, change);
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
it("rejects foreign administration scope, extra authority and wrong observation time", async () => {
  for (const change of [
    { brand: { ...context().brand, brandReference: id(99) } },
    { resolvedAt: until },
    { allow: true },
  ]) {
    const x = setup();
    x.ports.authority.withCurrentBrandAdministrationScope = async (_input, work) =>
      work(parseBrandAdministrationContext({ ...x.state.context, ...change }));
    await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  }
});
it("retains original finite callback clock and source expiry checks", async () => {
  const x = setup();
  await expect(
    x.service.withCurrentCapability(capability, async () => x.setTime("2026-10-06T12:00:05.001Z")),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  const y = setup([definition({ effectiveUntil: "2026-10-06T12:00:01.000Z" })]);
  await expect(
    y.service.withCurrentCapability(capability, async () => y.setTime("2026-10-06T12:00:01.000Z")),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
it("requires exactly one completed authority callback and propagates withdrawal", async () => {
  const x = setup();
  x.ports.authority.withCurrentBrandAdministrationScope = async (_input, work) => {
    await work(x.state.context);
    return work(x.state.context);
  };
  await expect(x.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
  const y = setup();
  y.ports.authority.withCurrentBrandAdministrationScope = async () => {
    throw new Error("synthetic current authority withdrawn");
  };
  await expect(y.read()).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});
it("does not widen the old operational Brand service to Draft administration", async () => {
  const x = setup();
  const service = createCurrentBrandCapabilityService(
    {
      ...x.ports,
      authority: {
        withCurrentBrandScope: async (_input, work) =>
          work(createTenantContext(x.state.context.actor, x.state.context.brand, null, at)),
      },
    },
    { brandReference: id(1) },
  );
  await expect(service.withCurrentCapability(capability, async () => true)).rejects.toHaveProperty(
    "code",
    "BRAND_CAPABILITY_UNAVAILABLE",
  );
  const active = context("Active");
  const incompatible = createCurrentBrandCapabilityService(
    {
      ...x.ports,
      authority: {
        withCurrentBrandScope: async (_input, work) => work({ ...active, scopeKind: "Brand" }),
      },
    },
    { brandReference: id(1) },
  );
  await expect(
    incompatible.withCurrentCapability(capability, async () => true),
  ).rejects.toHaveProperty("code", "BRAND_CAPABILITY_UNAVAILABLE");
});

it.each(["Enabled", "Disabled"])(
  "reads the independently registered Brand list %s definition",
  async (configuredValue) => {
    const f = setup([definition({ key: "organization.brand.list", configuredValue })], "List");
    expect(await f.read()).toMatchObject({
      capabilityKey: "organization.org_brand_list",
      controlKey: "organization.brand.list",
      reason: configuredValue,
    });
    await expect(f.service.withCurrentCapability(capability, async () => true)).rejects.toThrow();
  },
);
it("does not turn absent Brand list definitions into an owning Enabled verdict", async () => {
  const f = setup([], "List");
  expect(await f.read()).toMatchObject({
    reason: "Unavailable",
    backendExecution: "Deny",
    frontendVisibility: "Hide",
  });
  expect(() =>
    createCurrentBrandAdministrationCapabilityService(
      f.ports,
      { brandReference: id(1) },
      "Unknown" as "List",
    ),
  ).toThrow();
});
