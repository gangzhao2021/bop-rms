import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CheckoutSessionServiceError } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerPaymentResultHandler } from "./customer-payment-result.js";
const servers: Server[] = [];
const id = (n: number) => "0198a001-0000-7000-8000-" + n.toString(16).padStart(12, "0");
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
async function setup(enabled = true) {
  const result = {
    checkoutSessionReference: id(31),
    paymentIntentReference: id(32),
    orderReference: id(33),
    status: "Succeeded",
    total: { amountMinor: "238", currency: "CAD" },
  };
  const read = vi.fn().mockResolvedValue(result);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerPaymentResult: new CustomerPaymentResultHandler({
              allowedOrigin: "https://pilot.example",
              port: { read },
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
    "/api/v1/checkout-sessions/" +
    id(31) +
    "/payment-result";
  return {
    read,
    result,
    send: (headers: Record<string, string> = {}, query = "") =>
      fetch(url + query, {
        headers: {
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
          "x-csrf-token": "c".repeat(43),
          ...headers,
        },
      }),
  };
}
it("returns only the scoped closed result with no-store/no-referrer, without requiring GET Origin", async () => {
  const f = await setup(),
    response = await f.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual({ schemaVersion: 1, payment: f.result });
  expect(f.read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(31),
  });
});
it("rejects foreign origins, missing metadata/CSRF, duplicate cookies and caller query before reads", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://foreign.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-csrf-token": "" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
  ])
    expect((await f.send(headers)).status).toBe(400);
  expect((await f.send({}, "?paid=true")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("rejects malformed or cross-session owner results without leaking them", async () => {
  const f = await setup();
  for (const result of [
    { ...f.result, checkoutSessionReference: id(99) },
    { ...f.result, extra: "private" },
    { ...f.result, total: { amountMinor: "9223372036854775808", currency: "CAD" } },
    { ...f.result, paymentIntentReference: null },
  ]) {
    f.read.mockResolvedValue(result);
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  }
  f.read.mockRejectedValue(new CheckoutSessionServiceError("PERMISSION_DENIED"));
  expect((await f.send()).status).toBe(404);
});
it("reports missing creation as pending and fails closed when unconfigured", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    checkoutSessionReference: id(31),
    paymentIntentReference: null,
    orderReference: null,
    total: null,
    status: "Pending",
  });
  expect((await f.send()).status).toBe(200);
  expect((await (await setup(false)).send()).status).toBe(503);
});

it("requires explicit same-origin JSON POST for reconciliation and rejects injected fields", async () => {
  const read = vi.fn().mockResolvedValue({
    checkoutSessionReference: id(31),
    paymentIntentReference: null,
    orderReference: null,
    status: "Pending",
    total: null,
  });
  const app = express();
  app.use(express.json());
  app.all(
    "/reconcile/:checkout_session_id",
    new CustomerPaymentResultHandler({
      allowedOrigin: "https://pilot.example",
      port: { read },
    }).handler("reconcile"),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reconcile/${id(31)}`;
  const headers = {
    origin: "https://pilot.example",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    cookie: "__Host-bop-guest=" + "s".repeat(43),
    "x-csrf-token": "c".repeat(43),
  };
  for (const options of [
    { method: "GET", headers },
    { method: "POST", headers: { ...headers, origin: "" }, body: "{}" },
    { method: "POST", headers: { ...headers, origin: "https://other.example" }, body: "{}" },
    { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" },
    { method: "POST", headers, body: JSON.stringify({ amountMinor: "1" }) },
  ])
    expect((await fetch(url, options)).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
  const response = await fetch(url, { method: "POST", headers, body: "{}" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledTimes(1);
});
