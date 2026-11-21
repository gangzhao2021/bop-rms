import assert from "node:assert/strict";
import {
  chunkKitchenWorkStepLines,
  parseKitchenWorkStepBody,
  runKitchenWorkStepChunk,
} from "../../rms/kitchen/src/index.ts";
import { createPostgresOrderKitchenSourceStore } from "../../rms/ordering/src/index.ts";
import { issuedSourceRefused } from "../../../tooling/environment/pilot-kitchen-command.mjs";

/**
 * WP-2423 batch 31: the pilot's current-source check for a board tap (pilot-kitchen-command.mjs
 * `createInternalKitchenStep`): the ticket's issued source over the real Ordering kitchen source
 * (`resolveIssued`); the Order's moved-on answers are a refusal, anything else stays "busy".
 */
export function pilotTicketSourceCheck({ brand, store, sha, quoteVersion }) {
  const source = createPostgresOrderKitchenSourceStore({
    brandReference: brand,
    storeReference: store,
    quoteVersion,
    sha256: sha,
    authorize: async () => true,
  });
  return async (transaction, ticketReference) => {
    const ticket = (
      await transaction.query(
        "SELECT order_id::text AS order_id,order_batch_id::text AS batch,confirmation_id::text AS confirmation," +
          "source_event_id::text AS event,source_aggregate_version::text AS version," +
          "source_snapshot_digest AS snapshot,source_evidence_digest AS evidence " +
          "FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3",
        [brand, store, ticketReference],
      )
    ).rows[0];
    if (ticket === undefined) return false;
    try {
      const current = await source.resolveIssued({
        transaction,
        query: {
          brandReference: brand,
          storeReference: store,
          orderReference: ticket.order_id,
          orderBatchReference: ticket.batch,
          confirmationReference: ticket.confirmation,
          sourceEventReference: ticket.event,
          sourceAggregateVersion: BigInt(ticket.version),
          sourceSnapshotDigest: ticket.snapshot,
          observedAt: new Date().toISOString(),
        },
      });
      return current.evidenceDigest === ticket.evidence;
    } catch (error) {
      if (issuedSourceRefused(error)) return false;
      throw error;
    }
  };
}

/** One board tap (POST /merchant/kitchen/step) as apps/api composes it: one transaction a chunk. */
export async function kitchenBoardTap({
  run,
  brand,
  store,
  actor,
  validateTicketSource,
  step,
  lines,
}) {
  const body = parseKitchenWorkStepBody({
    step,
    storeReference: store,
    correlationReference: lines.correlationReference,
    lines: lines.items,
  });
  const tapTickets = [...new Set(body.lines.map((line) => line.ticketReference))];
  const results = [];
  for (const chunk of chunkKitchenWorkStepLines(body.lines))
    results.push(
      ...(
        await run((transaction) =>
          runKitchenWorkStepChunk(
            {
              brandReference: brand,
              storeReference: store,
              actorReference: actor,
              now: () => new Date().toISOString(),
              guard: async () => true,
              validateTicketSource,
              comboChoices: async () => new Map(),
            },
            {
              transaction,
              step,
              correlationReference: body.correlationReference,
              tapTickets,
              lines: chunk,
            },
          ),
        )
      ).lines,
    );
  return results;
}

/**
 * The cook taps a ticket still on the board after Orders cancelled its order whole (v15 orders 1, 7,
 * 11, 21). Each tap is answered at once, line by line, "was cancelled" (never "busy, try again",
 * which the route answers 503 and the board retries), nothing is recorded and the ticket stays as
 * the kitchen recorded it: DEC-KITCHEN-ONE-TAP keeps a cancelled dish crossed out on its card for a
 * minute, then it leaves the board; no closure is written.
 */
export async function assertTapAfterOrdersCancelled({
  admin,
  run,
  brand,
  store,
  actor,
  validateTicketSource,
  ticket,
  next,
}) {
  const facts = async () =>
    (
      await admin.query(
        "SELECT t.status,t.aggregate_version::text AS version," +
          "(SELECT count(*)::int FROM rms_kitchen.kitchen_ticket_closure c WHERE c.kitchen_ticket_id=t.kitchen_ticket_id) AS closures," +
          "(SELECT count(*)::int FROM rms_kitchen.kitchen_work_lifecycle_operation o WHERE o.kitchen_ticket_id=t.kitchen_ticket_id) AS operations," +
          "(SELECT array_agg(w.status||':'||w.version ORDER BY w.source_item_ordinal,w.split_ordinal) FROM rms_kitchen.kitchen_work_item w WHERE w.kitchen_ticket_id=t.kitchen_ticket_id) AS items" +
          " FROM rms_kitchen.kitchen_ticket t WHERE t.kitchen_ticket_id=$1",
        [ticket],
      )
    ).rows[0];
  const workItems = (
    await admin.query(
      "SELECT kitchen_work_item_id::text AS work_item,order_item_id::text AS order_item FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY source_item_ordinal,split_ordinal",
      [ticket],
    )
  ).rows;
  const before = await facts();
  assert.equal(before.status, "Open");
  assert.ok(before.items.every((item) => item.startsWith("Cancelled:")));
  for (const step of ["Finish", "Start"]) {
    const lines = await kitchenBoardTap({
      run,
      brand,
      store,
      actor,
      validateTicketSource,
      step,
      lines: {
        correlationReference: next(),
        items: workItems.map((row) => ({
          idempotencyKey: next(),
          ticketReference: ticket,
          workItemReference: row.work_item,
          orderItemReference: row.order_item,
          optionReferences: null,
        })),
      },
    });
    assert.deepEqual(
      lines.map((line) => [line.workItemReference, line.outcome, line.refusedReason]),
      workItems.map((row) => [row.work_item, "Refused", "Cancelled"]),
    );
    assert.ok(lines.every((line) => line.workItemStatus === "Cancelled"));
  }
  assert.deepEqual(await facts(), { ...before, closures: 0 });
}
