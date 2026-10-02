import { it, expect, vi } from "vitest";
import { createMerchantCategoryAuthority } from "./merchant-category-authority.js";
import {
  categoryPersistenceFields,
  categoryTreeViewFields,
  categoryTreeMenuViewFields,
  menuCategorySourceFields,
} from "@rms/catalog";
import {
  tenantContext,
  ACTOR,
  BRAND,
  STORE,
  AT,
  uuid,
} from "../../../packages/bop/permission/src/tests/current-policy.fixture.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const state = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => state.resolve }));
function fixture() {
  const holdFields = vi.fn(async () => undefined),
    register = vi.fn(async () => undefined),
    sql = vi.fn(async () => {
      throw new Error("UNEXPECTED_OWNER_READ");
    });
  const options = {
    source: { now: () => AT } as unknown as PersistentMerchantBffOptions,
    sessionCookie: "Synthetic opaque credential",
    sessionReference: uuid("91"),
    tenantReference: uuid("90"),
    brandReference: BRAND,
    storeReference: STORE,
    actorReference: ACTOR,
    holdFieldsAndPhaseUntilCommit: holdFields,
    registerBeforeCommit: register,
  };
  const authority = createMerchantCategoryAuthority(options);
  const query = {
    tenantReference: uuid("90"),
    brandReference: BRAND,
    actorReference: ACTOR,
    purposeCode: "CATALOG_CATEGORY_SOURCE_READ" as const,
    permission: "catalog.manage" as const,
    capability: "catalog.cat_category_tree" as const,
    requiredFields: categoryPersistenceFields,
    observedAt: AT,
  };
  const selected = {
    selected: { tenantReference: uuid("90") },
    context: tenantContext,
    actorReference: ACTOR,
    sessionReference: uuid("91"),
    allowed: async () => true,
  };
  state.resolve.mockReset();
  state.resolve.mockResolvedValue(selected);
  return { options, authority, query, tx: { query: sql }, sql, holdFields, register, selected };
}
it.each([
  { capability: "catalog.cat_category_list" },
  { permission: "catalog.category.read" },
  { purposeCode: "CATALOG_OTHER" },
  { requiredFields: ["categoryReference"] },
  { activeRoleCodes: ["Owner"] },
  { phaseEnabled: true },
])("rejects unsupported caller authority claim case %# before resolution", async (change) => {
  const f = fixture();
  await expect(
    f.authority.holdUntilTransactionCompletes(f.tx, {
      ...f.query,
      ...change,
    } as unknown as typeof f.query),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(state.resolve).not.toHaveBeenCalled();
  expect(f.sql).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "rejects rebound %s before current owner reads",
  async (key) => {
    const f = fixture();
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, { ...f.query, [key]: uuid("99") }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.resolve).not.toHaveBeenCalled();
    expect(f.sql).not.toHaveBeenCalled();
  },
);
it("rejects accessors without executing them", async () => {
  const f = fixture(),
    getter = vi.fn(() => BRAND);
  Object.defineProperty(f.query, "brandReference", { enumerable: true, get: getter });
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.query)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(state.resolve).not.toHaveBeenCalled();
});
it.each(["session", "tenant", "actor", "store_access", "future"])(
  "rejects current selection mismatch %s before Brand owner reads",
  async (kind) => {
    const f = fixture();
    state.resolve.mockResolvedValue({
      ...f.selected,
      ...(kind === "session"
        ? { sessionReference: uuid("99") }
        : kind === "tenant"
          ? { selected: { tenantReference: uuid("99") } }
          : kind === "actor"
            ? { actorReference: uuid("99") }
            : kind === "store_access"
              ? { allowed: async () => false }
              : {}),
    });
    const value = {
      ...f.query,
      ...(kind === "future" ? { observedAt: "2026-07-28T12:30:00.001Z" } : {}),
    };
    await expect(f.authority.holdUntilTransactionCompletes(f.tx, value)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.sql).not.toHaveBeenCalled();
    expect(f.holdFields).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);
it("requires both current fields/Phase holder and real COMMIT hook configuration", () => {
  const f = fixture();
  for (const missing of ["holdFieldsAndPhaseUntilCommit", "registerBeforeCommit"]) {
    expect(() =>
      createMerchantCategoryAuthority({
        ...f.options,
        [missing]: undefined,
      } as unknown as typeof f.options),
    ).toThrow();
  }
  expect(state.resolve).not.toHaveBeenCalled();
});
it("returns bounded dependency failure without leaking session or driver detail", async () => {
  const f = fixture();
  state.resolve.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_DRIVER_DETAIL"));
  await expect(f.authority.holdUntilTransactionCompletes(f.tx, f.query)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
});

it.each([
  { requiredFields: categoryPersistenceFields },
  { requiredFields: categoryTreeViewFields.slice(0, -1) },
  { referencedCapability: "catalog.cat_category_tree" },
  { referencedCapability: null },
  { activeRoleCodes: ["Owner"] },
])("rejects malformed tree holder packet %# before current owner reads", async (change) => {
  const f = fixture();
  const value = {
    ...f.query,
    purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ",
    requiredFields: categoryTreeViewFields,
    referencedCapability: "catalog.cat_product_list",
    ...change,
  };
  await expect(
    f.authority.holdUntilTransactionCompletes(
      f.tx,
      value as unknown as Parameters<typeof f.authority.holdUntilTransactionCompletes>[1],
    ),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(state.resolve).not.toHaveBeenCalled();
  expect(f.sql).not.toHaveBeenCalled();
});
it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "rejects rebound tree %s before current public readers",
  async (key) => {
    const f = fixture();
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, {
        ...f.query,
        purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ",
        requiredFields: categoryTreeViewFields,
        referencedCapability: "catalog.cat_product_list",
        [key]: uuid("99"),
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.resolve).not.toHaveBeenCalled();
  },
);

it.each([
  { requiredFields: categoryTreeMenuViewFields },
  { requiredFields: menuCategorySourceFields.slice(0, -1) },
  { requiredFields: [...menuCategorySourceFields, "sectionNames"] },
  { referencedCapability: "catalog.cat_product_list" },
  { brandReference: uuid("99") },
])("rejects unsupported or rebound Menu source authority packet %#", async (change) => {
  const f = fixture();
  await expect(
    f.authority.holdUntilTransactionCompletes(f.tx, {
      ...f.query,
      purposeCode: "CATALOG_MENU_CATEGORY_SOURCE_READ",
      requiredFields: menuCategorySourceFields,
      ...change,
    } as unknown as Parameters<typeof f.authority.holdUntilTransactionCompletes>[1]),
  ).rejects.toMatchObject({
    code: change.brandReference ? "CATALOG_PERMISSION_DENIED" : "CATALOG_INPUT_INVALID",
  });
  expect(state.resolve).not.toHaveBeenCalled();
  expect(f.sql).not.toHaveBeenCalled();
});
