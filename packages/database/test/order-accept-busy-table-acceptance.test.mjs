import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const id = (n) => "01a0fe30-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 batch 30 (held-price-and-table-races, item 2). v15 2026-11-18, Test Merchant 2, a
 * pay-first table with two paid rounds waiting on Orders: staff pressed Accept on one round, then
 * on the other about 0.3 s later. The second answered 409 order_changed (accept again), because
 * it named the Order version the list loaded and the first acceptance had moved the Order on. The
 * same happened when a staff round was sent between loading the list and pressing Accept.
 *
 * Here, through the pilot's real compositions under the restricted NOBYPASSRLS API role holding the
 * rendered pilot ACL: rounds paid on the Store's card machine wait for acceptance; Orders' accept
 * (the seen-version command the page sends) of a round whose Order another round's acceptance, or
 * another round, moved on since is accepted at the version the Order is at now. A round whose own
 * facts changed since the version staff saw (here: it was sent after it) is never accepted on it.
 * Synthetic TEST references only.
 */
it("Orders accepts a waiting round after another round of the same order was accepted or sent, never one whose own facts changed", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_accept_busy" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_acb");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const server = await store.staff(id(0x810), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const accept = await store.acceptanceFor(server);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };

      const placeRound = async () => {
        const placed = await counter.staffDiningRound({
          ...as,
          command: {
            operationReference: reference(),
            tableReference,
            tip: { kind: "None" },
            recordedAfterOutage: false,
            lines: [
              {
                sellableReference: soup.skuReference,
                quantity: 1,
                optionSelections: [],
                note: null,
              },
            ],
          },
        });
        // The soup and its tax, to the cent (6.50 + 13 % = 7.35).
        assert.deepEqual([placed.status, placed.totalMinor], ["Placed", "735"]);
        return placed;
      };
      // Paid on the card machine and recorded; it then waits on Orders for staff to accept it.
      const payRound = async (placed, slip) => {
        const paid = await counter.cardMachinePayment({
          ...as,
          command: {
            operationReference: reference(),
            orderReference: placed.orderReference,
            orderBatchReference: placed.orderBatchReference,
            expectedTotalMinor: placed.totalMinor,
            slipReference: slip,
            takenAt: null,
          },
        });
        assert.equal(paid.status, "Recorded");
      };
      const orderVersion = async (orderReference) =>
        (
          await admin.query(
            "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
            [orderReference],
          )
        ).rows[0].version;
      // Orders' Accept: the version the list loaded, as the page sends it.
      const acceptAsSeen = (round, expectedOrderVersion) =>
        accept(
          {
            ...as,
            command: {
              acceptanceReference: reference(),
              operationReference: reference(),
              orderReference: round.orderReference,
              orderBatchReference: round.orderBatchReference,
              expectedOrderVersion,
            },
          },
          "SeenVersion",
        ).then(
          (value) => value,
          (error) => ({ status: "Refused", code: error?.code ?? String(error) }),
        );
      const accepted = async (orderReference) =>
        (
          await admin.query(
            "SELECT order_batch_id::text AS round, expected_order_version AS expected, accepted_order_version AS accepted FROM rms_ordering.order_acceptance_record WHERE order_id=$1 ORDER BY accepted_order_version",
            [orderReference],
          )
        ).rows;

      // (1) Two paid rounds wait together. Accept one, then the other with the same list.
      const first = await placeRound();
      await payRound(first, "AUTH 300001");
      const second = await placeRound();
      await payRound(second, "AUTH 300002");
      const orderReference = first.orderReference;
      const listed = await orderVersion(orderReference);
      const one = await acceptAsSeen(first, listed);
      assert.deepEqual(one, { status: "Created", acceptedOrderVersion: listed + 1 });
      const two = await acceptAsSeen(second, listed);
      assert.deepEqual(
        two,
        { status: "Created", acceptedOrderVersion: listed + 2 },
        "the second round is accepted, not refused as changed",
      );
      // Pressed again from an older list, it is told the round was already accepted.
      const again = await accept(
        {
          ...as,
          command: {
            acceptanceReference: reference(),
            operationReference: reference(),
            orderReference,
            orderBatchReference: second.orderBatchReference,
            expectedOrderVersion: listed,
          },
        },
        "SeenVersion",
      ).catch((error) => ({ status: "Refused", code: error?.code }));
      assert.deepEqual(again, { status: "Refused", code: "ORDER_ACCEPTANCE_ALREADY_ACCEPTED" });

      // (2) A paid round waits; staff send another round for the table before Accept is pressed.
      const third = await placeRound();
      await payRound(third, "AUTH 300003");
      const loaded = await orderVersion(orderReference);
      const fourth = await placeRound();
      assert.ok((await orderVersion(orderReference)) > loaded);
      const three = await acceptAsSeen(third, loaded);
      assert.equal(three.status, "Created", JSON.stringify(three));
      assert.ok(three.acceptedOrderVersion > loaded + 1);

      // (3) A round whose own facts changed since the list: here the list was read before this
      // very round was sent (the version staff saw names no such round). Never accepted on it.
      await payRound(fourth, "AUTH 300004");
      const beforeFifth = await orderVersion(orderReference);
      const fifth = await placeRound();
      await payRound(fifth, "AUTH 300005");
      const five = await acceptAsSeen(fifth, beforeFifth);
      assert.deepEqual(five, { status: "Refused", code: "ORDER_ACCEPTANCE_VERSION_CONFLICT" });
      // The fourth round, read after it was sent, is accepted although the fifth came since.
      const four = await acceptAsSeen(fourth, beforeFifth);
      assert.equal(four.status, "Created", JSON.stringify(four));

      // Each acceptance is one record, recorded at the version the Order was at then.
      assert.deepEqual(
        (await accepted(orderReference)).map((row) => [row.round, row.accepted - row.expected]),
        [first, second, third, fourth].map((round) => [round.orderBatchReference, 1]),
      );
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
