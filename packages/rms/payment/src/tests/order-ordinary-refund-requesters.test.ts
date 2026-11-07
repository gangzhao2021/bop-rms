import { expect, it } from "vitest";
import { encodeOrdinaryRefundRequest } from "../application/ordinary-refund-request.js";
import { listOrderOrdinaryRefundRequesters } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";

const tx = (rows: readonly Record<string, unknown>[]) => ({
  query: async (sql: string) => ({ rows: sql.startsWith("SELECT set_config") ? [] : rows }),
});

it("WP-2423 M61 review: an order record's refund says how the money goes back from Payment's record", async () => {
  const f = ordinaryRefundRequestFixture();
  const row = {
    request: f.requestReference,
    actor: f.actorReference,
    amount: "6000",
    requested_at: new Date(f.requestedAt),
    record: encodeOrdinaryRefundRequest(f),
  };
  const scope = { brandReference: f.brandReference, storeReference: f.storeReference };
  expect(
    await listOrderOrdinaryRefundRequesters(tx([row]) as never, scope, f.orderReference),
  ).toEqual([
    {
      requestReference: f.requestReference,
      actorReference: f.actorReference,
      amountMinor: "6000",
      requestedAt: f.requestedAt,
      method: "Online",
    },
  ]);
  // A record that is not this request's is not guessed at.
  await expect(
    listOrderOrdinaryRefundRequesters(
      tx([{ ...row, request: id(99) }]) as never,
      scope,
      f.orderReference,
    ),
  ).rejects.toThrow("ORDINARY_REFUND_REQUEST_UNAVAILABLE");
});
