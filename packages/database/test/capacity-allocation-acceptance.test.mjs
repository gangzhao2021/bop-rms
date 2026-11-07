import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCapacityHoldTransitionStore,
  createPostgresCapacityAllocationTerminalStore,
  createPostgresCapacityQueryStore,
} from "../../rms/fulfillment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = `sha256:${"b".repeat(64)}`;
const added = ["capacity_hold_terminal", "capacity_allocation", "capacity_allocation_terminal"];
const tables = ["capacity_slot", "capacity_slot_configuration", "capacity_hold", ...added];

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const first = new Client(context.clientConfig);
  const second = new Client(context.clientConfig);
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  const role = `bop_wp2339_${context.runId}`;
  let roleCreated = false;
  try {
    const brand = id(1),
      store = id(2);
    const stamp = async (client = admin) =>
      (
        await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
      ).rows[0].at.toISOString();
    const base = Date.parse(await stamp());
    const future = (offset) => new Date(base + offset).toISOString();
    const begin = async (client, requestedStore = store, isolation = "") => {
      await client.query(`BEGIN ${isolation}`);
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, requestedStore],
      );
      await client.query(`SET LOCAL ROLE ${role}`);
    };
    const rollback = (client) => client.query("ROLLBACK");
    const rejected = async (
      work,
      pattern = /invalid capacity|insufficient capacity|unique constraint/u,
      requestedStore = store,
      isolation = "",
    ) => {
      await begin(first, requestedStore, isolation);
      try {
        await assert.rejects(work(first), pattern);
      } finally {
        await rollback(first);
      }
    };
    const waitForLock = async () => {
      for (let n = 0; n < 100; n++) {
        const row = (
          await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [
            second.processID,
          ])
        ).rows[0];
        if (row?.wait_event_type === "Lock") return;
        await delay(20);
      }
      assert.fail("contender did not reach the database lock");
    };
    const seed = async (slot, limit = 1, startsAt = future(3_600_000 + slot * 1_800_000)) => {
      await admin.query(
        `INSERT INTO rms_fulfillment.capacity_slot
        (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date)
        VALUES ($1,$2,$3,'Pickup',$4,$5,'UTC','2026-09-09')`,
        [
          brand,
          store,
          id(slot),
          startsAt,
          new Date(Date.parse(startsAt) + 1_800_000).toISOString(),
        ],
      );
      await admin.query(
        `INSERT INTO rms_fulfillment.capacity_slot_configuration
        (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,$4,$5)`,
        [brand, store, id(slot), limit, future(-1_000)],
      );
    };
    const hold = async (client, slot, h, expires = future(600_000)) => {
      await client.query(
        `INSERT INTO rms_fulfillment.capacity_hold
        (brand_id,store_id,hold_id,slot_id,config_version,cart_id,operation_id,intent_digest,
        capacity_units,units_rule_version,units_input_digest,created_at,expires_at,data_classification)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,1,1,$7,$8,$9,'IndirectIdentifier')`,
        [
          brand,
          store,
          id(h),
          id(slot),
          id(h + 10_000),
          id(h + 20_000),
          sha,
          await stamp(client),
          expires,
        ],
      );
    };
    const terminal = async (
      client,
      h,
      state,
      allocation = null,
      at = null,
      operation = h + 30_000,
    ) => {
      const occurred = at ?? (await stamp(client));
      await client.query(
        `INSERT INTO rms_fulfillment.capacity_hold_terminal
        (brand_id,store_id,hold_id,terminal_state,allocation_id,operation_id,intent_digest,occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          brand,
          store,
          id(h),
          state,
          allocation === null ? null : id(allocation),
          id(operation),
          sha,
          occurred,
        ],
      );
      return occurred;
    };
    const allocation = (client, h, a, at) =>
      client.query(
        `INSERT INTO rms_fulfillment.capacity_allocation
      (brand_id,store_id,allocation_id,hold_id,order_id,fulfillment_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [brand, store, id(a), id(h), id(a + 40_000), id(a + 50_000), at],
      );
    const convert = async (client, h, a) => {
      const at = await terminal(client, h, "Converted", a);
      await allocation(client, h, a, at);
      return at;
    };
    const finish = async (
      client,
      a,
      state,
      inProgress = null,
      consumed = null,
      at = null,
      operation = a + 60_000,
    ) => {
      await client.query(
        `INSERT INTO rms_fulfillment.capacity_allocation_terminal
        (brand_id,store_id,allocation_id,terminal_state,operation_id,intent_digest,
        occurred_at,fulfillment_in_progress_at,consumed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          brand,
          store,
          id(a),
          state,
          id(operation),
          sha,
          at ?? (await stamp(client)),
          inProgress,
          consumed,
        ],
      );
    };

    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
      platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    for (const table of tables)
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_fulfillment.${table} TO ${role}`,
      );

    await admin.query("GRANT SELECT ON rms_fulfillment.capacity_asap_commitment TO " + role);

    const security = await admin.query(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid=ANY($1::regclass[])`,
      [added.map((t) => `rms_fulfillment.${t}`)],
    );
    assert.equal(security.rows.length, 3);
    assert(security.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));
    const publicAcl = await admin.query(
      `SELECT count(*) AS count FROM pg_class c,
      LATERAL aclexplode(c.relacl) a WHERE c.oid=ANY($1::regclass[]) AND a.grantee=0`,
      [added.map((t) => `rms_fulfillment.${t}`)],
    );
    assert.equal(Number(publicAcl.rows[0].count), 0);

    await seed(10);
    await begin(first);
    await hold(first, 10, 100);
    await first.query("COMMIT");

    // A Converted record alone cannot commit and does not expose a free unit inside the transaction.
    await begin(first);
    await terminal(first, 100, "Converted", 200);
    await assert.rejects(first.query("COMMIT"), { code: "23503" });
    await rollback(first);
    await rejected(async (client) => {
      await terminal(client, 100, "Converted", 200);
      await hold(client, 10, 101);
    }, /insufficient capacity/u);
    await rejected(
      (client) => allocation(client, 100, 200, future(0)),
      /invalid capacity allocation/u,
    );

    // A full-slot conversion succeeds, while the waiting new Hold sees unchanged occupancy.
    await begin(first);
    await convert(first, 100, 200);
    await begin(second);
    const contender = hold(second, 10, 101).then(
      () => null,
      (error) => error.code,
    );
    await waitForLock();
    await first.query("COMMIT");
    assert.equal(await contender, "23514");
    await rollback(second);
    await rejected((client) => terminal(client, 100, "Released"));
    await rejected((client) => convert(client, 100, 201));

    // Release is append-only and makes the exact original unit reusable.
    await begin(first);
    await finish(first, 200, "Released");
    await first.query("COMMIT");
    await rejected((client) => finish(client, 200, "Released"));
    await begin(first);
    await hold(first, 10, 101);
    await first.query("COMMIT");

    // Conversion on a partially occupied slot must not double count the original Hold.
    await seed(11, 2);
    await begin(first);
    await hold(first, 11, 110);
    await convert(first, 110, 210);
    await hold(first, 11, 111);
    await first.query("COMMIT");
    await rejected((client) => hold(client, 11, 112), /insufficient capacity/u);

    // Hold release wins its serialized race against conversion.
    await seed(12);
    await begin(first);
    await hold(first, 12, 120);
    await first.query("COMMIT");
    await begin(first);
    await terminal(first, 120, "Released");
    await begin(second);
    const losingConversion = convert(second, 120, 220).then(
      () => null,
      (error) => error.code,
    );
    await waitForLock();
    await first.query("COMMIT");
    assert.equal(await losingConversion, "23514");
    await rollback(second);
    await begin(first);
    await hold(first, 12, 121);
    await first.query("COMMIT");

    // Allocation outlives original Hold TTL and still occupies the slot.
    await seed(13);
    await begin(first);
    const shortExpiry = new Date(Date.parse(await stamp(first)) + 600).toISOString();
    await hold(first, 13, 130, shortExpiry);
    await convert(first, 130, 230);
    await first.query("COMMIT");
    await admin.query("SELECT pg_sleep(0.65)");
    await rejected((client) => hold(client, 13, 131), /insufficient capacity/u);
    await rejected((client) => terminal(client, 130, "Expired"));

    // Authoritative early progress consumes capacity permanently.
    const inProgress = await stamp();
    await begin(first);
    await finish(first, 230, "Consumed", inProgress, inProgress);
    await first.query("COMMIT");
    await rejected((client) => finish(client, 230, "Released"));
    await rejected((client) => hold(client, 13, 131), /insufficient capacity/u);

    // No progress evidence before slot start cannot manufacture a consumption.
    await seed(14);
    await begin(first);
    await hold(first, 14, 140);
    await convert(first, 140, 240);
    await first.query("COMMIT");
    await rejected(async (client) => finish(client, 240, "Consumed", null, await stamp(client)));
    await rejected(
      async (client) => finish(client, 240, "Released", await stamp(client)),
      /check constraint/u,
    );
    await rejected((client) => finish(client, 240, "Consumed", future(-1000), future(-1000)));
    await rejected((client) => finish(client, 240, "Consumed", future(60_000), future(60_000)));

    // At slot start even a late cancellation cannot return capacity.
    const startsAt = new Date(Date.parse(await stamp()) + 800).toISOString();
    await seed(15, 1, startsAt);
    await begin(first);
    await hold(first, 15, 150);
    await convert(first, 150, 250);
    await first.query("COMMIT");
    await admin.query("SELECT pg_sleep(0.85)");
    await rejected((client) => finish(client, 250, "Released"));
    await begin(first);
    await finish(first, 250, "Consumed", null, startsAt);
    await first.query("COMMIT");
    const consumedRow = await admin.query(
      "SELECT consumed_at FROM rms_fulfillment.capacity_allocation_terminal WHERE allocation_id=$1",
      [id(250)],
    );
    assert.equal(consumedRow.rows[0].consumed_at.toISOString(), startsAt);

    await seed(16);
    await begin(first);
    const expiring = new Date(Date.parse(await stamp(first)) + 600).toISOString();
    await hold(first, 16, 160, expiring);
    await first.query("COMMIT");
    await rejected((client) => terminal(client, 160, "Expired"));
    await admin.query("SELECT pg_sleep(0.65)");
    await rejected((client) => convert(client, 160, 260));
    await begin(first);
    await terminal(first, 160, "Expired");
    await first.query("COMMIT");
    await begin(first);
    await hold(first, 16, 161);
    await first.query("COMMIT");

    for (const table of added) {
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
      await begin(first, id(99));
      assert.equal((await first.query(`SELECT * FROM rms_fulfillment.${table}`)).rows.length, 0);
      await rollback(first);
    }
    await rejected(
      (client) => terminal(client, 101, "Released"),
      /invalid capacity scope/u,
      id(99),
    );
    await rejected((client) => finish(client, 240, "Released"), /invalid capacity scope/u, id(99));
    await rejected(
      (client) => allocation(client, 101, 999, future(0)),
      /invalid capacity scope/u,
      id(99),
    );

    for (const work of [
      (client) => terminal(client, 101, "Released"),
      (client) => allocation(client, 101, 999, future(0)),
      (client) => finish(client, 240, "Released"),
    ])
      await rejected(work, /require read committed/u, store, "ISOLATION LEVEL REPEATABLE READ");

    const provenance = await admin.query(
      `SELECT h.config_version,h.capacity_units,h.cart_id::text,h.units_input_digest
      FROM rms_fulfillment.capacity_allocation a JOIN rms_fulfillment.capacity_hold h
      ON h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.hold_id=a.hold_id WHERE a.allocation_id=$1`,
      [id(200)],
    );
    assert.deepEqual(provenance.rows, [
      { config_version: "1", capacity_units: "1", cart_id: id(10100), units_input_digest: sha },
    ]);

    // WP-2340 reads actual owner rows through a dedicated role with no write grant.
    const reader = `bop_wp2340_${context.runId}`;
    await admin.query(`CREATE ROLE ${reader} NOLOGIN`);
    try {
      await admin.query(`GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO ${reader}`);
      await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
        platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${reader}`);
      for (const table of ["capacity_slot", "capacity_hold", ...added])
        await admin.query(`GRANT SELECT ON rms_fulfillment.${table} TO ${reader}`);
      const runner = {
        async run(action) {
          await admin.query("BEGIN READ ONLY");
          try {
            await admin.query(`SET LOCAL ROLE ${reader}`);
            assert.equal(
              (await admin.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const result = await action({ query: (sql, values) => admin.query(sql, values) });
            await admin.query("COMMIT");
            return result;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const owner = createPostgresCapacityQueryStore(runner, {
        brandReference: brand,
        storeReference: store,
      });
      const found = await owner.loadHold({ holdReference: id(100), cartReference: id(10100) });
      assert.equal(found.state, "Converted");
      assert.equal(found.allocationReference, id(200));
      const recovered = await owner.resolveHoldOperation({
        operationReference: id(20100),
        cartReference: id(10100),
        intentDigest: sha,
      });
      assert.deepEqual(recovered, found);
      assert.equal(
        (await owner.loadHold({ holdReference: id(160), cartReference: id(10160) })).state,
        "Expired",
      );
      assert.equal(
        (await owner.loadHold({ holdReference: id(101), cartReference: id(10101) })).state,
        "Active",
      );
      assert.equal(
        (
          await owner.loadAllocation({
            allocationReference: id(200),
            orderReference: id(40200),
            fulfillmentReference: id(50200),
          })
        ).state,
        "Released",
      );
      assert.equal(
        (
          await owner.loadAllocation({
            allocationReference: id(230),
            orderReference: id(40230),
            fulfillmentReference: id(50230),
          })
        ).state,
        "Consumed",
      );
      assert.equal(
        (
          await owner.loadAllocation({
            allocationReference: id(210),
            orderReference: id(40210),
            fulfillmentReference: id(50210),
          })
        ).state,
        "Active",
      );
      assert.equal(await owner.loadHold({ holdReference: id(100), cartReference: id(999) }), null);
      assert.equal(
        await owner.loadAllocation({
          allocationReference: id(200),
          orderReference: id(999),
          fulfillmentReference: id(50200),
        }),
        null,
      );
      await assert.rejects(
        owner.resolveHoldOperation({
          operationReference: id(20100),
          cartReference: id(10100),
          intentDigest: `sha256:${"c".repeat(64)}`,
        }),
        { code: "CAPACITY_IDEMPOTENCY_CONFLICT" },
      );
      await assert.rejects(
        owner.resolveHoldOperation({
          operationReference: id(20100),
          cartReference: id(999),
          intentDigest: sha,
        }),
        { code: "CAPACITY_IDEMPOTENCY_CONFLICT" },
      );
      const foreign = createPostgresCapacityQueryStore(runner, {
        brandReference: brand,
        storeReference: id(99),
      });
      assert.equal(
        await foreign.loadHold({ holdReference: id(100), cartReference: id(10100) }),
        null,
      );
      assert.equal(
        await foreign.resolveHoldOperation({
          operationReference: id(20100),
          cartReference: id(10100),
          intentDigest: sha,
        }),
        null,
      );
      const permission = await admin.query(
        "SELECT has_table_privilege($1,'rms_fulfillment.capacity_hold','INSERT') AS can_write,has_table_privilege($1,'rms_fulfillment.fulfillment','SELECT') AS can_read_other",
        [reader],
      );
      assert.deepEqual(permission.rows, [{ can_write: false, can_read_other: false }]);
      const contextAfter = await admin.query(
        "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
      );
      assert.equal(contextAfter.rows[0].brand, "");
      assert.equal(contextAfter.rows[0].store, "");
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      await admin.query(`DROP OWNED BY ${reader}`);
      await admin.query(`DROP ROLE ${reader}`);
    }

    {
      // WP-2344: public owner transition adapters preserve terminal/Audit atomicity.
      await admin.query(`GRANT USAGE ON SCHEMA platform_audit TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
      const fixed = { brandReference: brand, storeReference: store };
      const readOriginal = async (h) =>
        createPostgresCapacityQueryStore(
          {
            async run(action) {
              await admin.query("BEGIN");
              try {
                const result = await action(admin);
                await admin.query("COMMIT");
                return result;
              } catch (error) {
                await admin.query("ROLLBACK");
                throw error;
              }
            },
          },
          fixed,
        ).loadHold({ holdReference: id(h), cartReference: id(h + 10_000) });
      const transitionRequest = async (h, mode = "Convert", operation = h + 70_000) => {
        const current = await readOriginal(h);
        assert(current);
        const at = await stamp();
        const common = { hold: current, scope: fixed, expectedVersion: 1, at };
        return {
          transition:
            mode === "Convert"
              ? {
                  ...common,
                  allocationReference: id(h + 30_000),
                  orderReference: id(h + 40_000),
                  fulfillmentReference: id(h + 50_000),
                }
              : { ...common, reason: mode },
          operationReference: id(operation),
          intentDigest: sha,
          audit: {
            auditId: id(operation + 10_000),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode:
              mode === "Convert"
                ? "FULFILLMENT_CAPACITY_HOLD_CONVERT"
                : "FULFILLMENT_CAPACITY_HOLD_RELEASE",
            targetType: "FulfillmentCapacityHold",
            targetId: id(h),
            reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
            correlationId: id(operation + 20_000),
            occurredAt: at,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "SYNTHETIC_RETENTION",
            retentionPolicyVersion: 1,
          },
        };
      };
      const writer = (client, options = {}) =>
        createPostgresCapacityHoldTransitionStore(
          {
            async run(action) {
              await client.query("BEGIN");
              try {
                await client.query(`SET LOCAL ROLE ${role}`);
                await client.query("SET LOCAL lock_timeout='3s'");
                const result = await action({
                  async query(sql, values) {
                    if (
                      options.failAudit &&
                      sql.startsWith("INSERT INTO platform_audit.audit_record")
                    )
                      throw new Error("synthetic Audit failure");
                    if (
                      options.failAllocation &&
                      sql.startsWith("INSERT INTO rms_fulfillment.capacity_allocation")
                    )
                      throw new Error("synthetic Allocation failure");
                    return client.query(sql, [...values]);
                  },
                });
                if (options.beforeCommit) await options.beforeCommit();
                await client.query("COMMIT");
                if (options.loseAck) throw new Error("synthetic lost acknowledgement");
                return result;
              } catch (error) {
                await client.query("ROLLBACK");
                throw error;
              }
            },
          },
          fixed,
        );
      const counts = async (h) =>
        (
          await admin.query(
            `SELECT
      (SELECT count(*)::int FROM rms_fulfillment.capacity_hold_terminal WHERE hold_id=$1) AS terminal,
      (SELECT count(*)::int FROM rms_fulfillment.capacity_allocation WHERE hold_id=$1) AS allocation,
      (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audit`,
            [id(h)],
          )
        ).rows[0];
      const unavailable = { code: "CAPACITY_DEPENDENCY_UNAVAILABLE" };
      await seed(30);
      await hold(admin, 30, 300);
      const conversion = await transitionRequest(300);
      await assert.rejects(
        writer(first, { failAllocation: true }).convert(conversion),
        unavailable,
      );
      assert.deepEqual(await counts(300), { terminal: 0, allocation: 0, audit: 0 });
      await assert.rejects(writer(first, { failAudit: true }).convert(conversion), unavailable);
      assert.deepEqual(await counts(300), { terminal: 0, allocation: 0, audit: 0 });
      await assert.rejects(writer(first, { loseAck: true }).convert(conversion), unavailable);
      const recovered = await writer(first).convert(conversion);
      assert.equal(recovered.status, "Existing");
      assert.equal(recovered.hold.state, "Converted");
      assert.deepEqual(await counts(300), { terminal: 1, allocation: 1, audit: 1 });
      await assert.rejects(
        writer(first).convert({ ...conversion, intentDigest: `sha256:${"c".repeat(64)}` }),
        { code: "CAPACITY_IDEMPOTENCY_CONFLICT" },
      );
      // A later allocation terminal does not rewrite the historical conversion receipt.
      await finish(admin, 30_300, "Released");
      assert.deepEqual((await writer(first).convert(conversion)).allocation, recovered.allocation);
      assert.deepEqual(await counts(300), { terminal: 1, allocation: 1, audit: 1 });

      await seed(31);
      await hold(admin, 31, 310);
      const release = await transitionRequest(310, "Release");
      const contender = await transitionRequest(310, "Convert", 71_310);
      let releaseCommit;
      const commitGate = new Promise((resolve) => {
        releaseCommit = resolve;
      });
      let reachedCommit;
      const entered = new Promise((resolve) => {
        reachedCommit = resolve;
      });
      const releasing = writer(first, {
        beforeCommit: async () => {
          reachedCommit();
          await commitGate;
        },
      }).release(release);
      await entered;
      const converting = writer(second)
        .convert(contender)
        .then(
          () => null,
          (error) => error.code,
        );
      try {
        await waitForLock();
      } finally {
        releaseCommit();
      }
      assert.equal((await releasing).hold.state, "Released");
      assert.equal(await converting, "CAPACITY_TRANSITION_CONFLICT");
      assert.equal((await writer(first).release(release)).status, "Existing");
      assert.deepEqual(await counts(310), { terminal: 1, allocation: 0, audit: 1 });
      await hold(admin, 31, 311); // Released unit really returns to admission.

      await seed(32);
      await hold(admin, 32, 320, new Date(Date.parse(await stamp()) + 700).toISOString());
      const aging = await transitionRequest(320);
      await admin.query("SELECT pg_sleep(0.8)");
      await assert.rejects(writer(first).convert(aging), unavailable);
      assert.deepEqual(await counts(320), { terminal: 0, allocation: 0, audit: 0 });
      const expiry = await transitionRequest(320, "Expire");
      assert.equal((await writer(first).release(expiry)).hold.state, "Expired");
      assert.deepEqual(await counts(320), { terminal: 1, allocation: 0, audit: 1 });

      await seed(33);
      await hold(admin, 33, 330);
      const wrong = await transitionRequest(330);
      wrong.transition.hold = { ...wrong.transition.hold, units: 2 };
      await assert.rejects(writer(first).convert(wrong), { code: "CAPACITY_TRANSITION_CONFLICT" });
      assert.deepEqual(await counts(330), { terminal: 0, allocation: 0, audit: 0 });
      const foreign = await transitionRequest(330);
      foreign.transition.hold = {
        ...foreign.transition.hold,
        slot: { ...foreign.transition.hold.slot, storeReference: id(99) },
      };
      await assert.rejects(writer(first).convert(foreign), { code: "CAPACITY_INPUT_INVALID" });
    }

    {
      // WP-2347: terminal receipts use explicit synthetic owner progress, never missing evidence.
      const fixed = { brandReference: brand, storeReference: store };
      const prepare = async (slot, h, a, startsAt) => {
        await seed(slot, 1, startsAt);
        await hold(admin, slot, h);
        await admin.query("BEGIN");
        try {
          await convert(admin, h, a);
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const readOriginal = async (a) =>
        createPostgresCapacityQueryStore(
          {
            async run(action) {
              await admin.query("BEGIN");
              try {
                const result = await action(admin);
                await admin.query("COMMIT");
                return result;
              } catch (error) {
                await admin.query("ROLLBACK");
                throw error;
              }
            },
          },
          fixed,
        ).loadAllocation({
          allocationReference: id(a),
          orderReference: id(a + 40_000),
          fulfillmentReference: id(a + 50_000),
        });
      const request = async (a, action = "Release", progress = null, operation = a + 80_000) => {
        const original = await readOriginal(a);
        assert(original);
        const at = await stamp();
        const inProgress = progress === "created" ? original.createdAt : progress;
        const consumed = inProgress !== null || at >= original.slot.startsAt;
        return {
          transition: {
            allocation: original,
            scope: fixed,
            expectedVersion: 1,
            at,
            action,
            fulfillmentInProgressAt: inProgress,
          },
          operationReference: id(operation),
          intentDigest: sha,
          audit: {
            auditId: id(operation + 10_000),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode: consumed
              ? "FULFILLMENT_CAPACITY_ALLOCATION_CONSUME"
              : "FULFILLMENT_CAPACITY_ALLOCATION_RELEASE",
            targetType: "FulfillmentCapacityAllocation",
            targetId: id(a),
            reasonCode: "AUTHORIZED_CAPACITY_TRANSITION",
            correlationId: id(operation + 20_000),
            occurredAt: at,
            sourceChannel: "EVENT_CONSUMER",
            dataClassification: "Restricted",
            retentionPolicyCode: "SYNTHETIC_RETENTION",
            retentionPolicyVersion: 1,
          },
        };
      };
      const writer = (client, options = {}) =>
        createPostgresCapacityAllocationTerminalStore(
          {
            async run(action) {
              await client.query("BEGIN");
              try {
                await client.query(`SET LOCAL ROLE ${role}`);
                await client.query("SET LOCAL lock_timeout='3s'");
                const result = await action({
                  async query(sql, values) {
                    if (
                      options.failAudit &&
                      sql.startsWith("INSERT INTO platform_audit.audit_record")
                    )
                      throw new Error("synthetic Audit failure");
                    return client.query(sql, [...values]);
                  },
                });
                if (options.beforeCommit) await options.beforeCommit();
                await client.query("COMMIT");
                if (options.loseAck) throw new Error("synthetic lost acknowledgement");
                return result;
              } catch (error) {
                await client.query("ROLLBACK");
                throw error;
              }
            },
          },
          fixed,
        );
      const counts = async (a) =>
        (
          await admin.query(
            `SELECT
        (SELECT count(*)::int FROM rms_fulfillment.capacity_allocation_terminal WHERE allocation_id=$1) AS terminal,
        (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audit`,
            [id(a)],
          )
        ).rows[0];
      const unavailable = { code: "CAPACITY_DEPENDENCY_UNAVAILABLE" };
      await prepare(40, 400, 40_400);
      const release = await request(40_400);
      await assert.rejects(writer(first, { failAudit: true }).append(release), unavailable);
      assert.deepEqual(await counts(40_400), { terminal: 0, audit: 0 });
      await assert.rejects(writer(first, { loseAck: true }).append(release), unavailable);
      assert.equal((await writer(first).append(release)).status, "Existing");
      assert.deepEqual(await counts(40_400), { terminal: 1, audit: 1 });
      await assert.rejects(
        writer(first).append({ ...release, intentDigest: `sha256:${"c".repeat(64)}` }),
        { code: "CAPACITY_IDEMPOTENCY_CONFLICT" },
      );
      await hold(admin, 40, 401); // Released units really return once.

      await prepare(41, 410, 40_410);
      const early = await request(40_410, "Release", "created");
      const consumed = await writer(first).append(early);
      assert.equal(consumed.allocation.state, "Consumed");
      assert.equal(consumed.allocation.consumedAt, early.transition.allocation.createdAt);
      assert.equal((await writer(first).append(early)).status, "Existing");
      assert.deepEqual(await counts(40_410), { terminal: 1, audit: 1 });
      await assert.rejects(hold(admin, 41, 411), /insufficient capacity/u);
      const reopen = {
        ...early,
        operationReference: id(120_999),
        intentDigest: `sha256:${"c".repeat(64)}`,
      };
      await assert.rejects(writer(first).append(reopen), { code: "CAPACITY_TRANSITION_CONFLICT" });

      await prepare(42, 420, 40_420);
      const firstRelease = await request(40_420);
      const duplicate = await request(40_420, "Release", null, 121_420);
      let releaseCommit;
      const gate = new Promise((resolve) => {
        releaseCommit = resolve;
      });
      let reachedCommit;
      const entered = new Promise((resolve) => {
        reachedCommit = resolve;
      });
      const initial = writer(first, {
        beforeCommit: async () => {
          reachedCommit();
          await gate;
        },
      }).append(firstRelease);
      await entered;
      const competing = writer(second)
        .append(duplicate)
        .then(
          () => null,
          (error) => error.code,
        );
      try {
        await waitForLock();
      } finally {
        releaseCommit();
      }
      assert.equal((await initial).status, "Created");
      assert.equal(await competing, "CAPACITY_TRANSITION_CONFLICT");
      assert.deepEqual(await counts(40_420), { terminal: 1, audit: 1 });

      const slotStart = new Date(Date.parse(await stamp()) + 700).toISOString();
      await prepare(43, 430, 40_430, slotStart);
      await admin.query("SELECT pg_sleep(0.8)");
      const started = await request(40_430, "Consume");
      const atStart = await writer(first).append(started);
      assert.equal(atStart.allocation.state, "Consumed");
      assert.equal(atStart.allocation.consumedAt, slotStart);

      await prepare(44, 440, 40_440);
      const wrong = await request(40_440);
      wrong.transition.allocation = { ...wrong.transition.allocation, units: 2 };
      await assert.rejects(writer(first).append(wrong), { code: "CAPACITY_TRANSITION_CONFLICT" });
      assert.deepEqual(await counts(40_440), { terminal: 0, audit: 0 });
      const foreign = await request(40_440);
      foreign.transition.allocation = {
        ...foreign.transition.allocation,
        slot: { ...foreign.transition.allocation.slot, storeReference: id(99) },
      };
      await assert.rejects(writer(first).append(foreign), { code: "CAPACITY_INPUT_INVALID" });
    }
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

it("atomically converts and accounts for immutable scoped capacity Allocations on PostgreSQL", async () => {
  await withIsolatedDatabase({ caseId: "capacity_allocation", root }, prove);
});
