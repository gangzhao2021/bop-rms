import { describe, expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresReceiptOrderSource } from "../infrastructure/persistence/receipt-order-source.js";
import { encodeOrderItemSnapshot } from "../domain/order-item-snapshot-codec.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";

function fixture() {
  const { record } = orderWriteFixture({ at: "2026-09-12T12:00:00.000Z" }).request;
  const rows: Record<string, unknown>[][] = [
    [],
    [
      {
        order_id: record.order.orderReference,
        order_number: "123",
        created_at: record.createdAt,
        guest_session_id: record.guestSessionReference,
      },
    ],
    record.order.batches.map((batch) => ({
      order_batch_id: batch.orderBatchReference,
      submitted_at: record.createdAt,
    })),
    record.items.map((item, index) => ({
      order_item_id: item.orderItemReference,
      order_batch_id: item.orderBatchReference,
      source_cart_line_id: item.cartItemReference,
      ordinal: index + 1,
      quantity: item.quantity,
      catalog_snapshot_digest: item.catalog.snapshotDigest,
      quote_input_digest: item.pricing.quoteInputDigest,
      snapshot_captured_at: item.snapshotCapturedAt,
      transaction_snapshot_json: JSON.parse(encodeOrderItemSnapshot(item)) as unknown,
      quote_version: "1",
    })),
  ];
  let queries = 0,
    authorizations = 0,
    allowed = true;
  const tx: ConsumerTransaction = {
    query: async <Row>() => ({ rows: (rows[queries++] ?? []) as Row[], rowCount: 1 }),
  };
  const read = createPostgresReceiptOrderSource({
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    authorize: async () => {
      authorizations++;
      return allowed;
    },
  });
  return {
    rows,
    record,
    tx,
    read,
    request: { orderReference: record.order.orderReference, observedAt: record.createdAt },
    deny: () => {
      allowed = false;
    },
    counts: () => ({ queries, authorizations }),
  };
}

describe("receipt Order persisted source", () => {
  it("decodes frozen owner rows and reauthorizes after the read", async () => {
    const f = fixture();
    const result = await f.read(f.tx, f.request);
    expect(result.items.map((item) => item.snapshot)).toEqual(f.record.items);
    expect(f.counts()).toEqual({ queries: 4, authorizations: 2 });
  });
  it("rejects unauthorized reads before any database access", async () => {
    const f = fixture();
    f.deny();
    await expect(f.read(f.tx, f.request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
    expect(f.counts().queries).toBe(0);
  });
  it.each(["quantity", "ordinal", "quote_version", "catalog_snapshot_digest"])(
    "rejects inconsistent persisted %s instead of issuing a partial receipt",
    async (field) => {
      const f = fixture();
      const row = f.rows[3]?.[0];
      if (!row) throw new Error("missing fixture item");
      row[field] = field === "quantity" || field === "ordinal" ? 999 : "invalid";
      await expect(f.read(f.tx, f.request)).rejects.toMatchObject({
        code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it("rejects authority revoked during owner reads", async () => {
    const f = fixture();
    const tx: ConsumerTransaction = {
      query: async <Row>(sql: string, params: readonly unknown[]) => {
        const result = await f.tx.query<Row>(sql, params);
        f.deny();
        return result;
      },
    };
    await expect(f.read(tx, f.request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
  });
});
