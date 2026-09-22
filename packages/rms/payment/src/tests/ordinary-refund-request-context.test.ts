import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundRequestContextSource } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";
function setup() {
  const request = ordinaryRefundRequestFixture();
  const scope = {
    tenantReference: request.tenantReference,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
  };
  const input = {
    orderReference: request.orderReference,
    operationReference: request.operationReference,
    observedAt: request.requestedAt,
  };
  const state = {
    operations: [] as { record: string }[],
    history: [] as { record: string; version: string }[],
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("operation_id=$3")
      ? state.operations
      : sql.includes("ORDER BY claim_version")
        ? state.history
        : [],
    rowCount: null,
  }));
  const authorize = vi.fn(async () => true);
  const tx = { query } as unknown as ConsumerTransaction;
  const source = createPostgresOrdinaryRefundRequestContextSource({ scope, authorize });
  const save = () => {
    const record = encodeOrdinaryRefundRequest(request);
    state.operations = [{ record }];
    state.history = [{ record, version: "1" }];
  };
  return { request, scope, input, state, query, authorize, tx, source, save };
}
it("holds the writer operation and order fences before reading an empty history", async () => {
  const f = setup();
  expect(await f.source(f.tx, f.input)).toEqual({ existing: null, history: [] });
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    expect.stringContaining("set_config"),
    expect.stringContaining("pg_advisory_xact_lock"),
    expect.stringContaining("pg_advisory_xact_lock"),
    expect.stringContaining("operation_id=$3"),
    expect.stringContaining("ORDER BY claim_version"),
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenLastCalledWith(f.tx, { ...f.scope, ...f.input });
});
it("retains original clock, audit, amounts and claim position for a later retry", async () => {
  const f = setup();
  f.save();
  const result = await f.source(f.tx, { ...f.input, observedAt: "2026-09-14T10:00:00.000Z" });
  expect(result.existing).toEqual(f.request);
  expect(result.history).toEqual([f.request]);
  expect(Object.isFrozen(result.history)).toBe(true);
});
it("does not read financial history when authorization is denied", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.source(f.tx, f.input)).rejects.toThrow("ORDINARY_REFUND_PERMISSION_DENIED");
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects authorization lost while holding the owner fences", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.source(f.tx, f.input)).rejects.toThrow("ORDINARY_REFUND_PERMISSION_DENIED");
});
it.each(["orderReference", "tenantReference", "storeReference", "operationReference"] as const)(
  "rejects an existing operation with a mismatched %s",
  async (field) => {
    const f = setup();
    f.request[field] = id(90);
    f.save();
    await expect(f.source(f.tx, f.input)).rejects.toThrow();
  },
);
it.each(["missing", "future", "version", "changed", "unindexed"])(
  "rejects inconsistent history: %s",
  async (kind) => {
    const f = setup();
    f.save();
    if (kind === "missing") f.state.history = [];
    if (kind === "future") f.input.observedAt = "2026-09-12T10:00:00.000Z";
    const row = f.state.history[0];
    if (kind !== "missing" && !row) throw new Error("fixture");
    if (kind === "version" && row) row.version = "2";
    if (kind === "changed" && row)
      row.record = encodeOrdinaryRefundRequest({
        ...f.request,
        auditReference: id(90),
      });
    if (kind === "unindexed") f.state.operations = [];
    await expect(f.source(f.tx, f.input)).rejects.toThrow();
  },
);
it("rejects extra query authority fields before accessing the transaction", async () => {
  const f = setup();
  await expect(
    f.source(f.tx, { ...f.input, tenantReference: id(90) } as typeof f.input),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
