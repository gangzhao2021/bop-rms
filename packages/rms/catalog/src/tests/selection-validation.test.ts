import { describe, expect, it } from "vitest";
import {
  CatalogError,
  createCatalogSelectionValidationService,
  type CatalogSelectionValidationPorts,
  type CurrentCatalogSelectionSnapshot,
} from "../index.js";

const id = (n: number) => `018f5200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  brand: id(1),
  store: id(2),
  sellable: id(3),
  menuVersion: id(4),
  productVersion: id(5),
  baseBinding: id(6),
  baseSetVersion: id(7),
  base: id(8),
  trigger: id(9),
  conflict: id(10),
  childBinding: id(11),
  childSetVersion: id(12),
  child: id(13),
  unknown: id(14),
};
const observedAt = "2026-08-02T17:00:00.000Z";

function snapshot(
  overrides: Partial<CurrentCatalogSelectionSnapshot> = {},
): CurrentCatalogSelectionSnapshot {
  return {
    brandReference: ids.brand as never,
    storeReference: ids.store as never,
    sourceChannel: "Qr",
    orderType: "DineIn",
    sellableReference: ids.sellable as never,
    availability: "Available",
    freshnessStatus: "Fresh",
    menuVersionReference: ids.menuVersion as never,
    productVersionReference: ids.productVersion as never,
    catalogChannelCode: "DINE_IN",
    catalogOrderTypeCode: "TABLE_SERVICE",
    effectiveFrom: "2026-08-02T16:00:00.000Z" as never,
    effectiveUntil: "2026-08-03T16:00:00.000Z" as never,
    resolvedAt: observedAt as never,
    rules: [
      {
        bindingReference: ids.baseBinding as never,
        optionSetVersionReference: ids.baseSetVersion as never,
        activationOptionReferences: [],
        minimumQuantity: 1,
        maximumQuantity: 2,
        options: [
          {
            optionReference: ids.base as never,
            maximumQuantity: 1,
            conflictOptionReferences: [ids.conflict as never],
          },
          {
            optionReference: ids.trigger as never,
            maximumQuantity: 1,
            conflictOptionReferences: [],
          },
          {
            optionReference: ids.conflict as never,
            maximumQuantity: 1,
            conflictOptionReferences: [ids.base as never],
          },
        ],
      },
      {
        bindingReference: ids.childBinding as never,
        optionSetVersionReference: ids.childSetVersion as never,
        activationOptionReferences: [ids.trigger as never],
        minimumQuantity: 1,
        maximumQuantity: 1,
        options: [
          {
            optionReference: ids.child as never,
            maximumQuantity: 1,
            conflictOptionReferences: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function command(optionSelections: readonly { optionReference: string; quantity: number }[]) {
  return {
    brandReference: ids.brand,
    storeReference: ids.store,
    sourceChannel: "Qr",
    orderType: "DineIn",
    sellableReference: ids.sellable,
    optionSelections,
    observedAt,
  };
}

function service(current: CurrentCatalogSelectionSnapshot | null = snapshot(), failure = false) {
  const ports: CatalogSelectionValidationPorts = {
    snapshots: {
      async resolveCurrent() {
        if (failure) throw new Error("synthetic dependency failure");
        return current;
      },
    },
  };
  return createCatalogSelectionValidationService(ports);
}

describe("Catalog current Sellable / Option selection validation", () => {
  it("accepts an exact current base selection with version-pinned evidence", async () => {
    await expect(
      service().validateSelection(command([{ optionReference: ids.base, quantity: 1 }])),
    ).resolves.toMatchObject({
      status: "Accepted",
      menuVersionReference: ids.menuVersion,
      productVersionReference: ids.productVersion,
      catalogChannelCode: "DINE_IN",
      ruleEvidence: [{ bindingReference: ids.baseBinding }],
      validatedAt: observedAt,
    });
  });

  it("activates a triggered rule and requires its selection", async () => {
    await expect(
      service().validateSelection(command([{ optionReference: ids.trigger, quantity: 1 }])),
    ).resolves.toEqual({ status: "Rejected", reason: "RULE_UNSATISFIED" });
    await expect(
      service().validateSelection(
        command([
          { optionReference: ids.trigger, quantity: 1 },
          { optionReference: ids.child, quantity: 1 },
        ]),
      ),
    ).resolves.toMatchObject({
      status: "Accepted",
      ruleEvidence: [{ bindingReference: ids.baseBinding }, { bindingReference: ids.childBinding }],
    });
  });

  it("rejects missing, inactive, unknown and excessive selections", async () => {
    await expect(service().validateSelection(command([]))).resolves.toEqual({
      status: "Rejected",
      reason: "RULE_UNSATISFIED",
    });
    await expect(
      service().validateSelection(command([{ optionReference: ids.child, quantity: 1 }])),
    ).resolves.toEqual({ status: "Rejected", reason: "RULE_UNSATISFIED" });
    await expect(
      service().validateSelection(command([{ optionReference: ids.unknown, quantity: 1 }])),
    ).resolves.toEqual({ status: "Rejected", reason: "OPTION_NOT_ENABLED" });
    await expect(
      service().validateSelection(command([{ optionReference: ids.base, quantity: 2 }])),
    ).resolves.toEqual({ status: "Rejected", reason: "OPTION_QUANTITY_INVALID" });
  });

  it("rejects selected conflict pairs", async () => {
    await expect(
      service().validateSelection(
        command([
          { optionReference: ids.base, quantity: 1 },
          { optionReference: ids.conflict, quantity: 1 },
        ]),
      ),
    ).resolves.toEqual({ status: "Rejected", reason: "OPTION_CONFLICT" });
  });

  it("fails closed for unavailable, wrong-scope, stale and dependency results", async () => {
    await expect(service(null).validateSelection(command([]))).resolves.toEqual({
      status: "Rejected",
      reason: "SELLABLE_UNAVAILABLE",
    });
    await expect(
      service(snapshot({ storeReference: id(50) as never })).validateSelection(
        command([{ optionReference: ids.base, quantity: 1 }]),
      ),
    ).rejects.toBeInstanceOf(CatalogError);
    await expect(
      service(snapshot({ effectiveUntil: observedAt as never })).validateSelection(
        command([{ optionReference: ids.base, quantity: 1 }]),
      ),
    ).rejects.toBeInstanceOf(CatalogError);
    await expect(
      service(snapshot({ freshnessStatus: "Stale" as never })).validateSelection(
        command([{ optionReference: ids.base, quantity: 1 }]),
      ),
    ).rejects.toBeInstanceOf(CatalogError);
    await expect(service(snapshot(), true).validateSelection(command([]))).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rejects malformed trigger graphs and dangling conflict references", async () => {
    const current = snapshot();
    const [baseRule, childRule] = current.rules;
    const [baseOption, ...otherBaseOptions] = baseRule?.options ?? [];
    if (baseRule === undefined || childRule === undefined || baseOption === undefined)
      throw new Error("synthetic rules missing");
    await expect(
      service(
        snapshot({
          rules: [{ ...baseRule, activationOptionReferences: [ids.base as never] }, childRule],
        }),
      ).validateSelection(command([{ optionReference: ids.base, quantity: 1 }])),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    await expect(
      service(
        snapshot({
          rules: [
            {
              ...baseRule,
              options: [
                {
                  ...baseOption,
                  conflictOptionReferences: [ids.unknown as never],
                },
                ...otherBaseOptions,
              ],
            },
            childRule,
          ],
        }),
      ).validateSelection(command([{ optionReference: ids.base, quantity: 1 }])),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  });

  it("rejects accessor-bearing input before resolving Catalog", async () => {
    const hostile = Object.defineProperty({ ...command([]) }, "sourceChannel", {
      enumerable: true,
      get: () => "Qr",
    });
    await expect(service().validateSelection(hostile)).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
  });
});
