import { expect, it, vi } from "vitest";
import { CatalogError, parseCatalogInstant } from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductAuthoringRuntimeAuthority } from "./merchant-product-authoring-runtime-authority.js";
import {
  createMerchantProductWriteGuard,
  MerchantProductWriteFeatureDisabled,
  type ProductWriteAuthorityInput,
  type ProductWriteIntent,
} from "./merchant-product-write-authority.js";

const id = (n: number) => "019a1000-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
type Options = Parameters<typeof createMerchantProductAuthoringRuntimeAuthority>[0];
type Guard = ReturnType<typeof createMerchantProductWriteGuard>;
type Authority = ReturnType<typeof createMerchantProductAuthoringRuntimeAuthority>;
const createIntent = (createsSkus = false): ProductWriteIntent => ({
  action: "Create",
  expectedAggregateVersion: null,
  createsSkus,
});
const draftIntent: ProductWriteIntent = { action: "ReplaceDraft", expectedAggregateVersion: 3 };
function harness(intent: ProductWriteIntent = createIntent()) {
  let now = at,
    allowed = true,
    disabled = false,
    committed = false,
    scope = "",
    fineUntil: string | null = null;
  const inputs: ProductWriteAuthorityInput[] = [],
    authorize = vi.fn(async (_actions: readonly string[]) => {
      void _actions;
      if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      scope = "Brand";
    }),
    capability = vi.fn(async () => {
      if (disabled) throw new MerchantProductWriteFeatureDisabled();
      scope = "Store";
    }),
    host = createMerchantCategoryTransactions({
      async run(work) {
        const result = await work({
          async query<Row>(sql: string) {
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
    inputs,
    authorize,
    capability,
    get committed() {
      return committed;
    },
    get scope() {
      return scope;
    },
    setNow(value: string) {
      now = value;
    },
    deny() {
      allowed = false;
    },
    disable() {
      disabled = true;
    },
    expireFineAt(value: string) {
      fineUntil = value;
    },
    run<T>(
      work: (
        authority: Authority,
        guard: Guard,
        tx: Options["transaction"],
        options: Options,
      ) => Promise<T>,
    ) {
      return host.transactions.run(async (tx) => {
        const options: Options = {
          transaction: tx,
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(4),
          sessionReference: id(5),
          productReference: id(6),
          operationReference: id(7),
          intent,
          clock: { now: () => now },
          originalValidUntil: until,
          currentAuthorization: {
            authorizeActions: authorize as (actions: readonly string[]) => Promise<undefined>,
            assertCurrent() {
              if (fineUntil !== null && now >= fineUntil)
                throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
              return parseCatalogInstant(now);
            },
            async withCurrentStoreScope() {
              throw new Error("Unused captured capability scope");
            },
          },
          capability: { holdUntilCommit: capability },
          registerBeforeCommit: host.registerBeforeCommit,
        };
        const authority = createMerchantProductAuthoringRuntimeAuthority(options),
          guard = createMerchantProductWriteGuard({
            transaction: tx,
            scope: {
              tenantReference: id(1),
              actorReference: id(4),
              selectedStoreReference: id(3),
              context: { brand: { brandReference: id(2) } },
              authorizeAction: async (action: string) => ({
                effect: "Allow",
                action,
                scopeKind: "Brand",
              }),
            } as unknown as Parameters<typeof createMerchantProductWriteGuard>[0]["scope"],
            sessionReference: id(5),
            productReference: id(6),
            operationReference: id(7),
            intent,
            now: () => now,
            registerBeforeCommit: host.registerBeforeCommit,
            authority: async (actual, input) => {
              inputs.push(input);
              return authority.writeAuthority(actual, input);
            },
          });
        return work(authority, guard, tx, options);
      });
    },
  };
}
it.each([false, true])(
  "admits exact Create fields and canonical permissions, SKU creation=%s",
  async (createsSkus) => {
    const h = harness(createIntent(createsSkus));
    await h.run(async (_a, guard) => {
      await guard.holdAndRegister();
      expect(h.scope).toBe("Brand");
    });
    expect(h.committed).toBe(true);
    expect(h.authorize.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        [
          "catalog.manage",
          "catalog.product.manage",
          "catalog.product.create",
          ...(createsSkus ? ["catalog.sku.create"] : []),
        ],
      ]),
    );
  },
);
it("binds actual derived Draft SKU create/update permissions through all host guards", async () => {
  const h = harness(draftIntent);
  await h.run(async (_a, guard) => {
    await guard.holdAndRegister();
    await guard.bindSkuDraftIntent({
      createdSkuReferences: [id(8)],
      updatedSkuReferences: [id(9)],
    });
    await guard.hold();
  });
  expect(h.committed).toBe(true);
  expect(h.authorize).toHaveBeenLastCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.update",
    "catalog.sku.create",
    "catalog.sku.update",
  ]);
});
it("requires a bound Draft SKU intent at commit, even when no SKU changed", async () => {
  const h = harness(draftIntent);
  await expect(h.run(async (_a, guard) => guard.holdAndRegister())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(h.committed).toBe(false);
  const empty = harness(draftIntent);
  await empty.run(async (_a, guard) => {
    await guard.holdAndRegister();
    await guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] });
    await guard.hold();
  });
  expect(empty.committed).toBe(true);
});
it.each([
  ["tenantReference", id(10)],
  ["storeReference", id(10)],
  ["actorReference", id(10)],
  ["sessionReference", id(10)],
  ["productReference", id(10)],
  ["operationReference", id(10)],
  ["requiredWriteFields", []],
  ["requiredReadFields", []],
  ["actionPermission", "catalog.manage"],
  ["capability", "catalog.cat_product_edit"],
  ["phase", "phase_2"],
  ["purposeCode", "CATALOG_PRODUCT_DRAFT_REPLACE"],
])("refuses altered fixed %s and poisons a caught failure", async (field, value) => {
  const h = harness();
  await expect(
    h.run(async (authority, guard, tx) => {
      await guard.holdAndRegister();
      await authority
        .writeAuthority(tx, {
          ...h.inputs[0],
          [field as string]: value,
        } as ProductWriteAuthorityInput)
        .catch(() => undefined);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(h.committed).toBe(false);
});
it.each(["identity", "extra field", "future observation"])(
  "refuses %s on a held request",
  async (kind) => {
    const h = harness();
    await expect(
      h.run(async (a, guard, tx) => {
        await guard.holdAndRegister();
        const input = {
          ...h.inputs[0],
          ...(kind === "extra field"
            ? { unused: true }
            : kind === "future observation"
              ? { observedAt: until }
              : {}),
        };
        await a.writeAuthority(
          kind === "identity" ? { ...tx } : tx,
          input as ProductWriteAuthorityInput,
        );
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);
it.each(["change", "unbind", "overlap"])("refuses SKU intent %s after binding", async (kind) => {
  const h = harness(draftIntent);
  await expect(
    h.run(async (a, guard, tx) => {
      await guard.holdAndRegister();
      await guard.bindSkuDraftIntent({ createdSkuReferences: [id(8)], updatedSkuReferences: [] });
      await guard.hold();
      await a.writeAuthority(tx, {
        ...h.inputs.at(-1),
        skuDraftIntent:
          kind === "unbind"
            ? null
            : {
                createdSkuReferences: [kind === "change" ? id(9) : id(8)],
                updatedSkuReferences: kind === "overlap" ? [id(8)] : [],
              },
      } as ProductWriteAuthorityInput);
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it.each(["deny", "disabled"])("retains actual late %s behavior", async (kind) => {
  const h = harness();
  const pending = h.run(async (_a, guard) => {
    await guard.holdAndRegister();
    if (kind === "deny") h.deny();
    else h.disable();
  });
  if (kind === "deny")
    await expect(pending).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  else await expect(pending).rejects.toBeInstanceOf(MerchantProductWriteFeatureDisabled);
  expect(h.committed).toBe(false);
});
it.each(["original", "fine", "rollback"])(
  "enforces %s boundary after later awaited host work",
  async (kind) => {
    const h = harness();
    await expect(
      h.run(async (_a, guard, tx, options) => {
        await guard.holdAndRegister();
        const boundary =
          kind === "original"
            ? until
            : kind === "fine"
              ? "2026-10-04T12:00:01.000Z"
              : "2026-10-04T11:59:59.000Z";
        if (kind === "fine") h.expireFineAt(boundary);
        await options.registerBeforeCommit(
          tx,
          async () => {
            h.setNow(boundary);
          },
          () => undefined,
        );
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(h.committed).toBe(false);
  },
);
it("captures ports and original intent before later caller mutation", async () => {
  const mutable = createIntent(true),
    h = harness(mutable);
  await h.run(async (_a, guard, _tx, options) => {
    Object.assign(mutable, { createsSkus: false });
    Object.assign(options.currentAuthorization, {
      authorizeActions: async () => {
        throw new Error("Replaced");
      },
    });
    Object.assign(options.capability, {
      holdUntilCommit: async () => {
        throw new Error("Replaced");
      },
    });
    await guard.holdAndRegister();
  });
  expect(h.authorize).toHaveBeenLastCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.create",
    "catalog.sku.create",
  ]);
});
it("rejects reentrant admission even when its failure is swallowed", async () => {
  const h = harness();
  await expect(
    h.run(async (authority, guard, tx) => {
      h.authorize.mockImplementationOnce(async () => {
        const input = h.inputs[0];
        if (!input) throw new Error("Missing captured admission");
        await authority.writeAuthority(tx, input).catch(() => undefined);
      });
      await guard.holdAndRegister();
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
