import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createPostgresCurrentPickupCapacityStore,
  createPostgresPickupCapacityScheduleStore,
} from "../../rms/fulfillment/src/index.ts";
import {
  createPostgresPublishedStoreServiceCalendarReader,
  expandStoreServiceCalendar,
} from "../../rms/store/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import {
  createPickupCapacityScheduleDispatcher,
  pickupScheduleInput,
  readInternalPickupCapacityHorizon,
} from "../../../tooling/environment/pilot-pickup-capacity-schedule.mjs";
import { evaluateAlertConditions } from "../../../tooling/environment/pilot-alerts.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";

/**
 * WP-2423 DEC-PICKUP-CAPACITY-SCHEDULE: Fulfillment's rolling pickup capacity schedule, run as the
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (the business worker's
 * database role). Synthetic TEST-ONLY Brand/Store references and hours; the ASAP commitment that
 * reserves a slot is seeded by the owner client.
 */
const HOUR = 3_600_000;
const brand = "0198b100-0000-7000-8000-000000000001",
  store = "0198b100-0000-7000-8000-000000000002";
const scope = Object.freeze({ brandReference: brand, storeReference: store });
const policy = { servicePerHour: 20, outsideServicePerHour: 100 };
const everyDay = (close) =>
  [1, 2, 3, 4, 5, 6, 7].map((isoWeekday) => ({
    isoWeekday,
    intervals: [
      {
        startLocalTime: "08:00:00",
        endLocalTime: close,
        endsNextDay: false,
        serviceModes: ["DineIn", "Pickup"],
      },
    ],
  }));

async function restrictedRole(admin, runId) {
  const api = "wp2423_pcs_" + runId,
    worker = "wp2423_pcs_w_" + runId;
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
  return {
    api,
    drop: async () => {
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
    },
  };
}

function runnerAs(clientConfig, role) {
  return {
    async run(work) {
      const client = new pg.Client({ ...clientConfig, query_timeout: 30000 });
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const result = await work({ query: (sql, values = []) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}

it("lays the schedule ahead, catches up after downtime, keeps reserved slots on an hours change and never overlaps", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pickup_slots" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const { api, drop } = await restrictedRole(admin, context.runId);
    try {
      const runner = runnerAs(context.clientConfig, api);
      const schedule = createPostgresPickupCapacityScheduleStore(runner, scope);
      const current = createPostgresCurrentPickupCapacityStore(runner, scope);
      let sequence = 0x100;
      const reference = () =>
        `0198b100-0000-7000-8000-${(sequence++).toString(16).padStart(12, "0")}`;
      const apply = (observedAt, horizonUntil, close = "20:00:00") => {
        const calendar = expandStoreServiceCalendar({
          timeZone: "America/Toronto",
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: everyDay(close),
          exceptions: [],
          serviceMode: "Pickup",
          from: observedAt,
          until: horizonUntil,
        });
        return schedule.apply({
          observedAt,
          horizonUntil,
          timeZone: "America/Toronto",
          serviceWindows: calendar.windows,
          businessDays: calendar.businessDays,
          policy,
          generateReference: reference,
        });
      };
      const dbNow = async () =>
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString();
      const shift = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
      const horizonAlert = async (at) => {
        const horizon = await readInternalPickupCapacityHorizon(
          { now: () => at, transactions: runner, scope },
          schedule,
        );
        const conditions = evaluateAlertConditions({
          now: Date.parse(at),
          supervisor: { reportAgeMs: 0, attention: [] },
          business: { pickupCapacity: { coveredMs: horizon.coveredMs } },
          backup: { lastSuccessAt: at },
        });
        return conditions.get("pickup.capacity_horizon")?.severity ?? null;
      };
      const slotCount = async () =>
        Number(
          (await admin.query("SELECT count(*) FROM rms_fulfillment.capacity_slot")).rows[0].count,
        );

      // 1. The worker last ran 6 hours ago and its schedule ran out 2 hours ago (downtime).
      let t0 = await dbNow();
      const past = await apply(shift(t0, -6 * HOUR), shift(t0, -2 * HOUR));
      assert.equal(past.created, 4);
      await assert.rejects(current.resolve(t0));
      assert.equal(await horizonAlert(t0), "critical"); // "Pickup orders cannot be taken"

      // 2. Back up: it catches up from now; a short horizon still warns, 3 days clears it.
      t0 = await dbNow();
      const short = await apply(t0, shift(t0, 12 * HOUR));
      assert.ok(short.created >= 12 && short.created <= 14);
      const live = await current.resolve(shift(t0, 1));
      assert.equal(live.slot.startsAt, t0); // the gap is filled from the current instant
      assert.equal(live.occupiedUnits, 0);
      assert.equal(await horizonAlert(t0), "warning");
      const full = await apply(t0, shift(t0, 3 * 24 * HOUR));
      assert.ok(full.coveredUntil > shift(t0, 3 * 24 * HOUR - HOUR)); // to the last whole hour
      assert.ok(full.coveredUntil <= shift(t0, 3 * 24 * HOUR));
      assert.equal(await horizonAlert(t0), null);

      // 3. Idempotent: rerunning writes nothing.
      const before = await slotCount();
      const rerun = await apply(await dbNow(), shift(t0, 3 * 24 * HOUR));
      assert.deepEqual([rerun.created, rerun.republished], [0, 0]);
      assert.equal(await slotCount(), before);

      // Every slot: no overlap, one local hour or less, Toronto zone, limits by service.
      const slots = (
        await admin.query(
          `SELECT s.slot_id, s.starts_at, s.ends_at, s.time_zone, s.business_date::text AS business_date,
             (SELECT capacity_limit FROM rms_fulfillment.capacity_slot_configuration c
              WHERE c.slot_id=s.slot_id ORDER BY config_version DESC LIMIT 1)::integer AS capacity_limit,
             to_char(s.starts_at AT TIME ZONE 'America/Toronto','HH24:MI') AS local_start
           FROM rms_fulfillment.capacity_slot s ORDER BY s.starts_at`,
        )
      ).rows;
      for (let n = 1; n < slots.length; n++)
        assert.ok(slots[n].starts_at >= slots[n - 1].ends_at, "slots never overlap");
      for (const slot of slots) {
        assert.equal(slot.time_zone, "America/Toronto");
        assert.ok(slot.ends_at - slot.starts_at <= HOUR);
        const hour = Number(slot.local_start.slice(0, 2));
        if (slot.ends_at - slot.starts_at === HOUR)
          assert.equal(slot.capacity_limit, hour >= 8 && hour < 20 ? 20 : 100);
      }
      const night = slots.find(
        (slot) => slot.local_start === "02:00" && slot.starts_at > Date.parse(t0),
      );
      // Local (UTC-4) minus the 04:00 business-day start: the previous local date.
      const nightDate = new Date(night.starts_at.getTime() - 8 * HOUR).toISOString().slice(0, 10);
      assert.equal(night.business_date, nightDate); // 02:00 belongs to the previous business day

      // 4. A guest reserves tomorrow's 19:00 slot; the Store then closes at 18:00 instead of 20:00.
      const tomorrow = slots.filter(
        (slot) => slot.starts_at > Date.parse(t0) + 24 * HOUR && slot.capacity_limit === 20,
      );
      const reserved = tomorrow.find((slot) => slot.local_start === "19:00");
      const freed = tomorrow.find((slot) => slot.local_start === "18:00");
      assert.ok(reserved && freed);
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const stamp = await dbNow();
      await admin.query(
        "INSERT INTO rms_fulfillment.capacity_asap_commitment " +
          "(brand_id,store_id,allocation_id,version,state,slot_id,config_version," +
          "guest_session_id,cart_id,cart_version,quote_id,submission_id,order_id,order_batch_id," +
          "fulfillment_id,payment_operation_id,capacity_units,units_rule_version,units_input_digest,intent_digest," +
          "prepared_at,preparation_valid_until) " +
          "VALUES ($1,$2,$3,1,'Prepared',$4,1,$5,$6,1,$7,$8,$9,$10,$11,$12,1,1,$13,$13,$14,$15)",
        [
          brand,
          store,
          reference(),
          reserved.slot_id,
          reference(),
          reference(),
          reference(),
          reference(),
          reference(),
          reference(),
          reference(),
          reference(),
          `sha256:${"b".repeat(64)}`,
          stamp,
          shift(stamp, 600_000),
        ],
      );
      await admin.query("COMMIT");
      const changed = await apply(await dbNow(), shift(t0, 3 * 24 * HOUR), "18:00:00");
      assert.equal(changed.created, 0);
      assert.ok(changed.republished >= 2); // 18:00 and 19:00 on each future day except the reserved one
      const versions = async (slot) =>
        (
          await admin.query(
            "SELECT config_version::integer AS v, capacity_limit::integer AS l FROM rms_fulfillment.capacity_slot_configuration WHERE slot_id=$1 ORDER BY config_version",
            [slot.slot_id],
          )
        ).rows;
      assert.deepEqual(await versions(freed), [
        { v: 1, l: 20 },
        { v: 2, l: 100 },
      ]);
      assert.deepEqual(await versions(reserved), [{ v: 1, l: 20 }]); // the reservation keeps its version
      // The current slot is never re-versioned.
      const currentNow = await current.resolve(await dbNow());
      assert.equal(currentNow.slot.configVersion, 1);
      // A rerun on the changed hours is idempotent too.
      const settled = await apply(await dbNow(), shift(t0, 3 * 24 * HOUR), "18:00:00");
      assert.deepEqual([settled.created, settled.republished], [0, 0]);

      // 5. Two workers extending at once (a restart overlap) lay one schedule, never overlapping.
      const extendTo = shift(t0, 4 * 24 * HOUR);
      const [left, right] = await Promise.all([
        apply(await dbNow(), extendTo, "18:00:00"),
        apply(await dbNow(), extendTo, "18:00:00"),
      ]);
      assert.equal(left.created + right.created, 24);
      assert.ok(left.created === 0 || right.created === 0);
      const overlaps = await admin.query(
        `SELECT count(*)::integer AS n FROM rms_fulfillment.capacity_slot a
         JOIN rms_fulfillment.capacity_slot b ON a.slot_id<b.slot_id
           AND a.starts_at<b.ends_at AND b.starts_at<a.ends_at`,
      );
      assert.equal(overlaps.rows[0].n, 0);

      // 6. Row security: another Store's scope sees none of these slots.
      const other = createPostgresPickupCapacityScheduleStore(runner, {
        brandReference: brand,
        storeReference: "0198b100-0000-7000-8000-0000000000ff",
      });
      const otherAt = await dbNow();
      assert.equal((await other.coverage(otherAt)).coveredUntil, otherAt);
    } finally {
      await drop();
      await admin.end();
    }
  });
});

it("lays the pickup schedule from the Store's published hours through the pilot worker composition", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_pickup_hours" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: async ({ resources, scope: storeScope, transactions, admin }) => {
            const scheduleScope = {
              brandReference: storeScope.brandReference,
              storeReference: storeScope.storeReference,
            };
            const worker = {
              ...resources,
              scope: scheduleScope,
              publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
            };
            const logged = [];
            const dispatcher = createPickupCapacityScheduleDispatcher({
              resources: worker,
              allowed: () => true,
              log: (entry) => logged.push(entry),
            });
            const created = await dispatcher.runOnce();
            assert.ok(created >= 14 * 24 - 1, `a fortnight of slots (${created})`);
            assert.equal(logged[0].event, "pickup_capacity_schedule_applied");
            // The same hours the open gate enforces: limits follow the published pickup windows.
            const at = resources.now();
            const calendar = await transactions.run((tx) =>
              createPostgresPublishedStoreServiceCalendarReader(resources.operating)(tx, at),
            );
            const input = pickupScheduleInput(calendar, at);
            const slots = (
              await admin.query(
                `SELECT s.starts_at, s.ends_at, (SELECT capacity_limit FROM rms_fulfillment.capacity_slot_configuration c
                   WHERE c.slot_id=s.slot_id ORDER BY config_version DESC LIMIT 1)::integer AS capacity_limit
                 FROM rms_fulfillment.capacity_slot s WHERE s.store_id=$1 ORDER BY s.starts_at`,
                [scheduleScope.storeReference],
              )
            ).rows;
            assert.ok(input.serviceWindows.length > 0, "the published Store offers pickup");
            let inService = 0;
            for (const slot of slots) {
              const open = input.serviceWindows.some(
                (window) =>
                  Date.parse(window.startsAt) < slot.ends_at.getTime() &&
                  slot.starts_at.getTime() < Date.parse(window.endsAt),
              );
              if (open) inService += 1;
              if (slot.ends_at - slot.starts_at === HOUR)
                assert.equal(slot.capacity_limit, open ? 20 : 100);
            }
            assert.ok(inService > 0);
            const horizon = await readInternalPickupCapacityHorizon(worker);
            assert.ok(horizon.coveredMs > 13 * 24 * HOUR);
            // The ordinary pickup checkout source finds the current slot.
            const currentSlot = await createPostgresCurrentPickupCapacityStore(
              transactions,
              scheduleScope,
            ).resolve(resources.now());
            assert.ok(currentSlot.capacityLimit >= 1);
            // A worker restart runs again at once and finds nothing to do.
            const restarted = createPickupCapacityScheduleDispatcher({
              resources: worker,
              allowed: () => true,
              log: (entry) => logged.push(entry),
            });
            assert.equal(await restarted.runOnce(), 0);
          },
        }),
    }),
  );
});
