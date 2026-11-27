import assert from "node:assert/strict";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { request } from "node:http";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
/** Loopback HTTP with synthetic fixture credentials, actual route and persisted service.
 * This verifies transport behavior, not browser Secure-cookie enforcement.
 */
export async function verifyMerchantConfigurationHttp({
  service,
  command,
  input,
  assertPersisted,
}) {
  const app = express();
  app.use(
    "/merchant",
    createMerchantBffRouter({
      service,
      storeConfiguration: command,
      storeConfigurationState: command.read,
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
  try {
    const path = "/merchant/store-configuration";
    const base = {
      cookie: "__Host-bop-merchant=" + input.sessionCookie,
      csrf: input.csrf,
      body: input.command,
    };
    for (const override of [
      { origin: "https://foreign.invalid" },
      { csrf: "invalid" },
      { body: { ...input.command, actorReference: "injected" } },
    ]) {
      const response = await send(path, { ...base, ...override });
      assert.equal(response.status, 403);
      assert.deepEqual(JSON.parse(response.text), { error: "request_denied" });
    }
    assert.equal((await send(path + "?store=other", base)).status, 403);
    const applied = await send(path, base);
    assert.equal(applied.status, 200);
    assert.equal(applied.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(applied.text), {
      status: "Applied",
      resultingVersion: input.command.expectedVersion + 1,
    });
    await assertPersisted();
    const state = await send(path, { cookie: base.cookie });
    assert.equal(state.status, 200);
    assert.equal(state.headers["cache-control"], "no-store");
    const view = JSON.parse(state.text);
    assert.equal(view.screenId, "STORE-HOURS-SERVICE");
    assert.equal(view.expectedVersion, input.command.expectedVersion + 1);
    assert.deepEqual(view.latest, input.command.configuration);
    assert.equal(view.current.lifecycle, "Published");
    assert.notEqual(view.current.configurationReference, view.latest.configurationReference);
    assert.equal((await send(path + "?store=other", { cookie: base.cookie })).status, 403);

    const replay = await send(path, base);
    assert.equal(replay.status, 200);
    assert.deepEqual(JSON.parse(replay.text), {
      status: "AlreadyApplied",
      resultingVersion: input.command.expectedVersion + 1,
    });
    const conflict = await send(path, {
      ...base,
      body: {
        ...input.command,
        configuration: { ...input.command.configuration, reasonCode: "CHANGED" },
      },
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(JSON.parse(conflict.text), { error: "store_configuration_conflict" });
    await assertPersisted();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
