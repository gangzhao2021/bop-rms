import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  pages: [],
  scope: { tenantReference: "tenant", brandReference: "brand", storeReference: "store" },
  called: [],
}));
vi.mock("../../packages/bop/projection/src/index.ts", () => ({
  parseOrderExceptionSource: (value) => value,
}));
vi.mock("./pilot-dining-exception-episodes.mjs", () => ({
  createInternalDiningExceptionEpisodePageRunner:
    ({ resources }, consume) =>
    (input) =>
      resources.transactions.run((tx) => {
        d.called.push(input);
        return consume({ tx, scope: d.scope, authorize: () => true, page: d.pages.shift() });
      }),
}));
vi.mock("./pilot-reconciliation-exceptions.mjs", () => ({
  createInternalReconciliationExceptionPageRunner: (resources, consume) => (input) =>
    resources.transactions.run((tx) => {
      d.called.push(input);
      return consume({ tx, scope: d.scope, authorize: () => true, page: d.pages.shift() });
    }),
}));
vi.mock("./pilot-reconciliation-projection.mjs", () => ({
  mapInternalReconciliationSource: (value) => value,
}));
import {
  createInternalDiningCoverage,
  createInternalReconciliationCoverage,
} from "./pilot-owner-exception-coverage.mjs";
const at = "2026-09-21T00:00:00.000Z";
function setup(dining = false) {
  const resources = {
    scope: { brandReference: "brand", storeReference: "store" },
    publicProfile: {
      binding: { tenantReference: "tenant", validUntil: "2026-09-22T00:00:00.000Z" },
    },
    now: () => at,
  };
  return {
    run: dining
      ? createInternalDiningCoverage({
          resources,
          providerAccountReference: "account",
          pageSize: 5,
        })
      : createInternalReconciliationCoverage(resources, { pageSize: 5 }),
    input: {
      tx: { query: vi.fn(async () => ({ rows: [{ isolation: "repeatable read" }] })) },
      authorize: vi.fn(async () => true),
      projected: [],
    },
  };
}
const source = (n, kind = "PaymentReconciliationDifference") => ({
  ...d.scope,
  sourceReference: String(n).padStart(3, "0"),
  kind,
  sourceVersion: 1n,
  sourceDigest: "digest",
  updatedAt: at,
});
beforeEach(() => {
  d.pages = [];
  d.called = [];
});
it("reads all pages in the retained snapshot and compares every source", async () => {
  const f = setup(),
    items = Array.from({ length: 6 }, (_, n) => source(n));
  f.input.projected = items;
  d.pages = [
    { items: items.slice(0, 5), nextAfterExceptionReference: "004" },
    { items: items.slice(5), nextAfterExceptionReference: null },
  ];
  expect(await f.run(f.input)).toEqual({ complete: true, sourceCount: 6 });
  expect(d.called[1].afterExceptionReference).toBe("004");
});
it("uses Dining episode sources including final outcomes", async () => {
  const f = setup(true),
    item = source(1, "DiningUnpaidBatch");
  f.input.projected = [item];
  d.pages = [{ items: [{ source: item }], nextAfterTaskReference: null }];
  expect((await f.run(f.input)).complete).toBe(true);
});
it.each(["missing", "stale", "extra"])("does not certify %s projection", async (mode) => {
  const f = setup(),
    item = source(1);
  f.input.projected =
    mode === "missing"
      ? []
      : mode === "stale"
        ? [{ ...item, sourceVersion: 2n }]
        : [item, source(2)];
  d.pages = [{ items: [item], nextAfterExceptionReference: null }];
  expect((await f.run(f.input)).complete).toBe(false);
});
it("denies malformed pagination and scope", async () => {
  const f = setup(),
    item = source(1);
  f.input.projected = [item];
  d.pages = [{ items: [item], nextAfterExceptionReference: "001" }];
  await expect(f.run(f.input)).rejects.toThrow();
  d.pages = [{ items: [{ ...item, storeReference: "other" }], nextAfterExceptionReference: null }];
  await expect(f.run(f.input)).rejects.toThrow();
});
it("denies weak isolation and revoked authorization", async () => {
  const f = setup();
  f.input.tx.query.mockResolvedValue({ rows: [{ isolation: "read committed" }] });
  await expect(f.run(f.input)).rejects.toThrow();
  const g = setup();
  g.input.authorize.mockResolvedValue(false);
  await expect(g.run(g.input)).rejects.toThrow();
});
it("empty source proves coverage only for an empty projection", async () => {
  const f = setup();
  d.pages = [{ items: [], nextAfterExceptionReference: null }];
  expect(await f.run(f.input)).toEqual({ complete: true, sourceCount: 0 });
  f.input.projected = [source(1)];
  d.pages = [{ items: [], nextAfterExceptionReference: null }];
  expect((await f.run(f.input)).complete).toBe(false);
});
it("WP-2423: reads only the shown cases and leaves unshown final cases unread", async () => {
  const f = setup(),
    open = source(3);
  f.input.projected = [open];
  f.input.references = new Map([
    ["001", { kind: "PaymentReconciliationDifference", final: true }],
    ["002", { kind: "PaymentReconciliationDifference", final: true }],
    ["003", { kind: "PaymentReconciliationDifference", final: false }],
    ["900", { kind: "DiningUnpaidBatch", final: false }],
  ]);
  d.pages = [
    {
      items: [{ reference: "001", skipped: true }, { reference: "002", skipped: true }, open],
      nextAfterExceptionReference: null,
    },
  ];
  expect(await f.run(f.input)).toEqual({ complete: true, sourceCount: 3 });
  expect(d.called[0].select("003")).toBe(true);
  expect(d.called[0].select("001")).toBe(false);
});
it.each([
  ["an owner case the projection lacks", "004", true],
  ["an unshown case that is still open", "002", false],
])("WP-2423: does not certify %s", async (_name, reference, final) => {
  const f = setup();
  f.input.projected = [];
  f.input.references = new Map([
    ["001", { kind: "PaymentReconciliationDifference", final: true }],
    ["002", { kind: "PaymentReconciliationDifference", final }],
  ]);
  d.pages = [
    {
      items: [
        { reference: "001", skipped: true },
        { reference, skipped: true },
      ],
      nextAfterExceptionReference: null,
    },
  ];
  expect((await f.run(f.input)).complete).toBe(false);
});
it("WP-2423: does not certify a projected case its owner no longer lists", async () => {
  const f = setup();
  f.input.projected = [];
  f.input.references = new Map([
    ["001", { kind: "PaymentReconciliationDifference", final: true }],
    ["002", { kind: "PaymentReconciliationDifference", final: true }],
  ]);
  d.pages = [{ items: [{ reference: "001", skipped: true }], nextAfterExceptionReference: null }];
  expect((await f.run(f.input)).complete).toBe(false);
});
