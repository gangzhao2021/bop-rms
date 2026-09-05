import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createCustomerCartService,
  createPostgresCustomerCartStore,
} from "../../rms/ordering/src/index.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2216_${code}`);
}
async function denied(action, code) {
  let result;
  try {
    await action();
  } catch (error) {
    result = error?.code;
  }
  check(result === code, "EXPECTED_CONTROLLED_DENIAL");
}
function guest(session = 4, store = 3, dining = false) {
  return {
    sessionReference: id(session),
    status: "Active",
    version: 1,
    brandReference: id(2),
    storeReference: id(store),
    publicStoreReference: id(5),
    publicTableReference: dining ? id(6) : null,
    channel: dining ? "DineIn" : "Pickup",
    locale: "en-CA",
    qrReference: id(7),
    qrRevocationVersion: 1,
    diningState: dining ? "DiningBound" : "ContextOnly",
    diningSessionReference: dining ? id(8) : null,
    diningParticipantReference: dining ? id(session + 500) : null,
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
}
const command = (n) => ({ operationReference: id(n), requestedAt: at });

it("persists authorized Cart ownership and original results across pools with atomic audit, concurrency and denial", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2216" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2216_${database.runId}`;
    let roleCreated = false;
    let phase = "SETUP";
    let next = 1000;
    let rolledBackAudit = false;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_ordering, platform_helpers, platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON rms_ordering.cart, rms_ordering.cart_customer_owner, rms_ordering.cart_creation_operation TO ${role}`,
      );
      await admin.query(`GRANT SELECT ON rms_ordering.cart_line TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON platform_audit.audit_record TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      function runner(store = 3, fail = false) {
        const pool = new Pool({
          ...database.clientConfig,
          max: 4,
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        pools.push(pool);
        const base = createTenantTransactionRunner(
          {
            options: pool.options,
            async connect() {
              const client = await pool.connect();
              try {
                await client.query(`SET ROLE ${role}`);
                return client;
              } catch {
                client.release(true);
                throw new Error("WP2216_ROLE_FAILED");
              }
            },
          },
          { brandId: id(2), storeId: id(store) },
        );
        return {
          run(action) {
            return base.run(async (tx) => {
              let audited = false;
              const result = await action({
                async query(sql, values) {
                  const value = await tx.query(sql, values);
                  if (sql.startsWith("INSERT INTO platform_audit.audit_record")) audited = true;
                  return value;
                },
              });
              if (fail && audited) {
                rolledBackAudit = true;
                throw new Error("WP2216_INJECTED_ROLLBACK");
              }
              return result;
            });
          },
        };
      }
      function service(session = guest(), fail = false) {
        return createCustomerCartService({
          authorization: {
            async authorize() {
              return session;
            },
          },
          policy: {
            async resolve() {
              return {
                policyVersionReference: id(20),
                policyDigest: `sha256:${"a".repeat(64)}`,
                idleTimeoutSeconds: 3600,
                absoluteTimeoutSeconds: 86400,
                sourceChannel: "Qr",
              };
            },
          },
          references: {
            generate: () => id(next++),
            hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
          },
          audit: {
            async prepare(input) {
              return {
                auditId: id(next++),
                brandId: input.owner.brandReference,
                storeId: input.owner.storeReference,
                actor: { type: "System" },
                actionCode: "ORDERING_CART_CREATE",
                targetType: "OrderingCart",
                targetId: input.cartReference,
                reasonCode: "AUTHORIZED_CART_MUTATION",
                correlationId: input.operationReference,
                occurredAt: input.occurredAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              };
            },
          },
          repository: createPostgresCustomerCartStore({
            brandReference: session.brandReference,
            storeReference: session.storeReference,
            runner: runner(Number.parseInt(session.storeReference.slice(-12), 16), fail),
          }),
        });
      }
      async function counts() {
        const value = await admin.query(`SELECT
          (SELECT count(*)::integer FROM rms_ordering.cart) AS carts,
          (SELECT count(*)::integer FROM rms_ordering.cart_customer_owner) AS owners,
          (SELECT count(*)::integer FROM rms_ordering.cart_creation_operation) AS operations,
          (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`);
        return value.rows[0];
      }
      phase = "CONCURRENT_CREATE";
      const a = service();
      const b = service();
      check((await a.current({ requestedAt: at })).status === "NotFound", "READ_CREATED_CART");
      const results = await Promise.all([
        a.create(command(30)),
        b.create(command(30)),
        a.create(command(31)),
        b.create(command(32)),
      ]);
      check(new Set(results.map((r) => r.aggregate.cartReference)).size === 1, "DUPLICATE_CART");
      check(results.filter((r) => r.status === "Created").length === 1, "DUPLICATE_CREATION");
      check(results.filter((r) => r.status === "AlreadyApplied").length === 1, "MISSING_REPLAY");
      check(
        JSON.stringify(await counts()) ===
          JSON.stringify({ carts: 1, owners: 1, operations: 3, audits: 3 }),
        "ATOMIC_COUNTS",
      );
      const original = results[0].aggregate;
      phase = "FRESH_POOL";
      await Promise.all(pools.map((pool) => pool.end()));
      pools.length = 0;
      const fresh = service();
      check(
        JSON.stringify((await fresh.current({ requestedAt: at })).aggregate) ===
          JSON.stringify(original),
        "FRESH_READ",
      );
      check((await fresh.create(command(30))).status === "AlreadyApplied", "DURABLE_REPLAY");
      phase = "LIVE_CART";
      // Explicit synthetic state setup: this proves projection freshness, not a persisted Item command.
      await admin.query(
        `INSERT INTO rms_ordering.cart_line
        (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at,customer_note)
        VALUES ($1,$2,$3,$4,$5,2,'[]',$6,$7,'synthetic note')`,
        [id(60), original.cartReference, id(2), id(3), id(61), id(4), at],
      );
      await admin.query(`UPDATE rms_ordering.cart SET aggregate_version=2 WHERE cart_id=$1`, [
        original.cartReference,
      ]);
      const live = await fresh.current({ requestedAt: at });
      check(
        live.aggregate.aggregateVersion === 2 &&
          live.aggregate.items.length === 1 &&
          live.aggregate.items[0].quantity === 2,
        "STALE_CURRENT",
      );
      const replay = await fresh.create(command(30));
      check(
        replay.aggregate.aggregateVersion === 1 && replay.aggregate.items.length === 0,
        "REPLAY_REWRITTEN",
      );
      phase = "CONCURRENT_READ_SNAPSHOT";
      await admin.query("BEGIN");
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=3 WHERE cart_id=$1", [
        original.cartReference,
      ]);
      await admin.query("UPDATE rms_ordering.cart_line SET quantity=3 WHERE cart_id=$1", [
        original.cartReference,
      ]);
      const waitingRead = fresh.current({ requestedAt: at });
      // Observe the real database lock wait before releasing the writer; no timing-only assertion.
      let observedWait = false;
      for (let attempt = 0; attempt < 40 && !observedWait; attempt++) {
        observedWait = (
          await admin.query(
            `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()) AS waiting`,
          )
        ).rows[0].waiting;
        if (!observedWait) await delay(20);
      }
      await admin.query("COMMIT");
      const consistent = await waitingRead;
      check(observedWait, "READER_DID_NOT_WAIT_FOR_CART_LOCK");
      check(
        consistent.aggregate.aggregateVersion === 3 && consistent.aggregate.items[0].quantity === 3,
        "MIXED_CART_LINE_SNAPSHOT",
      );
      phase = "OWNER_ISOLATION";
      const other = service(guest(70));
      check((await other.current({ requestedAt: at })).status === "NotFound", "PICKUP_OWNER_LEAK");
      await denied(() => other.create(command(30)), "CART_IDEMPOTENCY_CONFLICT");
      await other.create(command(71));
      const otherStore = service(guest(4, 73));
      check((await otherStore.current({ requestedAt: at })).status === "NotFound", "STORE_LEAK");
      await otherStore.create(command(30));
      phase = "SHARED_DINING";
      const dining = await Promise.all([
        service(guest(80, 3, true)).create(command(81)),
        service(guest(82, 3, true)).create(command(83)),
      ]);
      check(
        dining[0].aggregate.cartReference === dining[1].aggregate.cartReference,
        "DINING_NOT_SHARED",
      );
      phase = "AUDIT_ROLLBACK";
      const before = await counts();
      const headsBefore = await admin.query(
        "SELECT next_sequence::text, encode(last_record_hash, 'hex') AS hash FROM platform_audit.audit_chain_head ORDER BY brand_id, store_id",
      );
      await denied(
        () => service(guest(90), true).create(command(91)),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      check(rolledBackAudit, "ROLLBACK_NOT_AFTER_AUDIT");
      const headsAfter = await admin.query(
        "SELECT next_sequence::text, encode(last_record_hash, 'hex') AS hash FROM platform_audit.audit_chain_head ORDER BY brand_id, store_id",
      );
      check(
        JSON.stringify(headsBefore.rows) === JSON.stringify(headsAfter.rows),
        "AUDIT_HEAD_NOT_ROLLED_BACK",
      );
      check(JSON.stringify(await counts()) === JSON.stringify(before), "PARTIAL_COMMIT");
      check(
        (await service(guest(90)).current({ requestedAt: at })).status === "NotFound",
        "ROLLED_BACK_OWNER_VISIBLE",
      );
      phase = "LEGACY_DENIAL";
      await admin.query(
        `INSERT INTO rms_ordering.cart
        (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at)
        VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5)`,
        [id(95), id(2), id(3), id(96), at],
      );
      await denied(() => service(guest(96)).create(command(97)), "CART_LIFECYCLE_UNAVAILABLE");
      phase = "RLS_AND_HISTORY";
      await admin.query(`SET ROLE ${role}`);
      check(
        (await admin.query(`SELECT * FROM rms_ordering.cart_customer_owner`)).rowCount === 0,
        "UNSCOPED_OWNER_LEAK",
      );
      check(
        (await admin.query(`SELECT * FROM rms_ordering.cart_creation_operation`)).rowCount === 0,
        "UNSCOPED_OPERATION_LEAK",
      );
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)",
        [id(2), id(3)],
      );
      check(
        (
          await admin.query(`SELECT * FROM rms_ordering.cart_customer_owner WHERE store_id=$1`, [
            id(73),
          ])
        ).rowCount === 0,
        "CROSS_STORE_OWNER_LEAK",
      );
      check(
        (
          await admin.query(
            `SELECT * FROM rms_ordering.cart_creation_operation WHERE store_id=$1`,
            [id(73)],
          )
        ).rowCount === 0,
        "CROSS_STORE_OPERATION_LEAK",
      );
      check(
        (await admin.query(`UPDATE rms_ordering.cart_customer_owner SET owner_id=$1`, [id(200)]))
          .rowCount === 0,
        "OWNER_MUTATED",
      );
      check(
        (await admin.query(`DELETE FROM rms_ordering.cart_customer_owner`)).rowCount === 0,
        "OWNER_DELETED",
      );
      check(
        (await admin.query(`UPDATE rms_ordering.cart_creation_operation SET outcome='Current'`))
          .rowCount === 0,
        "HISTORY_MUTATED",
      );
      check(
        (await admin.query(`DELETE FROM rms_ordering.cart_creation_operation`)).rowCount === 0,
        "HISTORY_DELETED",
      );
      await admin.query("SAVEPOINT cross_store_write");
      let crossStoreDenied = false;
      try {
        await admin.query(
          `INSERT INTO rms_ordering.cart_customer_owner (brand_id,store_id,order_type,owner_id,cart_id,created_at) VALUES ($1,$2,'Pickup',$3,$4,$5)`,
          [id(2), id(73), id(350), original.cartReference, at],
        );
      } catch (error) {
        crossStoreDenied = error?.code === "42501";
      }
      check(crossStoreDenied, "CROSS_STORE_WRITE_ACCEPTED");
      await admin.query("ROLLBACK TO SAVEPOINT cross_store_write");
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      phase = "CONSTRAINTS";
      let constraintDenied = false;
      try {
        await admin.query(
          `INSERT INTO rms_ordering.cart_creation_operation
        SELECT brand_id,store_id,$1,operation_intent_hash,guest_session_id,order_type,owner_id,cart_id,outcome,result_json,occurred_at,occurred_at
        FROM rms_ordering.cart_creation_operation LIMIT 1`,
          [id(300)],
        );
      } catch {
        constraintDenied = true;
      }
      check(constraintDenied, "INVALID_RETENTION_ACCEPTED");
      let ownerMismatchDenied = false;
      try {
        await admin.query(
          `INSERT INTO rms_ordering.cart_creation_operation
          SELECT brand_id,store_id,$1,operation_intent_hash,guest_session_id,order_type,$2,cart_id,outcome,result_json,occurred_at,expires_at
          FROM rms_ordering.cart_creation_operation WHERE operation_id=$3 AND store_id=$4`,
          [id(301), id(70), id(30), id(3)],
        );
      } catch (error) {
        ownerMismatchDenied = error?.code === "23503";
      }
      check(ownerMismatchDenied, "OWNER_CART_MISMATCH_ACCEPTED");
    } catch {
      throw new Error(`WP2216_ACCEPTANCE_${phase}_FAILED`);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      try {
        await admin.query("ROLLBACK");
        await admin.query("RESET ROLE");
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await admin.end();
      }
    }
  });
});
