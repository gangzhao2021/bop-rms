import { registerInternalDiningEntry } from "./pilot-dining-launcher.mjs";
import { installInternalStaffLogin } from "./pilot-staff-login.mjs";
import process from "node:process";
import { URL } from "node:url";
import { CustomerPaymentResultHandler } from "../../apps/api/dist/customer-payment-result.js";
import { createMerchantBffRouter } from "../../apps/api/dist/merchant-bff.js";
import { CustomerPaymentIntentHandler } from "../../apps/api/dist/customer-payment-intent.js";
import { createServer } from "node:https";
import { request } from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const express = require("express");
export async function startInternalCustomerServer({
  createInternalMerchant,
  loadInternalPickupQr,
  diningEntries = [],
  createInternalTestResources,
  createInternalCustomerEntry,
  createInternalDiningCheckout,
  createInternalTestItems,
  createInternalCheckout,
  createInternalOrder,
  createInternalChannelPayment,
  createInternalSimulatedProvider,
  createInternalPaymentTerminal,
  loadProfile,
  keyFile,
  certificateFile,
}) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
  const profile = await loadProfile();
  if (profile.environment !== "InternalTest") throw new Error("INTERNAL_TEST_ONLY");
  const stat = await lstat(keyFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== process.getuid()
  )
    throw new Error("INTERNAL_TLS_UNAVAILABLE");
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== "127.0.0.1:4443") return res.sendStatus(421);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  registerInternalDiningEntry(app, { profile, tables: diningEntries });
  const pickupQr = await loadInternalPickupQr(profile);
  app.get("/bff/internal-test/pickup-entry", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers["sec-fetch-site"] !== "same-origin" ||
      (req.headers.origin !== undefined && req.headers.origin !== "https://127.0.0.1:4443") ||
      Object.keys(req.query).length !== 0
    )
      return res.status(400).json({ code: "INTERNAL_ENTRY_UNAVAILABLE" });
    res.json({ schemaVersion: 1, qrToken: pickupQr.token() });
  });
  let resources, simulator;
  try {
    resources = await createInternalTestResources();
    simulator = await createInternalSimulatedProvider();
    const entry = await createInternalCustomerEntry(resources),
      items = await createInternalTestItems(resources);
    const checkout = createInternalCheckout(resources, entry, items.catalogCartItems);
    const orders = await createInternalOrder(resources, checkout, items.catalogCartItems);
    const diningCheckout = createInternalDiningCheckout(resources, entry, checkout);
    const diningOrders = await createInternalOrder(
      resources,
      { ...checkout, preparation: diningCheckout.preparation },
      items.catalogCartItems,
      "DineIn",
    );
    const intents = await createInternalChannelPayment(
      resources,
      checkout,
      diningCheckout,
      orders,
      diningOrders,
      simulator,
      items.catalogCartItems,
    );
    const terminal = createInternalPaymentTerminal(resources, checkout, intents, simulator);
    const merchant = await createInternalMerchant(resources);
    installInternalStaffLogin(app, merchant);
    app.use("/merchant", createMerchantBffRouter(merchant.bff));

    app.post(
      "/api/v1/checkout-sessions/:checkout_session_id/payment-reconciliation",
      express.json({ limit: "2kb", strict: true }),
      new CustomerPaymentResultHandler({
        allowedOrigin: "https://127.0.0.1:4443",
        port: { read: (input) => terminal.reconcile(input) },
      }).handler("reconcile"),
    );
    for (const [path, confirmation] of [
      ["simulation-confirm", "SIMULATE_CAPTURE"],
      ["simulation-fail", "SIMULATE_FAILURE"],
    ]) {
      const handler = new CustomerPaymentIntentHandler({
        allowedOrigin: "https://127.0.0.1:4443",
        port: {
          async create(input) {
            await terminal.confirm(input, confirmation);
            return intents.create(input);
          },
        },
      });
      app.post(
        "/api/v1/checkout-sessions/:checkout_session_id/" + path,
        (req, res, next) => {
          res.setHeader("Cache-Control", "no-store");
          if (req.headers["x-bop-simulation-confirmation"] !== confirmation)
            return res.status(400).json({ code: "SIMULATION_CONFIRMATION_REQUIRED" });
          next();
        },
        express.json({ limit: "2kb", strict: true }),
        handler.handler(),
      );
    }
    app.use((error, req, res, next) => {
      if (!error) return next();
      res.status(400).set("Cache-Control", "no-store").json({ code: "SIMULATION_REQUEST_INVALID" });
    });
    app.use((req, res, next) => {
      if (!/^\/(?:api|bff)(?:\/|$)/u.test(req.url)) return next();
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: 4300,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "127.0.0.1:4443", connection: "close" },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          response.on("error", () => res.destroy());
        },
      );
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on("error", () => {
        if (res.headersSent) return res.destroy();
        res.status(502).set("Cache-Control", "no-store").json({ code: "INTERNAL_API_UNAVAILABLE" });
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    });
    const assets = resolve("apps/customer-pwa/dist");
    app.use(
      express.static(assets, {
        dotfiles: "deny",
        index: false,
        setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
      }),
    );
    const merchantAssets = resolve("apps/merchant-web/dist");
    app.use(
      express.static(merchantAssets, {
        dotfiles: "deny",
        index: false,
        setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
      }),
    );
    app.get(["/app", "/app/{*path}", "/operations/{*path}"], (_req, res) =>
      res.set("Cache-Control", "no-store").sendFile(resolve(merchantAssets, "index.html")),
    );
    app.get("/{*path}", (_req, res) =>
      res.set("Cache-Control", "no-store").sendFile(resolve(assets, "index.html")),
    );
    const server = createServer(
      { key: await readFile(keyFile), cert: await readFile(certificateFile) },
      app,
    );
    server.listen(4443, "127.0.0.1", () =>
      process.stdout.write("Internal customer HTTPS listening on 127.0.0.1:4443\n"),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () =>
        server.close(async () => {
          try {
            simulator.close();
            await resources.close();
          } finally {
            process.exit(0);
          }
        }),
      );
    return server;
  } catch (error) {
    try {
      simulator?.close();
    } finally {
      await resources?.close();
    }
    throw error;
  }
}
