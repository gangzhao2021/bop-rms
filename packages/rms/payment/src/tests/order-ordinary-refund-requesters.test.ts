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
    declined: null,
    prepared: "1",
    going_back: "6000",
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
      state: "Sent",
      goingBackMinor: "6000",
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

it("WP-2423 M61 review: a request that did not send money back says so, never as a refund", async () => {
  const f = ordinaryRefundRequestFixture();
  const row = {
    request: f.requestReference,
    actor: f.actorReference,
    amount: "6000",
    requested_at: new Date(f.requestedAt),
    record: encodeOrdinaryRefundRequest(f),
    declined: null,
    prepared: "0",
    going_back: "0",
  };
  const scope = { brandReference: f.brandReference, storeReference: f.storeReference };
  const read = async (changes: Record<string, unknown>) =>
    (
      await listOrderOrdinaryRefundRequesters(
        tx([{ ...row, ...changes }]) as never,
        scope,
        f.orderReference,
      )
    ).map((entry) => [entry.state, entry.goingBackMinor]);
  // Waiting for approval, or not sent yet.
  expect(await read({})).toEqual([["Requested", "0"]]);
  // An owner said no; the sole operator took their own request back.
  expect(await read({ declined: "Independent" })).toEqual([["Declined", "0"]]);
  expect(await read({ declined: "SoleOperator" })).toEqual([["Withdrawn", "0"]]);
  // The Provider failed or canceled every leg.
  expect(await read({ prepared: "1", going_back: "0" })).toEqual([["Failed", "0"]]);
  // One of two legs failed: only the other goes back, to the cent.
  expect(await read({ prepared: "2", going_back: "2550" })).toEqual([["Sent", "2550"]]);
  // Records that cannot be true are not guessed at.
  for (const broken of [
    { declined: "Independent", prepared: "1", going_back: "6000" },
    { declined: "Someone" },
    { prepared: "1", going_back: "6001" },
  ])
    await expect(read(broken)).rejects.toThrow("ORDINARY_REFUND_REQUEST_UNAVAILABLE");
});
