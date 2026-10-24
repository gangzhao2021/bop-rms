import { createMerchantWorkspaceClient } from "../../../apps/merchant-web/src/merchant-workspace.ts";
import assert from "node:assert/strict";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createPostgresOrderExceptionSourceStore } from "../../bop/projection/src/index.ts";
import { createMerchantOrderExceptionRead } from "../../../apps/api/src/merchant-order-exception-read.ts";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");

export async function verifyMerchantExceptionHttp({
  admin,
  client,
  role,
  cookie,
  authorize,
  sessionSource,
  revoke,
}) {
  await admin.query("GRANT USAGE ON SCHEMA platform_projection TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_projection.order_exception_source TO " + role);
  const transactions = {
    async run(work) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE " + role);
        const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
  const input = { sessionCookie: cookie, permission: "operations.order-exception.manage" };
  const scope = await transactions.run((tx) => authorize(tx, input));
  assert(scope);
  const sources = (scope) =>
    createPostgresOrderExceptionSourceStore({
      scope,
      authorize: async (tx) => {
        const current = await authorize(tx, input);
        return (
          current?.sessionReference === scope.sessionReference &&
          current?.tenantReference === scope.tenantReference &&
          current?.brandReference === scope.brandReference &&
          current?.storeReference === scope.storeReference
        );
      },
      validateSource: async (_tx, source) => source.sourceReference === f.uuid("500"),
    });
  await transactions.run((tx) =>
    sources(scope).write(
      tx,
      {
        sourceReference: f.uuid("500"),
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        orderReference: f.uuid("501"),
        paymentReference: f.uuid("502"),
        diningReference: null,
        kind: "PaidWithoutFulfillableOrder",
        severity: "Critical",
        sourceOwner: "Payment",
        sourceStatus: "Open",
        providerState: "Confirmed",
        compensationStatus: "Pending",
        sourceVersion: 1n,
        sourceDigest: "sha256:" + "d".repeat(64),
        createdAt: f.FROM,
        updatedAt: f.AT,
        resolutionEvidenceReference: null,
      },
      f.uuid("503"),
    ),
  );
  const read = createMerchantOrderExceptionRead({
    transactions,
    authorize,
    sources,
    metadata: async () => ({
      storeLabel: "Synthetic Store",
      businessDate: "2026-07-28",
      checkpointReference: f.uuid("503"),
      projectedAt: f.AT,
      freshnessStatus: "Stale",
    }),
  });
  const unused = async () => {
    throw new Error("unused fixture route");
  };
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      exactOrigin: "https://merchant.example.test",
      acceptedHost: "merchant.example.test",
      service: {
        start: unused,
        callback: unused,
        bootstrap: async (sessionCookie) =>
          transactions.run(async (tx) => {
            const authorized = await authorize(tx, { ...input, sessionCookie });
            if (!authorized) throw new Error("denied");
            const session = await sessionSource(tx, sessionCookie);
            const selectedScope = {
              brandLabel: "Synthetic Brand",
              storeLabel: "Synthetic Store",
              storeReference: authorized.storeReference,
            };
            return {
              session,
              csrf: "a".repeat(43),
              workspace: {
                screenId: "HOME-OVERVIEW",
                selectedScope,
                authorizedStores: [selectedScope],
                businessDate: "2026-07-28",
                storeStatus: "Unavailable",
                freshness: "Stale",
                dashboardAvailability: "UnavailableUntilWP1905",
                navigation: [
                  {
                    screenId: "OPS-ORDER-EXCEPTION",
                    label: "Order exceptions",
                    href: "/operations/order-exceptions",
                    permission: input.permission,
                  },
                ],
              },
            };
          }),
        authorize: unused,
        logout: unused,
        switchStore: unused,
      },
      orderExceptions: read,
    }),
  );
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  function get({
    path = "/merchant/order-exceptions",
    credential = cookie,
    origin = "https://merchant.example.test",
  } = {}) {
    return new Promise((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: "GET",
          headers: {
            Host: "merchant.example.test",
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            Cookie: "__Host-bop-merchant=" + credential,
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (value) => {
            body += value;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, body }),
          );
        },
      );
      call.setTimeout(5000, () => call.destroy(new Error("synthetic HTTP timeout")));
      call.on("error", reject);
      call.end();
    });
  }
  try {
    const workspaceClient = createMerchantWorkspaceClient(async (path) => {
      assert.equal(path, "/merchant/session");
      const response = await get({ path });
      return new globalThis.Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    });
    const bootstrap = await workspaceClient.bootstrap();
    assert(bootstrap);
    assert.equal(bootstrap.workspace.selectedScope.storeReference, f.STORE);
    assert.equal(bootstrap.workspace.navigation[0].screenId, "OPS-ORDER-EXCEPTION");
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const view = JSON.parse(response.body);
    assert.equal(view.screenId, "OPS-ORDER-EXCEPTION");
    assert.equal(view.freshnessStatus, "Stale");
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].orderReference, f.uuid("501"));
    for (const secret of [
      cookie,
      f.uuid("502"),
      "sourceDigest",
      "tenantReference",
      "sessionReference",
      "resolutionEvidenceReference",
    ])
      assert.equal(response.body.includes(secret), false);
    assert.equal((await get({ origin: "https://foreign.example.test" })).status, 403);
    assert.equal((await get({ credential: "x".repeat(43) })).status, 403);
    assert.equal((await get({ path: "/merchant/order-exceptions?store=" + f.STORE })).status, 403);
    await revoke();
    assert.equal(await workspaceClient.bootstrap(), null);
    const revoked = await get();
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body, '{"error":"request_denied"}');
    assert.equal(revoked.headers["cache-control"], "no-store");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
