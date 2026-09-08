import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import {
  fixture,
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };
const digest = `sha256:${"a".repeat(64)}`;
const optionRules = [];
it("composes scoped persisted entry and menu through one restartable loopback runtime", async () => {
  await withIsolatedDatabase({ caseId: "wp2221_runtime" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const pool = new Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    const sessionRole = `wp2221_s_${context.runId}`;
    const menuRole = `wp2221_m_${context.runId}`;
    const f = fixture();
    const key = randomBytes(32);
    const credentials = createGuestSessionCredentialProvider(key);
    const logs = [];
    const secrets = [key.toString("hex"), key.toString("base64"), f.token()];
    let runtime;
    let sequence = 600;
    let entryFault = false;
    let menuFault = false;
    let reads = 0;
    let writes = 0;
    await admin.connect();
    try {
      for (const role of [sessionRole, menuRole]) {
        assert.match(role, /^wp2221_[sm]_[a-f0-9]+$/u);
        await admin.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        await admin.query(`GRANT USAGE ON SCHEMA platform_helpers TO ${role}`);
        await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
        );
      }
      await admin.query(`GRANT USAGE ON SCHEMA bop_identity TO ${sessionRole}`);
      await admin.query(
        `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${sessionRole}`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_catalog TO ${menuRole}`);
      await admin.query(
        `GRANT SELECT ON rms_catalog.published_menu_projection_generation, rms_catalog.published_menu_projection, rms_catalog.published_menu_projection_section, rms_catalog.published_menu_projection_sellable, rms_catalog.published_menu_projection_checkpoint TO ${menuRole}`,
      );
      await seedMenu(admin);
      const sessionRunner = createTenantTransactionRunner(
        {
          options: pool.options,
          async connect() {
            const client = await pool.connect();
            try {
              await client.query(`SET ROLE ${sessionRole}`);
              return client;
            } catch (error) {
              client.release(true);
              throw error;
            }
          },
        },
        { brandId: scope.brandReference, storeId: scope.storeReference },
      );
      const sessionTransactions = {
        async run(action) {
          writes++;
          if (entryFault) throw new Error("synthetic_session_driver_fault");
          return sessionRunner.run(action);
        },
      };
      const menuTransactions = {
        async run(action) {
          reads++;
          if (menuFault) throw new Error("synthetic_menu_driver_fault");
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${menuRole}`);
            await client.query("SET LOCAL statement_timeout='5s'");
            assert.equal(
              (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand, current_setting('bop.store_id',true) AS store",
            );
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const options = {
        scope,
        entry: { ...f.options, session: { binding: f.options.session.binding, credentials } },
        menuStores: {
          resolvePublic: async (reference) =>
            reference === id(4) ? { ...scope, status: "Active" } : null,
        },
        sessionTransactions,
        menuTransactions,
        allowedOrigin: "https://customer.invalid",
        now: () => at,
        uuidV7Factory: () => id(++sequence),
        runtime: { logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }) },
      };
      const start = async () => {
        runtime = createLocalCustomerRuntime(options);
        await runtime.listen();
        const address = runtime.server.address();
        assert(address && typeof address === "object" && address.address === "127.0.0.1");
        return `http://127.0.0.1:${address.port}`;
      };
      let root = await start();
      const entry = (overrides = {}, qrToken = secrets[2]) =>
        globalThis.fetch(`${root}/bff/customer/entry`, {
          method: "POST",
          headers: {
            origin: options.allowedOrigin,
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            ...overrides,
          },
          body: JSON.stringify({ qrToken }),
        });
      const menu = (publicStore = id(4)) =>
        globalThis.fetch(
          `${root}/api/v1/public/stores/${publicStore}/menu?channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA`,
        );
      for (const response of [
        await entry({ origin: "https://wrong.invalid" }),
        await entry({}, "bad-qr"),
      ]) {
        assert.equal(response.status, 400);
        await response.text();
      }
      assert.equal(writes, 0);
      const issued = await entry();
      assert.equal(issued.status, 201);
      const body = await issued.json();
      const cookie = issued.headers.get("set-cookie");
      assert.match(cookie, /^__Host-bop-guest=/u);
      assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/u);
      const sessionCredential = cookie.split(";")[0].split("=")[1];
      const selector = credentials.hashCredential("Session", sessionCredential);
      secrets.push(sessionCredential, body.csrfToken, selector);
      assert.equal(f.records.size, 0);
      const sessionStore = createPostgresGuestSessionEntryStore(sessionRunner, scope);
      const record = await sessionStore.resolve(selector);
      assert(record);
      assert.equal(record.session.diningState, "ContextOnly");
      assert.equal(record.session.storeReference, scope.storeReference);
      assert(!JSON.stringify(record).includes(sessionCredential));
      assert(!JSON.stringify(record).includes(body.csrfToken));
      const found = await menu(body.publicStoreReference);
      assert.equal(found.status, 200);
      const publicMenu = await found.json();
      assert.equal(publicMenu.menu.sections[0].sellables[0].name, "Latte");
      assert.equal(publicMenu.menu.sections[0].sellables[0].displayPrice.status, "Unavailable");
      assert.equal(publicMenu.scope.publicStoreReference, id(4));
      const beforeUnknown = reads;
      const unknown = await menu(id(99));
      assert.equal(unknown.status, 404);
      await unknown.text();
      assert.equal(reads, beforeUnknown);
      entryFault = true;
      const denied = await entry();
      assert.equal(denied.status, 422);
      await denied.text();
      entryFault = false;
      assert.equal(
        (await admin.query("SELECT count(*)::int AS count FROM bop_identity.guest_session")).rows[0]
          .count,
        1,
      );
      menuFault = true;
      const unavailable = await menu();
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get("retry-after"), "5");
      assert.deepEqual(await unavailable.json(), {
        schemaVersion: 1,
        error: {
          code: "menu_service_unavailable",
          messageKey: "customer.menu.service_unavailable",
        },
      });
      menuFault = false;
      await runtime.shutdown("SIGTERM");
      assert.equal(runtime.server.listening, false);
      root = await start();
      const afterRestart = await menu();
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(await afterRestart.json(), publicMenu);
      const recreated = new GuestSessionService({
        ...options.entry.session,
        credentials: createGuestSessionCredentialProvider(key),
        store: createPostgresGuestSessionEntryStore(sessionRunner, scope),
        admission: { consume: async () => null },
      });
      assert.deepEqual(
        await recreated.authorize({
          sessionCredential,
          csrfCredential: body.csrfToken,
          observedAt: at,
        }),
        record.session,
      );
      const ready = await globalThis.fetch(`${root}/ready`);
      assert.equal(ready.status, 503);
      await ready.text();
      await runtime.shutdown("SIGTERM");
      assert.equal(runtime.server.listening, false);
      assert(logs.length > 0);
      for (const line of logs) assert.equal(typeof JSON.parse(line), "object");
      for (const forbidden of [
        ...secrets,
        "synthetic_session_driver_fault",
        "synthetic_menu_driver_fault",
        "rms_catalog.",
        "bop_identity.",
      ])
        assert(
          !logs.join("").includes(forbidden),
          "logs must exclude credentials, selectors and driver details",
        );
    } finally {
      try {
        if (runtime) await runtime.shutdown("SIGTERM");
      } finally {
        try {
          await pool.end();
        } finally {
          await admin.end();
        }
      }
      key.fill(0);
    }
  });
}, 120_000);

async function seedMenu(admin) {
  await admin.query(
    `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
    [id(1), scope.brandReference, at, id(3)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
    [id(4), id(1), scope.brandReference, at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
    [id(5), id(1), id(4), scope.brandReference, digest, id(6), id(7), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
    [id(8), id(5), id(1), id(4), scope.brandReference, digest, at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
    [id(9), scope.brandReference, id(1), id(10), at],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,'UTC',$7)`,
    [
      id(9),
      scope.brandReference,
      id(1),
      id(4),
      id(8),
      digest,
      at,
      JSON.stringify([scope.storeReference]),
    ],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
    [id(9), scope.brandReference, id(1), id(11)],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Latte"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
    [
      id(9),
      scope.brandReference,
      id(1),
      id(11),
      id(12),
      id(13),
      id(14),
      JSON.stringify(optionRules),
    ],
  );
  await admin.query(
    `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
    [scope.brandReference, id(1), id(9), id(10), at],
  );
}
