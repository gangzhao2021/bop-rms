import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { it, vi } from "vitest";
import { createGuestSessionCredentialProvider } from "../../bop/identity/src/index.ts";
import { startInternalCustomerServer } from "../../../tooling/environment/pilot-customer-server.mjs";
import { createTestCertificates } from "../../../tooling/environment/pilot-test-certificates.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * v15 2026-11-01 (coordinator): store 2's first guest payment failed — `simulation-confirm` was
 * answered by store 1's simulator and payment stack (registered on the HTTPS server itself, before
 * the per-Store forwarding), so store 2's checkout session was looked up in store 1 and not found.
 * Every guest payment request is now answered by the payment stack of the Store that owns the
 * guest's Session, found as the rest of the customer routing finds it: Identity's Store-scoped
 * owner read of the Session, as the restricted pilot API role. Here the real HTTPS customer server
 * runs with two Stores; each Store's payment stack (terminal, payment intents, simulator, table
 * payments) records what reaches it:
 * 1. store 2's guest: confirm, decline, another card (retry), back to the open payment (resume),
 *    the reconciliation check, the payment form's configuration and the table payment all reach
 *    store 2's stack — store 1's records nothing;
 * 2. store 1's guest: exactly as before, store 1's stack;
 * 3. a guest whose Session no Store holds: store 1's stack, which refuses it as today — never
 *    store 2's.
 * (Capture, decline, retry and reconciliation themselves are the same Store-scoped payment code
 * each Store runs; their persistence has its own acceptances.)
 */
it("each guest payment reaches the payment stack of the Store that owns the guest's Session", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "Pilot");
  await withIsolatedDatabase({ caseId: "wp2423_store_pay" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const directory = await mkdtemp(join(tmpdir(), "bop-store-pay-"));
    let server;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_spy");
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
      // Each Store's own transactions as the pilot API role.
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            const value = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const resourcesOf = (storeReference, publicStoreReference) => ({
        scope: { brandReference: brand, storeReference },
        publicProfile: { binding: { publicStoreReference } },
        transactions,
        credentials: { sessions: { hashCredential: (k, v) => credentials.hashCredential(k, v) } },
        close: async () => undefined,
      });
      // Each Store's payment stack: what reaches it is recorded under its name.
      const reached = [];
      const stack = (name) => ({
        createInternalCustomerEntry: async () => ({ dining: {} }),
        createInternalTestItems: async () => ({ catalogCartItems: [] }),
        createInternalCheckout: () => ({ preparation: {}, accessOptions: {} }),
        createInternalOrder: async () => ({}),
        createInternalDiningCheckout: () => ({ preparation: {} }),
        createInternalChannelPayment: async () => ({
          create: async () => reached.push([name, "create"]),
        }),
        createInternalSimulatedProvider: async () => ({
          simulation: true,
          close: () => undefined,
          name,
        }),
        createInternalPaymentTerminal: (_r, _c, _i, simulator) => ({
          confirm: async (_input, confirmation, mode = {}) => {
            reached.push([
              simulator.name,
              confirmation + (mode.retry ? ":retry" : mode.resume ? ":resume" : ""),
            ]);
            return { created: {} };
          },
          reconcile: async () => reached.push([name, "reconcile"]),
        }),
        registerInternalDiningTablePayment: (router) =>
          router.post("/api/v1/dine-in/table-payment", (_req, res) => {
            reached.push([name, "table-payment"]);
            res.status(204).end();
          }),
      });
      // Staff routing is not exercised here (no staff requests).
      const merchantPersistence = {
        transactions,
        identity: { hasher: { hash: () => "unused" } },
        now: () => new Date().toISOString(),
        currentActor: async () => null,
        validateAssociation: async () => false,
      };
      const certificates = await createTestCertificates(directory, {
        hostname: "order.store-pilot.ca",
      });
      const one = stack("store 1"),
        two = stack("store 2");
      server = await startInternalCustomerServer({
        publicOrigin: "https://order.store-pilot.ca",
        listenPort: 0,
        apiPort: 1,
        keyFile: certificates.keyFile,
        certificateFile: certificates.certificateFile,
        loadProfile: async () => ({
          environment: "Pilot",
          binding: { publicStoreReference: publicOne },
        }),
        loadInternalPickupQr: async () => ({ token: () => "synthetic.pickup.token" }),
        createInternalTestResources: async () => resourcesOf(storeOne, publicOne),
        ...one,
        createInternalMerchant: async () => ({
          staffSignInMode: "cognito",
          persistence: merchantPersistence,
          bff: {
            exactOrigin: "https://order.store-pilot.ca",
            acceptedHost: "order.store-pilot.ca",
          },
        }),
        additionalStores: [
          {
            storeReference: storeTwo,
            apiPort: 2,
            customer: two,
            createInternalTestResources: async () => resourcesOf(storeTwo, publicTwo),
            createInternalMerchant: async () => ({
              staffSignInMode: "cognito",
              persistence: merchantPersistence,
              bff: {
                exactOrigin: "https://order.store-pilot.ca",
                acceptedHost: "order.store-pilot.ca",
              },
            }),
          },
        ],
      });
      if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
      const send = (method, path, guest, body, headers = {}) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body);
          const call = request(
            {
              hostname: "127.0.0.1",
              port: server.address().port,
              method,
              path,
              servername: "order.store-pilot.ca",
              ca: [certificates.root],
              headers: {
                host: "order.store-pilot.ca",
                origin: "https://order.store-pilot.ca",
                "sec-fetch-site": "same-origin",
                ...(guest === null ? {} : { cookie: "__Host-bop-guest=" + guest }),
                "x-csrf-token": credentials.generateCredential("Csrf"),
                ...(bytes === null
                  ? {}
                  : { "content-type": "application/json", "content-length": bytes.length }),
                ...headers,
              },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            },
          );
          call.on("error", reject);
          call.end(bytes ?? undefined);
        });
      const checkoutPath = "/api/v1/checkout-sessions/" + id(500);
      const paymentsOf = async (guest) => {
        reached.length = 0;
        await send(
          "POST",
          checkoutPath + "/simulation-confirm",
          guest,
          {
            tip: { amountMinor: "0", currency: "CAD" },
          },
          { "x-bop-simulation-confirmation": "SIMULATE_CAPTURE", "idempotency-key": id(600) },
        );
        await send(
          "POST",
          checkoutPath + "/simulation-fail",
          guest,
          {
            tip: { amountMinor: "0", currency: "CAD" },
          },
          { "x-bop-simulation-confirmation": "SIMULATE_FAILURE", "idempotency-key": id(601) },
        );
        await send(
          "POST",
          checkoutPath + "/simulation-confirm",
          guest,
          { retry: true },
          {
            "x-bop-simulation-confirmation": "SIMULATE_CAPTURE",
          },
        );
        await send(
          "POST",
          checkoutPath + "/simulation-confirm",
          guest,
          { resume: true },
          {
            "x-bop-simulation-confirmation": "SIMULATE_CAPTURE",
          },
        );
        await send("POST", checkoutPath + "/payment-reconciliation", guest, {});
        await send("POST", "/api/v1/dine-in/table-payment", guest, {});
        return [...reached];
      };

      // 1. Store 2's guest: everything reaches store 2's stack; store 1's records nothing.
      const storeTwoPayments = await paymentsOf(guestTwo);
      assert.deepEqual(
        storeTwoPayments.map(([name]) => name),
        storeTwoPayments.map(() => "store 2"),
        JSON.stringify(storeTwoPayments),
      );
      for (const step of [
        "SIMULATE_CAPTURE",
        "SIMULATE_FAILURE",
        "SIMULATE_CAPTURE:retry",
        "SIMULATE_CAPTURE:resume",
        "reconcile",
        "table-payment",
      ])
        assert.ok(
          storeTwoPayments.some(([, what]) => what === step),
          step + " " + JSON.stringify(storeTwoPayments),
        );
      // 2. Store 1's guest: store 1's stack, as before.
      const storeOnePayments = await paymentsOf(guestOne);
      assert.ok(storeOnePayments.length > 0);
      assert.ok(storeOnePayments.every(([name]) => name === "store 1"));
      // 3. No Store holds this Session: store 1's stack refuses it, never store 2's.
      const unknown = await paymentsOf(credentials.generateCredential("Session"));
      assert.ok(unknown.length > 0);
      assert.ok(unknown.every(([name]) => name === "store 1"));
    } finally {
      server?.close();
      await rm(directory, { recursive: true, force: true });
      await admin.end();
    }
  });
}, 240_000);
