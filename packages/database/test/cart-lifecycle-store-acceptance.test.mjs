import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createCartLifecycleCommandService,
  createPostgresCartLifecycleStore,
  createCustomerCartService,
  createPostgresCustomerCartStore,
} from "../../rms/ordering/src/index.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2223_${code}`);
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

it("persists Cart lifecycle with original replay, concurrency, immutable history and atomic Audit", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2223" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2223_${database.runId}`;
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
        `GRANT SELECT, INSERT ON rms_ordering.cart, rms_ordering.cart_customer_owner, rms_ordering.cart_creation_operation TO ${role}`,
      );
      await admin.query(`GRANT UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON rms_ordering.cart_line TO ${role}`,
      );
      await admin.query(`GRANT SELECT, INSERT ON rms_ordering.cart_operation_record TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON platform_audit.audit_record TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart_lifecycle_operation_record TO ${role}`,
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
                throw new Error("WP2223_ROLE_FAILED");
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
                throw new Error("WP2223_INJECTED_ROLLBACK");
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
      const hashIntent = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
      const repo = (store = 3, fail = false) =>
        createPostgresCartLifecycleStore({
          brandReference: id(2),
          storeReference: id(store),
          runner: runner(store, fail),
        });
      function life(session = guest(), repository = repo()) {
        return createCartLifecycleCommandService({
          repository,
          references: { hashIntent, equals: (a, b) => a === b },
          authorization: {
            async authorize(input) {
              return {
                guestSession: session,
                audit: {
                  auditId: id(next++),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "System" },
                  actionCode: `ORDERING_CART_${input.action.toUpperCase()}`,
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode:
                    input.action === "Abandon"
                      ? "AUTHORIZED_CART_ABANDONMENT"
                      : "CART_DEADLINE_REACHED",
                  correlationId: input.operationReference,
                  occurredAt: input.observedAt,
                  sourceChannel: input.action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
        });
      }
      const equal = (a, b) => check(JSON.stringify(a) === JSON.stringify(b), "EXACT_RESULT");
      async function counts() {
        return (
          await admin.query(
            `SELECT (SELECT count(*)::integer FROM rms_ordering.cart_lifecycle_operation_record) AS operations, (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`,
          )
        ).rows[0];
      }
      const abandonAt = "2026-08-02T14:01:00.000Z";
      const dueAt = "2026-08-02T15:00:00.000Z";
      const first = (await service().create(command(30))).aggregate;
      // Explicit synthetic historical Item/Quote rows test preservation; no real pricing claim.
      await admin.query(
        `INSERT INTO rms_ordering.cart_line (brand_id,store_id,cart_id,cart_line_id,sellable_id,quantity,option_selections_json,customer_note,added_by_actor_id,added_at) VALUES ($1,$2,$3,$4,$5,1,'[]',NULL,$6,$7)`,
        [id(2), id(3), first.cartReference, id(90), id(91), id(4), at],
      );
      await admin.query(
        `INSERT INTO rms_ordering.cart_quote_attachment (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,quote_id,quote_version,quote_input_digest,currency_code,currency_metadata_version,currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at) VALUES ($1,$2,$3,$4,1,$5,$6,$7,1,$6,'CAD',1,$8,100,0,0,0,100,1,'[]',$9,$10,$9,$11)`,
        [
          id(92),
          id(2),
          id(3),
          first.cartReference,
          id(4),
          hashIntent("synthetic"),
          id(93),
          id(94),
          at,
          dueAt,
          "2026-08-03T14:00:00.000Z",
        ],
      );
      const history = async () =>
        (
          await admin.query(
            `SELECT (SELECT jsonb_agg(to_jsonb(l)) FROM rms_ordering.cart_line l) AS lines, (SELECT jsonb_agg(to_jsonb(q)) FROM rms_ordering.cart_quote_attachment q) AS quotes`,
          )
        ).rows[0];
      const originalHistory = await history();
      const input = {
        cartReference: first.cartReference,
        expectedAggregateVersion: 1,
        operationReference: id(31),
        requestedAt: abandonAt,
      };
      phase = "CAPTURE_AUTHORIZED_TRANSITION";
      let candidate;
      await life(guest(), {
        ...repo(),
        commit: async (value) => {
          candidate = value;
          return value.record;
        },
      }).abandon(input);
      phase = "CONCURRENT_IDENTICAL_COMMIT";
      const duplicates = await Promise.all([repo().commit(candidate), repo().commit(candidate)]);
      equal(duplicates[0], duplicates[1]);
      equal(await counts(), { operations: 1, audits: 2 });
      equal(await history(), originalHistory);
      phase = "FRESH_REPLAY";
      const replay = await life().abandon(input);
      check(replay.status === "AlreadyApplied", "REPLAY_STATUS");
      equal(replay.aggregate, candidate.record.result);
      equal(await repo().load(first.cartReference), replay.aggregate);
      await denied(
        () =>
          repo().commit({
            ...candidate,
            record: { ...candidate.record, operationIntentHash: hashIntent("changed") },
          }),
        "CART_IDEMPOTENCY_CONFLICT",
      );
      await denied(() => life(guest(44)).abandon(input), "CART_PERMISSION_DENIED");
      await denied(
        () => life().abandon({ ...input, requestedAt: "2026-08-03T14:01:00.000Z" }),
        "CART_PERMISSION_DENIED",
      );
      await denied(
        () => life().abandon({ ...input, expectedAggregateVersion: 2, operationReference: id(32) }),
        "CART_ABANDONED",
      );
      phase = "SCOPE_AND_HISTORY";
      check((await repo(99).load(first.cartReference)) === null, "FOREIGN_CART");
      check((await repo(99).resolveOperation(id(31))) === null, "FOREIGN_OPERATION");
      await admin.query(
        `UPDATE rms_ordering.cart_lifecycle_operation_record SET intent_digest=$1 WHERE operation_id=$2`,
        [hashIntent("changed"), id(31)],
      );
      await admin.query(
        `DELETE FROM rms_ordering.cart_lifecycle_operation_record WHERE operation_id=$1`,
        [id(31)],
      );
      equal(await repo().resolveOperation(id(31)), candidate.record);
      const foreignRows = await runner(99).run((tx) =>
        tx.query("SELECT operation_id FROM rms_ordering.cart_lifecycle_operation_record", []),
      );
      check(foreignRows.rows.length === 0, "FORCED_RLS");
      phase = "EXPIRATION";
      const second = (await service(guest(45)).create(command(40))).aggregate;
      const expireInput = {
        cartReference: second.cartReference,
        expectedAggregateVersion: 1,
        operationReference: id(41),
        evaluatedAt: abandonAt,
      };
      await denied(() => life(null).expire(expireInput), "CART_EXPIRATION_NOT_DUE");
      await denied(
        () => life(guest()).expire({ ...expireInput, evaluatedAt: dueAt }),
        "CART_PERMISSION_DENIED",
      );
      const beforeFailure = await counts();
      phase = "AUDIT_ROLLBACK";
      await denied(
        () => life(null, repo(3, true)).expire({ ...expireInput, evaluatedAt: dueAt }),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      check(rolledBackAudit, "ROLLBACK_INJECTED");
      equal(await counts(), beforeFailure);
      equal(await repo().load(second.cartReference), second);
      phase = "DIFFERENT_OPERATION_RACE";
      let expiration;
      await life(null, {
        ...repo(),
        commit: async (value) => {
          expiration = value;
          return value.record;
        },
      }).expire({ ...expireInput, evaluatedAt: dueAt });
      const competitor = {
        ...expiration,
        record: {
          ...expiration.record,
          operationReference: id(42),
          operationIntentHash: hashIntent("different"),
        },
        audit: { ...expiration.audit, auditId: id(next++), correlationId: id(42) },
      };
      const raced = await Promise.allSettled([
        repo().commit(expiration),
        repo().commit(competitor),
      ]);
      check(raced.filter((value) => value.status === "fulfilled").length === 1, "ONE_RACE_WINNER");
      check(
        raced.find((value) => value.status === "rejected")?.reason?.code ===
          "CART_VERSION_CONFLICT",
        "RACE_VERSION_CONFLICT",
      );
      const expired = await repo().load(second.cartReference);
      check(
        expired.lifecycle.status === "Expired" &&
          expired.lifecycle.terminalReason === "IDLE_TIMEOUT" &&
          expired.aggregateVersion === 2,
        "EXPIRED_RESULT",
      );
      const winner = raced.find((value) => value.status === "fulfilled").value;
      await denied(
        () =>
          life(null).expire({
            ...expireInput,
            operationReference: winner.operationReference,
            evaluatedAt: "2026-08-03T15:00:00.000Z",
          }),
        "CART_IDEMPOTENCY_CONFLICT",
      );
      equal(await history(), originalHistory);
      equal(await counts(), { operations: 2, audits: 4 });
      phase = "CORRUPT_SNAPSHOT";
      const third = (await service(guest(46)).create(command(50))).aggregate;
      let bad;
      await life(guest(46), {
        ...repo(),
        commit: async (value) => {
          bad = value;
          return value.record;
        },
      }).abandon({ ...input, cartReference: third.cartReference, operationReference: id(51) });
      const beforeBad = await counts();
      await denied(
        () =>
          repo().commit({
            ...bad,
            record: { ...bad.record, result: { ...bad.record.result, sourceChannel: "Web" } },
          }),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      equal(await counts(), beforeBad);
      equal(await repo().load(third.cartReference), third);
    } catch (error) {
      if (/^WP2223_[A-Z_]+$/.test(error?.message ?? "")) throw error;
      check(false, `${phase}_FAILED`);
    } finally {
      await admin.query("ROLLBACK");
      await Promise.all(pools.map((pool) => pool.end()));
      try {
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
