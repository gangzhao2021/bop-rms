import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createKitchenTicketClosedEnvelope,
  createPostgresKitchenQueueSourceReader,
  createPostgresKitchenReworkStore,
  createPostgresKitchenStaleTicketStore,
  KitchenReworkError,
  KitchenStaleTicketError,
  listClosedKitchenTickets,
  listOpenKitchenReworkItems,
  parseKitchenTicketClosedEnvelope,
} from "../../rms/kitchen/src/index.ts";
import { listStoreOrderBusinessDates } from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0f027-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (character) => "sha256:" + character.repeat(64);
const hash = (value) =>
  "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const instant = (offsetMs) =>
  new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString();

async function insertRow(client, table, row) {
  const columns = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
    columns.map((column) => row[column]),
  );
}

/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS: a kitchen ticket left open from an earlier business day is
 * labelled with its day (order numbers restart daily), closed by a manager with a reason, audited
 * and evented, leaves the live board, and no later kitchen step may change it. Kitchen owner
 * persistence runs as a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants
 * (matrix + Owner-approved additions). Test-only stand-ins: synthetic Kitchen tickets and work
 * items and Ordering Order headers inserted by the owner (creation is covered by the Kitchen
 * ticket and Ordering suites); the Store's current business day is supplied as a fixed date.
 */
it("lists an earlier day's ticket by its business day, closes it once with a reason, audits and events it, drops it from the board and refuses any later kitchen step", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stale" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_st_" + context.runId,
      worker = "wp2423_st_w_" + context.runId;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const tenant = id(1),
        brand = id(2),
        store = id(3),
        storeB = id(4);
      let sequence = 0x10000;
      const next = () => id(sequence++);

      /** One restricted-role transaction (pilot API grants). */
      const asApi = async (work, scopeStore = store) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, scopeStore],
          );
          const result = await work({
            query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      };
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── Synthetic facts. Store A: Order 2 of Fri, Oct 9 (left open: queued, in progress and a
      // dish completed but never marked ready) and today's Order 2; an earlier ticket whose work
      // was all cancelled. Store B: a finished ticket untouched for three days, and an open one.
      const at = instant(-5 * 86_400_000);
      const ticketRow = (ticket, order, batch, storeId, updatedAt = at, version = 3) => ({
        kitchen_ticket_id: ticket,
        brand_id: brand,
        store_id: storeId,
        order_id: order,
        order_batch_id: batch,
        confirmation_id: next(),
        consumer_name: "kitchen.confirmed-order:v1",
        consumer_version: 1,
        source_event_id: next(),
        source_aggregate_version: 1,
        source_snapshot_digest: sha("1"),
        confirmed_at: at,
        correlation_id: next(),
        semantic_event_binding_digest: sha("2"),
        source_evidence_id: ticket.replace(
          "01a0f027-0000-7000-8000-0",
          "01a0f027-0000-7000-8000-e",
        ),
        source_evidence_version: 1,
        source_evidence_digest: sha("3"),
        source_evidence_captured_at: at,
        work_plan_id: ticket.replace("01a0f027-0000-7000-8000-0", "01a0f027-0000-7000-8000-f"),
        work_plan_version: 1,
        work_plan_digest: sha("4"),
        work_plan_generated_at: at,
        aggregate_version: version,
        status: "Open",
        created_by_actor_type: "System",
        updated_by_actor_type: "System",
        created_at: at,
        updated_at: updatedAt,
      });
      const itemRow = (
        ticketRowValue,
        n,
        ordinal,
        status,
        required,
        completed,
        createdAt = at,
      ) => ({
        kitchen_work_item_id: id(n),
        brand_id: brand,
        store_id: ticketRowValue.store_id,
        kitchen_ticket_id: ticketRowValue.kitchen_ticket_id,
        order_id: ticketRowValue.order_id,
        order_batch_id: ticketRowValue.order_batch_id,
        order_item_id: id(n + 1),
        source_evidence_id: ticketRowValue.source_evidence_id,
        work_plan_id: ticketRowValue.work_plan_id,
        source_item_ordinal: ordinal,
        split_ordinal: 1,
        version: 2,
        status,
        required_quantity: required,
        completed_quantity: completed,
        product_id: id(700),
        product_version_id: id(701),
        sku_id: id(702),
        menu_version_id: id(703),
        localized_display_names_json: JSON.stringify({ "en-CA": "Synthetic bowl " + ordinal }),
        selected_options_json: JSON.stringify([]),
        source_line_digest: sha("5"),
        station_id: id(704),
        routing_rule_id: id(705),
        routing_rule_version: 1,
        routing_rule_digest: sha("6"),
        preparation_id: id(706),
        preparation_version: 1,
        preparation_digest: sha("7"),
        preparation_instructions_json: JSON.stringify(["Synthetic preparation"]),
        execution_snapshot_digest: sha("8"),
        created_by_actor_type: "System",
        updated_by_actor_type: "System",
        created_at: createdAt,
        updated_at: createdAt,
      });
      const oldOrder = id(0x11),
        todayOrder = id(0x21),
        cancelledOrder = id(0x31);
      const oldTicket = ticketRow(id(0x10), oldOrder, id(0x12), store);
      const todayTicket = ticketRow(id(0x20), todayOrder, id(0x22), store, instant(-600_000));
      const cancelledTicket = ticketRow(id(0x30), cancelledOrder, id(0x32), store);
      const finishedB = ticketRow(id(0x40), id(0x41), id(0x42), storeB, instant(-3 * 86_400_000));
      const openB = ticketRow(id(0x50), id(0x51), id(0x52), storeB);
      for (const row of [oldTicket, todayTicket, cancelledTicket, finishedB, openB])
        await insertRow(admin, "rms_kitchen.kitchen_ticket", row);
      // The dish completed but never marked ready reached the kitchen an hour ago (a late ticket).
      const items = [
        itemRow(oldTicket, 0x100, 1, "Queued", 2, 0),
        itemRow(oldTicket, 0x110, 2, "In Progress", 1, 0),
        itemRow(oldTicket, 0x120, 3, "Completed", 1, 1, instant(-3_600_000)),
        itemRow(todayTicket, 0x200, 1, "Queued", 1, 0, instant(-600_000)),
        itemRow(cancelledTicket, 0x300, 1, "Cancelled", 1, 0),
        itemRow(finishedB, 0x400, 1, "Cancelled", 1, 0, instant(-3 * 86_400_000)),
        itemRow(openB, 0x500, 1, "Queued", 1, 0),
      ];
      for (const row of items) await insertRow(admin, "rms_kitchen.kitchen_work_item", row);
      const actor = id(0x60);
      for (const [order, storeId, businessDate, createdAt] of [
        [oldOrder, store, "2026-10-09", at],
        [todayOrder, store, "2026-10-14", instant(-600_000)],
      ]) {
        await admin.query(
          "INSERT INTO rms_ordering.order_number_allocation " +
            "(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at," +
            "business_date_configuration_id,business_date_configuration_version,business_date_content_digest," +
            "time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) " +
            "VALUES ($1,$2,$3,$4,2,'2',$5,$6,1,$7,'America/Toronto','00:00',$5,'Exact')",
          [order, brand, storeId, businessDate, createdAt, id(0x61), hash("bd")],
        );
        await admin.query(
          "INSERT INTO rms_ordering.order_header " +
            "(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id," +
            "created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) " +
            "VALUES ($1,$2,$3,$4,'2','Pickup','Web',NULL,$5,$5,1,'Submitted','Open','NotReported',$6)",
          [order, brand, storeId, businessDate, actor, createdAt],
        );
      }
      const scopeA = { brandReference: brand, storeReference: store };

      // ── 1. Both tickets are "Order 2"; Ordering's business day tells them apart (the board
      // keeps the earlier one in "From earlier days — check and close").
      const dates = await asApi((tx) =>
        listStoreOrderBusinessDates(tx, scopeA, [oldOrder, todayOrder]),
      );
      assert.equal(dates.get(oldOrder), "2026-10-09");
      assert.equal(dates.get(todayOrder), "2026-10-14");

      const manager = id(0x70);
      const kitchen = createPostgresKitchenStaleTicketStore({ ...scopeA, nextReference: next });
      const days =
        (current = "2026-10-14") =>
        async (order) => ({
          orderBusinessDate:
            (await asApi((tx) => listStoreOrderBusinessDates(tx, scopeA, [order]))).get(order) ??
            null,
          currentBusinessDate: current,
        });
      const closeDays = days();
      const close = (command, actorReference = manager, businessDays = closeDays) =>
        asApi(async (tx) => {
          const orderDays = await businessDays(
            command.ticketReference === oldTicket.kitchen_ticket_id
              ? oldOrder
              : command.ticketReference === todayTicket.kitchen_ticket_id
                ? todayOrder
                : cancelledOrder,
          );
          return kitchen.close(tx, {
            command,
            actorReference,
            occurredAt: instant(0),
            businessDays: async () => orderDays,
          });
        });
      const refused = async (promise, code) =>
        assert.rejects(
          promise,
          (error) => error instanceof KitchenStaleTicketError && error.code === code,
        );
      const command = (overrides = {}) => ({
        idempotencyKey: next(),
        ticketReference: oldTicket.kitchen_ticket_id,
        expectedTicketVersion: "3",
        reasonCode: "NOT_MADE_ABANDONED",
        correlationReference: next(),
        ...overrides,
      });

      // ── 2. Refused: today's ticket, a stale version, nothing open, an unknown ticket.
      await refused(
        close(command({ ticketReference: todayTicket.kitchen_ticket_id })),
        "KITCHEN_STALE_TICKET_NOT_EARLIER_DAY",
      );
      await refused(
        close(command({ expectedTicketVersion: "2" })),
        "KITCHEN_STALE_TICKET_CONFLICT",
      );
      await refused(
        close(command({ ticketReference: cancelledTicket.kitchen_ticket_id })),
        "KITCHEN_STALE_TICKET_NOTHING_OPEN",
      );
      await refused(
        close(command({ ticketReference: id(0x99) })),
        "KITCHEN_STALE_TICKET_NOT_FOUND",
      );
      assert.equal(
        (await rows("SELECT count(*)::int AS n FROM rms_kitchen.kitchen_ticket_closure"))[0].n,
        0,
      );

      // ── 3. A manager closes the earlier day's Order 2 as never made: one closure, one audit,
      // one event; every work item keeps the state the kitchen recorded.
      const before = await rows(
        "SELECT kitchen_work_item_id::text AS id,status,version::int AS v FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY 1",
        [oldTicket.kitchen_ticket_id],
      );
      const notMade = command();
      const closed = await close(notMade);
      assert.equal(closed.status, "Closed");
      assert.deepEqual(
        {
          ticket: closed.closure.ticketReference,
          reason: closed.closure.reasonCode,
          foodMade: closed.closure.foodMade,
          orderDay: closed.closure.orderBusinessDate,
          closingDay: closed.closure.closingBusinessDate,
          open: closed.closure.openWorkItemCount,
          by: closed.closure.closedBy,
        },
        {
          ticket: oldTicket.kitchen_ticket_id,
          reason: "NOT_MADE_ABANDONED",
          foodMade: false,
          orderDay: "2026-10-09",
          closingDay: "2026-10-14",
          open: 3,
          by: manager,
        },
      );
      assert.deepEqual(
        await rows(
          "SELECT kitchen_work_item_id::text AS id,status,version::int AS v FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1 ORDER BY 1",
          [oldTicket.kitchen_ticket_id],
        ),
        before,
        "closing never rewrites the kitchen's recorded work",
      );
      const audits = await rows(
        "SELECT action_code,reason_code,actor_reference::text AS actor FROM platform_audit.audit_record WHERE target_id=$1",
        [oldTicket.kitchen_ticket_id],
      );
      assert.deepEqual(audits, [
        {
          action_code: "KITCHEN_STALE_TICKET_CLOSED",
          reason_code: "KITCHEN_STALE_TICKET_NOT_MADE_ABANDONED",
          actor: manager,
        },
      ]);
      const events = await rows(
        "SELECT event_id::text AS id,aggregate_version::text AS v,payload_json FROM platform_eventing.outbox_event WHERE event_type='KitchenTicketClosed'",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].v, "3");
      assert.deepEqual(Object.keys(events[0].payload_json).sort(), [
        "closedAt",
        "foodMade",
        "kitchenTicketReference",
        "openWorkItems",
        "orderBatchReference",
        "orderBusinessDate",
        "orderReference",
        "reasonCode",
        "ticketVersion",
      ]);
      assert.deepEqual(
        events[0].payload_json.openWorkItems.map((item) => [item.status, item.requiredQuantity]),
        [
          ["Queued", 2],
          ["In Progress", 1],
          ["Completed", 1],
        ],
      );
      // The stored event parses with the owner's strict parser (consumers read it the same way).
      const stored = (
        await rows(
          "SELECT event_id::text AS id,occurred_at,aggregate_id::text AS agg,correlation_id::text AS corr,causation_id::text AS cause,actor_id::text AS actor FROM platform_eventing.outbox_event WHERE event_type='KitchenTicketClosed'",
        )
      )[0];
      assert.equal(
        parseKitchenTicketClosedEnvelope(
          createKitchenTicketClosedEnvelope({
            eventReference: stored.id,
            closureReference: stored.cause,
            correlationReference: stored.corr,
            actorReference: stored.actor,
            brandReference: brand,
            storeReference: store,
            payload: events[0].payload_json,
          }),
        ).aggregateId,
        oldTicket.kitchen_ticket_id,
      );

      // ── 4. The same request again is the same closure; any other close of it is refused.
      assert.equal((await close(notMade)).status, "AlreadyClosed");
      await refused(
        close({ ...notMade, reasonCode: "ALREADY_SERVED" }),
        "KITCHEN_STALE_TICKET_CONFLICT",
      );
      await refused(
        close(command({ reasonCode: "ALREADY_SERVED" })),
        "KITCHEN_STALE_TICKET_CONFLICT",
      );
      assert.equal(
        (await rows("SELECT count(*)::int AS n FROM rms_kitchen.kitchen_ticket_closure"))[0].n,
        1,
      );
      assert.deepEqual(
        [
          ...(await asApi((tx) =>
            listClosedKitchenTickets(tx, scopeA, [
              oldTicket.kitchen_ticket_id,
              todayTicket.kitchen_ticket_id,
            ]),
          )),
        ],
        [oldTicket.kitchen_ticket_id],
      );

      // ── 5. Guard: no kitchen step or remake may be recorded for the closed ticket, even past
      // the application; a remake already open is no longer shown as being remade.
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "INSERT INTO rms_kitchen.kitchen_work_lifecycle_operation (kitchen_work_lifecycle_operation_id,brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_item_id) VALUES ($1,$2,$3,$4,$5,$6)",
            [next(), brand, store, oldTicket.kitchen_ticket_id, id(0x100), id(0x101)],
          ),
        ),
        /closed kitchen ticket cannot change/u,
      );
      const rework = createPostgresKitchenReworkStore({ ...scopeA, nextReference: next });
      await assert.rejects(
        asApi((tx) =>
          rework.execute(tx, {
            command: {
              action: "CreateKitchenRework",
              idempotencyKey: next(),
              originalWorkItemReference: id(0x120),
              reasonCode: "DROPPED",
              note: null,
              quantity: 1,
              correlationReference: next(),
            },
            actorReference: manager,
            occurredAt: instant(0),
          }),
        ),
        (error) =>
          error instanceof KitchenReworkError &&
          error.code === "KITCHEN_REWORK_PRECONDITION_FAILED",
      );
      assert.deepEqual(await asApi((tx) => listOpenKitchenReworkItems(tx, scopeA, [oldOrder])), []);
      // Today's ticket is untouched and still takes kitchen steps (its item can be remade later).
      assert.equal(
        (await asApi((tx) => listClosedKitchenTickets(tx, scopeA, [todayTicket.kitchen_ticket_id])))
          .size,
        0,
      );

      // ── 6. History is append-only; scope and grants hold.
      await assert.rejects(
        admin.query("UPDATE rms_kitchen.kitchen_ticket_closure SET reason_code='ALREADY_SERVED'"),
        /append-only/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_kitchen.kitchen_ticket_closure"),
        /append-only/u,
      );
      await assert.rejects(
        asApi((tx) => tx.query("UPDATE rms_kitchen.kitchen_ticket_closure SET food_made=true", [])),
        /permission denied/u,
      );
      assert.equal(
        (
          await asApi(
            (tx) => tx.query("SELECT 1 FROM rms_kitchen.kitchen_ticket_closure", []),
            storeB,
          )
        ).rows.length,
        0,
        "another Store sees no closure",
      );
      {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + worker);
          await assert.rejects(
            client.query("SELECT 1 FROM rms_kitchen.kitchen_ticket_closure"),
            /permission denied/u,
            "the worker role has no closure grant",
          );
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          await client.end();
        }
      }
      // An earlier-day check constraint holds even past the application.
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "INSERT INTO rms_kitchen.kitchen_ticket_closure (kitchen_ticket_closure_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,ticket_version,reason_code,food_made,order_business_date,closing_business_date,open_work_item_count,open_rework_count,evidence_digest,actor_type,actor_id,idempotency_key,request_digest,correlation_id,audit_id,event_id,closed_at) VALUES ($1,$2,$3,$4,$5,$6,3,'NOT_MADE_ABANDONED',false,'2026-10-14','2026-10-14',1,0,$7,'User',$8,$9,$7,$10,$11,$12,$13)",
            [
              next(),
              brand,
              store,
              todayTicket.kitchen_ticket_id,
              todayOrder,
              todayTicket.order_batch_id,
              sha("a"),
              manager,
              next(),
              next(),
              next(),
              next(),
              instant(0),
            ],
          ),
        ),
        /earlier_day_check/u,
      );

      // ── 7. The live board: closed tickets leave it, and (when set) so do finished tickets
      // untouched for a day. Store B: a ticket finished three days ago and an earlier open one.
      // Synthetic tickets have no creation record, so any ticket the reader still reads fails it.
      const refs = { next, derive: () => next() };
      const reader = (retire) =>
        createPostgresKitchenQueueSourceReader({
          brandReference: brand,
          storeReference: storeB,
          maxTickets: 100,
          maxItemsPerTicket: 100,
          maxOperationsPerTicket: 1000,
          creationValidation: { references: refs, digests: { sha256: (v) => hash(v) } },
          lifecycleValidation: { references: refs, digests: { sha256: (v) => hash(v) } },
          nextSnapshotReference: next,
          authorize: async () => true,
          ...(retire ? { retireFinishedAfterMs: 24 * 3_600_000 } : {}),
        });
      await assert.rejects(
        asApi((tx) => reader(true).read(tx), storeB),
        "the open ticket is read",
      );
      const kitchenB = createPostgresKitchenStaleTicketStore({
        brandReference: brand,
        storeReference: storeB,
        nextReference: next,
      });
      const closedB = await asApi(
        (tx) =>
          kitchenB.close(tx, {
            command: command({
              ticketReference: openB.kitchen_ticket_id,
              reasonCode: "ALREADY_SERVED",
            }),
            actorReference: manager,
            occurredAt: instant(0),
            businessDays: async () => ({
              orderBusinessDate: "2026-10-09",
              currentBusinessDate: "2026-10-14",
            }),
          }),
        storeB,
      );
      assert.deepEqual([closedB.status, closedB.closure.foodMade], ["Closed", true]);
      const feed = await asApi((tx) => reader(true).read(tx), storeB);
      assert.equal(feed.tickets.length, 0, "closed and long-finished tickets leave the live board");
      await assert.rejects(
        asApi((tx) => reader(false).read(tx), storeB),
        "without retirement the finished ticket is still read",
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });
});
