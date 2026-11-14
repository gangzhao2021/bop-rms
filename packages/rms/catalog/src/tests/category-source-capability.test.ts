import { expect, it, vi } from "vitest";
import type { CategorySourceAuthority } from "../index.js";
import {
  createPostgresCategorySourceStore,
  CatalogError,
  categoryPersistenceFields,
} from "../index.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function setup() {
  const sql = vi.fn(),
    hold = vi.fn(
      async (...args: Parameters<CategorySourceAuthority["holdUntilTransactionCompletes"]>) => {
        void args;
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    );
  return {
    sql,
    hold,
    options: {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      transactions: {
        run: async <T>(work: (tx: { query: typeof sql }) => Promise<T>) => work({ query: sql }),
      },
      authority: { holdUntilTransactionCompletes: hold },
      clock: { now: () => "2026-09-28T12:00:00.000Z" },
      maximumCategoryNodes: 100,
      maximumSourceCommits: 100,
    },
  };
}
it.each([
  undefined,
  "catalog.cat_category_tree",
  "catalog.cat_product_create",
  "catalog.cat_product_edit",
] as const)(
  "holds selected required source capability %s without granting SQL",
  async (readCapability) => {
    const f = setup();
    await expect(
      createPostgresCategorySourceStore({
        ...f.options,
        ...(readCapability === undefined ? {} : { readCapability }),
      }).loadSnapshot(),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.hold.mock.calls[0]?.[1]).toMatchObject({
      capability: readCapability ?? "catalog.cat_category_tree",
      permission: "catalog.manage",
      purposeCode: "CATALOG_CATEGORY_SOURCE_READ",
      requiredFields: categoryPersistenceFields,
    });
    expect(f.sql).not.toHaveBeenCalled();
  },
);
it.each([null, "catalog.cat_product_list", "caller.grant"])(
  "rejects unsupported explicit profile %s before transaction or authority",
  (readCapability) => {
    const f = setup();
    expect(() =>
      createPostgresCategorySourceStore({ ...f.options, readCapability: readCapability as never }),
    ).toThrow();
    expect(f.hold).not.toHaveBeenCalled();
    expect(f.sql).not.toHaveBeenCalled();
  },
);
