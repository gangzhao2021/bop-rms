import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { startCognitoTestProvider } from "../../../tooling/environment/cognito-test-provider.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalMerchantCognitoSession } from "../../../tooling/environment/pilot-merchant-cognito-session.mjs";
import {
  createServedStoreTarget,
  servedStoresOf,
} from "../../../tooling/environment/pilot-served-stores.mjs";
import {
  MerchantOpeningError,
  merchantOpeningReferences,
  recordMerchantFirstContent,
  recordMerchantOpening,
} from "../../../apps/api/dist/merchant-opening.js";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const id = (n) => "018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const merchantA = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const merchantB = { tenantReference: id(11), brandReference: id(12), storeReference: id(13) };
const staffA = id(21),
  staffB = id(22),
  both = id(23);
const sessionOf = (actorReference) => ({ actor: { actorReference } });

/**
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION A3: the first merchant's composition answers a sign-in. Each
 * person reaches their own merchant's Store only, checked as the restricted API role.
 */
it("a merchant's staff sign in to their own merchant and never reach another's Store", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_merchants" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_mm_" + context.runId,
      worker = "wp2423_mm_w_" + context.runId;
    const fake = await startCognitoTestProvider({ pool: "ca-central-1_Synthetic" });
    let session = null;
    try {
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
      let next = 100;
      const assign = async (actor, scope) => {
        const membership = id(next++);
        await admin.query(
          `INSERT INTO bop_membership.membership
            (membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,
             effective_from,effective_until,version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,'Active',now()-interval '1 day',NULL,1,now(),now())`,
          [membership, actor, scope.brandReference, id(next++)],
        );
        await admin.query(
          `INSERT INTO bop_membership.store_assignment
            (assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,
             effective_from,effective_until,version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'Active',now()-interval '1 day',NULL,1,now(),now())`,
          [id(next++), membership, actor, scope.brandReference, scope.storeReference],
        );
      };
      await assign(staffA, merchantA);
      await assign(staffB, merchantB);
      await assign(both, merchantA);
      await assign(both, merchantB);

      const resources = {
        now: () => new Date().toISOString(),
        transactions: { run: async () => undefined },
        credentials: { reference: () => id(next++) },
        publicProfile: { binding: { tenantReference: merchantA.tenantReference } },
        scope: {
          brandReference: merchantA.brandReference,
          storeReference: merchantA.storeReference,
        },
        servedStores: [merchantB],
      };
      session = await createInternalMerchantCognitoSession(resources, {
        signIn: {
          mode: "cognito",
          environment: "InternalTest",
          exactOrigin: "https://127.0.0.1:4443",
          acceptedHost: "127.0.0.1:4443",
          cognito: {
            environment: "bop-pilot",
            issuer: fake.issuer,
            clientId: fake.clientId,
            clientSecret: fake.clientSecret,
            managedLoginOrigin: fake.managedLoginOrigin,
          },
          staffPinKeys: {
            pepper: Buffer.alloc(32, 1),
            device: Buffer.alloc(32, 2),
            choice: Buffer.alloc(32, 3),
          },
          testProvider: { origin: fake.origin, browserOrigin: null },
        },
        createInternalMerchantCredentials: async () => ({
          hasher: {
            hash: (value) => createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
          },
          envelopes: { encrypt: async () => ({}), decrypt: async () => "" },
        }),
      });
      const target = createServedStoreTarget({
        served: servedStoresOf(resources),
        validateAssociation: session.validateAssociation,
        now: resources.now,
      });
      const restricted = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + api);
          await admin.query("SET LOCAL statement_timeout = '5s'");
          return await work(admin);
        } finally {
          await admin.query("ROLLBACK");
        }
      };
      const signInStore = (actor, reference) =>
        restricted((tx) => target(tx, sessionOf(actor), reference));

      // The first merchant's composition sends each person to their own merchant.
      assert.equal((await signInStore(staffA)).storeReference, merchantA.storeReference);
      assert.equal((await signInStore(staffB)).storeReference, merchantB.storeReference);
      assert.equal((await signInStore(both)).storeReference, merchantA.storeReference);
      // Someone at both merchants can choose either.
      assert.equal(
        (await signInStore(both, merchantB.storeReference)).storeReference,
        merchantB.storeReference,
      );
      // Nobody reaches a merchant they don't work for, and a stranger reaches none.
      await assert.rejects(
        signInStore(staffB, merchantA.storeReference),
        /INTERNAL_MERCHANT_SCOPE_DENIED/u,
      );
      await assert.rejects(
        signInStore(staffA, merchantB.storeReference),
        /INTERNAL_MERCHANT_SCOPE_DENIED/u,
      );
      await assert.rejects(signInStore(id(99)), /INTERNAL_MERCHANT_SCOPE_DENIED/u);
      // A forged selection: a served Store under another merchant's Tenant and Brand.
      assert.equal(
        await restricted((tx) =>
          session.validateAssociation(
            tx,
            sessionOf(both),
            { ...merchantA, storeReference: merchantB.storeReference },
            resources.now(),
          ),
        ),
        false,
      );
      // With one merchant's scope set, the database shows none of the other's staff.
      const visible = await restricted(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [merchantB.brandReference, merchantB.storeReference],
        );
        return (await tx.query("SELECT DISTINCT actor_id FROM bop_membership.store_assignment"))
          .rows;
      });
      assert.deepEqual(visible.map((row) => row.actor_id).sort(), [staffB, both].sort());
    } finally {
      session?.poolCheck.stop();
      await fake.close?.();
      await admin.end();
    }
  });
});

/**
 * DEC-MULTI-MERCHANT-ONE-INSTALLATION A6: a new merchant from nothing, as the restricted API role:
 * Brand, first Store, Owner's place, audit and an opening that names no earlier Store.
 */
it("opens a merchant from nothing; a retry finds it, another merchant's code is refused", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_merchant_open" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_mo_" + context.runId,
      worker = "wp2423_mo_w_" + context.runId;
    try {
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
      const owner = id(31),
        operator = id(32),
        operation = id(33),
        at = new Date().toISOString();
      const command = {
        operationReference: operation,
        ownerActorReference: owner,
        brandCode: "NEW_MERCHANT",
        brandName: "New Merchant – not production",
        storeCode: "MAIN",
        storeName: "New Merchant Main – not production",
        timeZone: "America/Vancouver",
        locale: "en-CA",
      };
      const open = async (input) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + api);
          const result = await recordMerchantOpening(admin, {
            command: input,
            openedByActorReference: operator,
            sourceChannel: "DEPLOYMENT",
            openedAt: at,
          });
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const refs = merchantOpeningReferences(operation);
      const first = await open(command);
      assert.equal(first.status, "Opened");
      assert.equal(first.storeReference, refs.storeReference);
      // A retry finds its own result and writes nothing.
      assert.equal((await open(command)).status, "AlreadyOpened");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_tenant.brand WHERE code='NEW_MERCHANT'",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(open({ ...command, brandName: "Something else" }), (error) => {
        assert.ok(error instanceof MerchantOpeningError);
        assert.equal(error.code, "Conflict");
        return true;
      });
      // Another merchant's code answers CodeTaken, and nothing of the attempt remains.
      const other = id(34);
      await assert.rejects(open({ ...command, operationReference: other }), (error) => {
        assert.ok(error instanceof MerchantOpeningError);
        assert.equal(error.code, "CodeTaken");
        return true;
      });
      const stray = merchantOpeningReferences(other);
      assert.equal(
        (
          await admin.query("SELECT count(*)::int n FROM bop_tenant.store WHERE store_id=$1", [
            stray.storeReference,
          ])
        ).rows[0].n,
        0,
      );
      const one = async (sql, values) => (await admin.query(sql, values)).rows[0];
      const brand = await one(
        "SELECT lifecycle,default_locale FROM bop_tenant.brand WHERE brand_id=$1",
        [refs.brandReference],
      );
      assert.deepEqual(brand, { lifecycle: "Active", default_locale: "en-CA" });
      const store = await one(
        "SELECT lifecycle,time_zone FROM bop_tenant.store WHERE store_id=$1",
        [refs.storeReference],
      );
      assert.deepEqual(store, { lifecycle: "Active", time_zone: "America/Vancouver" });
      const opening = await one(
        "SELECT opened_from_store_id,actor_id::text actor FROM bop_tenant.store_opening WHERE store_id=$1",
        [refs.storeReference],
      );
      assert.deepEqual(opening, { opened_from_store_id: null, actor: owner });
      const member = await one(
        "SELECT m.lifecycle,s.store_id::text store FROM bop_membership.membership m JOIN bop_membership.store_assignment s ON s.membership_id=m.membership_id WHERE m.actor_id=$1",
        [owner],
      );
      assert.deepEqual(member, { lifecycle: "Active", store: refs.storeReference });
      const audits = (
        await admin.query(
          "SELECT action_code,actor_reference::text actor FROM platform_audit.audit_record WHERE correlation_id=$1 ORDER BY action_code",
          [operation],
        )
      ).rows;
      assert.deepEqual(audits, [
        { action_code: "BRAND_CREATED", actor: operator },
        { action_code: "STORE_OPENED", actor: operator },
      ]);
      // Its first content: one tax class and one empty menu, under its Owner.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + api);
      const content = await recordMerchantFirstContent(admin, { command, openedAt: at });
      await admin.query("COMMIT");
      assert.equal(content.menuReference, refs.menuReference);
      assert.equal(
        (
          await one("SELECT brand_id::text b FROM rms_catalog.menu WHERE menu_id=$1", [
            refs.menuReference,
          ])
        ).b,
        refs.brandReference,
      );
      assert.equal(
        (
          await one(
            "SELECT count(*)::int n FROM rms_catalog.product_tax_classification_registry_record WHERE brand_id=$1",
            [refs.brandReference],
          )
        ).n,
        1,
      );
      // The owner is a member of the new merchant, seen through its scope and no other.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + api);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(40), id(41)],
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_tenant.store")).rows[0].n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_tenant.store_opening")).rows[0].n,
        0,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_membership.membership")).rows[0].n,
        0,
      );
      await admin.query("ROLLBACK");
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  });
});
