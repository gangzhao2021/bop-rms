import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const tables = ["capacity_slot", "capacity_slot_configuration", "capacity_hold"];
const sha = `sha256:${"a".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const first = new Client(context.clientConfig);
  const second = new Client(context.clientConfig);
  const role = `bop_wp2338_${context.runId}`;
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  let roleCreated = false;
  try {
    const now = (await admin.query("SELECT date_trunc('milliseconds', clock_timestamp()) AS now"))
      .rows[0].now;
    const instant = (offset) => new Date(now.getTime() + offset).toISOString();
    const scope = { brand: id(1), store: id(2) };
    const begin = async (client, requested = scope, isolation = "") => {
      await client.query(`BEGIN ${isolation}`);
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query(
        "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
        [requested.brand ?? "", requested.store ?? ""],
      );
      await client.query(`SET LOCAL ROLE ${role}`);
    };
    const rollback = (client) => client.query("ROLLBACK");
    const waitForLock = async (client) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await admin.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [client.processID],
        );
        if (result.rows[0]?.wait_event_type === "Lock") return;
        await delay(20);
      }
      assert.fail("contender did not reach the actual database lock");
    };

    const seedSlot = async (
      slot,
      limit = 1,
      store = scope.store,
      starts = instant(3_600_000 + slot * 1_800_000),
    ) => {
      await admin.query(
        `INSERT INTO rms_fulfillment.capacity_slot
         (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date)
         VALUES ($1,$2,$3,'Pickup',$4,$5,'UTC',$6)`,
        [
          scope.brand,
          store,
          id(slot),
          starts,
          new Date(Date.parse(starts) + 1_800_000).toISOString(),
          "2026-09-09",
        ],
      );
      await config(admin, slot, 1, limit, store);
    };
    const config = (client, slot, version, limit, store = scope.store) =>
      client.query(
        `INSERT INTO rms_fulfillment.capacity_slot_configuration
       (brand_id,store_id,slot_id,config_version,capacity_limit,published_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
        [scope.brand, store, id(slot), version, limit, instant(-1_000)],
      );
    const insert = (client, slot, hold, patch = {}) => {
      const p = {
        brand: scope.brand,
        store: scope.store,
        version: 1,
        units: 1,
        operation: id(hold + 1000),
        created: instant(0),
        expires: instant(600_000),
        ...patch,
      };
      return client.query(
        `INSERT INTO rms_fulfillment.capacity_hold
         (brand_id,store_id,hold_id,slot_id,config_version,cart_id,operation_id,intent_digest,
          capacity_units,units_rule_version,units_input_digest,created_at,expires_at,data_classification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$8,$10,$11,'IndirectIdentifier')`,
        [
          p.brand,
          p.store,
          id(hold),
          id(slot),
          p.version,
          id(hold + 2000),
          p.operation,
          sha,
          p.units,
          p.created,
          p.expires,
        ],
      );
    };
    const rejected = async (work, pattern, requested = scope, isolation = "") => {
      await begin(first, requested, isolation);
      try {
        await assert.rejects(work(first), pattern);
      } finally {
        await rollback(first);
      }
    };
    const count = async (slot) =>
      Number(
        (
          await admin.query(
            "SELECT count(*) AS count FROM rms_fulfillment.capacity_hold WHERE slot_id=$1",
            [id(slot)],
          )
        ).rows[0].count,
      );

    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
      platform_helpers.current_store_id(), platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    for (const table of tables)
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON rms_fulfillment.${table} TO ${role}`,
      );

    const security = await admin.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid=ANY($1::regclass[])`,
      [tables.map((table) => `rms_fulfillment.${table}`)],
    );
    assert.equal(security.rows.length, 3);
    assert(security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
    const publicAcl = await admin.query(
      `SELECT count(*) AS count FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid=ANY($1::regclass[]) AND a.grantee=0`,
      [tables.map((table) => `rms_fulfillment.${table}`)],
    );
    assert.equal(Number(publicAcl.rows[0].count), 0);

    // Two transactions contend after the first has occupied the last unit but before it commits.
    await seedSlot(10);
    await begin(first);
    await insert(first, 10, 100);
    await begin(second);
    const competing = insert(second, 10, 101).then(
      () => ({ succeeded: true }),
      (error) => ({ succeeded: false, code: error.code }),
    );
    await waitForLock(second);
    await first.query("COMMIT");
    const outcome = await competing;
    assert.deepEqual(outcome, { succeeded: false, code: "23514" });
    await rollback(second);
    assert.equal(await count(10), 1);

    // The same lock admits a waiter if the previous transaction rolls back.
    await seedSlot(11);
    await begin(first);
    await insert(first, 11, 110);
    await begin(second);
    const afterRollback = insert(second, 11, 111).then(
      () => null,
      (error) => error,
    );
    await waitForLock(second);
    await rollback(first);
    assert.equal(await afterRollback, null);
    await second.query("COMMIT");
    assert.equal(await count(11), 1);

    // Configuration publication takes the same lock, so an old-version waiter cannot enter.
    await seedSlot(17, 2);
    await begin(first);
    await config(first, 17, 2, 0);
    await begin(second);
    const staleConfig = insert(second, 17, 180).then(
      () => null,
      (error) => error.code,
    );
    await waitForLock(second);
    await first.query("COMMIT");
    assert.equal(await staleConfig, "23514");
    await rollback(second);
    assert.equal(await count(17), 0);

    await seedSlot(12, 5);
    await begin(first);
    await insert(first, 12, 120, { units: 3 });
    await first.query("COMMIT");
    await config(admin, 12, 2, 2);
    await rejected((client) => insert(client, 12, 121, { version: 2 }), /insufficient capacity/u);
    await rejected((client) => insert(client, 12, 121), /invalid capacity hold/u);
    assert.equal(await count(12), 1);
    await rejected((client) => config(client, 12, 4, 10), /invalid capacity configuration/u);
    await config(admin, 12, 3, 5);
    await begin(first);
    await insert(first, 12, 122, { version: 3, units: 2 });
    await first.query("COMMIT");
    const retained = await admin.query(
      "SELECT config_version,capacity_units FROM rms_fulfillment.capacity_hold WHERE hold_id=$1",
      [id(120)],
    );
    assert.deepEqual(retained.rows, [{ config_version: "1", capacity_units: "3" }]);

    // Scoped operation uniqueness retains the original binding even when capacity remains.
    await seedSlot(13, 5);
    await begin(first);
    await insert(first, 13, 130);
    await first.query("COMMIT");
    await rejected(
      (client) => insert(client, 13, 131, { operation: id(1130) }),
      /unique constraint/u,
    );
    assert.equal(await count(13), 1);

    for (const isolation of ["ISOLATION LEVEL REPEATABLE READ", "ISOLATION LEVEL SERIALIZABLE"]) {
      await rejected(
        (client) => insert(client, 13, 132),
        /require read committed/u,
        scope,
        isolation,
      );
      await rejected(
        (client) => config(client, 13, 2, 6),
        /require read committed/u,
        scope,
        isolation,
      );
    }

    for (const requested of [
      { brand: id(99), store: scope.store },
      { brand: scope.brand, store: id(99) },
      { brand: null, store: null },
    ]) {
      await begin(first, requested);
      for (const table of tables) {
        const hidden = await first.query(`SELECT * FROM rms_fulfillment.${table}`);
        assert.equal(hidden.rows.length, 0);
      }
      await rollback(first);
      await rejected(
        (client) => insert(client, 13, 133),
        /invalid capacity scope|row-level security/u,
        requested,
      );
    }
    await seedSlot(14, 1, id(98));
    await rejected((client) => insert(client, 14, 140), /invalid capacity scope/u);
    await rejected(
      (client) => insert(client, 13, 141, { store: id(98) }),
      /invalid capacity scope|row-level security/u,
    );
    for (const patch of [
      { units: 0 },
      { units: -1 },
      { units: "1.5" },
      { units: "9007199254740992" },
      { created: instant(60_000) },
      { expires: instant(-1) },
      { expires: "infinity" },
      { created: "-infinity" },
    ])
      await rejected(
        (client) => insert(client, 13, 150, patch),
        /invalid capacity|check constraint|invalid input|insufficient capacity/u,
      );

    for (const table of tables) {
      await rejected(
        (client) => client.query(`UPDATE rms_fulfillment.${table} SET brand_id=brand_id`),
        /append-only/u,
      );
      await rejected(
        (client) => client.query(`DELETE FROM rms_fulfillment.${table}`),
        /append-only/u,
      );
      await rejected(
        (client) => client.query(`TRUNCATE rms_fulfillment.${table} CASCADE`),
        /append-only/u,
      );
    }

    // A short synthetic TTL proves expiry returns capacity without erasing the historical Hold.
    await seedSlot(15);
    await begin(first);
    const soon = (
      await first.query(
        "SELECT date_trunc('milliseconds', clock_timestamp() + interval '600 milliseconds') AS expires",
      )
    ).rows[0].expires.toISOString();
    await insert(first, 15, 160, { expires: soon });
    await first.query("COMMIT");
    await admin.query("SELECT pg_sleep(0.65)");
    await begin(first);
    await insert(first, 15, 161);
    await first.query("COMMIT");
    assert.equal(await count(15), 2);

    // Expiry is re-evaluated after an actual lock wait, not at statement start.
    await seedSlot(18);
    await begin(first);
    await first.query(
      "SELECT slot_id FROM rms_fulfillment.capacity_slot WHERE slot_id=$1 FOR UPDATE",
      [id(18)],
    );
    await begin(second);
    const shortExpiry = (
      await second.query(
        "SELECT date_trunc('milliseconds', clock_timestamp() + interval '600 milliseconds') AS expires",
      )
    ).rows[0].expires.toISOString();
    const aged = insert(second, 18, 190, { expires: shortExpiry }).then(
      () => null,
      (error) => error.code,
    );
    await waitForLock(second);
    await admin.query("SELECT pg_sleep(0.65)");
    await first.query("COMMIT");
    assert.equal(await aged, "23514");
    await rollback(second);
    assert.equal(await count(18), 0);

    await seedSlot(16, 1, scope.store, instant(-10_000));
    await rejected(
      (client) => insert(client, 16, 170, { created: instant(-20_000) }),
      /invalid capacity hold/u,
    );
    // A future trigger will add Allocation occupancy before this schema can serve checkout.
  } finally {
    await Promise.all([
      first.query("ROLLBACK").catch(() => undefined),
      second.query("ROLLBACK").catch(() => undefined),
    ]);
    await Promise.all([first.end(), second.end()]);
    if (roleCreated) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.end();
  }
}

it("serializes scoped immutable capacity Hold admission on actual PostgreSQL", async () => {
  await withIsolatedDatabase({ caseId: "capacity_hold", root }, prove);
});
