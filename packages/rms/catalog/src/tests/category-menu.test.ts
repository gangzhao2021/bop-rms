import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";

import {
  CatalogError,
  createCategoryMenuService,
  parseMenuAggregate,
  validateCategoryMove,
  validateMenuBase,
  type CategoryAggregate,
  type CategoryMenuPorts,
  type CategoryOperationRecord,
  type MenuAggregate,
  type MenuOperationRecord,
} from "../index.js";

const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  actor: id(1),
  brand: id(2),
  category: id(3),
  menu: id(4),
  version: id(5),
  section: id(6),
  placement: id(7),
  sku: id(8),
  operation: id(9),
  audit: id(10),
  correlation: id(11),
  policy: id(12),
} as const;
const at = "2026-07-30T15:00:00.000Z";

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
function fixture(
  options: {
    denied?: boolean;
    invalidFacts?: boolean;
    derivedBase?: boolean;
    tamperSaved?: boolean;
  } = {},
) {
  let category: CategoryAggregate | null = null;
  let menu: MenuAggregate | null = null;
  const categoryOperations = new Map<string, CategoryOperationRecord>();
  const menuOperations = new Map<string, MenuOperationRecord>();
  let generatedPlacement = 0;
  const ports: CategoryMenuPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: context(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: `catalog.${input.resource.toLowerCase()}.manage`,
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `CATALOG_${input.resource.toUpperCase()}_${input.action.toUpperCase()}`,
            targetType: `Catalog${input.resource}`,
            targetId: input.aggregateReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: at,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: {
      generate: (purpose) => {
        if (purpose === "Category") return ids.category;
        if (purpose === "Menu") return ids.menu;
        if (purpose === "MenuVersion") return ids.version;
        if (purpose === "MenuSection") return ids.section;
        generatedPlacement += 1;
        return generatedPlacement === 1 ? ids.placement : id(80 + generatedPlacement);
      },
      hashIntent: (value) => digest(value) as never,
      equals: (left, right) => left === right,
    },
    facts: {
      async validateStores() {
        return !options.invalidFacts;
      },
      async validateCategories() {
        return !options.invalidFacts;
      },
      async validateSellables() {
        return !options.invalidFacts;
      },
    },
    categories: {
      async resolveOperation(reference) {
        return categoryOperations.get(reference) ?? null;
      },
      async load(reference) {
        return category?.categoryReference === reference ? category : null;
      },
      async codeAvailable() {
        return true;
      },
      async inspectMove(input) {
        return {
          parent: input.parentCategoryReference === null ? null : category,
          ancestorReferences: [],
          subtreeDepth: 1,
          siblingSortAvailable: true,
          hasActiveChildren: false,
        };
      },
      async create(input) {
        category = input.record.aggregate;
        categoryOperations.set(input.record.operationReference, input.record);
        return options.tamperSaved
          ? {
              ...input.record,
              aggregate: { ...input.record.aggregate, aggregateVersion: 2 },
            }
          : input.record;
      },
      async commit(input) {
        if (category?.aggregateVersion !== input.expectedAggregateVersion)
          throw new CatalogError("CATALOG_VERSION_CONFLICT");
        category = input.record.aggregate;
        categoryOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
    menus: {
      async resolveOperation(reference) {
        return menuOperations.get(reference) ?? null;
      },
      async load(reference) {
        return menu?.menuReference === reference ? menu : null;
      },
      async codeAvailable() {
        return true;
      },
      async inspectBase() {
        return { base: null, menuIsBase: options.derivedBase ?? false };
      },
      async create(input) {
        menu = input.record.aggregate;
        menuOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async commit(input) {
        if (menu?.aggregateVersion !== input.expectedAggregateVersion)
          throw new CatalogError("CATALOG_VERSION_CONFLICT");
        menu = input.record.aggregate;
        menuOperations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return { service: createCategoryMenuService(ports), category: () => category, menu: () => menu };
}
function categoryInput() {
  return {
    internalCode: " hot-drinks ",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Hot Drinks" },
    localizedDescriptions: { "en-CA": "Warm beverages" },
    parentCategoryReference: null,
    sortOrder: 0,
    storeReferences: [],
    operationReference: ids.operation,
    requestedAt: at,
  };
}
function menuInput() {
  return {
    internalCode: " all-day ",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "All Day" },
      baseMenuReference: null,
      storeReferences: [],
      channelCodes: ["POS"],
      orderTypeCodes: ["DINE_IN"],
      sections: [
        {
          internalCode: " drinks ",
          localizedNames: { "en-CA": "Drinks" },
          sortOrder: 0,
          categoryReferences: [ids.category],
          placements: [
            {
              sellableReference: ids.sku,
              sellableType: "Sku",
              presentationRole: "Standard",
              sortOrder: 0,
              pinned: false,
              localizedNameOverrides: {},
            },
          ],
        },
      ],
    },
    operationReference: id(20),
    requestedAt: at,
  };
}

describe("Category and Draft Menu structure", () => {
  it("creates a Brand Category and replays the same deterministic intent", async () => {
    const state = fixture();
    await expect(state.service.createCategory(categoryInput())).resolves.toMatchObject({
      status: "Applied",
      aggregate: { brandReference: ids.brand, internalCode: "HOT-DRINKS", level: 1 },
    });
    await expect(state.service.createCategory(categoryInput())).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    await expect(
      state.service.createCategory({ ...categoryInput(), internalCode: "FOOD" }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed on denied authority and unavailable Store facts", async () => {
    await expect(
      fixture({ denied: true }).service.createCategory(categoryInput()),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    await expect(
      fixture({ invalidFacts: true }).service.createCategory(categoryInput()),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
    await expect(
      fixture({ tamperSaved: true }).service.createCategory(categoryInput()),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  });

  it("prevents self/cycle/cross-Brand and depth above three", () => {
    const category = {
      categoryReference: ids.category,
      brandReference: ids.brand,
      level: 2,
    } as CategoryAggregate;
    expect(() =>
      validateCategoryMove({
        category,
        parent: { ...category, categoryReference: id(30), level: 3 } as CategoryAggregate,
        ancestorReferences: [],
        subtreeDepth: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
    expect(() =>
      validateCategoryMove({
        category,
        parent: {
          ...category,
          categoryReference: id(31),
          brandReference: id(32),
        } as CategoryAggregate,
        ancestorReferences: [],
        subtreeDepth: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
    expect(() =>
      validateCategoryMove({
        category,
        parent: null,
        ancestorReferences: [ids.category as never],
        subtreeDepth: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
  });

  it("creates one complete Draft with distinct Section, Category and SKU Placement identities", async () => {
    const result = await fixture().service.createMenu(menuInput());
    expect(result).toMatchObject({
      status: "Applied",
      aggregate: {
        internalCode: "ALL-DAY",
        draft: {
          status: "Draft",
          sections: [
            {
              sectionReference: ids.section,
              categoryReferences: [ids.category],
              placements: [{ placementReference: ids.placement, sellableType: "Sku" }],
            },
          ],
        },
      },
    });
    const base = parseMenuAggregate(result.aggregate);
    const derivedReference = id(70);
    const derived = parseMenuAggregate({
      ...base,
      menuReference: derivedReference,
      internalCode: "DERIVED",
      draft: {
        ...base.draft,
        baseMenuReference: base.menuReference,
        sections: base.draft.sections.map((section) => ({
          ...section,
          menuReference: derivedReference,
          placements: section.placements.map((placement) => ({
            ...placement,
            menuReference: derivedReference,
          })),
        })),
      },
    });
    expect(() => validateMenuBase(derived, base, false)).not.toThrow();
    expect(() => validateMenuBase(derived, base, true)).toThrowError(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  });

  it("rejects Published state, non-SKU placement, duplicate placement tuple and accessors", async () => {
    const input = menuInput();
    const [firstSection] = input.draft.sections;
    const [firstPlacement] = firstSection?.placements ?? [];
    if (firstSection === undefined || firstPlacement === undefined)
      throw new Error("invalid synthetic fixture");
    await expect(
      fixture().service.createMenu({
        ...input,
        draft: {
          ...input.draft,
          sections: [
            {
              ...firstSection,
              placements: [firstPlacement, { ...firstPlacement, sortOrder: 1 }],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    await expect(
      fixture().service.createMenu({
        ...input,
        draft: {
          ...input.draft,
          sections: [
            {
              ...firstSection,
              placements: [{ ...firstPlacement, sellableType: "Product" }],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    await expect(
      fixture().service.createMenu({
        ...input,
        draft: { ...input.draft, status: "Published" },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    const accessorDescriptions = Object.defineProperty({}, "en-CA", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    await expect(
      fixture().service.createCategory({
        ...categoryInput(),
        localizedDescriptions: accessorDescriptions,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  });

  it("enforces stable Draft identity and aggregate optimistic concurrency", async () => {
    const state = fixture();
    const created = await state.service.createMenu(menuInput());
    const current = parseMenuAggregate(created.aggregate);
    await expect(
      state.service.replaceMenuDraft({
        menuReference: current.menuReference,
        expectedAggregateVersion: 2,
        draft: current.draft,
        operationReference: id(40),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
    await expect(
      state.service.replaceMenuDraft({
        menuReference: current.menuReference,
        expectedAggregateVersion: 1,
        draft: { ...current.draft, versionReference: id(41) },
        operationReference: id(42),
        requestedAt: at,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  });
});
