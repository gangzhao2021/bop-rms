import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiningTable,
  createPostgresDiningTableStore,
  type DiningTableOperationRecord,
} from "../index.js";
import { diningTableCommandIntent } from "../application/dining-table-record.js";
const id = (n: number) => `01902272-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-09T09:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const refs = {
  hashIntent: (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  equals: (a: string, b: string) => a === b,
};
function table() {
  return createDiningTable({
    ...scope,
    tableReference: id(4),
    stableLabel: "T01",
    areaReference: id(5),
    areaCode: "MAIN",
    capacity: 4,
    accessibilityAttributes: ["STEP_FREE"],
    lifecycle: "Draft",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: at,
    observedAt: at,
  });
}
function record(): DiningTableOperationRecord {
  const candidate = table();
  return {
    operationReference: id(6) as never,
    intentDigest: refs.hashIntent(
      diningTableCommandIntent("CreateDraft", id(6) as never, null, candidate, at),
    ),
    table: candidate,
    audit: {
      auditId: id(7),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(8) },
      actionCode: "DINING_TABLE_CREATEDRAFT",
      targetType: "DiningTable",
      targetId: id(4),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(9),
      occurredAt: at,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
    event: {
      eventType: "DiningTableDrafted",
      tableReference: id(4) as never,
      aggregateVersion: "1",
      lifecycle: "Draft",
      qrStatus: "Inactive",
      operationalState: "Available",
      occurredAt: at,
    },
  };
}
function fixture(result: unknown = { rows: [{ table: table() }] }) {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(async (sql) =>
    sql.includes(" AS ") ? result : { rows: [] },
  );
  const called = vi.fn();
  const run = async <T>(
    action: (transaction: { query: typeof query }) => Promise<T>,
  ): Promise<T> => {
    called();
    return action({ query });
  };
  const store = createPostgresDiningTableStore({ run }, scope, refs);
  return { store, query, run, called };
}
describe("WP-2272 Dining Table storage boundary", () => {
  it("copies exact scope and freezes a current owner Table", async () => {
    const state = fixture();
    const mutableScope = { ...scope };
    const store = createPostgresDiningTableStore({ run: state.run }, mutableScope, refs);
    mutableScope.tenantReference = id(90);
    const result = await store.loadTable(id(4) as never);
    expect(result).toEqual(table());
    expect(Object.isFrozen(result)).toBe(true);
    expect(state.query.mock.calls.map((call) => call[1])).toEqual([
      [id(2), id(3)],
      [id(1), id(2), id(3), id(4)],
    ]);
  });
  it("returns null only for absence", async () => {
    expect(await fixture({ rows: [] }).store.loadTable(id(4) as never)).toBeNull();
    expect(await fixture({ rows: [] }).store.resolveTableOperation(id(6) as never)).toBeNull();
  });
  it("rejects malformed locators before transaction entry", async () => {
    const state = fixture();
    await expect(state.store.loadTable("invalid" as never)).rejects.toMatchObject({
      code: "DINING_TABLE_INPUT_INVALID",
    });
    await expect(state.store.resolveTableOperation("invalid" as never)).rejects.toMatchObject({
      code: "DINING_TABLE_INPUT_INVALID",
    });
    expect(state.called).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { rows: null },
    { rows: [null] },
    { rows: [{ table: {} }] },
    { rows: [{ table: table() }, { table: table() }] },
    ...["tenantReference", "brandReference", "storeReference", "tableReference"].map((field) => ({
      rows: [{ table: { ...table(), [field]: id(90) } }],
    })),
  ])("rejects malformed or foreign read results", async (result) => {
    await expect(fixture(result).store.loadTable(id(4) as never)).rejects.toMatchObject({
      code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      message: "Dining Table operation is unavailable",
    });
  });
  it("validates full original operation and its canonical intent", async () => {
    const state = fixture({ rows: [{ record: record() }] });
    const result = await state.store.resolveTableOperation(id(6) as never);
    expect(result).toEqual(record());
    expect(Object.isFrozen(result?.audit.actor)).toBe(true);
  });
  it.each(["intentDigest", "operationReference", "table", "audit", "event"])(
    "rejects malformed historical %s",
    async (field) => {
      const result = { ...record(), [field]: "invalid" };
      await expect(
        fixture({ rows: [{ record: result }] }).store.resolveTableOperation(id(6) as never),
      ).rejects.toMatchObject({ code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE" });
    },
  );
  it("rejects a correctly shaped digest for different command facts before writing", async () => {
    const state = fixture();
    await expect(
      state.store.commitTable({ ...record(), intentDigest: `sha256:${"a".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE" });
    expect(state.called).not.toHaveBeenCalled();
  });
  it("does not invoke result getters", async () => {
    const getter = vi.fn(() => {
      throw new Error("synthetic private detail");
    });
    const result = Object.defineProperty({}, "rows", { enumerable: true, get: getter });
    await expect(fixture(result).store.loadTable(id(4) as never)).rejects.toMatchObject({
      code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("redacts runner failures", async () => {
    const store = createPostgresDiningTableStore(
      {
        run: async () => {
          throw new Error("synthetic private detail");
        },
      },
      scope,
      refs,
    );
    for (const action of [
      () => store.loadTable(id(4) as never),
      () => store.resolveTableOperation(id(6) as never),
      () => store.commitTable(record()),
    ])
      await expect(action()).rejects.toMatchObject({
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
        message: "Dining Table operation is unavailable",
      });
  });
});
