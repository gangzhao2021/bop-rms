import assert from "node:assert/strict";
import {
  listStoreDiningSessionOrders,
  listStoreOrderRoundSubmissions,
  listStoreOrdersWithRoundsSince,
} from "../../rms/ordering/src/index.ts";

/**
 * WP-2423 D4 (restricted-role check): a table's later round has its own submission time, so a
 * round added on a later business day is that day's work. Run inside a transaction of the
 * NOBYPASSRLS pilot role (e.g. the acceptance's `asApi`). Pass the Order's first round, its later
 * round, the Order's own business date and a "today" whose start lies between the two rounds'
 * submissions (`todayStartsAt`, ISO instant, and `todayBusinessDate`). Optionally the dining
 * session, to check the Tables page finds its one Order.
 */
export async function assertLateRoundBusinessDate(tx, scope, input) {
  const rounds = await listStoreOrderRoundSubmissions(tx, scope, [
    input.initialBatchReference,
    input.laterBatchReference,
  ]);
  const first = rounds.get(input.initialBatchReference);
  const later = rounds.get(input.laterBatchReference);
  assert.ok(first && later, "both rounds are read under the restricted role");
  assert.equal(first.initial, true);
  assert.equal(later.initial, false);
  assert.equal(first.orderReference, input.orderReference);
  assert.equal(later.orderReference, input.orderReference);
  assert.equal(later.orderBusinessDate, input.openedBusinessDate);
  assert.ok(Date.parse(later.submittedAt) >= Date.parse(input.todayStartsAt));
  const carried = await listStoreOrdersWithRoundsSince(tx, scope, {
    since: input.todayStartsAt,
    businessDate: input.todayBusinessDate,
    limit: 100,
  });
  assert.ok(
    carried.some((order) => order.orderReference === input.orderReference),
    "the older Order with a round today is listed with today's orders",
  );
  if (input.diningSessionReference !== undefined) {
    const orders = await listStoreDiningSessionOrders(tx, scope, [input.diningSessionReference]);
    assert.equal(orders.get(input.diningSessionReference), input.orderReference);
  }
}
