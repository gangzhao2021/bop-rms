import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerPaymentHandoffError } from "@rms/payment";
import { createApp } from "./app.js";
import { CustomerPaymentHandoffHandler } from "./customer-payment-handoff.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(enabled = true) {
  const retrieve = vi
    .fn()
    .mockResolvedValue({ clientSecret: "pi_SYNTHETIC000001_secret_SYNTHETICONLY" });
  const server = createServer(
    createApp(
      enabled
        ? {
            customerPaymentHandoff: new CustomerPaymentHandoffHandler({
              allowedOrigin: "https://pilot.example",
              port: { retrieve },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" +
    (server.address() as AddressInfo).port +
    "/api/v1/checkout-sessions/0198a001-0000-7000-8000-000000000031/payment-handoff";
  return {
    retrieve,
    send: (body: unknown = {}, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: {
          origin: "https://pilot.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
          "x-csrf-token": "c".repeat(43),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
  };
}
it("returns only ephemeral credential with no-store and no-referrer", async () => {
  const f = await setup(),
    response = await f.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    clientSecret: "pi_SYNTHETIC000001_secret_SYNTHETICONLY",
  });
});
it("rejects cross-site, missing CSRF, duplicate cookie and extra body fields before owner access", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://foreign.example" },
    { "x-csrf-token": "" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
  ]) {
    expect((await f.send({}, headers)).status).toBe(400);
  }
  expect((await f.send({ paymentOperationReference: "not accepted" })).status).toBe(400);
  expect(f.retrieve).not.toHaveBeenCalled();
});
it("withholds malformed owner response and safely maps unavailable/payability errors", async () => {
  const f = await setup();
  f.retrieve.mockResolvedValue({ clientSecret: "invalid", extra: "never expose" });
  expect((await f.send()).status).toBe(503);
  f.retrieve.mockRejectedValue(new CustomerPaymentHandoffError("NOT_READY"));
  const response = await f.send();
  expect(response.status).toBe(422);
  expect(await response.text()).not.toContain("secret");
});
it("fails closed without runtime configuration", async () => {
  expect((await (await setup(false)).send()).status).toBe(503);
});
