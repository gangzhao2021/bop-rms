import assert from "node:assert/strict";
import { URL, URLSearchParams } from "node:url";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { parseMerchantWorkspace } from "../../../apps/merchant-web/src/merchant-workspace.ts";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");

/** Actual HTTP and persisted service; synthetic Provider/authority supplied by caller. */
export async function verifyPersistentMerchantBffHttp({
  service,
  authorization,
  credentials,
  initialStore,
  targetStore,
}) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      exactOrigin: "https://merchant.example.test",
      acceptedHost: "merchant.example.test",
    }),
  );
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  function send(path, { cookie, body, csrf, origin = "https://merchant.example.test" } = {}) {
    return new Promise((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: body === undefined ? "GET" : "POST",
          headers: {
            Host: "merchant.example.test",
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(csrf ? { "X-BOP-CSRF": csrf } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (value) => {
            text += value;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, headers: response.headers, text }),
          );
          response.on("error", reject);
        },
      );
      call.setTimeout(5000, () => call.destroy(new Error("synthetic HTTP timeout")));
      call.on("error", reject);
      call.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  function issued(response, name) {
    const cookies = response.headers["set-cookie"] ?? [];
    const value = cookies.find(
      (entry) => entry.startsWith(name + "=") && !entry.includes("Max-Age=0"),
    );
    assert(value);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"])
      assert(value.includes(attribute));
    return value.split(";")[0];
  }
  try {
    const start = await send("/merchant/login?returnTo=/operations/order-exceptions");
    assert.equal(start.status, 303);
    assert.equal(start.headers.location, "https://provider.example.test/authorize");
    const authCookie = issued(start, "__Host-bop-auth");
    const query = new URLSearchParams({
      state: authorization().state,
      code: credentials.generate(),
    });
    const callbackPath = "/merchant/callback?" + query;
    const callback = await send(callbackPath, { cookie: authCookie });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.location, "/operations/order-exceptions");
    const cookie = issued(callback, "__Host-bop-merchant");
    assert.equal((await send(callbackPath, { cookie: authCookie })).status, 403);
    const initial = await send("/merchant/session", { cookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers["cache-control"], "no-store");
    const bootstrap = JSON.parse(initial.text);
    assert.equal(
      parseMerchantWorkspace(bootstrap.workspace).selectedScope.storeReference,
      initialStore,
    );
    const body = { targetStoreReference: targetStore };
    assert.equal(
      (await send("/merchant/store-context", { cookie, body, csrf: credentials.generate() }))
        .status,
      403,
    );
    assert.equal(
      (
        await send("/merchant/store-context", {
          cookie,
          body,
          csrf: bootstrap.csrf,
          origin: "https://foreign.example.test",
        })
      ).status,
      403,
    );
    const switched = await send("/merchant/store-context", { cookie, body, csrf: bootstrap.csrf });
    assert.equal(switched.status, 200);
    assert.equal(
      parseMerchantWorkspace(JSON.parse(switched.text).workspace).selectedScope.storeReference,
      targetStore,
    );
    const nextCookie = issued(switched, "__Host-bop-merchant");
    assert.notEqual(nextCookie, cookie);
    assert.equal((await send("/merchant/session", { cookie })).status, 403);
    const refreshed = await send("/merchant/session", { cookie: nextCookie });
    assert.equal(refreshed.status, 200);
    const next = JSON.parse(refreshed.text);
    assert.notEqual(next.csrf, bootstrap.csrf);
    assert.equal(
      (await send("/merchant/protected", { cookie: nextCookie, csrf: bootstrap.csrf, body: {} }))
        .status,
      403,
    );
    assert.equal(
      (await send("/merchant/protected", { cookie: nextCookie, csrf: next.csrf, body: {} })).status,
      200,
    );
    const logout = await send("/merchant/logout", {
      cookie: nextCookie,
      csrf: next.csrf,
      body: {},
    });
    assert.equal(logout.status, 204);
    assert(logout.headers["set-cookie"].some((entry) => entry.includes("Max-Age=0")));
    assert.equal((await send("/merchant/session", { cookie: nextCookie })).status, 403);
    for (const response of [start, callback, switched, refreshed, logout])
      assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
