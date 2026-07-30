import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";

import {
  CatalogError,
  createCatalogProductService,
  parseCatalogDecimal,
  parseProductAggregate,
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
            : audit(input.action),
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
  };
  return { service: createCatalogProductService(ports), current: () => aggregate };
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
