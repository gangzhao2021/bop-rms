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
