import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ revision: vi.fn() }));
vi.mock("../infrastructure/persistence/order-revision-position.js", () => ({
  createPostgresOrderRevisionPosition: () => mock.revision,
}));
import {
  createPostgresOrderClosurePosition,
  createPostgresOrderClosureHistory,
} from "../infrastructure/persistence/order-closure-position.js";
const id = (n: number) => "0190fad2-0000-7000-8000-" + String(n).padStart(12, "0");
const closed = {
  closureReference: id(1),
  operationReference: id(2),
  tenantReference: id(3),
  brandReference: id(4),
  storeReference: id(5),
  orderReference: id(6),
  closureVersion: 1,
  orderVersion: 4,
  previousClosureReference: null,
  status: "Closed",
  actorType: "System",
  actorReference: null,
  reasonCode: "ORDER_COMPLETE",
  financialFinalityReference: id(7),
  evidenceDigest: "sha256:" + "a".repeat(64),
  occurredAt: "2026-09-20T00:01:00.000Z",
};
const reopened = {
  ...closed,
  closureReference: id(8),
  operationReference: id(9),
  closureVersion: 2,
  previousClosureReference: id(1),
  status: "Open",
  actorType: "User",
  actorReference: id(10),
  reasonCode: "MANAGER_CORRECTION",
  financialFinalityReference: null,
  occurredAt: "2026-09-20T00:02:00.000Z",
};

beforeEach(() => vi.resetAllMocks());
function setup() {
  const input = { orderReference: closed.orderReference, observedAt: "2026-09-20T00:03:00.000Z" },
    scope = {
      tenantReference: closed.tenantReference,
      brandReference: closed.brandReference,
      storeReference: closed.storeReference,
    };
  const current = {
    ...scope,
    ...input,
    version: 4,
    checkpoint: id(20),
    snapshotDigest: "sha256:" + "b".repeat(64),
  };
  mock.revision.mockResolvedValue(current);
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    tx = { query },
    authorize = vi.fn(async () => true);
  const read = createPostgresOrderClosurePosition({ ...scope, authorize });
  return {
    current,
    query,
    authorize,
    load: () => read(tx, input),
    history: () => createPostgresOrderClosureHistory({ ...scope, authorize })(tx, input),
  };
}
it("initial Open requires existing Order and successfully read empty history", async () => {
  const f = setup();
  expect(await f.load()).toMatchObject({
    status: "Open",
    closureVersion: 0,
    closureReference: null,
  });
  f.query.mockRejectedValue(new Error("missing table"));
  await expect(f.load()).rejects.toThrow("ORDER_CLOSURE_POSITION_UNAVAILABLE");
});
it("reads current closure and later reopen without discarding history", async () => {
  const f = setup();
  f.query.mockResolvedValue({ rows: [closed], rowCount: 1 });
  expect((await f.load()).status).toBe("Closed");
  f.query.mockResolvedValue({ rows: [closed, reopened], rowCount: 2 });
  expect(await f.load()).toMatchObject({ status: "Open", closureVersion: 2 });
});
it("refuses missing Order source", async () => {
  const f = setup();
  mock.revision.mockRejectedValue(new Error("missing"));
  await expect(f.load()).rejects.toThrow();
});
it.each(["tenant", "future", "version", "gap"])(
  "rejects inconsistent closure history %s",
  async (kind) => {
    const f = setup();
    f.query.mockResolvedValue({
      rows: [
        {
          ...closed,
          ...(kind === "tenant"
            ? { tenantReference: id(40) }
            : kind === "future"
              ? { occurredAt: "2026-09-21T00:00:00.000Z" }
              : kind === "version"
                ? { orderVersion: 5 }
                : { closureVersion: 2, previousClosureReference: id(40) }),
        },
      ],
      rowCount: 1,
    });
    await expect(f.load()).rejects.toThrow();
  },
);
it("does not report stale Closed over later Order revision", async () => {
  const f = setup();
  f.current.version = 5;
  f.query.mockResolvedValue({ rows: [closed], rowCount: 1 });
  await expect(f.load()).rejects.toThrow();
});
it("reauthorizes after reading complete history", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
});

it("exposes immutable full owner history while preserving the current position contract", async () => {
  const f = setup();
  f.query.mockResolvedValue({ rows: [closed, reopened], rowCount: 2 });
  const result = await f.history();
  expect(result.records).toEqual([closed, reopened]);
  expect(result.position).toEqual(await f.load());
  expect(result.position.status).toBe("Open");
  expect(result.records[0]?.financialFinalityReference).toBe(closed.financialFinalityReference);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.records)).toBe(true);
  expect(result.records.every(Object.isFrozen)).toBe(true);
  expect(result.position).not.toHaveProperty("records");
});
it("history distinguishes a verified empty history from unavailable or revoked evidence", async () => {
  const f = setup();
  expect((await f.history()).records).toEqual([]);
  f.query.mockRejectedValueOnce(new Error("unavailable"));
  await expect(f.history()).rejects.toThrow("ORDER_CLOSURE_POSITION_UNAVAILABLE");
  f.authorize.mockResolvedValue(false);
  await expect(f.history()).rejects.toThrow("ORDER_CLOSURE_POSITION_UNAVAILABLE");
});
it("history rejects an incomplete or cross-store chain rather than returning a partial finality", async () => {
  const f = setup();
  for (const rows of [[reopened], [closed, { ...reopened, storeReference: id(99) }]]) {
    f.query.mockResolvedValueOnce({ rows, rowCount: rows.length });
    await expect(f.history()).rejects.toThrow("ORDER_CLOSURE_POSITION_UNAVAILABLE");
  }
});
