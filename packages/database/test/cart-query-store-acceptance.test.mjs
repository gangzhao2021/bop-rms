import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartQueryStore,
  createPostgresDiningCartCommandQueryStore,
  createPostgresDiningCartReadStore,
  createDiningCartReadService,
  createPostgresCartItemOperationStore,
  createPostgresBoundCartItemOperationStore,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
it("reads scoped Cart facts through a least-privilege read-only PostgreSQL adapter", async () => {
  await withIsolatedDatabase({ caseId: "wp2223_cart_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2223_${context.runId}`;
    assert.match(role, /^wp2223_[a-f0-9]+$/u);
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA platform_helpers, rms_ordering TO ${role}`);
      await admin.query(
        `GRANT SELECT ON rms_ordering.cart, rms_ordering.cart_line, rms_ordering.cart_operation_record TO ${role}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      for (const cartId of [id(1), id(10)]) {
        await admin.query(
          `INSERT INTO rms_ordering.cart
          (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at)
          VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5)`,
          [cartId, id(2), id(3), id(4), at],
        );
      }
      const selection = {
        menuVersionReference: id(20),
        productVersionReference: id(21),
        catalogChannelCode: "PICKUP",
        catalogOrderTypeCode: "PICKUP",
        ruleEvidence: [],
        validatedAt: at,
      };
      for (const lineId of [id(6), id(5)]) {
        await admin.query(
          `INSERT INTO rms_ordering.cart_line
          (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at,customer_note,catalog_selection_evidence_json)
          VALUES ($1,$2,$3,$4,$5,2,$6::jsonb,$7,$8,$9,$10::jsonb)`,
          [
            lineId,
            id(1),
            id(2),
            id(3),
            id(7),
            JSON.stringify([{ optionReference: id(8), quantity: 1 }]),
            id(4),
            at,
            "Synthetic preparation note",
            JSON.stringify(selection),
          ],
        );
      }
      await admin.query(
        `UPDATE rms_ordering.cart SET lifecycle_status='Active',lifecycle_policy_version_id=$2,
        lifecycle_policy_digest=$3,idle_timeout_seconds=3600,absolute_timeout_seconds=86400,
        idle_expires_at=$4,absolute_expires_at=$5 WHERE cart_id=$1`,
        [
          id(10),
          id(11),
          `sha256:${"a".repeat(64)}`,
          "2026-08-02T15:00:00.000Z",
          "2026-08-03T14:00:00.000Z",
        ],
      );
      let reads = 0;
      const runner = {
        async run(action) {
          const client = new Client({
            ...context.clientConfig,
            query_timeout: 5000,
            connectionTimeoutMillis: 2000,
          });
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL statement_timeout='5s'");
            assert.equal(
              (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
            reads++;
            await client.query("COMMIT");
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
            );
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const reader = createPostgresCartQueryStore(runner, scope);
      const legacy = await reader.load(id(1));
      assert.equal(legacy.lifecycle, null);
      assert.equal(legacy.createdAt, at);
      assert.equal(legacy.aggregateVersion, 1);
      assert.deepEqual(
        legacy.items.map((line) => line.cartItemReference),
        [id(5), id(6)],
      );
      assert.deepEqual(legacy.items[0].catalogSelectionEvidence, selection);
      assert.equal(legacy.items[0].customerNote, "Synthetic preparation note");
      assert.deepEqual(legacy.items[0].optionSelections, [{ optionReference: id(8), quantity: 1 }]);
      assert(Object.isFrozen(legacy) && Object.isFrozen(legacy.items));
      const configured = await reader.load(id(10));
      assert.equal(configured.lifecycle.status, "Active");
      assert.equal(configured.lifecycle.idleTimeoutSeconds, 3600);
      assert.equal(configured.lifecycle.absoluteExpiresAt, "2026-08-03T14:00:00.000Z");
      assert.deepEqual(configured.items, []);
      assert.equal(await reader.load(id(90)), null);
      for (const foreign of [
        { ...scope, brandReference: id(91) },
        { ...scope, storeReference: id(92) },
      ])
        assert.equal(await createPostgresCartQueryStore(runner, foreign).load(id(1)), null);
      assert.equal(reads, 5);
      assert.deepEqual(await reader.load(id(1)), legacy);
      await assert.rejects(
        runner.run(async (transaction) =>
          transaction.query("UPDATE rms_ordering.cart SET aggregate_version=2", []),
        ),
        (error) => ["25006", "42501"].includes(error.code),
      );
      assert.equal(
        (
          await admin.query("SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1", [
            id(1),
          ])
        ).rows[0].aggregate_version,
        1,
      );
      // WP-2230: immutable operation history is independent of the current aggregate.
      const snapshot = { ...legacy, aggregateVersion: 2 };
      await admin.query(
        `INSERT INTO rms_ordering.cart_operation_record
        (operation_id,brand_id,store_id,cart_id,cart_line_id,guest_session_id,action_code,
         intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'Add',$7,2,$8::jsonb,$9,$9::timestamptz + interval '24 hours')`,
        [
          id(30),
          id(2),
          id(3),
          id(1),
          id(5),
          id(4),
          `sha256:${"a".repeat(64)}`,
          JSON.stringify(snapshot),
          at,
        ],
      );
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=3 WHERE cart_id=$1", [
        id(1),
      ]);
      const operations = createPostgresCartItemOperationStore(runner, scope);
      const historical = await operations.resolveOperation(id(30));
      assert.deepEqual(historical.result, snapshot);
      const boundHistory = createPostgresBoundCartItemOperationStore(runner, {
        ...scope,
        cartReference: id(1),
        guestSessionReference: id(4),
      });
      assert.deepEqual(await boundHistory.resolveOperation(id(30)), historical);
      for (const mismatch of [{ cartReference: id(10) }, { guestSessionReference: id(99) }])
        await assert.rejects(
          createPostgresBoundCartItemOperationStore(runner, {
            ...scope,
            cartReference: id(1),
            guestSessionReference: id(4),
            ...mismatch,
          }).resolveOperation(id(30)),
          { code: "CART_IDEMPOTENCY_CONFLICT" },
        );
      assert.equal(historical.expiresAt, "2026-08-03T14:00:00.000Z");
      assert.equal((await reader.load(id(1))).aggregateVersion, 3);
      assert.deepEqual(
        await createPostgresCartItemOperationStore(runner, scope).resolveOperation(id(30)),
        historical,
      );
      assert.equal(await operations.resolveOperation(id(90)), null);
      for (const foreign of [
        { ...scope, brandReference: id(91) },
        { ...scope, storeReference: id(92) },
      ]) {
        assert.equal(
          await createPostgresCartItemOperationStore(runner, foreign).resolveOperation(id(30)),
          null,
        );
        await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [foreign.brandReference, foreign.storeReference],
          );
          // Omitting SQL scope predicates still cannot bypass forced RLS.
          assert.equal(
            (
              await transaction.query(
                "SELECT operation_id FROM rms_ordering.cart_operation_record WHERE operation_id=$1",
                [id(30)],
              )
            ).rows.length,
            0,
          );
        });
      }
      await assert.rejects(
        runner.run((transaction) =>
          transaction.query(
            "INSERT INTO rms_ordering.cart_operation_record SELECT * FROM rms_ordering.cart_operation_record",
            [],
          ),
        ),
        (error) => ["25006", "42501"].includes(error.code),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM rms_ordering.cart_operation_record",
          )
        ).rows[0].count,
        1,
      );
    } finally {
      await admin.end();
    }
  });
}, 120_000);

it("reads only one eligible shared Dining Cart under scoped read-only transactions", async () => {
  await withIsolatedDatabase({ caseId: "wp2314_cart_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2314_${context.runId}`;
    assert.match(role, /^wp2314_[a-f0-9]+$/u);
    const observedAt = "2026-08-02T14:01:00.000Z";
    let transactions = 0;
    let afterAggregateRead = null;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA platform_helpers,rms_ordering TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart,rms_ordering.cart_line TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      // Explicit synthetic owner rows: this exercises repository selection, not a creation command.
      async function seed(
        cartId,
        storeId = id(3),
        sessionId = id(40),
        idle = "2026-08-02T15:00:00.000Z",
        channel = "Qr",
      ) {
        await admin.query(
          `INSERT INTO rms_ordering.cart
     (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
     VALUES($1,$2,$3,'DineIn',$4,$5,$6,1,'2026-08-02T13:00:00Z','2026-08-02T13:00:00Z','Active',$7,$8,7200,86400,$9,'2026-08-03T13:00:00Z')`,
          [
            cartId,
            id(2),
            storeId,
            channel,
            sessionId,
            id(41),
            id(80),
            `sha256:${"a".repeat(64)}`,
            idle,
          ],
        );
      }
      await seed(id(30));
      await seed(id(32), id(99));
      await seed(id(33), id(3), id(90));
      await seed(id(34), id(3), id(40), "2026-08-02T14:00:00.000Z");
      await seed(id(36), id(3), id(40), undefined, "Pos");
      await admin.query(
        `INSERT INTO rms_ordering.cart(cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at) VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6)`,
        [id(35), id(2), id(3), id(40), id(41), at],
      );
      for (const [line, actor, participant] of [
        [61, 41, 51],
        [62, 42, 52],
      ]) {
        await admin.query(
          `INSERT INTO rms_ordering.cart_line(cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at) VALUES($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8)`,
          [id(line), id(30), id(2), id(3), id(70), id(actor), id(participant), at],
        );
      }
      await admin.query("UPDATE rms_ordering.cart SET updated_at=$2 WHERE cart_id=$1", [
        id(30),
        at,
      ]);
      const runner = {
        async run(action) {
          const client = new Client({
            ...context.clientConfig,
            connectionTimeoutMillis: 2000,
            query_timeout: 5000,
          });
          await client.connect();
          transactions++;
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL statement_timeout='5s'");
            assert.equal(
              (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const result = await action({
              query: async (sql, values) => {
                const result = await client.query(sql, [...values]);
                if (afterAggregateRead && sql.startsWith("SELECT jsonb_build_object(")) {
                  const inject = afterAggregateRead;
                  afterAggregateRead = null;
                  await inject();
                }
                return result;
              },
            });
            await client.query("COMMIT");
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
            );
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const reader = createPostgresDiningCartReadStore(runner, scope);
      const request = { ...scope, diningSessionReference: id(40), observedAt };
      assert.equal((await reader.current(request)).cartReference, id(30));
      assert.equal(transactions, 1);
      // WP-2321: command recovery reads bind the authorized session in the owner SQL,
      // including history excluded from the current display reader.
      const commandReader = createPostgresDiningCartCommandQueryStore(runner, {
        ...scope,
        diningSessionReference: id(40),
      });
      assert.equal((await commandReader.load(id(30))).items.length, 2);
      for (const reference of [32, 33, 36, 90])
        assert.equal(await commandReader.load(id(reference)), null);
      assert.equal(
        (await commandReader.load(id(34))).lifecycle.idleExpiresAt,
        "2026-08-02T14:00:00.000Z",
      );
      assert.equal((await commandReader.load(id(35))).lifecycle, null);
      assert.equal(
        await createPostgresDiningCartCommandQueryStore(runner, {
          ...scope,
          brandReference: id(99),
          diningSessionReference: id(40),
        }).load(id(30)),
        null,
      );
      assert.equal(await reader.current({ ...request, diningSessionReference: id(91) }), null);
      assert.equal(
        await reader.current({ ...request, observedAt: "2026-08-02T15:00:00.000Z" }),
        null,
      );
      for (const foreign of [
        { ...scope, brandReference: id(98) },
        { ...scope, storeReference: id(98) },
      ])
        assert.equal(
          await createPostgresDiningCartReadStore(runner, foreign).current({
            ...request,
            ...foreign,
          }),
          null,
        );
      // Identity and Dining ports below are bounded synthetic current-authority fixtures only.
      let allowed = true;
      let guestReads = 0;
      const service = (actor, participant) =>
        createDiningCartReadService({
          scope,
          now: () => observedAt,
          carts: reader,
          sessions: {
            resolve: async () => {
              guestReads++;
              return {
                sessionReference: id(actor),
                status: "Active",
                version: 1,
                brandReference: id(2),
                storeReference: id(3),
                publicStoreReference: id(81),
                publicTableReference: id(82),
                channel: "DineIn",
                locale: "en-CA",
                qrReference: id(83),
                qrRevocationVersion: 1,
                diningState: "DiningBound",
                diningSessionReference: id(40),
                diningParticipantReference: id(participant),
                createdAt: "2026-08-02T13:00:00.000Z",
                lastSeenAt: at,
                idleExpiresAt: "2026-08-02T18:00:00.000Z",
                absoluteExpiresAt: "2026-08-03T13:00:00.000Z",
                orderClosedAt: null,
                closureExpiresAt: null,
                rotatedFromGuestSessionReference: null,
                revocationReason: null,
                revokedAt: null,
              };
            },
          },
          participation: {
            resolve: async () =>
              allowed
                ? {
                    schemaVersion: 1,
                    brandReference: id(2),
                    storeReference: id(3),
                    diningSessionReference: id(40),
                    participantReference: id(participant),
                    tableReference: id(84),
                    tableAssignmentVersion: 1,
                    diningSessionVersion: 1,
                    participantVersion: 1,
                    observedAt,
                  }
                : null,
          },
        });
      const one = await service(41, 51).read({ sessionCredential: "a".repeat(43) });
      const two = await service(42, 52).read({ sessionCredential: "b".repeat(43) });
      assert.deepEqual(one.cart, two.cart);
      assert.equal(one.cart.createdByActorReference, id(41));
      assert.deepEqual(
        one.cart.items.map((line) => line.addedByParticipantReference),
        [id(51), id(52)],
      );
      assert.equal(guestReads, 8);
      const before = transactions;
      allowed = false;
      await assert.rejects(service(41, 51).read({ sessionCredential: "a".repeat(43) }), {
        code: "CART_PERMISSION_DENIED",
      });
      assert.equal(transactions, before);
      allowed = true;
      await seed(id(31));
      await assert.rejects(reader.current(request), { code: "CART_DEPENDENCY_UNAVAILABLE" });
      await admin.query(
        "UPDATE rms_ordering.cart SET lifecycle_status='Abandoned',terminal_at=$2,terminal_reason='CUSTOMER_ABANDONED',updated_at=$2,aggregate_version=2 WHERE cart_id=$1",
        [id(31), at],
      );
      assert.equal((await reader.current(request)).cartReference, id(30));
      // An administrative fixture injection changes the owner version between two read statements.
      assert.equal((await commandReader.load(id(31))).lifecycle.status, "Abandoned");
      afterAggregateRead = () =>
        admin.query(
          "UPDATE rms_ordering.cart SET aggregate_version=2,updated_at=$2 WHERE cart_id=$1",
          [id(30), observedAt],
        );
      await assert.rejects(reader.current(request), { code: "CART_DEPENDENCY_UNAVAILABLE" });
      assert.equal((await reader.current(request)).aggregateVersion, 2);
      await assert.rejects(
        runner.run((tx) => tx.query("UPDATE rms_ordering.cart SET aggregate_version=2", [])),
        (error) => ["25006", "42501"].includes(error.code),
      );
      assert.equal(
        (
          await admin.query("SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1", [
            id(30),
          ])
        ).rows[0].aggregate_version,
        2,
      );
    } finally {
      await admin.end();
    }
  });
});
