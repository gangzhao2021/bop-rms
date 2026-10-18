import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresAsapCapacityStore,
  createPostgresCurrentPickupCapacityStore,
  parseAsapCapacityCommitment,
  sealAsapCapacityCommitment,
  finishAsapCapacityCommitment,
  listStorePickupAcceptanceDeadlines,
} from "../../rms/fulfillment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = `sha256:${"b".repeat(64)}`;
const added = ["capacity_hold_terminal", "capacity_allocation", "capacity_allocation_terminal"];
const tables = [
  "capacity_slot",
  "capacity_slot_configuration",
  "capacity_hold",
  ...added,
  "capacity_asap_commitment",
];

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const first = new Client(context.clientConfig);
  const second = new Client(context.clientConfig);
  await Promise.all([admin.connect(), first.connect(), second.connect()]);
  const role = `bop_wp2402_asap_${context.runId}`;
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
    const seed = async (
      slot,
      limit = 1,
      startsAt = future(3_600_000 + slot * 1_800_000),
      publishedAt = future(-1_000),
    ) => {
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
        [brand, store, id(slot), limit, publishedAt],
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

    const asap = async (client, slot, a, until = future(600_000), preparedAt = null) => {
      await client.query(
        "INSERT INTO rms_fulfillment.capacity_asap_commitment " +
          "(brand_id,store_id,allocation_id,version,state,slot_id,config_version," +
          "guest_session_id,cart_id,cart_version,quote_id,submission_id,order_id,order_batch_id," +
          "fulfillment_id,payment_operation_id,capacity_units,units_rule_version,units_input_digest,intent_digest," +
          "prepared_at,preparation_valid_until) " +
          "VALUES ($1,$2,$3,1,'Prepared',$4,1,$5,$6,1,$7,$8,$9,$10,$11,$12,1,1,$13,$13,$14,$15)",
        [
          brand,
          store,
          id(a),
          id(slot),
          id(a + 1000),
          id(a + 2000),
          id(a + 3000),
          id(a + 4000),
          id(a + 5000),
          id(a + 6000),
          id(a + 7000),
          id(a + 8000),
          sha,
          preparedAt ?? (await stamp(client)),
          until,
        ],
      );
    };
    const advance = async (client, a, state, overrides = {}) => {
      const prior = (
        await client.query(
          "SELECT * FROM rms_fulfillment.capacity_asap_commitment WHERE brand_id=$1 AND store_id=$2 AND allocation_id=$3 ORDER BY version DESC LIMIT 1",
          [brand, store, id(a)],
        )
      ).rows[0];
      assert(prior);
      const now = await stamp(client);
      const next = {
        ...prior,
        version: Number(prior.version) + 1,
        state,
        ...(state === "PaymentPending"
          ? {
              ordering_linked_at: now,
              payment_requested_at: now,
              capacity_expires_at: new Date(Date.parse(now) + 1_800_000).toISOString(),
            }
          : { terminal_at: now }),
        ...overrides,
      };
      const columns = Object.keys(next);
      await client.query(
        "INSERT INTO rms_fulfillment.capacity_asap_commitment (" +
          columns.join(",") +
          ") VALUES (" +
          columns.map((_, i) => "$" + (i + 1)).join(",") +
          ")",
        columns.map((k) => next[k]),
      );
    };
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    for (const table of tables)
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_fulfillment." + table + " TO " + role,
      );

    // Both insertion orders contend for the same physical row and the loser sees committed occupancy.
    for (const [slot, firstKind] of [
      [10, "asap"],
      [11, "scheduled"],
    ]) {
      await seed(slot);
      await begin(first);
      await (firstKind === "asap" ? asap(first, slot, slot * 100) : hold(first, slot, slot * 100));
      await begin(second);
      const contender = (
        firstKind === "asap"
          ? hold(second, slot, slot * 100 + 1)
          : asap(second, slot, slot * 100 + 1)
      ).then(
        () => null,
        (error) => error.code,
      );
      await waitForLock();
      await first.query("COMMIT");
      assert.equal(await contender, "23514");
      await rollback(second);
    }
    // Sealing preserves original occupancy, releasing returns it exactly once.
    await begin(first);
    await advance(first, 1000, "PaymentPending");
    await first.query("COMMIT");
    await rejected((c) => hold(c, 10, 1002), /insufficient capacity/u);
    await begin(first);
    await advance(first, 1000, "Released");
    await hold(first, 10, 1003);
    await first.query("COMMIT");
    await rejected((c) => advance(c, 1000, "Consumed"), /invalid ASAP|check constraint/u);

    // Expired preparation cannot be sealed and no longer blocks a Scheduled Hold.
    await seed(12);
    await begin(first);
    await asap(first, 12, 1200, new Date(Date.parse(await stamp(first)) + 350).toISOString());
    await first.query("COMMIT");
    await delay(400);
    await rejected((c) => advance(c, 1200, "PaymentPending"), /invalid ASAP/u);
    await begin(first);
    await advance(first, 1200, "Expired");
    await hold(first, 12, 1201);
    await first.query("COMMIT");

    // Current configuration is authoritative; callers cannot reuse the old version.
    await seed(13, 2);
    await admin.query(
      "INSERT INTO rms_fulfillment.capacity_slot_configuration (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,2,2,$4)",
      [brand, store, id(13), await stamp()],
    );
    await rejected((c) => asap(c, 13, 1300), /invalid ASAP preparation/u);

    // Consumed capacity remains counted and exact provenance cannot change on sealing.
    await seed(14);
    await begin(first);
    await asap(first, 14, 1400);
    await first.query("COMMIT");
    await rejected(
      (c) => advance(c, 1400, "PaymentPending", { order_id: id(999) }),
      /invalid ASAP/u,
    );
    await begin(first);
    await advance(first, 1400, "PaymentPending");
    await advance(first, 1400, "Consumed");
    await first.query("COMMIT");
    await rejected((c) => hold(c, 14, 1401), /insufficient capacity/u);
    await rejected((c) => asap(c, 14, 1402), /insufficient capacity/u);

    // WP-2423 Q1: only a current PaymentPending commitment gives an Order its acceptance deadline.
    await seed(15);
    await begin(first);
    await asap(first, 15, 1500);
    await advance(first, 1500, "PaymentPending");
    await first.query("COMMIT");
    await begin(first);
    const deadlines = await listStorePickupAcceptanceDeadlines(
      first,
      { brandReference: brand, storeReference: store },
      [id(1500 + 5000), id(1400 + 5000), id(1000 + 5000), id(777)],
    );
    const expected = (
      await first.query(
        "SELECT capacity_expires_at FROM rms_fulfillment.capacity_asap_commitment WHERE allocation_id=$1 AND version=2",
        [id(1500)],
      )
    ).rows[0].capacity_expires_at.toISOString();
    assert.deepEqual([...deadlines], [[id(1500 + 5000), expected]]);
    await rollback(first);
    await begin(first, id(99));
    assert.equal(
      (
        await listStorePickupAcceptanceDeadlines(
          first,
          { brandReference: brand, storeReference: id(99) },
          [id(1500 + 5000)],
        )
      ).size,
      0,
    );
    await rollback(first);

    // RLS is exercised directly using a non-superuser, not merely inspected.
    await begin(first, id(99));
    assert.equal(
      (await first.query("SELECT * FROM rms_fulfillment.capacity_asap_commitment")).rows.length,
      0,
    );
    await rollback(first);
    await rejected((c) => asap(c, 14, 1499), /invalid capacity scope|row-level security/u, id(99));
    for (const sql of [
      "UPDATE rms_fulfillment.capacity_asap_commitment SET capacity_units=2",
      "DELETE FROM rms_fulfillment.capacity_asap_commitment",
      "TRUNCATE rms_fulfillment.capacity_asap_commitment",
    ])
      await rejected((c) => c.query(sql), /append-only/u);
    await rejected(
      (c) => asap(c, 14, 1498),
      /require read committed/u,
      store,
      "ISOLATION LEVEL REPEATABLE READ",
    );

    // Actual owner repository and public Audit commit together.
    await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
    const scope = { brandReference: brand, storeReference: store };
    const request = async (slot, a, ttl = 600_000) => {
      const preparedAt = await stamp();
      const record = parseAsapCapacityCommitment({
        slot: {
          ...scope,
          fulfillmentType: "Pickup",
          slotReference: id(slot),
          configVersion: 1,
          startsAt: future(3_600_000 + slot * 1_800_000),
          endsAt: future(5_400_000 + slot * 1_800_000),
        },
        allocationReference: id(a),
        guestSessionReference: id(a + 1000),
        cartReference: id(a + 2000),
        quoteReference: id(a + 3000),
        submissionReference: id(a + 4000),
        orderReference: id(a + 5000),
        orderBatchReference: id(a + 6000),
        fulfillmentReference: id(a + 7000),
        paymentOperationReference: id(a + 8000),
        cartVersion: 1,
        units: 1,
        unitsRuleVersion: 1,
        unitsInputDigest: sha,
        intentDigest: sha,
        state: "Prepared",
        version: 1,
        preparedAt,
        preparationValidUntil: new Date(Date.parse(preparedAt) + ttl).toISOString(),
        orderingLinkedAt: null,
        paymentRequestedAt: null,
        capacityExpiresAt: null,
        terminalAt: null,
      });
      return { record, audit: auditFor(record, a + 9000) };
    };
    const auditFor = (record, n) => ({
      auditId: id(n),
      brandId: brand,
      storeId: store,
      actor: { type: "System" },
      actionCode: "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase(),
      targetType: "FulfillmentAsapCapacity",
      targetId: record.allocationReference,
      reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
      correlationId: id(n + 100000),
      occurredAt: record.terminalAt ?? record.paymentRequestedAt ?? record.preparedAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "SYNTHETIC_RETENTION",
      retentionPolicyVersion: 1,
    });
    const writer = (client, options = {}) =>
      createPostgresAsapCapacityStore(
        {
          async run(action) {
            await client.query("BEGIN");
            try {
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='3s'");
              const result = await action({
                query(sql, values) {
                  if (
                    options.failAudit &&
                    sql.startsWith("INSERT INTO platform_audit.audit_record")
                  )
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              if (options.loseAck) throw new Error("synthetic acknowledgement loss");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          },
        },
        scope,
        { now: () => new Date().toISOString() },
      );
    const counts = async (a) => ({
      records: Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM rms_fulfillment.capacity_asap_commitment WHERE allocation_id=$1",
            [id(a)],
          )
        ).rows[0].n,
      ),
      audits: Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM platform_audit.audit_record WHERE target_id=$1",
            [id(a)],
          )
        ).rows[0].n,
      ),
    });
    await seed(30);
    const acquisition = await request(30, 3000);
    const simultaneous = await Promise.all([
      writer(first).append(acquisition),
      writer(second).append(acquisition),
    ]);
    assert.deepEqual(simultaneous.map((r) => r.status).sort(), ["Created", "Existing"]);
    assert.deepEqual(await counts(3000), { records: 1, audits: 1 });
    assert.deepEqual(
      await writer(first).load(acquisition.record.allocationReference),
      acquisition.record,
    );
    assert.deepEqual(
      await writer(first).loadSubmission(acquisition.record.submissionReference),
      acquisition.record,
    );
    await assert.rejects(
      writer(first).append({
        ...acquisition,
        record: { ...acquisition.record, intentDigest: "sha256:" + "c".repeat(64) },
      }),
      { code: "ASAP_CAPACITY_CONFLICT" },
    );

    await seed(31);
    const rolledBack = await request(31, 3100);
    await assert.rejects(writer(first, { failAudit: true }).append(rolledBack), {
      code: "ASAP_CAPACITY_UNAVAILABLE",
    });
    assert.deepEqual(await counts(3100), { records: 0, audits: 0 });
    assert.equal((await writer(first).append(rolledBack)).status, "Created");

    await seed(32);
    const lost = await request(32, 3200);
    await assert.rejects(writer(first, { loseAck: true }).append(lost), {
      code: "ASAP_CAPACITY_UNAVAILABLE",
    });
    assert.equal((await writer(first).append(lost)).status, "Existing");
    assert.deepEqual(await counts(3200), { records: 1, audits: 1 });

    const r = lost.record;
    const acknowledgedAt = await stamp();
    const acknowledgement = {
      allocationReference: r.allocationReference,
      guestSessionReference: r.guestSessionReference,
      cartReference: r.cartReference,
      quoteReference: r.quoteReference,
      submissionReference: r.submissionReference,
      orderReference: r.orderReference,
      orderBatchReference: r.orderBatchReference,
      fulfillmentReference: r.fulfillmentReference,
      paymentOperationReference: r.paymentOperationReference,
      brandReference: brand,
      storeReference: store,
      cartVersion: r.cartVersion,
      intentDigest: r.intentDigest,
      acknowledgedAt,
    };
    const pending = sealAsapCapacityCommitment(r, acknowledgement, acknowledgedAt, acknowledgedAt);
    await assert.rejects(
      writer(first, { loseAck: true }).append({
        record: pending,
        audit: auditFor(pending, 193200),
      }),
      { code: "ASAP_CAPACITY_UNAVAILABLE" },
    );
    assert.deepEqual(
      (await writer(first).append({ record: pending, audit: auditFor(pending, 193201) })).record,
      pending,
    );
    const released = finishAsapCapacityCommitment(pending, "Released", await stamp());
    await writer(first).append({ record: released, audit: auditFor(released, 293200) });
    assert.deepEqual(await counts(3200), { records: 3, audits: 3 });
    assert.deepEqual((await writer(first).append(lost)).record, lost.record);
    assert.deepEqual(await writer(first).loadSubmission(r.submissionReference), released);

    // Deadline is checked after an actual slot-lock wait, with no orphan Audit or capacity row.
    await seed(33);
    const short = await request(33, 3300, 600);
    await begin(first);
    await first.query(
      "SELECT slot_id FROM rms_fulfillment.capacity_slot WHERE slot_id=$1 FOR UPDATE",
      [id(33)],
    );
    const aged = writer(second)
      .append(short)
      .then(
        () => null,
        (error) => error.code,
      );
    try {
      await waitForLock();
      await delay(650);
    } finally {
      await first.query("COMMIT");
    }
    assert.equal(await aged, "ASAP_CAPACITY_UNAVAILABLE");
    assert.deepEqual(await counts(3300), { records: 0, audits: 0 });
    const cleared = (
      await first.query(
        "SELECT nullif(current_setting('bop.brand_id',true),'') AS brand,nullif(current_setting('bop.store_id',true),'') AS store",
      )
    ).rows[0];
    assert.deepEqual(cleared, { brand: null, store: null });

    // Synthetic historical instants put the original fixed 30-minute expiry near now.
    // No duration is shortened in production code and no applied row is updated.
    const historicalNow = Date.parse(await stamp());
    const historical = (delta) => new Date(historicalNow + delta).toISOString();
    await seed(34, 1, future(3_600_000 + 34 * 1_800_000), historical(-2_000_000));
    await begin(first);
    await asap(first, 34, 3400, historical(60_000), historical(-1_900_000));
    await advance(first, 3400, "PaymentPending", {
      ordering_linked_at: historical(-1_800_000 + 700),
      payment_requested_at: historical(-1_800_000 + 700),
      capacity_expires_at: historical(700),
    });
    await first.query("COMMIT");
    const originalPending = await writer(first).load(id(3400));
    assert.equal(
      Date.parse(originalPending.capacityExpiresAt) -
        Date.parse(originalPending.paymentRequestedAt),
      1_800_000,
    );
    await delay(Math.max(0, historicalNow + 750 - Date.now()));
    // Even a stale terminal timestamp cannot consume units after the lock-time clock has expired.
    await rejected(
      (c) => advance(c, 3400, "Consumed", { terminal_at: historical(600) }),
      /invalid ASAP/u,
    );
    await begin(first);
    await hold(first, 34, 3401);
    await advance(first, 3400, "Expired");
    await first.query("COMMIT");
    assert.equal((await writer(first).load(id(3400))).state, "Expired");

    // Current public owner reader sees the same Scheduled and ASAP occupancy.
    const currentReader = (requestedScope = scope) =>
      createPostgresCurrentPickupCapacityStore(
        {
          async run(action) {
            await admin.query("BEGIN READ ONLY");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              const result = await action({
                query: (sql, values) => admin.query(sql, [...values]),
              });
              await admin.query("COMMIT");
              return result;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
        requestedScope,
      );
    await assert.rejects(currentReader().resolve(await stamp()), {
      code: "ASAP_CAPACITY_UNAVAILABLE",
    });
    const upcoming = Date.parse(await stamp()) + 1000;
    await seed(40, 3, new Date(upcoming).toISOString());
    await begin(first);
    await hold(first, 40, 4000);
    await asap(first, 40, 4001);
    await first.query("COMMIT");
    await delay(Math.max(0, upcoming + 20 - Date.now()));
    const observed = await stamp();
    const currentSlot = await currentReader().resolve(observed);
    assert.equal(currentSlot.slot.slotReference, id(40));
    assert.equal(currentSlot.capacityLimit, 3);
    assert.equal(currentSlot.occupiedUnits, 2);
    assert.equal(currentSlot.observedAt, observed);
    await begin(first);
    await advance(first, 4001, "Released");
    await first.query("COMMIT");
    assert.equal((await currentReader().resolve(await stamp())).occupiedUnits, 1);
    await assert.rejects(
      currentReader({ ...scope, storeReference: id(99) }).resolve(await stamp()),
      { code: "ASAP_CAPACITY_UNAVAILABLE" },
    );
    await seed(41, 3, new Date(upcoming - 100).toISOString());
    await assert.rejects(currentReader().resolve(await stamp()), {
      code: "ASAP_CAPACITY_UNAVAILABLE",
    });
  } finally {
    await Promise.all([
      first.query("ROLLBACK").catch(() => undefined),
      second.query("ROLLBACK").catch(() => undefined),
    ]);
    await Promise.all([first.end(), second.end()]);
    if (roleCreated) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
it("serializes shared Scheduled and ASAP capacity with immutable scoped history", async () => {
  await withIsolatedDatabase({ caseId: "asap_capacity", root }, prove);
});
