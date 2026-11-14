import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  parseCatalogInstant,
  productEditorContentFields,
} from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductLifecycleRuntimeAuthority } from "./merchant-product-lifecycle-runtime-authority.js";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";

const id = (n: number) => "019a1000-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
const aggregate = () =>
  parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "PRODUCT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(4),
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Product" },
      taxClassificationReference: null,
      optionBindings: [],
      skus: [
        {
          skuReference: id(7),
          productReference: id(5),
          brandReference: id(2),
          skuCode: "SKU",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "SKU" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(4),
        },
      ],
      categoryClassification: { categoryReferences: [id(8)], primaryCategoryReference: id(8) },
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [{ selections: [], disposition: "Valid", skuReference: id(7) }],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
      createdAt: at,
      updatedAt: at,
    },
  });
type Authority = ReturnType<typeof createMerchantProductLifecycleRuntimeAuthority>;
type Tx = Parameters<Authority["editorContentAuthority"]["holdUntilTransactionCompletes"]>[0];
type Host = ReturnType<typeof createMerchantCategoryTransactions>;
function harness() {
  let now = at,
    allowed = true,
    currentScope = "",
    committed = false;
  let replacePorts: () => void = () => {
    throw new Error("Authority not constructed");
  };
  const actions: (readonly string[])[] = [],
    queries: string[] = [];
  const authorize = vi.fn(async (requested: readonly string[]) => {
      actions.push([...requested]);
      if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      currentScope = "Brand";
    }),
    capability = vi.fn(async () => {
      currentScope = "Store";
    });
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const result = await work({
        async query<Row>(sql: string) {
          queries.push(sql);
          return {
            rows: (sql.includes("transaction_isolation")
              ? [{ isolation: "read committed" }]
              : []) as unknown as readonly Row[],
          };
        },
      });
      committed = true;
      return result;
    },
  });
  return {
    actions,
    queries,
    authorize,
    capability,
    get committed() {
      return committed;
    },
    get currentScope() {
      return currentScope;
    },
    deny() {
      allowed = false;
    },
    setNow(value: string) {
      now = value;
    },
    replacePorts() {
      replacePorts();
    },
    run<T>(
      work: (authority: Authority, tx: Tx, host: Host) => Promise<T>,
      command = {
        productReference: id(5),
        skuReference: id(7) as string | null,
        targetLifecycle: "Active" as const,
      },
    ) {
      return host.transactions.run(async (tx) => {
        const authorization = {
            authorizeActions: authorize as (actions: readonly string[]) => Promise<undefined>,
            assertCurrent: () => parseCatalogInstant(now),
            async withCurrentStoreScope() {
              throw new Error("Not used by this captured capability");
            },
          },
          capturedCapability = { holdUntilCommit: capability as () => Promise<void> };
        const authority = createMerchantProductLifecycleRuntimeAuthority({
          transaction: tx,
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          command,
          clock: { now: () => now },
          originalValidUntil: until,
          currentAuthorization: authorization,
          capability: capturedCapability,
          registerBeforeCommit: host.registerBeforeCommit,
        });
        replacePorts = () => {
          authorization.authorizeActions = async () => {
            throw new Error("Replaced authority");
          };
          capturedCapability.holdUntilCommit = async () => {
            throw new Error("Replaced capability");
          };
        };
        await authority.holdAndRegister();
        return work(authority, tx, host);
      });
    },
  };
}
const read = (authority: Authority, tx: Tx, value: unknown = aggregate()) =>
  authority.editorContentAuthority.holdUntilTransactionCompletes(tx, {
    mode: "Read",
    aggregate: value as ReturnType<typeof aggregate>,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: [],
  });
const bind = (authority: Authority) =>
  authority.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"));

it("holds complete recorded content/category ACCESS and exact SKU activate through the actual host final phase", async () => {
  const h = harness();
  await h.run(async (authority, tx) => {
    await read(authority, tx);
    await authority.categoryAssignments.holdUntilTransactionCompletes(tx, {
      mode: "Read",
      aggregate: aggregate(),
    });
    await bind(authority);
    expect(h.currentScope).toBe("Brand");
  });
  expect(h.committed).toBe(true);
  expect(h.actions).toContainEqual([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.read",
    "catalog.sku.read",
    "catalog.sku.activate",
  ]);
  expect(h.queries.some((sql) => sql.includes("rms_catalog.category"))).toBe(false);
  expect(h.queries.some((sql) => sql.includes("set_config"))).toBe(true);
});
it("reads exact original and later immutable root snapshots without applying current publish qualification", async () => {
  const h = harness();
  await h.run(async (authority, tx) => {
    await read(authority, tx);
    const next = parseProductAggregate({
      ...aggregate(),
      aggregateVersion: 4,
      draft: {
        ...aggregate().draft,
        skus: aggregate().draft.skus.map((sku) => ({ ...sku, lifecycle: "Active" })),
      },
    });
    await read(authority, tx, next);
    await bind(authority);
  });
  expect(h.committed).toBe(true);
});
it.each(["DraftWrite", "Publish"] as const)(
  "never turns lifecycle reads into %s qualification",
  async (mode) => {
    const h = harness();
    await expect(
      h.run(async (authority, tx) => {
        await authority.editorContentAuthority.holdUntilTransactionCompletes(tx, {
          mode,
          aggregate: aggregate(),
          requiredFields: productEditorContentFields,
          requiredReferenceChecks: [],
        });
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(h.committed).toBe(false);
  },
);
it("rejects category mutation rather than granting an assignment lifecycle policy", async () => {
  const h = harness();
  await expect(
    h.run(async (authority, tx) => {
      await authority.categoryAssignments.holdUntilTransactionCompletes(tx, {
        mode: "Write",
        aggregate: aggregate(),
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["foreign Product", "foreign Brand", "foreign transaction", "extra check"])(
  "rejects %s read binding",
  async (mode) => {
    const h = harness();
    await expect(
      h.run(async (authority, tx) => {
        const original = aggregate();
        if (mode === "foreign Product")
          return read(authority, tx, {
            ...original,
            productReference: id(88),
            draft: { ...original.draft, skus: [] },
          });
        if (mode === "foreign Brand")
          return read(authority, tx, {
            ...original,
            brandReference: id(88),
            draft: { ...original.draft, skus: [] },
          });
        if (mode === "foreign transaction") return read(authority, { query: tx.query }, original);
        return authority.editorContentAuthority.holdUntilTransactionCompletes(tx, {
          mode: "Read",
          aggregate: original,
          requiredFields: productEditorContentFields,
          requiredReferenceChecks: ["Media"],
        });
      }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(h.committed).toBe(false);
  },
);
it("a caught bad read permanently prevents the outer commit", async () => {
  const h = harness();
  await expect(
    h.run(async (authority, tx) => {
      await bind(authority);
      await read(authority, { query: tx.query }).catch(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.committed).toBe(false);
});
it("later current denial rejects the outer transaction", async () => {
  const h = harness();
  await expect(
    h.run(async (authority) => {
      await bind(authority);
      h.deny();
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.committed).toBe(false);
});
it("a later asynchronous host guard cannot outlive an earlier authority lease", async () => {
  const h = harness();
  await expect(
    h.run(async (authority, tx, host) => {
      await bind(authority);
      await host.registerBeforeCommit(tx, async () => {
        h.setNow(until);
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.committed).toBe(false);
});
it("a caught backwards clock cannot be repaired by restoring time", async () => {
  const h = harness();
  await expect(
    h.run(async (authority) => {
      await bind(authority);
      h.setNow("2026-10-04T11:59:59.999Z");
      try {
        authority.assertCurrent();
      } catch {
        /* Restore does not erase the failure. */
      }
      h.setNow(at);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("does not authorize a commit without a bound owning action", async () => {
  const h = harness();
  await expect(
    h.run(async (authority, tx) => {
      await read(authority, tx);
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("rejects a changed fine action instead of trusting a caller intent", async () => {
  const h = harness();
  await expect(
    h.run(async (authority) => {
      await authority.bindIntent({
        ...resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"),
        actionPermission: "catalog.sku.resume",
      });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures authority and capability methods before later port replacement", async () => {
  const h = harness();
  await h.run(async (authority) => {
    h.replacePorts();
    await bind(authority);
    expect(h.authorize).toHaveBeenCalled();
    expect(h.capability).toHaveBeenCalled();
  });
});

it("refuses new authority work after the final synchronous phase", async () => {
  const h = harness();
  const saved = await h.run(async (authority) => {
    await bind(authority);
    return authority;
  });
  await expect(saved.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.committed).toBe(true);
});
