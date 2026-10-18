import { expect, it } from "vitest";
import {
  createCurrentCatalogSelectionSource,
  type CurrentSelectionSourcePorts,
} from "../application/current-selection-source.js";
import { createCatalogSelectionValidationService } from "../application/selection-validation-service.js";
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function pair(n = 10) {
  const option = (offset: number) => ({
    optionReference: id(n + offset),
    optionSetReference: id(n),
    brandReference: id(1),
    stableCode: "OPTION_" + offset,
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic option" },
    localizedDescriptions: {},
    sortOrder: offset,
    defaultEligible: true,
    triggeredOptionSetReference: null as string | null,
    conflictOptionReferences: [] as string[],
    createdAt: at,
    createdByActorReference: id(2),
  });
  return {
    binding: {
      bindingReference: id(n + 1),
      optionSetReference: id(n),
      optionSetVersionReference: id(n + 2),
      purpose: "CHOICE",
      sortOrder: n,
      enabledOptionReferences: [id(n + 3), id(n + 4)],
      defaultSelections: [{ optionReference: id(n + 3), quantity: 1 }],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [] as string[],
      channelCodes: [] as string[],
      storeOverrideAllowed: false,
    },
    optionSet: {
      optionSetReference: id(n),
      brandReference: id(1),
      internalCode: "SET_" + n,
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(2),
      updatedAt: at,
      draft: {
        versionReference: id(n + 2),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic set" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 1,
        maximumSelection: 4,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 3,
        maximumTotalQuantity: 4,
        options: [option(3), option(4)] as const,
        createdAt: at,
        updatedAt: at,
      },
    },
  };
}

function fixture() {
  const bindings = [pair()];
  const release = {
    menuReference: id(70),
    menuVersionReference: id(71),
    releaseReference: id(72),
    snapshotDigest: "sha256:" + "a".repeat(64),
    channelCode: "CUSTOMER_PWA",
    orderTypeCode: "PICKUP",
    effectiveFrom: at,
    effectiveUntil: null as string | null,
    releasedAt: at,
  };
  const facts = {
    brandReference: id(1),
    storeReference: id(2),
    sellableReference: id(3),
    observedAt: at,
    release,
    published: {
      menuReference: id(70),
      menuVersionReference: id(71),
      releaseReference: id(72),
      snapshotDigest: release.snapshotDigest,
      sellableReference: id(3),
      productVersionReference: id(80),
    },
    sku: { sellableReference: id(3), productVersionReference: id(80), catalogEligible: true },
    bindings,
  };
  const input = {
    brandReference: id(1),
    storeReference: id(2),
    sourceChannel: "Web",
    orderType: "Pickup",
    sellableReference: id(3),
    optionSelections: [{ optionReference: id(13), quantity: 1 }],
    observedAt: at,
  };
  let calls = 0;
  const availability = { status: "Available", observedAt: at };
  const ports: CurrentSelectionSourcePorts = {
    clock: { now: () => at },
    facts: {
      async load() {
        calls++;
        return facts;
      },
    },
    availability: {
      async resolveCurrent() {
        return availability;
      },
    },
  };
  const service = createCatalogSelectionValidationService({
    snapshots: createCurrentCatalogSelectionSource(ports, {
      brandReference: id(1),
      storeReference: id(2),
      menuReference: id(70),
      sourceChannel: "Web",
      orderType: "Pickup",
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "PICKUP",
    }),
  });
  return { facts, input, availability, ports, service, calls: () => calls };
}
it("connects exact published membership and current rules to selection validation", async () => {
  const f = fixture();
  expect(await f.service.validateSelection(f.input)).toMatchObject({
    status: "Accepted",
    menuVersionReference: id(71),
    productVersionReference: id(80),
  });
  expect(await f.service.validateSelection({ ...f.input, optionSelections: [] })).toMatchObject({
    status: "Rejected",
    reason: "RULE_UNSATISFIED",
  });
});
it.each(["brandReference", "storeReference", "sourceChannel", "orderType"])(
  "denies wrong request %s before reading facts",
  async (key) => {
    const f = fixture();
    const value = key === "sourceChannel" ? "Qr" : key === "orderType" ? "DineIn" : id(99);
    expect((await f.service.validateSelection({ ...f.input, [key]: value })).status).toBe(
      "Rejected",
    );
    expect(f.calls()).toBe(0);
  },
);
it.each([
  "menuReference",
  "menuVersionReference",
  "releaseReference",
  "snapshotDigest",
  "sellableReference",
  "productVersionReference",
])("denies published %s mismatch", async (key) => {
  const f = fixture();
  Object.assign(f.facts.published, {
    [key]: key === "snapshotDigest" ? "sha256:" + "b".repeat(64) : id(99),
  });
  expect((await f.service.validateSelection(f.input)).status).toBe("Rejected");
});
it("denies expired release, ineligible SKU and non-current availability", async () => {
  for (const change of ["expiry", "sku", "unavailable", "observation"]) {
    const f = fixture();
    if (change === "expiry") f.facts.release.effectiveUntil = at;
    if (change === "sku") f.facts.sku.catalogEligible = false;
    if (change === "unavailable") f.availability.status = "Indeterminate";
    if (change === "observation") f.availability.observedAt = "2026-09-10T11:59:59.999Z";
    expect((await f.service.validateSelection(f.input)).status).toBe("Rejected");
  }
});
it("rejects wrong-brand and out-of-scope option sources", async () => {
  for (const change of ["brand", "channel", "sku", "future"]) {
    const f = fixture(),
      p = f.facts.bindings[0];
    if (!p) throw new Error("fixture missing");
    if (change === "brand") p.optionSet.brandReference = id(99);
    if (change === "channel") p.binding.channelCodes = ["POS"];
    if (change === "sku") p.binding.excludedSkuReferences = [id(3)];
    if (change === "future") p.optionSet.updatedAt = "2026-09-10T12:00:00.001Z";
    await expect(f.service.validateSelection(f.input)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  }
});
it("captures selection metadata and rules before awaiting availability", async () => {
  const f = fixture();
  f.ports.availability.resolveCurrent = async () => {
    f.facts.release.menuVersionReference = id(99);
    f.facts.bindings.length = 0;
    return f.availability;
  };
  expect(await f.service.validateSelection(f.input)).toMatchObject({
    status: "Accepted",
    menuVersionReference: id(71),
    ruleEvidence: [{ bindingReference: id(11) }],
  });
});

it("refuses future observations before reading and expiry or clock regression during availability", async () => {
  const future = fixture();
  future.ports.clock.now = () => "2026-09-10T11:59:59.999Z";
  expect((await future.service.validateSelection(future.input)).status).toBe("Rejected");
  expect(future.calls()).toBe(0);
  for (const mode of ["expiry", "backward"]) {
    const f = fixture();
    let now = at;
    f.facts.release.effectiveUntil = "2026-09-10T12:00:01.000Z";
    f.ports.clock.now = () => now;
    f.ports.availability.resolveCurrent = async () => {
      now = mode === "expiry" ? "2026-09-10T12:00:01.000Z" : "2026-09-10T11:59:59.999Z";
      return f.availability;
    };
    expect((await f.service.validateSelection(f.input)).status).toBe("Rejected");
  }
});
