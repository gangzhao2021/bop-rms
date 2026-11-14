import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCategoryAssignments } from "./merchant-product-category-assignments.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T08:00:00.000Z";
function aggregate() {
  const aggregate = parseProductAggregate({
    productReference: id(20),
    brandReference: id(1),
    internalCode: "CLASSIFIED",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(21),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(10)], primaryCategoryReference: id(10) },
    },
  });
  return aggregate;
}
function setup() {
  let permitted = true,
    allowedLifecycles: readonly ("Active" | "Draft")[] = ["Active"];
  const events: string[] = [];
  const query = vi.fn(async (sql: string) =>
    sql.includes("transaction_isolation")
      ? { rows: [{ isolation: "read committed" }] }
      : sql.includes("FROM rms_catalog.category")
        ? { rows: [{ category_reference: id(10), brand_reference: id(1), lifecycle: "Active" }] }
        : { rows: [] },
  );
  const pool: Parameters<typeof createMerchantCategoryTransactions>[0] = {
    async run(work) {
      events.push("BEGIN");
      try {
        const result = await work({ query });
        events.push("COMMIT");
        return result;
      } catch (error) {
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  const host = createMerchantCategoryTransactions(pool);
  const policy = vi.fn(
    async (
      _tx: ProductLifecycleTransaction,
      _input: Parameters<
        NonNullable<Parameters<typeof createMerchantProductCategoryAssignments>[0]["policy"]>
      >[1],
    ) => {
      expect(typeof _tx.query).toBe("function");
      expect(_input.brandReference).toBe(id(1));
      if (!permitted) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { allowedLifecycles };
    },
  );
  return {
    host,
    events,
    query,
    policy,
    deny: () => {
      permitted = false;
    },
    changePolicy: () => {
      allowedLifecycles = ["Draft"];
    },
  };
}
it("preserves missing provider for legacy operations", async () => {
  const f = setup();
  await f.host.transactions.run(async (tx) => {
    expect(
      createMerchantProductCategoryAssignments({
        transaction: tx,
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        now: () => at,
        policy: undefined,
        registerBeforeCommit: f.host.registerBeforeCommit,
      }),
    ).toBeUndefined();
    await f.host.registerBeforeCommit(tx, async () => undefined);
  });
});
function holder(f: ReturnType<typeof setup>, tx: ProductLifecycleTransaction) {
  return createMerchantProductCategoryAssignments({
    transaction: tx,
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(3),
    now: () => at,
    policy: f.policy,
    registerBeforeCommit: f.host.registerBeforeCommit,
  });
}
it("rechecks independent policy and actual Category facts before hostCOMMIT", async () => {
  const f = setup();
  await f.host.transactions.run(async (tx) => {
    const authority = holder(f, tx);
    if (!authority) throw new Error("holder missing");
    await authority.holdUntilTransactionCompletes(tx, { mode: "Write", aggregate: aggregate() });
  });
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
  expect(f.policy).toHaveBeenCalledTimes(2);
  expect(f.policy.mock.calls[0]?.[1]).toMatchObject({
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(3),
    permission: "catalog.product.manage",
    referencedPermission: "catalog.manage",
    purposeCode: "CATALOG_PRODUCT_CATEGORY_MUTATION",
    requiredFields: ["categoryClassification", "categoryReferences", "primaryCategoryReference"],
  });
  expect(
    f.query.mock.calls.filter(([sql]) => sql.includes("FROM rms_catalog.category")),
  ).toHaveLength(2);
});
it("rolls back fields revoked after business work", async () => {
  const f = setup();
  await expect(
    f.host.transactions.run(async (tx) => {
      const authority = holder(f, tx);
      if (!authority) throw new Error("holder missing");
      await authority.holdUntilTransactionCompletes(tx, { mode: "Write", aggregate: aggregate() });
      f.deny();
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("does not let later replay Read replace pending Write validation", async () => {
  const f = setup();
  await expect(
    f.host.transactions.run(async (tx) => {
      const authority = holder(f, tx);
      if (!authority) throw new Error("holder missing");
      await authority.holdUntilTransactionCompletes(tx, { mode: "Write", aggregate: aggregate() });
      await authority.holdUntilTransactionCompletes(tx, { mode: "Read", aggregate: aggregate() });
      f.changePolicy();
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it("captures original validated assignments across caller mutation", async () => {
  const f = setup();
  await f.host.transactions.run(async (tx) => {
    const authority = holder(f, tx);
    if (!authority) throw new Error("holder missing");
    const data = JSON.parse(JSON.stringify(aggregate()));
    await authority.holdUntilTransactionCompletes(tx, { mode: "Write", aggregate: data });
    data.draft.categoryClassification.categoryReferences = [];
    data.draft.categoryClassification.primaryCategoryReference = null;
  });
  expect(f.policy).toHaveBeenCalledTimes(2);
  expect(
    f.query.mock.calls.filter(([sql]) => sql.includes("FROM rms_catalog.category")),
  ).toHaveLength(2);
});
it("rejects a foreign transaction before calling policy", async () => {
  const f = setup();
  await f.host.transactions.run(async (tx) => {
    const authority = holder(f, tx);
    if (!authority) throw new Error("holder missing");
    await expect(
      authority.holdUntilTransactionCompletes(
        { query: tx.query },
        { mode: "Read", aggregate: aggregate() },
      ),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    await f.host.registerBeforeCommit(tx, async () => undefined);
  });
  expect(f.policy).not.toHaveBeenCalled();
});
it("rejects getter packets without evaluating them", async () => {
  const f = setup();
  await f.host.transactions.run(async (tx) => {
    const authority = holder(f, tx);
    if (!authority) throw new Error("holder missing");
    const getter = vi.fn(() => aggregate());
    const input = {
      mode: "Read" as const,
      get aggregate() {
        return getter();
      },
    };
    await expect(authority.holdUntilTransactionCompletes(tx, input)).rejects.toBeInstanceOf(
      CatalogError,
    );
    expect(getter).not.toHaveBeenCalled();
    await f.host.registerBeforeCommit(tx, async () => undefined);
  });
});
