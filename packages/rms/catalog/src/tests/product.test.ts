import { validateAuditRecord } from "@bop/audit";
import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";

import {
  CatalogError,
  createCatalogProductService,
  parseCatalogDecimal,
  parseCatalogLifecycleReasonCode,
  productLifecycleReviewAreas,
  parseCatalogReference,
  parseProductAggregate,
  parseCatalogProductInitialEditorContent,
  resolveSkuSellable,
  transitionCatalogLifecycle,
  type CatalogOperationRecord,
  type CatalogProductPorts,
  type ProductAggregate,
} from "../index.js";

const id = (n: number) => `018f4000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  actor: id(1),
  brand: id(2),
  product: id(3),
  version: id(4),
  sku: id(5),
  dimension: id(6),
  value: id(7),
  operation: id(8),
  audit: id(9),
  correlation: id(10),
  policy: id(11),
} as const;
const at = "2026-07-30T14:00:00.000Z";

function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, "0").repeat(8);
}
function context() {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "CATALOG",
      displayName: "Catalog Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
function audit(action: CatalogOperationRecord["action"]) {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    actor: { type: "User" as const, reference: ids.actor },
    actionCode: `CATALOG_PRODUCT_${action.toUpperCase()}`,
    targetType: "CatalogProduct",
    targetId: ids.product,
    beforeSummary: {},
    afterSummary: {},
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}
function fixture(
  options: {
    denied?: boolean;
    codeConflict?: boolean;
    auditMismatch?: boolean;
    tamperSaved?: boolean;
    lifecycleReasonCode?: string;
  } = {},
) {
  let aggregate: ProductAggregate | null = null;
  const operations = new Map<string, CatalogOperationRecord>();
  const generated = [ids.product, ids.version, ids.sku];
  const ports: CatalogProductPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: context(),
          permission: Object.freeze({
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "catalog.product.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: Object.freeze({
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
            }),
          }),
          audit: options.auditMismatch
            ? { ...audit(input.action), brandId: id(90) }
            : {
                ...audit(input.action),
                ...(input.action === "ChangeLifecycle" && options.lifecycleReasonCode !== undefined
                  ? { reasonCode: options.lifecycleReasonCode }
                  : {}),
              },
        } as never;
      },
    },
    references: {
      generate: () => generated.shift() ?? id(99),
      hashIntent: (value) => digest(value) as never,
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.productReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return !options.codeConflict;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return options.tamperSaved
          ? {
              ...input.record,
              aggregate: { ...input.record.aggregate, aggregateVersion: 2 },
            }
          : input.record;
      },
      async commit(input) {
        if (aggregate?.aggregateVersion !== input.expectedAggregateVersion)
          throw new CatalogError("CATALOG_VERSION_CONFLICT");
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
    optionSets: {
      async resolveVersion() {
        return null;
      },
    },
  };
  return { service: createCatalogProductService(ports), current: () => aggregate, ports };
}
function createInput() {
  return {
    internalCode: " latte ",
    productType: "NonAlcoholicBeverage",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Latte" },
    taxClassificationReference: null,
    skus: [
      {
        skuCode: " latte-12 ",
        localizedNames: { "en-CA": "Latte 12 oz" },
        variantSelections: [{ dimensionReference: ids.dimension, valueReference: ids.value }],
        unitOfSale: "EACH",
        unitQuantity: "1.000",
      },
    ],
    operationReference: ids.operation,
    requestedAt: at,
  };
}

describe("Product / SKU minimum aggregate", () => {
  const initialDetails = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: {},
    localizedDescriptions: { "en-CA": "Initial complete content" },
    preparationNotes: {},
    tagReferences: [],
    attributeValues: [],
    media: [],
    variantDimensions: [],
    variantCombinations: [],
    optionRules: [],
    allergenReferences: [],
    nutritionProfile: null,
  };
  it("creates complete initial content with owning identities and binds it to original replay", async () => {
    expect(parseCatalogProductInitialEditorContent(initialDetails, "en-CA")).toEqual(
      initialDetails,
    );
    const state = fixture(),
      command = { ...createInput(), skus: [], editorContent: initialDetails },
      created = await state.service.create(command);
    expect(created.aggregate.draft.skus).toEqual([]);
    expect(created.aggregate.draft.editorContent).toEqual(initialDetails);
    expect(created.aggregate.draft.versionReference).toBe(ids.version);
    expect(Object.isFrozen(created.aggregate.draft.editorContent)).toBe(true);
    await expect(state.service.create(command)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    await expect(
      state.service.create({
        ...command,
        editorContent: { ...initialDetails, localizedDescriptions: { "en-CA": "Changed" } },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });
  it("refuses unsupported initial full SKU mappings and getter content without writing", async () => {
    const state = fixture();
    await expect(
      state.service.create({ ...createInput(), editorContent: initialDetails }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    const getter = vi.fn(() => ({})),
      malformed = { ...initialDetails };
    Object.defineProperty(malformed, "localizedDescriptions", { enumerable: true, get: getter });
    await expect(
      state.service.create({ ...createInput(), skus: [], editorContent: malformed }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
    expect(state.current()).toBeNull();
  });
  it("creates a Brand-scoped Product with one Product-owned Draft SKU", async () => {
    const state = fixture();
    const result = await state.service.create(createInput());
    expect(result).toMatchObject({
      status: "Applied",
      aggregate: {
        brandReference: ids.brand,
        internalCode: "LATTE",
        lifecycle: "Draft",
        aggregateVersion: 1,
        draft: {
          status: "Draft",
          skus: [
            {
              productReference: ids.product,
              brandReference: ids.brand,
              skuCode: "LATTE-12",
              unitQuantity: "1",
            },
          ],
        },
      },
    });
    await expect(state.service.create(createInput())).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });

  it("fails closed on denied authority and Brand code conflict", async () => {
    await expect(fixture({ denied: true }).service.create(createInput())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    await expect(
      fixture({ codeConflict: true }).service.create(createInput()),
    ).rejects.toMatchObject({ code: "CATALOG_CODE_CONFLICT" });
    await expect(
      fixture({ auditMismatch: true }).service.create(createInput()),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  });

  it("uses Product aggregate version for SKU lifecycle changes", async () => {
    const state = fixture();
    await state.service.create(createInput());
    const activeProduct = await state.service.changeLifecycle({
      productReference: ids.product,
      skuReference: null,
      targetLifecycle: "Active",
      expectedAggregateVersion: 1,
      operationReference: id(20),
      requestedAt: at,
    });
    const activeSku = await state.service.changeLifecycle({
      productReference: ids.product,
      skuReference: ids.sku,
      targetLifecycle: "Active",
      expectedAggregateVersion: 2,
      operationReference: id(21),
      requestedAt: at,
    });
    expect(activeProduct.aggregate.aggregateVersion).toBe(2);
    expect(activeSku.aggregate.aggregateVersion).toBe(3);
    expect(resolveSkuSellable(activeSku.aggregate, ids.sku)).toMatchObject({
      sellableType: "Sku",
      catalogEligible: true,
      unitQuantity: "1",
    });
  });

  it("replaces the complete Draft at the Product version and rejects stale versions", async () => {
    const state = fixture();
    await state.service.create(createInput());
    const current = state.current();
    if (current === null) throw new Error("fixture did not persist the Product");
    for (const change of [{ unitOfSale: "KG" }, { unitQuantity: "2" }]) {
      await expect(
        state.service.replaceDraft({
          productReference: ids.product,
          expectedAggregateVersion: 1,
          draft: {
            ...current.draft,
            skus: current.draft.skus.map((sku) => ({ ...sku, ...change })),
          },
          operationReference: id(40),
          requestedAt: at,
        }),
      ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
      expect(state.current()).toEqual(current);
    }
    const replaced = await state.service.replaceDraft({
      productReference: ids.product,
      expectedAggregateVersion: 1,
      draft: {
        ...current.draft,
        localizedNames: { "en-CA": "Iced Latte" },
        updatedAt: at,
      },
      operationReference: id(30),
      requestedAt: at,
    });
    expect(replaced.aggregate).toMatchObject({
      aggregateVersion: 2,
      draft: { localizedNames: { "en-CA": "Iced Latte" } },
    });
    await expect(
      state.service.changeLifecycle({
        productReference: ids.product,
        skuReference: null,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: id(31),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  });

  it("rejects changed-intent replay and malformed repository success", async () => {
    const state = fixture();
    await state.service.create(createInput());
    await expect(
      state.service.create({ ...createInput(), internalCode: "MOCHA" }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
    await expect(
      fixture({ tamperSaved: true }).service.create(createInput()),
    ).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("enforces lifecycle policy without direct archive/reactivation shortcuts", () => {
    expect(transitionCatalogLifecycle("Active", "Suspended")).toBe("Suspended");
    expect(() => transitionCatalogLifecycle("Active", "Archived")).toThrowError(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
    expect(() => transitionCatalogLifecycle("Archived", "Active")).toThrowError(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  });

  it("accepts canonical positive decimal strings and rejects binary floats", () => {
    expect(parseCatalogDecimal("001.2300")).toBe("1.23");
    expect(() => parseCatalogDecimal(1.23)).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(() => parseCatalogDecimal("0")).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
  });

  it("rejects extra fields, independent/cross-Product SKU and duplicate variants", () => {
    const valid = {
      productReference: ids.product,
      brandReference: ids.brand,
      internalCode: "LATTE",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      draft: {
        versionReference: ids.version,
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Latte" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
      },
      createdAt: at,
      createdByActorReference: ids.actor,
      updatedAt: at,
    };
    expect(() => parseProductAggregate({ ...valid, price: 4.5 })).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(() =>
      parseProductAggregate(
        Object.defineProperty({ ...valid }, "hidden", {
          enumerable: false,
          value: "not accepted",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(() =>
      parseProductAggregate({
        ...valid,
        draft: {
          ...valid.draft,
          localizedNames: { "en-CA": "[Latte](https://example.invalid)" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    const sku = {
      skuReference: ids.sku,
      productReference: ids.product,
      brandReference: ids.brand,
      skuCode: "LATTE-12",
      lifecycle: "Draft",
      localizedNames: { "en-CA": "Latte 12 oz" },
      variantSelections: [{ dimensionReference: ids.dimension, valueReference: ids.value }],
      unitOfSale: "EACH",
      unitQuantity: "1",
      createdAt: at,
      createdByActorReference: ids.actor,
    };
    expect(() =>
      parseProductAggregate({
        ...valid,
        draft: {
          ...valid.draft,
          skus: [
            sku,
            {
              ...sku,
              skuReference: id(40),
              skuCode: "LATTE-16",
            },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(() =>
      parseProductAggregate({
        ...valid,
        draft: {
          ...valid.draft,
          skus: [{ ...sku, brandReference: id(41) }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });
});

describe("Product-owned category classification", () => {
  it("retains absent legacy classification without adding a JSON key", async () => {
    const { service } = fixture();
    const result = await service.create(createInput());
    expect(Object.hasOwn(result.aggregate.draft, "categoryClassification")).toBe(false);
    expect(parseProductAggregate(result.aggregate)).toEqual(result.aggregate);
    expect(() =>
      parseProductAggregate({
        ...result.aggregate,
        draft: { ...result.aggregate.draft, categoryClassification: undefined },
      }),
    ).toThrow(CatalogError);
  });
  it("canonicalizes classified create intent and returns the immutable original replay", async () => {
    const { service } = fixture();
    const value = { categoryReferences: [id(72), id(71)], primaryCategoryReference: id(71) };
    const result = await service.create({ ...createInput(), categoryClassification: value });
    expect(result.aggregate.draft.categoryClassification).toEqual({
      categoryReferences: [id(71), id(72)],
      primaryCategoryReference: id(71),
    });
    const replay = await service.create({
      ...createInput(),
      categoryClassification: {
        ...value,
        categoryReferences: [...value.categoryReferences].reverse(),
      },
    });
    expect(replay.status).toBe("AlreadyApplied");
    expect(replay.aggregate).toEqual(result.aggregate);
    await expect(
      service.create({
        ...createInput(),
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });
  it("rejects implicit coverage loss while permitting an explicit empty replacement", async () => {
    const { service } = fixture();
    const original = await service.create({
      ...createInput(),
      categoryClassification: { categoryReferences: [id(71)], primaryCategoryReference: id(71) },
    });
    const unknown = { ...original.aggregate.draft };
    delete unknown.categoryClassification;
    const request = {
      productReference: ids.product,
      expectedAggregateVersion: 1,
      draft: unknown,
      operationReference: id(80),
      requestedAt: at,
    };
    await expect(service.replaceDraft(request)).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
    const cleared = await service.replaceDraft({
      ...request,
      draft: {
        ...unknown,
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      },
    });
    expect(cleared.aggregate.draft.categoryClassification).toEqual({
      categoryReferences: [],
      primaryCategoryReference: null,
    });
    const replay = await service.create({
      ...createInput(),
      categoryClassification: { categoryReferences: [id(71)], primaryCategoryReference: id(71) },
    });
    expect(replay.aggregate).toEqual(original.aggregate);
  });
  it("rejects malformed create classification before persistence", async () => {
    for (const categoryClassification of [
      undefined,
      null,
      { categoryReferences: [id(71)], primaryCategoryReference: id(72) },
      { categoryReferences: [], primaryCategoryReference: null, permission: "Allow" },
    ]) {
      const state = fixture();
      await expect(
        state.service.create({ ...createInput(), categoryClassification }),
      ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
      expect(state.current()).toBeNull();
    }
  });
});

describe("Product repository policy denial", () => {
  it("preserves typed current policy denial during Create", async () => {
    const state = fixture();
    state.ports.repository.create = async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    };
    await expect(state.service.create(createInput())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(state.current()).toBeNull();
  });
  it("preserves typed current policy denial during Draft replace", async () => {
    const state = fixture();
    const initial = await state.service.create(createInput());
    state.ports.repository.commit = async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    };
    await expect(
      state.service.replaceDraft({
        productReference: initial.aggregate.productReference,
        draft: initial.aggregate.draft,
        expectedAggregateVersion: 1,
        operationReference: id(91),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.current()).toEqual(initial.aggregate);
  });
  it("preserves typed current policy denial during lifecycle", async () => {
    const state = fixture();
    const initial = await state.service.create(createInput());
    state.ports.repository.commit = async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    };
    await expect(
      state.service.changeLifecycle({
        productReference: initial.aggregate.productReference,
        skuReference: ids.sku,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: id(92),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.current()).toEqual(initial.aggregate);
  });
  it("bounds spoofed codes and private driver errors", async () => {
    for (const error of [
      Object.assign(new Error("synthetic private driver"), { code: "CATALOG_PERMISSION_DENIED" }),
      new Error("synthetic private driver"),
    ]) {
      const state = fixture();
      state.ports.repository.create = async () => {
        throw error;
      };
      await expect(state.service.create(createInput())).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        message: "catalog is unavailable",
      });
    }
  });
});

it.each(["Active", "Suspended", "Discontinued", "Archived"] as const)(
  "Draft replacement cannot change an existing SKU lifecycle to %s",
  async (lifecycle) => {
    const state = fixture();
    const original = (await state.service.create(createInput())).aggregate;
    await expect(
      state.service.replaceDraft({
        productReference: original.productReference,
        expectedAggregateVersion: original.aggregateVersion,
        draft: {
          ...original.draft,
          skus: original.draft.skus.map((sku) => ({ ...sku, lifecycle })),
        },
        operationReference: id(88),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(state.current()).toEqual(original);
    expect(await state.ports.repository.resolveOperation(parseCatalogReference(id(88)))).toBeNull();
  },
);
it("new SKU added by Draft replacement must start as Draft", async () => {
  const state = fixture();
  const original = (await state.service.create(createInput())).aggregate;
  const sku = original.draft.skus[0];
  if (!sku) throw new Error("Missing synthetic SKU");
  await expect(
    state.service.replaceDraft({
      productReference: original.productReference,
      expectedAggregateVersion: original.aggregateVersion,
      draft: {
        ...original.draft,
        skus: [{ ...sku, skuReference: id(87), skuCode: "NEW_SKU", lifecycle: "Active" }],
      },
      operationReference: id(88),
      requestedAt: at,
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(state.current()).toEqual(original);
  expect(await state.ports.repository.resolveOperation(parseCatalogReference(id(88)))).toBeNull();
});

describe("Catalog lifecycle governance reason", () => {
  it.each([
    undefined,
    null,
    "",
    "lower_case",
    "A".repeat(129),
    "REASON\n",
    " REASON",
    "REASON ",
    "REASON:OTHER",
    {},
    1,
  ])("rejects invalid reason %s without conversion", (value) => {
    expect(() => parseCatalogLifecycleReasonCode(value)).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
  });
  it("accepts stable Audit-compatible code at128 and never coerces objects", () => {
    expect(parseCatalogLifecycleReasonCode("A".repeat(128))).toBe("A".repeat(128));
    const conversion = vi.fn(() => "SYNTHETIC");
    expect(() => parseCatalogLifecycleReasonCode({ toString: conversion })).toThrow(CatalogError);
    expect(conversion).not.toHaveBeenCalled();
  });
  it("binds provided reason to intent, exact immutable replay and append-only Audit", async () => {
    const state = fixture({ lifecycleReasonCode: "SYNTHETIC_ACTIVATION" });
    await state.service.create(createInput());
    const commit = vi.spyOn(state.ports.repository, "commit"),
      command = {
        productReference: ids.product,
        skuReference: ids.sku,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: id(120),
        requestedAt: at,
        reasonCode: "SYNTHETIC_ACTIVATION",
      };
    const result = await state.service.changeLifecycle(command);
    expect(commit.mock.calls[0]?.[0].audit.reasonCode).toBe(command.reasonCode);
    const prior = await state.ports.repository.resolveOperation(
      parseCatalogReference(command.operationReference),
    );
    expect(prior?.operationIntentHash).toBe(
      digest(`Lifecycle:${ids.product}:${ids.sku}:Active:1:Reason:SYNTHETIC_ACTIVATION`),
    );
    expect(
      await state.service.changeLifecycle({ ...command, requestedAt: "2026-07-31T14:00:00.000Z" }),
    ).toEqual({ ...result, status: "AlreadyApplied" });
    await expect(
      state.service.changeLifecycle({ ...command, reasonCode: "SYNTHETIC_OTHER" }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
    const withoutReason = {
      productReference: command.productReference,
      skuReference: command.skuReference,
      targetLifecycle: command.targetLifecycle,
      expectedAggregateVersion: command.expectedAggregateVersion,
      operationReference: command.operationReference,
      requestedAt: command.requestedAt,
    };
    await expect(state.service.changeLifecycle(withoutReason)).rejects.toMatchObject({
      code: "CATALOG_IDEMPOTENCY_CONFLICT",
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(state.current()).toEqual(result.aggregate);
  });
  it("rejects audit reason substitution before writes", async () => {
    const state = fixture();
    const original = await state.service.create(createInput());
    const commit = vi.spyOn(state.ports.repository, "commit");
    await expect(
      state.service.changeLifecycle({
        productReference: ids.product,
        skuReference: ids.sku,
        targetLifecycle: "Active",
        expectedAggregateVersion: 1,
        operationReference: id(121),
        requestedAt: at,
        reasonCode: "SYNTHETIC_EXPLICIT_REASON",
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(commit).not.toHaveBeenCalled();
    expect(state.current()).toEqual(original.aggregate);
  });
  it("preserves absent-reason legacy owning intent and replay", async () => {
    const state = fixture();
    await state.service.create(createInput());
    const command = {
      productReference: ids.product,
      skuReference: ids.sku,
      targetLifecycle: "Active",
      expectedAggregateVersion: 1,
      operationReference: id(122),
      requestedAt: at,
    };
    const result = await state.service.changeLifecycle(command),
      prior = await state.ports.repository.resolveOperation(
        parseCatalogReference(command.operationReference),
      );
    expect(prior?.operationIntentHash).toBe(digest(`Lifecycle:${ids.product}:${ids.sku}:Active:1`));
    expect(await state.service.changeLifecycle(command)).toEqual({
      ...result,
      status: "AlreadyApplied",
    });
    await expect(
      state.service.changeLifecycle({ ...command, reasonCode: "AUTHORIZED_OPERATION" }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });
});

it.each(["Suspended", "Discontinued", "Archived", "Draft"])(
  "owning new %s operation requires reason, not only HTTP",
  async (targetLifecycle) => {
    const state = fixture();
    const original = await state.service.create(createInput()),
      commit = vi.spyOn(state.ports.repository, "commit");
    await expect(
      state.service.changeLifecycle({
        productReference: ids.product,
        skuReference: null,
        targetLifecycle,
        expectedAggregateVersion: 1,
        operationReference: id(130),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(commit).not.toHaveBeenCalled();
    expect(state.current()).toEqual(original.aggregate);
  },
);
it("replays explicit pre-existing legacy dangerous receipt without manufacturing a reason", async () => {
  const state = fixture();
  const original = await state.service.create(createInput());
  const command = {
    productReference: ids.product,
    skuReference: null,
    targetLifecycle: "Archived",
    expectedAggregateVersion: 1,
    operationReference: id(131),
    requestedAt: at,
  };
  const aggregate = parseProductAggregate({
    ...original.aggregate,
    lifecycle: "Archived",
    aggregateVersion: 2,
  });
  // Seed one historical owner receipt; this is not a new canonical no-reason command.
  await state.ports.repository.commit({
    expectedAggregateVersion: 1,
    record: {
      action: "ChangeLifecycle",
      operationReference: parseCatalogReference(command.operationReference),
      operationIntentHash: digest(`Lifecycle:${ids.product}:Product:Archived:1`) as never,
      aggregate,
    },
    audit: validateAuditRecord(audit("ChangeLifecycle"), Date.parse(at)),
  });
  const commit = vi.spyOn(state.ports.repository, "commit");
  expect(await state.service.changeLifecycle(command)).toEqual({
    status: "AlreadyApplied",
    aggregate,
  });
  expect(commit).not.toHaveBeenCalled();
  await expect(
    state.service.changeLifecycle({
      ...command,
      operationReference: id(132),
      expectedAggregateVersion: 2,
      targetLifecycle: "Draft",
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(commit).not.toHaveBeenCalled();
});

it("owning new dangerous action cannot bypass missing current review", async () => {
  const state = fixture({ lifecycleReasonCode: "SYNTHETIC_ARCHIVE" });
  await state.service.create(createInput());
  const commit = vi.spyOn(state.ports.repository, "commit");
  await expect(
    state.service.changeLifecycle({
      productReference: ids.product,
      skuReference: null,
      targetLifecycle: "Archived",
      expectedAggregateVersion: 1,
      operationReference: id(140),
      requestedAt: at,
      reasonCode: "SYNTHETIC_ARCHIVE",
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(commit).not.toHaveBeenCalled();
});
it("owner mutation callback persists actual review binding and denies provider bypass", async () => {
  const state = fixture({ lifecycleReasonCode: "SYNTHETIC_ARCHIVE" });
  await state.service.create(createInput());
  const command = {
    productReference: ids.product,
    skuReference: null,
    targetLifecycle: "Archived",
    expectedAggregateVersion: 1,
    operationReference: id(141),
    requestedAt: at,
    reasonCode: "SYNTHETIC_ARCHIVE",
  };
  const reviewed = createCatalogProductService({
    ...state.ports,
    lifecycleReview: {
      async withCurrentReview(request, mutate) {
        const checkedAt = "2026-07-01T00:00:00.000Z",
          validUntil = "2027-01-01T00:00:00.000Z";
        return mutate({
          reviewReference: id(150),
          request,
          policyReference: id(151),
          policyVersion: 1,
          decision: "Allowed",
          checkedAt,
          validUntil,
          sources: productLifecycleReviewAreas.map((area, i) => ({
            area,
            coverage: "Complete",
            sourceReference: id(160 + i),
            sourceRevision: "1",
            sourceDigest: "a".repeat(64),
            activeReferenceCount: area === "ActiveSkus" ? request.activeSkuCount : 0,
            checkedAt,
            validUntil,
          })),
        });
      },
    },
  });
  const commit = vi.spyOn(state.ports.repository, "commit");
  await reviewed.changeLifecycle(command);
  expect(commit.mock.calls[0]?.[0].audit.afterSummary?.lifecycleReviewReference).toBe(id(150));
  const fake = createCatalogProductService({
    ...state.ports,
    lifecycleReview: { withCurrentReview: async () => ({}) as never },
  });
  await expect(
    fake.changeLifecycle({
      ...command,
      expectedAggregateVersion: 2,
      targetLifecycle: "Draft",
      operationReference: id(142),
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(commit).toHaveBeenCalledTimes(1);
});

it("preserves an owning complete Draft reference conflict without recording a result", async () => {
  const state = fixture();
  await state.service.create(createInput());
  const current = state.current();
  if (!current) throw new Error("Missing synthetic Product");
  const commit = state.ports.repository.commit;
  const rejected = vi.fn(async () => {
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  });
  state.ports.repository.commit = rejected;
  const request = {
    productReference: ids.product,
    expectedAggregateVersion: 1,
    operationReference: id(995),
    requestedAt: at,
    draft: { ...current.draft, localizedNames: { "en-CA": "Synthetic refused current reference" } },
  };
  await expect(state.service.replaceDraft(request)).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(rejected).toHaveBeenCalledOnce();
  expect(state.current()).toEqual(current);
  expect(await state.ports.repository.resolveOperation(parseCatalogReference(id(995)))).toBeNull();
  state.ports.repository.commit = commit;
  await expect(state.service.replaceDraft(request)).resolves.toMatchObject({
    status: "Applied",
    aggregate: { aggregateVersion: 2 },
  });
});
it("bounds unknown owning Draft failures without echoing details or accepting a result", async () => {
  const state = fixture();
  await state.service.create(createInput());
  const current = state.current();
  if (!current) throw new Error("Missing synthetic Product");
  state.ports.repository.commit = async () => {
    throw new Error("Synthetic private source detail");
  };
  await expect(
    state.service.replaceDraft({
      productReference: ids.product,
      expectedAggregateVersion: 1,
      operationReference: id(996),
      requestedAt: at,
      draft: current.draft,
    }),
  ).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
  expect(state.current()).toEqual(current);
  expect(await state.ports.repository.resolveOperation(parseCatalogReference(id(996)))).toBeNull();
});
