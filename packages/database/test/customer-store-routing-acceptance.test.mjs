import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createGuestSessionCredentialProvider } from "../../bop/identity/src/index.ts";
import { createCustomerStoreRouting } from "../../../tooling/environment/pilot-customer-store-routing.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 4: a guest request reaches the customer
 * API of the Store whose own records hold the guest's Session — found through Identity's
 * Store-scoped owner read as the restricted pilot API role, each Store in its own scope — the
 * scanned table code's Store for an entry, the path's Store for the public menu; anything else
 * the installation's first Store (which refuses what is not its own). Never a request field.
 */
it("guest requests reach their own Store's customer API from server-side records only", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cust_route" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_crt");
      const brand = id(2),
        storeOne = id(3),
        storeTwo = id(4),
        publicOne = id(13),
        publicTwo = id(14);
      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      const createdAt = (
        await admin.query("SELECT date_trunc('milliseconds',now()) at")
      ).rows[0].at.toISOString();
      const seed = async (n, store, publicStore) => {
        const credential = credentials.generateCredential("Session");
        await admin.query(
          "INSERT INTO bop_identity.guest_session (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,NULL,'Pickup','en-CA',$9,1,'ContextOnly','Active',$10,$10,$10::timestamptz + interval '4 hours',$10::timestamptz + interval '24 hours',1)",
          [
            id(100 + n),
            credentials.hashCredential("Session", credential),
            credentials.hashCredential("Csrf", credentials.generateCredential("Csrf")),
            id(200 + n),
            credentials.hashOperationIntent("seed" + n),
            brand,
            store,
            publicStore,
            id(300 + n),
            createdAt,
          ],
        );
        return credential;
      };
      const guestOne = await seed(1, storeOne, publicOne),
        guestTwo = await seed(2, storeTwo, publicTwo);
      // Each Store's transactions as the pilot API role (the Store owner sets its own scope).
      let reads = 0;
      const transactions = {
        async run(work) {
          reads += 1;
          await admin.query("BEGIN");
          try {
            await admin.query("SET LOCAL ROLE " + api);
            const value = await work({
              query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
            });
            await admin.query("COMMIT");
            return value;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const store = (storeReference, publicStoreReference, port) => ({
        storeReference,
        brandReference: brand,
        publicStoreReference,
        port,
        transactions,
        hashSession: (credential) => credentials.hashCredential("Session", credential),
      });
      const route = createCustomerStoreRouting({
        stores: [store(storeOne, publicOne, 4300), store(storeTwo, publicTwo, 4301)],
      });
      const cookie = (value) => "theme=x; __Host-bop-guest=" + value;
      const portOf = async (request) => (await route(request)).port;
      // The guest's own Store, whichever Store is asked first.
      assert.equal(
        await portOf({ method: "GET", url: "/api/v1/dine-in/session", cookie: cookie(guestTwo) }),
        4301,
      );
      assert.equal(
        await portOf({ method: "GET", url: "/api/v1/dine-in/session", cookie: cookie(guestOne) }),
        4300,
      );
      // Remembered: a known Session reads nothing more.
      const before = reads;
      assert.equal(
        await portOf({ method: "POST", url: "/api/v1/orders", cookie: cookie(guestTwo) }),
        4301,
      );
      assert.equal(reads, before);
      // No Session, an unknown one, or a malformed cookie: the first Store.
      for (const value of [
        undefined,
        cookie(credentials.generateCredential("Session")),
        cookie("short"),
      ])
        assert.equal(
          await portOf({ method: "GET", url: "/bff/customer/cart", cookie: value }),
          4300,
        );
      // The scanned code's Store (its runtime verifies the code), and the public menu's.
      const token = (publicStoreReference) =>
        "eyJhbGciOiJFUzI1NiJ9." +
        Buffer.from(JSON.stringify({ publicStoreReference })).toString("base64url") +
        ".sig";
      const entry = (publicStoreReference) =>
        portOf({
          method: "POST",
          url: "/bff/customer/entry",
          body: Buffer.from(JSON.stringify({ qrToken: token(publicStoreReference) })),
        });
      assert.equal(await entry(publicTwo), 4301);
      assert.equal(await entry(id(99)), 4300);
      assert.equal(
        await portOf({ method: "GET", url: "/api/v1/public/stores/" + publicTwo + "/menu" }),
        4301,
      );
      assert.equal(
        await portOf({ method: "GET", url: "/api/v1/public/stores/" + id(98) + "/menu" }),
        4300,
      );
      // A one-Store installation never reads anything.
      const single = createCustomerStoreRouting({ stores: [store(storeOne, publicOne, 4300)] });
      const quiet = reads;
      assert.equal(
        (await single({ method: "GET", url: "/x", cookie: cookie(guestTwo) })).port,
        4300,
      );
      assert.equal(reads, quiet);
    } finally {
      await admin.end();
    }
  });
});
