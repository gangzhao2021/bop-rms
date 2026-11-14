import { expect, it, vi } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  createCurrentStoreCapabilityService,
  createFeatureControlAdministrationDefinition,
  type CurrentStoreCapabilityPorts,
  type StoreCapabilityDependencyEvidence,
} from "../index.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  until = "2026-09-29T13:00:00.000Z";
function context(storeReference = id(2)) {
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
  const store = createStore({
    storeReference,
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
  });
  return createTenantContext(actor as never, brand, store, at);
}
function definition(overrides: Record<string, unknown> = {}) {
  return createFeatureControlAdministrationDefinition({
    controlId: id(4),
    key: "dining.table.capability",
    description: "Synthetic capability",
    version: 1,
    ownerReference: id(5),
    purposeCode: "TABLE_CAPABILITY",
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
    held = 0;
  const source = {
    brandReference: id(1),
    storeReference: id(2),
    key: "dining.table.capability",
    observedAt: at,
    dependencyCoverage: "Complete" as const,
    definitions,
  };
  const binding = {
    capabilityKey: "dining.din_table_list",
    controlKey: source.key,
    mappingReference: id(20),
    mappingVersion: 1,
    phase: "phase_2" as const,
    commitment: "Committed" as const,
  };
  let evidence: StoreCapabilityDependencyEvidence[] = [];
  const hold = async <T>(work: () => Promise<T>) => {
    held++;
    try {
      return await work();
    } finally {
      held--;
    }
  };
  const ports: CurrentStoreCapabilityPorts = {
    clock: { now: () => now },
    authority: { withCurrentStoreScope: async (_input, work) => hold(() => work(context())) },
    bindings: { withCurrentBinding: async (_input, work) => hold(() => work(binding)) },
    definitions: { withCurrentDefinitions: async (_input, work) => hold(() => work(source)) },
    dependencies: { withCurrentEvidence: async (_input, work) => hold(() => work(evidence)) },
  };
  const service = createCurrentStoreCapabilityService(ports, {
    brandReference: id(1),
    storeReference: id(2),
  });
  const read = () =>
    service.withCurrentCapability(binding.capabilityKey, async (decision) => {
      expect(held).toBeGreaterThanOrEqual(3);
      return decision;
    });
  return {
    ports,
    source,
    binding,
    read,
    service,
    setTime: (v: string) => {
      now = v;
    },
    setEvidence: (v: StoreCapabilityDependencyEvidence[]) => {
      evidence = v;
    },
  };
}
it("uses explicit mapping and approved Brand inheritance while all ports are held", async () => {
  const x = setup();
  expect(await x.read()).toMatchObject({
    reason: "Enabled",
    source: "BrandOverride",
    backendExecution: "Allow",
    frontendVisibility: "Show",
  });
});
it("honors Store disable without resurrecting an older published version or falling back to Brand", async () => {
  const old = definition({
    controlId: id(12),
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    source: "StoreOverride",
  });
  const x = setup([
    definition(),
    old,
    definition({ ...old, version: 2, lifecycle: "Disabled", configuredValue: "Disabled" }),
  ]);
  expect(await x.read()).toMatchObject({
    reason: "Disabled",
    source: "StoreOverride",
    controlVersion: 2,
    backendExecution: "Deny",
    frontendVisibility: "Hide",
  });
});
it("never enables missing or ambiguous definitions", async () => {
  expect((await setup([]).read()).reason).toBe("Unavailable");
  expect((await setup([definition(), definition({ controlId: id(11) })]).read()).reason).toBe(
    "Unavailable",
  );
});
it("rejects unconfirmed dependency coverage even if the visible array is empty", async () => {
  const x = setup();
  Object.assign(x.source, { dependencyCoverage: "Unconfirmed" });
  await expect(x.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
});
it("denies stale stored dependencies without pretending a current trigger was accepted", async () => {
  const x = setup([
    definition({
      dependencies: [
        {
          dependencyId: id(30),
          kind: "RequiresFutureTrigger",
          targetKey: "dining.table.readiness",
          minimumCompatibleVersion: 1,
          status: "Unsatisfied",
          evidenceReference: null,
          evidenceVersion: null,
        },
      ],
    }),
  ]);
  expect((await x.read()).reason).toBe("Unavailable");
});
for (const kind of [
  "RequiresCapability",
  "ConflictsWithCapability",
  "RequiresFutureTrigger",
] as const) {
  it(`requires actual held-current ${kind} evidence`, async () => {
    const dep = {
      dependencyId: id(30),
      kind,
      targetKey: "dining.table.readiness",
      minimumCompatibleVersion: 2,
      status: "Satisfied",
      evidenceReference: id(31),
      evidenceVersion: 2,
    };
    const x = setup([definition({ dependencies: [dep] })]);
    const receipt = {
      dependencyId: dep.dependencyId,
      kind,
      targetKey: dep.targetKey,
      evidenceReference: id(31),
      evidenceVersion: 2,
      outcome:
        kind === "RequiresCapability"
          ? ("Enabled" as const)
          : kind === "ConflictsWithCapability"
            ? ("Disabled" as const)
            : ("Accepted" as const),
      observedAt: at,
      validUntil: until,
    };
    x.setEvidence([receipt]);
    expect((await x.read()).reason).toBe("Enabled");
    x.setEvidence([{ ...receipt, evidenceVersion: 1 }]);
    await expect(x.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  });
}
it("rejects caller identity/evidence objects and implicit control-key rewriting before reading", async () => {
  const x = setup();
  const read = vi.spyOn(x.ports.definitions, "withCurrentDefinitions");
  for (const raw of [
    { capabilityKey: x.binding.capabilityKey, storeReference: id(2) },
    "dining.table.capability",
    "dining/din_table_list",
  ]) {
    await expect(x.service.withCurrentCapability(raw, async (d) => d)).rejects.toHaveProperty(
      "code",
      "STORE_CAPABILITY_UNAVAILABLE",
    );
  }
  expect(read).not.toHaveBeenCalled();
});
it("denies cross-Store authority and uncommitted mapping", async () => {
  const x = setup();
  x.ports.authority.withCurrentStoreScope = async (_i, w) => w(context(id(99)));
  await expect(x.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  const y = setup();
  Object.assign(y.binding, { commitment: "Future" });
  await expect(y.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
});
it("rejects revoked holder, duplicate callbacks and substituted holder result", async () => {
  const x = setup();
  x.ports.bindings.withCurrentBinding = async (_i, w) => {
    await w(x.binding);
    return w(x.binding);
  };
  await expect(x.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  const y = setup();
  y.ports.authority.withCurrentStoreScope = async (_i, w) => {
    await w(context());
    throw Error("private denial");
  };
  await expect(y.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  const z = setup();
  z.ports.authority.withCurrentStoreScope = async (_i, w) => {
    await w(context());
    return {} as never;
  };
  await expect(z.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
});
it("refuses expiry crossed during callback and backwards observation clock", async () => {
  const x = setup([definition({ effectiveUntil: until })]);
  await expect(
    x.service.withCurrentCapability(x.binding.capabilityKey, async () => {
      x.setTime(until);
    }),
  ).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  const y = setup();
  y.setTime("2026-09-29T11:59:59.000Z");
  await expect(y.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
});
it("never invokes a definition getter", async () => {
  const x = setup();
  const getter = vi.fn(() => id(1));
  x.source.definitions[0] = { ...x.source.definitions[0] } as never;
  Object.defineProperty(x.source.definitions[0], "unused", { get: getter, enumerable: true });
  await expect(x.read()).rejects.toHaveProperty("code", "STORE_CAPABILITY_UNAVAILABLE");
  expect(getter).not.toHaveBeenCalled();
});

it("does not silently inherit enabled Brand when an applicable Store override expires", async () => {
  const store = definition({
    controlId: id(12),
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    source: "StoreOverride",
    effectiveUntil: at,
    effectiveFrom: "2026-09-28T12:00:00.000Z",
    reviewAt: "2026-09-28T13:00:00.000Z",
  });
  expect(await setup([definition(), store]).read()).toMatchObject({
    reason: "Unavailable",
    source: "StoreOverride",
    backendExecution: "Deny",
    frontendVisibility: "Hide",
  });
});

it("keeps a new Enabled Draft unavailable and hides its module", async () => {
  const draft = definition({
    lifecycle: "Draft",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
  });
  expect(await setup([draft]).read()).toMatchObject({
    reason: "Unavailable",
    backendExecution: "Deny",
    frontendVisibility: "Hide",
    controlReference: null,
  });
});
it("does not replace a published Brand with an unpublished Store proposal", async () => {
  const draft = definition({
    controlId: id(12),
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    source: "StoreOverride",
    configuredValue: "Disabled",
    lifecycle: "Draft",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
  });
  expect(await setup([definition(), draft]).read()).toMatchObject({
    reason: "Enabled",
    source: "BrandOverride",
    backendExecution: "Allow",
    frontendVisibility: "Show",
  });
});
