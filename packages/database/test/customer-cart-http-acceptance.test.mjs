import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import { createPostgresCustomerCartStore } from "../../rms/ordering/src/index.ts";
import { createCustomerCartComposition } from "../../../apps/api/src/customer-cart-composition.ts";
import { CustomerCartHandler } from "../../../apps/api/src/customer-cart.ts";
import { createApiServerRuntime, createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client, Pool } = pg;
const id = (n) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2217_${code}`);
}
it("connects real Identity authorization and Cart services through HTTP to isolated PostgreSQL", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2217" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2217_${database.runId}`;
    const logs = [];
    let runtime;
    let roleCreated = false;
    let phase = "SETUP";
    let sequence = 100;
    let observedAt = at;
    let bindingCurrent = true;
    let displayAvailable = true;
    let rollback = false;
    let rollbackObserved = false;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA bop_identity, rms_ordering, platform_helpers, platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${role}`,
      );
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart_line TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart_customer_owner, rms_ordering.cart_creation_operation, platform_audit.audit_record TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      function runner(failAfterAudit = false) {
        const pool = new Pool({
          ...database.clientConfig,
          max: 2,
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
                throw new Error("WP2217_ROLE_FAILED");
              }
            },
          },
          { brandId: id(1), storeId: id(2) },
        );
        return {
          run(action) {
            return base.run(async (tx) => {
              let audited = false;
              const result = await action({
                async query(sql, values) {
                  const answer = await tx.query(sql, values);
                  if (sql.startsWith("INSERT INTO platform_audit.audit_record")) audited = true;
                  return answer;
                },
              });
              if (failAfterAudit && audited) {
                rollbackObserved = true;
                throw new Error("WP2217_INJECTED_ROLLBACK");
              }
              return result;
            });
          },
        };
      }
      const key = randomBytes(32);
      const credentials = createGuestSessionCredentialProvider(key);
      key.fill(0);
      const scope = { brandReference: id(1), storeReference: id(2) };
      function sessionService() {
        return new GuestSessionService({
          credentials,
          store: createPostgresGuestSessionEntryStore(runner(), scope),
          binding: {
            async validate() {
              return bindingCurrent ? "Current" : "Unavailable";
            },
          },
          admission: {
            async consume(command) {
              return {
                decision: "Allowed",
                evidenceReference: id(5),
                entryRequestReference: command.entryRequestReference,
                ...scope,
                publicStoreReference: id(3),
                publicTableReference: null,
                channel: "Pickup",
                locale: "en-CA",
                qrReference: id(4),
                qrRevocationVersion: 1,
                evaluatedAt: at,
                validUntil: "2026-08-02T14:01:00.000Z",
              };
            },
          },
          now: () => observedAt,
        });
      }
      const issuing = sessionService();
      const first = await issuing.create({
        entryRequestReference: id(10),
        operationReference: id(11),
        requestedAt: at,
      });
      const second = await issuing.create({
        entryRequestReference: id(12),
        operationReference: id(13),
        requestedAt: at,
      });
      check(first.status === "Issued" && second.status === "Issued", "SESSION_NOT_ISSUED");
      // Fresh Identity pool, real credential verifier, and per-request Ordering pools.
      const composition = createCustomerCartComposition({
        session: sessionService(),
        ordering(session) {
          check(
            session.brandReference === scope.brandReference &&
              session.storeReference === scope.storeReference,
            "SCOPE_DRIFT",
          );
          return {
            repository: createPostgresCustomerCartStore({ ...scope, runner: runner(rollback) }),
            references: {
              generate: () => id(sequence++),
              hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
            },
            policy: {
              async resolve() {
                return {
                  policyVersionReference: id(6),
                  policyDigest: `sha256:${"a".repeat(64)}`,
                  idleTimeoutSeconds: 3600,
                  absoluteTimeoutSeconds: 86400,
                  sourceChannel: "Qr",
                };
              },
            },
            audit: {
              async prepare(input) {
                return {
                  auditId: id(sequence++),
                  brandId: scope.brandReference,
                  storeId: scope.storeReference,
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
          };
        },
        display: {
          async resolve(request) {
            return displayAvailable
              ? {
                  ...request,
                  brandName: "Synthetic Brand",
                  storeName: "Synthetic Store",
                  serviceMode: request.orderType,
                }
              : null;
          },
        },
      });
      const origin = "https://customer.invalid";
      runtime = createApiServerRuntime({
        port: 0,
        host: "127.0.0.1",
        logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
        customerCart: new CustomerCartHandler({
          port: composition,
          allowedOrigin: origin,
          now: () => observedAt,
        }),
      });
      await runtime.listen();
      const address = runtime.server.address();
      check(address !== null && typeof address === "object", "LISTENER_UNAVAILABLE");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = (session) => ({
        cookie: `__Host-bop-guest=${session.sessionCredential}`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      });
      async function request(path, session = first, mutation = false, overrides = {}) {
        const response = await globalThis.fetch(base + path, {
          method: mutation ? "POST" : "GET",
          headers: {
            ...headers(session),
            ...(mutation
              ? {
                  origin,
                  "content-type": "application/json",
                  "x-csrf-token": session.csrfCredential,
                  "idempotency-key": id(20),
                }
              : {}),
            ...overrides,
          },
          ...(mutation ? { body: "{}" } : {}),
          signal: globalThis.AbortSignal.timeout(5000),
        });
        const text = await response.text();
        check(response.headers.get("cache-control") === "no-store", "CACHEABLE_RESPONSE");
        for (const secret of [
          first.sessionCredential,
          first.csrfCredential,
          second.sessionCredential,
          second.csrfCredential,
          "brandReference",
          "policyDigest",
          "operationIntentHash",
          "createdByActorReference",
        ])
          check(!text.includes(secret), "PRIVATE_RESPONSE");
        return { response, body: JSON.parse(text) };
      }
      async function counts() {
        return (
          await admin.query(
            `SELECT (SELECT count(*)::integer FROM rms_ordering.cart) AS carts, (SELECT count(*)::integer FROM rms_ordering.cart_creation_operation) AS operations, (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`,
          )
        ).rows[0];
      }
      phase = "CREATE_REPLAY";
      check((await request("/bff/customer/cart")).response.status === 404, "READ_CREATED_CART");
      const created = await request("/api/v1/carts", first, true);
      check(
        created.response.status === 201 && created.body.cart.items.length === 0,
        "CREATE_FAILED",
      );
      const cartId = created.body.cart.cartReference;
      check(created.response.headers.get("etag") === '"1"', "VERSION_MISSING");
      observedAt = "2026-08-02T14:01:00.000Z";
      const read = await request("/bff/customer/cart");
      check(
        read.response.status === 200 && read.body.cart.cartReference === cartId,
        "PERSISTED_READ_FAILED",
      );
      check(
        (await request(`/api/v1/carts/${cartId}`)).response.status === 200,
        "REFERENCE_READ_FAILED",
      );
      const replay = await request("/api/v1/carts", first, true);
      check(
        replay.response.status === 200 &&
          JSON.stringify(replay.body) === JSON.stringify(created.body),
        "REPLAY_CHANGED",
      );
      check(
        JSON.stringify(await counts()) === JSON.stringify({ carts: 1, operations: 1, audits: 1 }),
        "REPLAY_DUPLICATED_WRITE",
      );
      check(
        (
          await admin.query(
            "SELECT version FROM bop_identity.guest_session WHERE guest_session_id=$1",
            [first.session.sessionReference],
          )
        ).rows[0].version === 1,
        "READ_RENEWED_SESSION",
      );
      phase = "DENIALS";
      check(
        (await request("/api/v1/carts", first, true, { "x-csrf-token": "x".repeat(43) })).response
          .status === 401,
        "CSRF_ACCEPTED",
      );
      check(
        (await request("/api/v1/carts", first, true, { origin: "https://other.invalid" })).response
          .status === 400,
        "ORIGIN_ACCEPTED",
      );
      check(
        (
          await request("/bff/customer/cart", first, false, {
            cookie: `__Host-bop-guest=${"x".repeat(43)}`,
          })
        ).response.status === 401,
        "COOKIE_ACCEPTED",
      );
      check(
        (await request(`/api/v1/carts/${cartId}`, second)).response.status === 404,
        "FOREIGN_CART_LEAK",
      );
      check(
        (await request("/api/v1/carts", second, true)).response.status === 409,
        "FOREIGN_REPLAY_ACCEPTED",
      );
      bindingCurrent = false;
      check(
        (await request("/api/v1/carts", first, true)).response.status === 401,
        "REVOKED_BINDING_REPLAY",
      );
      bindingCurrent = true;
      displayAvailable = false;
      check(
        (await request("/api/v1/carts", second, true, { "idempotency-key": id(21) })).response
          .status === 503,
        "MISSING_DISPLAY_SUCCEEDED",
      );
      displayAvailable = true;
      phase = "ROLLBACK";
      rollback = true;
      check(
        (await request("/api/v1/carts", second, true, { "idempotency-key": id(21) })).response
          .status === 503,
        "FAILED_WRITE_SUCCEEDED",
      );
      check(rollbackObserved, "FAILURE_NOT_AFTER_AUDIT");
      check(
        JSON.stringify(await counts()) === JSON.stringify({ carts: 1, operations: 1, audits: 1 }),
        "PARTIAL_COMMIT",
      );
      rollback = false;
      phase = "CONCURRENT_RETRY";
      const concurrent = await Promise.all([
        request("/api/v1/carts", second, true, { "idempotency-key": id(21) }),
        request("/api/v1/carts", second, true, { "idempotency-key": id(21) }),
      ]);
      check(
        concurrent
          .map((r) => r.response.status)
          .sort()
          .join(",") === "200,201",
        "CONCURRENT_RETRY_FAILED",
      );
      check(
        JSON.stringify(await counts()) === JSON.stringify({ carts: 2, operations: 2, audits: 2 }),
        "CONCURRENT_DUPLICATE",
      );
      for (const secret of [
        first.sessionCredential,
        first.csrfCredential,
        second.sessionCredential,
        second.csrfCredential,
        cartId,
        first.session.sessionReference,
      ])
        check(
          logs.every((line) => !line.includes(secret)),
          "PRIVATE_LOG",
        );
    } catch {
      throw new Error(`WP2217_HTTP_${phase}_FAILED`);
    } finally {
      if (runtime) await runtime.shutdown("SIGTERM");
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
