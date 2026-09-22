import { describe, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresKitchenCustomerStatusReader } from "../index.js";

const id = (n: number) => "10000000-0000-7000-8000-" + n.toString().padStart(12, "0");
function fixture(status = "Queued", ready = false) {
  const ticket = {
    kitchen_ticket_id: id(4),
    order_batch_id: id(5),
    version: "3",
    status: "Open",
    updated_at: new Date("2026-09-12T12:00:00.000Z"),
  };
  const item = {
    kitchen_work_item_id: id(6),
    order_item_id: id(7),
    status,
    required_quantity: 1,
    completed_quantity: status === "Completed" ? 1 : 0,
    ready_result_id: ready ? id(8) : null,
    ready_quantity: ready ? 1 : null,
    ready_required_quantity: ready ? 1 : null,
  };
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM rms_kitchen.kitchen_ticket") ? [ticket] : [item],
    rowCount: 1,
  }));
  const transaction = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn().mockResolvedValue(true);
  const reader = createPostgresKitchenCustomerStatusReader({
    brandReference: id(1),
    storeReference: id(2),
    authorize,
  });
  const load = () => reader.loadByOrder({ transaction, orderReference: id(3) });
  return { ticket, item, query, transaction, authorize, load };
}
describe("customer-safe Kitchen status", () => {
  it.each([
    ["Queued", false, "Queued"],
    ["In Progress", false, "InProgress"],
    ["Completed", false, "InProgress"],
    ["Completed", true, "Ready"],
  ] as const)("maps %s with ready result %s to %s", async (status, ready, expected) => {
    const f = fixture(status, ready);
    const result = await f.load();
    expect(result?.batches[0]).toEqual({
      orderBatchReference: id(5),
      ticketReference: id(4),
      ticketVersion: 3n,
      updatedAt: "2026-09-12T12:00:00.000Z",
      status: expected,
      items: [{ orderItemReference: id(7), status: expected }],
    });
    expect(f.authorize).toHaveBeenCalledWith(f.transaction, {
      brandReference: id(1),
      storeReference: id(2),
      orderReference: id(3),
    });
    expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2), id(3)]);
    expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(4)]);
  });
  it("keeps partial item readiness separate from batch progress", async () => {
    const f = fixture("Completed", true);
    f.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM rms_kitchen.kitchen_ticket")
        ? [f.ticket]
        : [
            f.item,
            {
              ...f.item,
              kitchen_work_item_id: id(9),
              order_item_id: id(10),
              status: "Queued",
              completed_quantity: 0,
              ready_result_id: null,
              ready_quantity: null,
              ready_required_quantity: null,
            },
          ],
      rowCount: 1,
    }));
    const result = await f.load();
    expect(result?.batches[0]?.status).toBe("InProgress");
    expect(result?.batches[0]?.items).toEqual([
      { orderItemReference: id(7), status: "Ready" },
      { orderItemReference: id(10), status: "Queued" },
    ]);
  });
  it("requires current authorization before reading each time", async () => {
    const f = fixture();
    await f.load();
    f.query.mockClear();
    f.authorize.mockResolvedValue(false);
    await expect(f.load()).rejects.toMatchObject({ code: "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("returns absence without inventing a queued ticket", async () => {
    const f = fixture();
    f.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await f.load()).toBeNull();
  });
  it.each(["Held", "Cancelled", "Ready"])("fails closed on unsupported %s", async (status) => {
    await expect(fixture(status).load()).rejects.toMatchObject({
      code: "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects a ready result inconsistent with completed quantity", async () => {
    await expect(fixture("In Progress", true).load()).rejects.toMatchObject({
      code: "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("omits any additional private row data", async () => {
    const f = fixture();
    Object.assign(f.item, { customer_note: "private", allergen_review: "private" });
    expect(
      JSON.stringify(await f.load(), (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("private");
  });
});
