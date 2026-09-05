import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createCartItemCommandService,
  createPostgresCartItemStore,
  createCustomerCartService,
  createPostgresCustomerCartStore,
} from "../../rms/ordering/src/index.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2218_${code}`);
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

it("persists Cart Item commands with original replay, CAS, scoped reads and atomic Audit", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2218" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2218_${database.runId}`;
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
                throw new Error("WP2218_ROLE_FAILED");
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
                throw new Error("WP2218_INJECTED_ROLLBACK");
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
      let validations = 0;
      function itemService(session = guest(), options = {}) {
        const repository = createPostgresCartItemStore({
          brandReference: session.brandReference,
          storeReference: session.storeReference,
          runner: runner(Number.parseInt(session.storeReference.slice(-12), 16), options.fail),
        });
        const service = createCartItemCommandService({
          repository: {
            ...repository,
            async resolveOperation(reference) {
              const result = await repository.resolveOperation(reference);
              if (options.operationBarrier) await options.operationBarrier();
              return result;
            },
          },
          authorization: {
            async authorize(input) {
              if (options.denied) return null;
              return {
                guestSession: session,
                audit: {
                  auditId: id(next++),
                  brandId: session.brandReference,
                  storeId: session.storeReference,
                  actor: { type: "System" },
                  actionCode: `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode: "AUTHORIZED_CART_MUTATION",
                  correlationId: input.operationReference,
                  occurredAt: input.observedAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          references: { generate: () => id(next++), hashIntent, equals: (a, b) => a === b },
          catalog: {
            async validateSelection(input) {
              validations++;
              if (options.barrier) await options.barrier();
              if (options.reject) return { status: "Rejected", reason: "SELLABLE_UNAVAILABLE" };
              if (options.unavailable) throw new Error("WP2218_SYNTHETIC_SOURCE_UNAVAILABLE");
              // Explicit synthetic public Catalog evidence, not a persisted Catalog or real Store fact.
              return {
                status: "Accepted",
                ...input,
                menuVersionReference: id(21),
                productVersionReference: id(22),
                catalogChannelCode: "SYNTHETIC_QR",
                catalogOrderTypeCode: "SYNTHETIC_ORDER_TYPE",
                ruleEvidence: [{ bindingReference: id(25), optionSetVersionReference: id(26) }],
                validatedAt: input.observedAt,
              };
            },
          },
        });
        return { service, repository };
      }
      function add(cart, operation, time = "2026-08-02T14:01:00.000Z") {
        return {
          cartReference: cart.cartReference,
          expectedAggregateVersion: cart.aggregateVersion,
          sellableReference: id(23),
          quantity: 2,
          optionSelections: [{ optionReference: id(24), quantity: 1 }],
          customerNote: "Synthetic napkins",
          operationReference: id(operation),
          requestedAt: time,
        };
      }
      function barrier() {
        let arrivals = 0;
        let release;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        return async () => {
          if (++arrivals === 2) release();
          await wait;
        };
      }
      async function counts() {
        return (
          await admin.query(`SELECT
          (SELECT count(*)::integer FROM rms_ordering.cart_line) AS lines,
          (SELECT count(*)::integer FROM rms_ordering.cart_operation_record) AS operations,
          (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      }
      const equal = (a, b, label) => check(JSON.stringify(a) === JSON.stringify(b), label);
      phase = "ADD_FRESH_READ";
      const cart = (await service().create(command(30))).aggregate;
      const firstService = itemService();
      const input = add(cart, 31);
      phase = "ADD_COMMAND";
      const added = await firstService.service.add(input);
      check(added.status === "Applied" && added.aggregate.aggregateVersion === 2, "ADD_RESULT");
      phase = "ADD_COUNTS";
      equal(await counts(), { lines: 1, operations: 1, audits: 2 }, "ADD_COUNTS");
      await Promise.all(pools.map((pool) => pool.end()));
      pools.length = 0;
      const fresh = itemService();
      phase = "FRESH_READ";
      equal(await fresh.repository.load(cart.cartReference), added.aggregate, "FRESH_READ");
      const original = await fresh.repository.resolveOperation(id(31));
      equal(original.result, added.aggregate, "DURABLE_OPERATION");
      check(
        Date.parse(original.expiresAt) - Date.parse(original.occurredAt) === 86_400_000,
        "RETENTION",
      );
      phase = "UPDATE_REMOVE_REPLAY";
      const update = {
        cartReference: cart.cartReference,
        cartItemReference: added.cartItemReference,
        expectedAggregateVersion: 2,
        quantity: 4,
        optionSelections: [],
        customerNote: null,
        operationReference: id(32),
        requestedAt: "2026-08-02T14:02:00.000Z",
      };
      const updated = await fresh.service.update(update);
      equal(
        await itemService().repository.load(cart.cartReference),
        updated.aggregate,
        "UPDATE_READ",
      );
      check(
        updated.aggregate.items[0].addedAt === added.aggregate.items[0].addedAt &&
          updated.aggregate.items[0].sellableReference === id(23) &&
          updated.aggregate.items[0].catalogSelectionEvidence.validatedAt === update.requestedAt,
        "ATTRIBUTION_EVIDENCE",
      );
      const remove = {
        cartReference: cart.cartReference,
        cartItemReference: added.cartItemReference,
        expectedAggregateVersion: 3,
        operationReference: id(33),
        requestedAt: "2026-08-02T14:03:00.000Z",
      };
      const removed = await fresh.service.remove(remove);
      equal(await fresh.repository.load(cart.cartReference), removed.aggregate, "REMOVE_READ");
      check(
        removed.aggregate.items.length === 0 && removed.aggregate.aggregateVersion === 4,
        "REMOVE_RESULT",
      );
      const beforeReplay = await counts();
      const validated = validations;
      for (const [method, request, result] of [
        ["add", input, added],
        ["update", update, updated],
        ["remove", remove, removed],
      ]) {
        equal(
          await itemService().service[method]({
            ...request,
            requestedAt: "2026-08-02T14:05:00.000Z",
          }),
          { ...result, status: "AlreadyApplied" },
          "DELAYED_ORIGINAL_REPLAY",
        );
      }
      equal(await counts(), beforeReplay, "REPLAY_DUPLICATED_WRITES");
      check(validations === validated, "REPLAY_REVALIDATED_CATALOG");
      await denied(() => fresh.service.add({ ...input, quantity: 3 }), "CART_IDEMPOTENCY_CONFLICT");
      await denied(
        () => fresh.service.add({ ...input, operationReference: id(34) }),
        "CART_VERSION_CONFLICT",
      );
      await denied(
        () => itemService(guest(), { denied: true }).service.add(input),
        "CART_PERMISSION_DENIED",
      );
      await denied(() => itemService(guest(40)).service.add(input), "CART_PERMISSION_DENIED");
      await denied(
        () => fresh.service.add({ ...input, requestedAt: "2026-08-03T14:01:00.000Z" }),
        "CART_PERMISSION_DENIED",
      );
      equal(await counts(), beforeReplay, "DENIAL_WRITES");
      phase = "CONCURRENT_SAME_KEY";
      const sync = barrier();
      const request = add(removed.aggregate, 35, "2026-08-02T14:06:00.000Z");
      const concurrent = await Promise.all([
        itemService(guest(), { barrier: sync }).service.add(request),
        itemService(guest(), { barrier: sync }).service.add({
          ...request,
          requestedAt: "2026-08-02T14:06:01.000Z",
        }),
      ]);
      equal(
        concurrent.map((r) => r.status).sort(),
        ["AlreadyApplied", "Applied"],
        "CONCURRENT_STATUS",
      );
      equal(concurrent[0].aggregate, concurrent[1].aggregate, "CONCURRENT_RESULT");
      check(concurrent[0].cartItemReference === concurrent[1].cartItemReference, "LOSING_ITEM_ID");
      equal(await counts(), { lines: 1, operations: 4, audits: 5 }, "CONCURRENT_DUPLICATES");
      phase = "CONCURRENT_CHANGED_INTENT";
      const syncChanged = barrier();
      const changedRequest = add(concurrent[0].aggregate, 36, "2026-08-02T14:07:00.000Z");
      const changed = await Promise.allSettled([
        itemService(guest(), { barrier: syncChanged }).service.add(changedRequest),
        itemService(guest(), { barrier: syncChanged }).service.add({
          ...changedRequest,
          quantity: 3,
        }),
      ]);
      check(
        changed.filter((r) => r.status === "fulfilled").length === 1 &&
          changed.some(
            (r) => r.status === "rejected" && r.reason?.code === "CART_IDEMPOTENCY_CONFLICT",
          ),
        "CHANGED_INTENT_WINNER",
      );
      phase = "CONCURRENT_VERSION";
      const live = await fresh.repository.load(cart.cartReference);
      const syncVersion = barrier();
      const contenders = await Promise.allSettled([
        itemService(guest(), { barrier: syncVersion }).service.add(
          add(live, 37, "2026-08-02T14:08:00.000Z"),
        ),
        itemService(guest(), { barrier: syncVersion }).service.add(
          add(live, 38, "2026-08-02T14:08:00.000Z"),
        ),
      ]);
      check(
        contenders.filter((r) => r.status === "fulfilled").length === 1 &&
          contenders.some(
            (r) => r.status === "rejected" && r.reason?.code === "CART_VERSION_CONFLICT",
          ),
        "CAS_WINNER",
      );
      phase = "CONCURRENT_UPDATE_REMOVE";
      for (const method of ["update", "remove"]) {
        const current = await fresh.repository.load(cart.cartReference);
        const before = await counts();
        const sync = barrier();
        const command = {
          cartReference: cart.cartReference,
          cartItemReference: current.items[0].cartItemReference,
          expectedAggregateVersion: current.aggregateVersion,
          operationReference: id(method === "update" ? 60 : 61),
          requestedAt:
            method === "update" ? "2026-08-02T14:08:30.000Z" : "2026-08-02T14:08:40.000Z",
          ...(method === "update" ? { quantity: 5, optionSelections: [], customerNote: null } : {}),
        };
        const results = await Promise.all([
          itemService(guest(), { operationBarrier: sync }).service[method](command),
          itemService(guest(), { operationBarrier: sync }).service[method](command),
        ]);
        equal(
          results.map((r) => r.status).sort(),
          ["AlreadyApplied", "Applied"],
          "ITEM_CONCURRENT_STATUS",
        );
        equal(results[0], { ...results[1], status: results[0].status }, "ITEM_CONCURRENT_RESULT");
        equal(
          await fresh.repository.load(cart.cartReference),
          results[0].aggregate,
          "ITEM_CONCURRENT_READ",
        );
        equal(
          await counts(),
          {
            lines: before.lines - (method === "remove" ? 1 : 0),
            operations: before.operations + 1,
            audits: before.audits + 1,
          },
          "ITEM_CONCURRENT_COUNTS",
        );
      }
      phase = "ATOMIC_ROLLBACK";
      const beforeFailure = await counts();
      const beforeCart = await fresh.repository.load(cart.cartReference);
      const failed = itemService(guest(), { fail: true });
      await denied(
        () => failed.service.add(add(beforeCart, 39, "2026-08-02T14:09:00.000Z")),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      const failUpdate = {
        ...update,
        cartItemReference: beforeCart.items[0].cartItemReference,
        expectedAggregateVersion: beforeCart.aggregateVersion,
        operationReference: id(41),
        requestedAt: "2026-08-02T14:09:00.000Z",
      };
      await denied(() => failed.service.update(failUpdate), "CART_DEPENDENCY_UNAVAILABLE");
      await denied(
        () =>
          failed.service.remove({
            ...remove,
            cartItemReference: beforeCart.items[0].cartItemReference,
            expectedAggregateVersion: beforeCart.aggregateVersion,
            operationReference: id(42),
            requestedAt: failUpdate.requestedAt,
          }),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      check(rolledBackAudit, "FAILURE_NOT_AFTER_AUDIT");
      equal(await counts(), beforeFailure, "PARTIAL_FAILURE_COUNTS");
      equal(await fresh.repository.load(cart.cartReference), beforeCart, "PARTIAL_CART_FAILURE");
      check(
        (await fresh.repository.resolveOperation(id(39))) === null,
        "PARTIAL_OPERATION_FAILURE",
      );
      phase = "CATALOG_DENIAL";
      await denied(
        () => itemService(guest(), { reject: true }).service.add(add(beforeCart, 43)),
        "CART_SELECTION_INVALID",
      );
      await denied(
        () => itemService(guest(), { unavailable: true }).service.add(add(beforeCart, 44)),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      equal(await counts(), beforeFailure, "CATALOG_DENIAL_WRITES");
      phase = "DINEIN_PARTICIPANT";
      const diningGuest = guest(50, 3, true);
      const diningCart = (await service(diningGuest).create(command(51))).aggregate;
      const diner = itemService(diningGuest);
      const diningItem = await diner.service.add(add(diningCart, 52));
      check(
        diningItem.aggregate.items[0].addedByParticipantReference ===
          diningGuest.diningParticipantReference,
        "PARTICIPANT_ATTRIBUTION",
      );
      const diningRemove = {
        cartReference: diningCart.cartReference,
        cartItemReference: diningItem.cartItemReference,
        expectedAggregateVersion: 2,
        operationReference: id(53),
        requestedAt: "2026-08-02T14:02:00.000Z",
      };
      await denied(
        () => itemService(guest(54, 3, true)).service.remove(diningRemove),
        "CART_PERMISSION_DENIED",
      );
      await denied(
        () =>
          itemService({
            ...diningGuest,
            diningState: "ContextOnly",
            diningSessionReference: null,
            diningParticipantReference: null,
          }).service.add(add(diningItem.aggregate, 55)),
        "CART_PERMISSION_DENIED",
      );
      check(
        (await diner.service.remove(diningRemove)).aggregate.items.length === 0,
        "OWN_ITEM_REMOVE",
      );
      phase = "RLS_AND_IMMUTABILITY";
      const foreign = itemService(guest(4, 70));
      check((await foreign.repository.load(cart.cartReference)) === null, "FOREIGN_CART_VISIBLE");
      check(
        (await foreign.repository.resolveOperation(id(31))) === null,
        "FOREIGN_OPERATION_VISIBLE",
      );
      await admin.query("BEGIN");
      await admin.query(`SET LOCAL ROLE ${role}`);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(2), id(70)],
      );
      for (const table of ["cart", "cart_line", "cart_operation_record"]) {
        check(
          (await admin.query(`SELECT * FROM rms_ordering.${table}`)).rowCount === 0,
          "RLS_READ_LEAK",
        );
      }
      await admin.query("SAVEPOINT foreign_write");
      let writeDenied = false;
      try {
        await admin.query(
          `INSERT INTO rms_ordering.cart_line
          (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at)
          VALUES ($1,$2,$3,$4,$5,1,'[]',$6,$7)`,
          [id(72), cart.cartReference, id(2), id(3), id(23), id(4), at],
        );
      } catch {
        writeDenied = true;
      }
      check(writeDenied, "RLS_WRITE_ALLOWED");
      await admin.query("ROLLBACK TO SAVEPOINT foreign_write");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(71), id(3)],
      );
      for (const table of ["cart", "cart_line", "cart_operation_record"]) {
        check(
          (await admin.query(`SELECT * FROM rms_ordering.${table}`)).rowCount === 0,
          "RLS_BRAND_LEAK",
        );
      }
      await admin.query("ROLLBACK");
      // Extra challenge-only grants prove immutable rules; the service ran without these grants.
      await admin.query(`GRANT UPDATE, DELETE ON rms_ordering.cart_operation_record TO ${role}`);
      await admin.query("BEGIN");
      await admin.query(`SET LOCAL ROLE ${role}`);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(2), id(3)],
      );
      check(
        (
          await admin.query(
            "UPDATE rms_ordering.cart_operation_record SET intent_digest=$1 WHERE operation_id=$2",
            [`sha256:${"b".repeat(64)}`, id(31)],
          )
        ).rowCount === 0,
        "MUTABLE_OPERATION",
      );
      check(
        (
          await admin.query(
            "DELETE FROM rms_ordering.cart_operation_record WHERE operation_id=$1",
            [id(31)],
          )
        ).rowCount === 0,
        "DELETABLE_OPERATION",
      );
      await admin.query("ROLLBACK");
      equal(await fresh.repository.resolveOperation(id(31)), original, "ORIGINAL_REWRITTEN");
    } catch {
      throw new Error(`WP2218_ACCEPTANCE_${phase}_FAILED`);
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
