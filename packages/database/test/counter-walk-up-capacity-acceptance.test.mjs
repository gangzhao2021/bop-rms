import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createAsapCapacityService,
  createPostgresAsapCapacityStore,
  createPostgresCurrentPickupCapacityStore,
  parseAsapCapacityCommitment,
  sealAsapCapacityCommitment,
} from "../../rms/fulfillment/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a7c9-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = "sha256:" + "d".repeat(64);
const [brand, store, slotReference, emptySlotReference] = [1, 2, 3, 4].map(id);
const scope = { brandReference: brand, storeReference: store };

/**
 * WP-2423 DEC-COUNTER-WALK-UP-CAPACITY reproduction. Reported on a restored copy of v15: after
 * about 20 counter (walk-up) orders in one pickup hour (limit 20 under PILOT_DEFAULT_PICKUP_CAPACITY_V1)
 * the next counter order was refused and staff saw "try again"; the slot held 40 commitment rows.
 * This runs the real Fulfillment owner service, store, current reader and database trigger as a
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants:
 * - 20 counter orders each write two rows (Prepared, then PaymentPending when payment is
 *   requested): 40 rows, 20 allocations, 20 occupied units — counted once each, not doubled;
 * - the 21st counter order is admitted (WalkUp) and counted, so an online (Paced) order is refused
 *   by both the owner check and the database trigger;
 * - later versions keep the WalkUp admission; a WalkUp admission is accepted only on a first version.
 */
it("never refuses a counter walk-up order for pickup capacity, and paces online orders by it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_walk_up" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_walkup_" + context.runId,
      worker = "wp2423_walkup_w_" + context.runId;
    assert.match(role, /^wp2423_walkup_[a-f0-9]+$/u);
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      // Each owner transaction runs as the pilot API role, like the pilot's runner.
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='5s'");
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      // The database clock decides; stay a few milliseconds behind it.
      const databaseNow = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const offset = databaseNow - Date.now();
      const now = () => new Date(Date.now() + offset - 5).toISOString();
      const base = Date.parse(now());
      const startsAt = new Date(base - 10 * 60_000).toISOString(),
        endsAt = new Date(base + 50 * 60_000).toISOString();
      await admin.query(
        `INSERT INTO rms_fulfillment.capacity_slot
          (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date)
          VALUES ($1,$2,$3,'Pickup',$4,$5,'America/Toronto','2026-10-19')`,
        [brand, store, slotReference, startsAt, endsAt],
      );
      // PILOT_DEFAULT_PICKUP_CAPACITY_V1: 20 an hour within pickup hours.
      await admin.query(
        `INSERT INTO rms_fulfillment.capacity_slot_configuration
          (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,20,$4)`,
        [brand, store, slotReference, new Date(base - 20 * 60_000).toISOString()],
      );
      const repository = createPostgresAsapCapacityStore(runner, scope, { now });
      const reader = createPostgresCurrentPickupCapacityStore(runner, scope);
      const slot = (await reader.resolve(now())).slot;
      const auditFor = (record, n) => ({
        auditId: id(n),
        brandId: brand,
        storeId: store,
        actor: { type: "System" },
        actionCode: "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase(),
        targetType: "FulfillmentAsapCapacity",
        targetId: record.allocationReference,
        reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
        correlationId: record.submissionReference,
        occurredAt: record.terminalAt ?? record.paymentRequestedAt ?? record.preparedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "SYNTHETIC_RETENTION",
        retentionPolicyVersion: 1,
      });
      let audits = 1_000_000;
      const commitment = (n) => {
        const preparedAt = now();
        return parseAsapCapacityCommitment({
          slot,
          allocationReference: id(n * 100 + 1),
          guestSessionReference: id(n * 100 + 2),
          cartReference: id(n * 100 + 3),
          quoteReference: id(n * 100 + 4),
          submissionReference: id(n * 100 + 5),
          orderReference: id(n * 100 + 6),
          orderBatchReference: id(n * 100 + 7),
          fulfillmentReference: id(n * 100 + 8),
          paymentOperationReference: id(n * 100 + 9),
          cartVersion: 1,
          units: 1,
          unitsRuleVersion: 1,
          unitsInputDigest: sha,
          intentDigest: sha,
          state: "Prepared",
          version: 1,
          preparedAt,
          preparationValidUntil: new Date(Date.parse(preparedAt) + 10 * 60_000).toISOString(),
          orderingLinkedAt: null,
          paymentRequestedAt: null,
          capacityExpiresAt: null,
          terminalAt: null,
        });
      };
      // The owner service as the checkout composes it; the counter's source adds WalkUp.
      const service = (record, walkUp) =>
        createAsapCapacityService({
          scope,
          now,
          authorization: {
            authorize: async (request) => ({
              guestSessionReference: record.guestSessionReference,
              brandReference: brand,
              storeReference: store,
              identityVersion: 1,
              observedAt: request.observedAt,
              validUntil: record.preparationValidUntil,
            }),
          },
          current: {
            resolve: async (_record, observedAt) => ({
              ...(await reader.resolve(observedAt)),
              ...(walkUp ? { admission: "WalkUp" } : {}),
            }),
          },
          repository,
          audit: { prepare: async (value) => auditFor(value, ++audits) },
        });
      const order = async (n, walkUp) => {
        const record = commitment(n);
        const prepared = await service(record, walkUp).prepare(record);
        assert.equal(prepared.status, "Created");
        // Payment requested (the counter's payment clock): the second row of the commitment.
        const at = now();
        const pending = sealAsapCapacityCommitment(
          record,
          {
            allocationReference: record.allocationReference,
            guestSessionReference: record.guestSessionReference,
            cartReference: record.cartReference,
            quoteReference: record.quoteReference,
            submissionReference: record.submissionReference,
            orderReference: record.orderReference,
            orderBatchReference: record.orderBatchReference,
            fulfillmentReference: record.fulfillmentReference,
            paymentOperationReference: record.paymentOperationReference,
            brandReference: brand,
            storeReference: store,
            cartVersion: record.cartVersion,
            intentDigest: record.intentDigest,
            acknowledgedAt: at,
          },
          at,
          at,
        );
        await repository.append({ record: pending, audit: auditFor(pending, ++audits) });
        return pending;
      };
      const rows = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n, count(DISTINCT allocation_id)::int AS allocations, " +
              "count(*) FILTER (WHERE admission='WalkUp')::int AS walk_up " +
              "FROM rms_fulfillment.capacity_asap_commitment WHERE slot_id=$1",
            [slotReference],
          )
        ).rows[0];

      // 20 counter orders fill the hour: 40 rows, 20 allocations, 20 units occupied.
      for (let n = 1; n <= 20; n++) await order(n, true);
      assert.deepEqual(await rows(), { n: 40, allocations: 20, walk_up: 40 });
      assert.equal((await reader.resolve(now())).occupiedUnits, 20);

      // The reported failure: the 21st customer at the counter. It is admitted and counted.
      const twentyFirst = await order(21, true);
      assert.equal(twentyFirst.state, "PaymentPending");
      assert.deepEqual(await rows(), { n: 42, allocations: 21, walk_up: 42 });
      const observed = await reader.resolve(now());
      assert.deepEqual([observed.capacityLimit, observed.occupiedUnits], [20, 21]);

      // An online order in the same hour is paced by the counter's load: refused by the owner
      // check, and by the database trigger if written directly.
      const online = commitment(30);
      await assert.rejects(service(online, false).prepare(online), {
        code: "ASAP_CAPACITY_INSUFFICIENT",
      });
      await assert.rejects(repository.append({ record: online, audit: auditFor(online, 30) }), {
        code: "ASAP_CAPACITY_UNAVAILABLE",
      });
      assert.deepEqual(await rows(), { n: 42, allocations: 21, walk_up: 42 });

      // A WalkUp admission is only taken on a first version; later versions inherit it.
      await assert.rejects(
        repository.append({
          record: twentyFirst,
          audit: auditFor(twentyFirst, 31),
          admission: "WalkUp",
        }),
        { code: "ASAP_CAPACITY_INVALID" },
      );
      await assert.rejects(
        runner.run((tx) =>
          tx.query(
            "UPDATE rms_fulfillment.capacity_asap_commitment SET admission='Paced' WHERE allocation_id=$1",
            [twentyFirst.allocationReference],
          ),
        ),
        /append-only|permission denied/u,
      );

      // The counter can tell staff when no pickup time covers now.
      assert.equal(await reader.covers(now()), true);
      assert.equal(await reader.covers(new Date(base + 2 * 3_600_000).toISOString()), false);
      assert.equal(
        await createPostgresCurrentPickupCapacityStore(runner, {
          ...scope,
          storeReference: emptySlotReference,
        }).covers(now()),
        false,
      );
    } finally {
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
