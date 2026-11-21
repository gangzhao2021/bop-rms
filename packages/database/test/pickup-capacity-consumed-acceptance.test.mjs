import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  consumeAcceptedAsapCapacity,
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
const [brand, store, slotReference] = [1, 2, 3].map(id);
const scope = { brandReference: brand, storeReference: store };

/**
 * WP-2423 DEC-PICKUP-CAPACITY-CONSUMED. Reported on v15 (2026-10-19): every pickup commitment's latest
 * version was PaymentPending, including 130 paid and accepted Orders. A PaymentPending commitment only
 * counts until its capacity expiry (payment request + 30 minutes), so an accepted Order stopped
 * counting against its pickup hour half an hour after checkout and the hour could take more Orders
 * than the kitchen limit. Runs Fulfillment's consumption as a restricted NOBYPASSRLS role holding
 * exactly the rendered pilot API grants, inside the caller's transaction:
 * - an accepted Order is Consumed (v3, audited) and still counts after its payment window, while an
 *   abandoned checkout (never accepted) stops counting when its window ends;
 * - repeating it appends nothing; a commitment of another Order is not touched;
 * - a commitment whose window already passed is left as it is and the caller's transaction (the
 *   acceptance) carries on.
 */
it("keeps an accepted pickup order counted against its hour after the payment window", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_consumed" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_consumed_" + context.runId,
      worker = "wp2423_consumed_w_" + context.runId;
    assert.match(role, /^wp2423_consumed_[a-f0-9]+$/u);
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
      // The owner service as the online checkout composes it.
      const service = (record) =>
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
            }),
          },
          repository,
          audit: { prepare: async (value) => auditFor(value, ++audits) },
        });
      const pending = async (n) => {
        const record = commitment(n);
        const prepared = await service(record).prepare(record);
        assert.equal(prepared.status, "Created");
        const at = now();
        const sealed = sealAsapCapacityCommitment(
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
        await repository.append({ record: sealed, audit: auditFor(sealed, ++audits) });
        return sealed;
      };
      let auditReferences = 2_000_000;
      const consume = (record, transaction, order = record.orderReference) =>
        consumeAcceptedAsapCapacity(transaction, scope, {
          submissionReference: record.submissionReference,
          orderReference: order,
          orderBatchReference: record.orderBatchReference,
          auditReference: id(++auditReferences),
          correlationReference: id(++auditReferences),
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        });
      const history = async (record) =>
        (
          await admin.query(
            "SELECT state,version::int AS version FROM rms_fulfillment.capacity_asap_commitment " +
              "WHERE allocation_id=$1 ORDER BY version",
            [record.allocationReference],
          )
        ).rows.map((row) => row.state + "/" + row.version);
      const consumedAudits = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record " +
              "WHERE action_code='FULFILLMENT_ASAP_CAPACITY_CONSUMED' AND reason_code='ORDER_ACCEPTED' " +
              "AND source_channel='MERCHANT_WEB' AND actor_type='System'",
          )
        ).rows[0].n;

      const accepted = await pending(1);
      const abandoned = await pending(2);
      assert.equal((await reader.resolve(now())).occupiedUnits, 2);

      // Staff accept Order 1: consumed in the caller's transaction; a repeat appends nothing; a
      // commitment named for another Order is not touched.
      assert.equal(
        await runner.run((tx) => consume(abandoned, tx, accepted.orderReference)),
        "NotConsumable",
      );
      assert.equal(await runner.run((tx) => consume(accepted, tx)), "Consumed");
      assert.equal(await runner.run((tx) => consume(accepted, tx)), "AlreadyConsumed");
      assert.deepEqual(await history(accepted), ["Prepared/1", "PaymentPending/2", "Consumed/3"]);
      assert.deepEqual(await history(abandoned), ["Prepared/1", "PaymentPending/2"]);
      assert.equal(await consumedAudits(), 1);

      // After both payment windows (30 minutes) but within the hour: the accepted Order still
      // counts, the abandoned checkout no longer does. Before the fix both stopped counting.
      const afterWindow = new Date(Date.parse(accepted.capacityExpiresAt) + 60_000).toISOString();
      assert.ok(afterWindow < endsAt);
      assert.equal((await reader.resolve(now())).occupiedUnits, 2);
      assert.equal((await reader.resolve(afterWindow)).occupiedUnits, 1);

      // A commitment whose payment window already ended (an Order held through an outage and
      // accepted later): nothing is written and the acceptance transaction carries on.
      const lapsed = commitment(3);
      const requestedAt = new Date(base - 40 * 60_000).toISOString();
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica"); // historic fixture rows only
      for (const row of [
        { ...lapsed, preparedAt: new Date(base - 41 * 60_000).toISOString() },
        {
          ...lapsed,
          preparedAt: new Date(base - 41 * 60_000).toISOString(),
          state: "PaymentPending",
          version: 2,
          orderingLinkedAt: requestedAt,
          paymentRequestedAt: requestedAt,
          capacityExpiresAt: new Date(base - 10 * 60_000).toISOString(),
        },
      ])
        await admin.query(
          `INSERT INTO rms_fulfillment.capacity_asap_commitment (brand_id,store_id,slot_id,config_version,
            allocation_id,guest_session_id,cart_id,quote_id,submission_id,order_id,order_batch_id,fulfillment_id,
            payment_operation_id,cart_version,capacity_units,units_rule_version,units_input_digest,intent_digest,
            state,version,prepared_at,preparation_valid_until,ordering_linked_at,payment_requested_at,
            capacity_expires_at,terminal_at)
            VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,1,1,$13,$13,$14,$15,$16,$17,$18,$19,$20,NULL)`,
          [
            brand,
            store,
            slotReference,
            row.allocationReference,
            row.guestSessionReference,
            row.cartReference,
            row.quoteReference,
            row.submissionReference,
            row.orderReference,
            row.orderBatchReference,
            row.fulfillmentReference,
            row.paymentOperationReference,
            sha,
            row.state,
            row.version,
            row.preparedAt,
            new Date(base - 31 * 60_000).toISOString(),
            row.orderingLinkedAt ?? null,
            row.paymentRequestedAt ?? null,
            row.capacityExpiresAt ?? null,
          ],
        );
      await admin.query("COMMIT");
      const carriedOn = await runner.run(async (tx) => {
        const outcome = await consume(lapsed, tx);
        const after = await tx.query("SELECT 1 AS alive", []);
        return [outcome, after.rows[0].alive];
      });
      assert.deepEqual(carriedOn, ["NotConsumable", 1]);
      assert.deepEqual(await history(lapsed), ["Prepared/1", "PaymentPending/2"]);
      assert.equal(await consumedAudits(), 1);
    } finally {
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
