import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import pg from "pg";
import { it, vi } from "vitest";
import { CustomerEntryHandler } from "../../../apps/api/dist/customer-entry.js";
import { createCustomerRequestAdmission } from "../../../tooling/environment/pilot-customer-admission.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
const id = (n) => "0190ab20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const origin = "https://guest.invalid";
const ENTRY = "/bff/customer/entry";

/**
 * v15 three-Store rush 2026-11-02: 18 guests across three Stores, then 2 more, then 429 for everyone:
 * the entry's per-address limit saw only the proxy's loopback address, so 20 scans anywhere in the
 * installation locked out every Store. Each guest here is a real HTTP request through the real entry
 * handler and the real limit, in the database, as the restricted role.
 */
it("twenty scans at one Store don't turn away guests at another or at the same Store", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "guest_entry_limit" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "guest_limit");
    const pool = new pg.Pool({ ...context.clientConfig, max: 3 });
    pool.on("connect", (client) => client.query("SET ROLE " + role));
    const database = {
      acquire: async () => {
        const client = await pool.connect();
        await client.query("SET ROLE " + role);
        return client;
      },
    };
    const secret = randomBytes(32);
    const servers = [];
    const start = async (storeReference, codeCheck) => {
      const requestAdmission = await createCustomerRequestAdmission(
        { database, scope: { brandReference: id(1), storeReference } },
        { loadSecret: async () => Buffer.from(secret) },
      );
      const app = express();
      app.use(express.json());
      app.post(
        ENTRY,
        new CustomerEntryHandler({
          allowedOrigin: origin,
          // Past the limit is not under test: every scan here is then refused for its code.
          port: new Proxy({}, { get: () => async () => ({ status: "Unavailable" }) }),
          uuidV7Factory: () => id(100),
          requestAdmission,
          ...(codeCheck === undefined ? {} : { codeCheck }),
        }).handler(),
      );
      const server = createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      return server.address().port;
    };
    const scan = (port, address) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({
          qrToken: "aaaa.bbbb." + Buffer.alloc(64, 7).toString("base64url"),
        });
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: ENTRY,
            method: "POST",
            headers: {
              origin,
              "sec-fetch-site": "same-origin",
              "sec-fetch-mode": "cors",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(address === undefined ? {} : { "x-bop-client-address": address }),
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    try {
      const [one, two] = [await start(id(2)), await start(id(3))];
      const statuses = [];
      for (let n = 0; n < 15; n += 1) statuses.push(await scan(one));
      for (let n = 0; n < 15; n += 1) statuses.push(await scan(two));
      // Every scan reached the limit (none turned back earlier for its shape).
      assert.deepEqual([...new Set(statuses)].includes(400), false, statuses.join());
      assert.equal(statuses.filter((status) => status === 429).length, 0, statuses.join());

      // One address (a restaurant's Wi-Fi, a carrier): 120 at this Store, and the 121st waits.
      const wifi = "198.51.100.20";
      const seen = [];
      for (let n = 0; n < 121; n += 1) seen.push(await scan(one, wifi));
      assert.equal(seen.filter((status) => status === 429).length, 1);
      assert.equal(seen.at(-1), 429);
      // The next address and the same address at another Store are not touched.
      assert.notEqual(await scan(one, "198.51.100.21"), 429);
      assert.notEqual(await scan(two, wifi), 429);

      // The Store's own limit: this Store's budget, not the other's.
      const three = await start(id(4));
      const many = [];
      for (let n = 0; n < 301; n += 1) many.push(await scan(three));
      assert.equal(many.filter((status) => status === 429).length, 1);
      assert.equal(many.at(-1), 429);
      assert.notEqual(await scan(two), 429);

      // Made-up codes: no budget of the Store's is spent, so its guests are never locked out by
      // them; the address that sends them still runs out.
      const budget = async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*) n FROM security.abuse_bucket WHERE bucket_class='GUEST_SESSION'",
            )
          ).rows[0].n,
        );
      let real = false;
      const four = await start(id(5), async () => real);
      const bucketsBefore = await budget();
      for (let n = 0; n < 310; n += 1) assert.equal(await scan(four), 422);
      assert.equal(await budget(), bucketsBefore);
      real = true;
      assert.equal(await scan(four), 503, "a real code passes; the port here is a stand-in");
      real = false;
      const forged = [];
      for (let n = 0; n < 121; n += 1) forged.push(await scan(four, "198.51.100.30"));
      assert.equal(forged.at(-1), 429);
    } finally {
      for (const server of servers) await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await admin.end();
    }
  });
});
