import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { afterEach, it, vi } from "vitest";
import { createDiningTable } from "../../rms/dining/src/index.ts";
import { createMerchantAllergens } from "../../../apps/api/src/merchant-allergens.ts";
import { createMerchantDiningSessionStart } from "../../../apps/api/src/merchant-dining-session-start.ts";
import { createMerchantDiningTables } from "../../../apps/api/src/merchant-dining-tables.ts";
import { refusalsStayReal } from "../../../apps/api/src/merchant-failure.ts";
import { createMerchantInventoryItems } from "../../../apps/api/src/merchant-inventory-items.ts";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createMerchantRequestReporter } from "../../../tooling/environment/pilot-unexpected.mjs";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client, Pool } = pg;
const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
const id = (n) => "01a7e500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tenant = id(3),
  brand = id(1),
  store = id(2);
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The application's own runner, as the restricted API role with the rendered pilot grants. */
async function restricted(context, admin) {
  const api = "wp2423_uf_" + context.runId,
    worker = "wp2423_uf_w_" + context.runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const root = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, { api, worker }));
  const pool = new Pool({
    ...context.clientConfig,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
  });
  const tenantRunner = createTenantTransactionRunner(pool, { brandId: brand, storeId: store });
  const asApi = (work) => async (tx) => {
    await tx.query("SET LOCAL ROLE " + api, []);
    return work(tx);
  };
  const runner = {
    run: (work) => tenantRunner.run(asApi(work)),
    runSnapshot: (work) => tenantRunner.runSnapshot(asApi(work)),
  };
  return { api, pool, runner };
}

async function seedTable(admin, reference, label, at) {
  const table = createDiningTable({
    tenantReference: tenant,
    brandReference: brand,
    storeReference: store,
    tableReference: reference,
    stableLabel: label,
    areaReference: id(0x3000),
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: at,
    observedAt: at,
  });
  await admin.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
    [reference, tenant, brand, store, JSON.stringify(table), at],
  );
}

/** A Brand-scope role (the seeded role is the Store's): catalog reads are decided at the Brand. */
async function grantBrandAction(admin, actor, action) {
  const from = new Date(Date.now() - 60_000).toISOString(),
    until = new Date(Date.now() + 3_600_000).toISOString();
  const membership = (
    await admin.query("SELECT membership_id FROM bop_membership.membership WHERE actor_id=$1", [
      actor,
    ])
  ).rows[0].membership_id;
  await admin.query(
    "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_brand_role','Active',$3,$4,1,$3,$3)",
    [id(0x900), brand, from, until],
  );
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
    [id(0x901), id(0x900), membership, actor, brand, from, until],
  );
  let permission = (
    await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
      [action],
    )
  ).rows[0]?.permission_id;
  if (!permission) {
    permission = id(0x910);
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
      [permission, action, from],
    );
  }
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [id(0x911), id(0x900), permission, brand, from, until],
  );
}

async function serve(options) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      exactOrigin: "https://merchant.invalid",
      acceptedHost: "merchant.invalid",
      onUnexpectedFailure: createMerchantRequestReporter({ store: "stores/acceptance" }),
      ...options,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const post = (path, session, body) =>
    new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        new URL("/merchant" + path, "http://127.0.0.1:" + server.address().port),
        {
          method: "POST",
          headers: {
            host: "merchant.invalid",
            origin: "https://merchant.invalid",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            "x-bop-csrf": session.csrf,
            cookie: "__Host-bop-merchant=" + session.sessionCookie,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
            }),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.end(JSON.stringify(body));
    });
  return { server, post };
}

const logLines = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    take() {
      const lines = spy.mock.calls.map(([line]) => JSON.parse(String(line)));
      spy.mockClear();
      return lines;
    },
  };
};

/**
 * WP-2423 item 10: "you have no permission" was the answer to any failure, and nothing was logged.
 * Real router and real services under a NOBYPASSRLS role holding the rendered pilot ACL minus one
 * SELECT, so PostgreSQL really refuses (42501) each read a merchant request makes in turn: the
 * session, the selected Store, the membership, the permission policy, the Store itself and the
 * business table. Each must answer 503 with a line naming the SQLSTATE, the table and the route,
 * and no message text; access stays closed. Before the fix each answered 403 and logged nothing.
 */
it("WP-2423 item 10: a read PostgreSQL refuses answers try again and is logged, whichever read it is", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_unexpected" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let harness;
    let listening;
    try {
      harness = await restricted(context, admin);
      const { api, runner } = harness;
      const honest = refusalsStayReal(runner);
      const at = new Date().toISOString();
      const now = () => new Date().toISOString();
      await seedTable(admin, id(0x1001), "T1", new Date(Date.now() - 3_600_000).toISOString());
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: honest,
        scope,
        actor: id(10),
        at,
        extraPermissions: ["dining.operate", "inventory.item.read"],
      });
      await grantBrandAction(admin, id(10), "catalog.allergen.read");
      const persistence = { ...session.persistence, transactions: honest, now };
      const diningTables = createMerchantDiningTables({
        persistence,
        authentication: session.authentication,
        tableAvailabilityCommandEnabled: true,
      });
      const inventoryItems = createMerchantInventoryItems({
        persistence,
        authentication: session.authentication,
        references: { next: () => id(0x5000) },
        locale: "en-CA",
      });
      const allergens = createMerchantAllergens({
        persistence,
        authentication: session.authentication,
        references: { next: () => id(0x5001) },
        locale: "en-CA",
      });
      const app = await serve({
        service: session.authentication,
        diningTables,
        inventoryItems,
        allergens,
      });
      listening = app.server;
      const query = { afterTableReference: null, limit: 100 };
      const lines = logLines();

      // The ordinary read works under these grants, and logs nothing.
      const fine = await app.post("/dining/tables", session, query);
      assert.equal(fine.status, 200);
      assert.equal(fine.body.items.length, 1);
      assert.deepEqual(lines.take(), []);

      // One grant out of the rendered pilot ACL, and back: the role holds it on the whole table.
      const withoutSelect = async (table, work) => {
        const held = await admin.query("SELECT has_table_privilege($1,$2,'SELECT') AS held", [
          api,
          table,
        ]);
        assert.equal(held.rows[0].held, true, table);
        await admin.query("REVOKE SELECT ON " + table + " FROM " + api);
        await work();
        await admin.query("GRANT SELECT ON " + table + " TO " + api);
      };
      for (const [table, name] of [
        ["bop_identity.authentication_session", "authentication_session"],
        ["bop_identity.browser_session_selection", "browser_session_selection"],
        ["bop_membership.membership", "membership"],
        ["bop_membership.store_assignment", "store_assignment"],
        ["bop_permission.policy_state", "policy_state"],
        ["bop_permission.role_assignment", "role_assignment"],
        ["bop_tenant.store", "store"],
        ["rms_dining.dining_table", "dining_table"],
      ]) {
        await withoutSelect(table, async () => {
          const failed = await app.post("/dining/tables", session, query);
          assert.equal(failed.status, 503, table + " answered " + failed.status);
          assert.equal(failed.headers["cache-control"], "no-store", table);
          assert.ok(failed.headers["retry-after"], table);
          assert.deepEqual(failed.body, { error: "retry_later" }, table);
          const logged = lines.take();
          assert.equal(logged.length, 1, table + " logged " + JSON.stringify(logged));
          const [line] = logged;
          assert.equal(line.event, "MERCHANT_REQUEST_UNEXPECTED", table);
          assert.equal(line.route, "/dining/tables", table);
          assert.equal(line.store, "stores/acceptance", table);
          assert.equal(line.sqlState, "42501", table + " " + JSON.stringify(line));
          assert.equal(line.table, name, table + " " + JSON.stringify(line));
          assert.ok(!JSON.stringify(line).includes("permission denied"), table);
        });
        // The grant is back: the next request works.
        assert.equal((await app.post("/dining/tables", session, query)).status, 200, table);
        lines.take();
      }

      // A service with its own typed answers: what it cannot read is not its PermissionDenied.
      const itemsQuery = {
        itemReference: null,
        search: null,
        lifecycle: null,
        afterInternalCode: null,
      };
      const items = await app.post("/supply/items/query", session, itemsQuery);
      assert.equal(items.status, 200, JSON.stringify(items.body));
      lines.take();
      for (const table of ["bop_membership.membership", "rms_inventory.inventory_item"])
        await withoutSelect(table, async () => {
          const typed = await app.post("/supply/items/query", session, itemsQuery);
          assert.equal(typed.status, 503, table + " " + JSON.stringify(typed.body));
          const [typedLine] = lines.take();
          assert.equal(typedLine.route, "/supply/items/query", table);
          assert.equal(typedLine.sqlState, "42501", table);
        });
      assert.equal((await app.post("/supply/items/query", session, itemsQuery)).status, 200);

      // And a catalog read, through its Brand scope.
      const catalogQuery = { itemReference: null };
      const catalog = await app.post("/compliance/allergens/query", session, catalogQuery);
      assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
      lines.take();
      await withoutSelect("rms_catalog.allergen_registry_version", async () => {
        const failed = await app.post("/compliance/allergens/query", session, catalogQuery);
        assert.equal(failed.status, 503, JSON.stringify(failed.body));
        const [line] = lines.take();
        assert.equal(line.route, "/compliance/allergens/query");
        assert.equal(line.sqlState, "42501");
        assert.equal(line.table, "allergen_registry_version");
      });
      lines.take();

      // A sign-in that has ended is a refusal on each of them, whatever rewrite it passes through:
      // these people are sent to sign in again, not told to try again for ever.
      await admin.query(
        "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='Logout',revoked_at=$1,version=version+1",
        [new Date().toISOString()],
      );
      for (const [path, body] of [
        ["/dining/tables", query],
        ["/supply/items/query", itemsQuery],
        ["/compliance/allergens/query", catalogQuery],
      ]) {
        const ended = await app.post(path, session, body);
        assert.equal(ended.status, 403, path + JSON.stringify(ended.body));
      }
      assert.deepEqual(lines.take(), []);
    } finally {
      await new Promise((resolve) => (listening ? listening.close(resolve) : resolve()));
      await harness?.pool.end();
      await admin.end();
    }
  });
});

/**
 * Real refusals stay refusals: someone whose role does not hold the permission, and a Store that has
 * been archived (a state, not an outage to wait out). Both 403, and neither logs a thing.
 */
it("WP-2423 item 10: a real refusal is still a refusal, and logs nothing", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_refusals" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let harness;
    let listening;
    try {
      harness = await restricted(context, admin);
      const honest = refusalsStayReal(harness.runner);
      const at = new Date().toISOString();
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: honest,
        scope,
        actor: id(10),
        at,
      });
      const diningTables = createMerchantDiningTables({
        persistence: {
          ...session.persistence,
          transactions: honest,
          now: () => new Date().toISOString(),
        },
        authentication: session.authentication,
        tableAvailabilityCommandEnabled: true,
      });
      const app = await serve({ service: session.authentication, diningTables });
      listening = app.server;
      const lines = logLines();
      const query = { afterTableReference: null, limit: 100 };
      const refused = await app.post("/dining/tables", session, query);
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.deepEqual(refused.body, { error: "request_denied" });
      assert.deepEqual(lines.take(), []);
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=version+1,updated_at=$2 WHERE store_id=$1",
        [store, new Date().toISOString()],
      );
      const archived = await app.post("/dining/tables", session, query);
      assert.equal(archived.status, 403, JSON.stringify(archived.body));
      assert.deepEqual(lines.take(), []);
    } finally {
      await new Promise((resolve) => (listening ? listening.close(resolve) : resolve()));
      await harness?.pool.end();
      await admin.end();
    }
  });
});

/**
 * Two servers open one table together. One opens it; the other is told the table changed (409) and
 * reads it again, rather than being told to press the button for ever or to check their permissions.
 * Nothing is logged: this is an ordinary Saturday.
 */
it("WP-2423 item 10: two servers open one table: the second gets changed, and a refreshed table", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_two_starts" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let harness;
    let listening;
    try {
      harness = await restricted(context, admin);
      const honest = refusalsStayReal(harness.runner);
      const at = new Date().toISOString();
      const table = id(0x1001);
      await seedTable(admin, table, "T1", new Date(Date.now() - 3_600_000).toISOString());
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: honest,
        scope,
        actor: id(10),
        at,
        extraPermissions: ["dining.operate"],
      });
      const persistence = {
        ...session.persistence,
        transactions: honest,
        now: () => new Date().toISOString(),
      };
      let next = 0x6000;
      const reference = () => id(next++);
      const digest = (value) => createHash("sha256").update(value).digest("hex");
      const credentials = {
        generateReference: reference,
        generateJoinCredential: (kind) =>
          kind === "HumanCode"
            ? String(100000 + next++)
            : Buffer.alloc(16, (next++ % 254) + 1).toString("base64url"),
        hashJoinCredential: (kind, value) =>
          createHmac("sha256", "synthetic-test-only-pepper")
            .update(`DiningJoin:${kind}:${value}`)
            .digest("hex"),
        hashOperationIntent: digest,
        equals: (a, b) => a === b,
      };
      const app = await serve({
        service: session.authentication,
        diningTables: createMerchantDiningTables({
          persistence,
          authentication: session.authentication,
          tableAvailabilityCommandEnabled: true,
        }),
        diningSessionStart: createMerchantDiningSessionStart({
          persistence,
          authentication: session.authentication,
          credentials,
          pepperVersion: 1,
          newReference: reference,
          retentionPolicyCode: "SYNTHETIC",
          retentionPolicyVersion: 1,
        }),
      });
      listening = app.server;
      const lines = logLines();
      const start = (operationReference) =>
        app.post("/dining/sessions/start", session, {
          tableReference: table,
          expectedAssignmentVersion: 1,
          operationReference,
          joinKind: "HumanCode",
        });
      const answers = await Promise.all([start(id(0x7001)), start(id(0x7002))]);
      const statuses = answers.map((answer) => answer.status).sort();
      assert.deepEqual(
        statuses,
        [200, 409],
        JSON.stringify([answers.map((a) => a.body), lines.take()]),
      );
      const lost = answers.find((answer) => answer.status === 409);
      assert.deepEqual(lost.body, { error: "changed_while_loading" });
      assert.deepEqual(lines.take(), []);
      // Reading again shows the party the other server seated.
      const read = await app.post("/dining/tables", session, {
        afterTableReference: null,
        limit: 100,
      });
      assert.equal(read.status, 200);
      assert.notEqual(read.body.items[0].currentDiningSessionReference, null);
    } finally {
      await new Promise((resolve) => (listening ? listening.close(resolve) : resolve()));
      await harness?.pool.end();
      await admin.end();
    }
  });
});
