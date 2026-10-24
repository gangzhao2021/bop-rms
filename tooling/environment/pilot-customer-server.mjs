import { registerInternalDiningEntry } from "./pilot-dining-launcher.mjs";
import { installInternalStaffLogin } from "./pilot-staff-login.mjs";
import process from "node:process";
import { URL } from "node:url";
import { CustomerPaymentResultHandler } from "../../apps/api/dist/customer-payment-result.js";
import { createMerchantBffRouter } from "../../apps/api/dist/merchant-bff.js";
import { createPilotProductImages } from "../../apps/api/dist/product-image-route.js";
import { CustomerPaymentIntentHandler } from "../../apps/api/dist/customer-payment-intent.js";
import { CustomerPaymentHandoffHandler } from "../../apps/api/dist/customer-payment-handoff.js";
import { createCustomerSessionPaymentHandoff } from "../../apps/api/dist/customer-session-payment-handoff.js";
import { createPostgresPaymentIntentCreationStore } from "../../packages/rms/payment/src/index.ts";
import { isStripeProvider } from "./pilot-stripe-provider.mjs";
import { createServer } from "node:https";
import { request } from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createPilotStaticAssets, missingPilotAsset } from "./pilot-static-assets.mjs";
import { INTERNAL_CUSTOMER_ORIGIN } from "./pilot-hosting.mjs";
import { isInternalTest, isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
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
  productImageDirectory,
  publicOrigin = INTERNAL_CUSTOMER_ORIGIN,
  // The local entry and API ports (tests pass their own; the pilot always uses 4443 and 4300).
  listenPort = 4443,
  apiPort = 4300,
}) {
  const origin = publicOrigin,
    host = new URL(publicOrigin).host;
  // DEC-PILOT-RUNTIME-ENVIRONMENT: the customer and staff HTTPS server of either pilot process
  // (InternalTest, or a Pilot Store with NODE_ENV=production); the installation profile must
  // declare the same environment. The DEMO launchers below stay InternalTest only.
  if (!isPilotRuntime()) throw new Error("PILOT_RUNTIME_ONLY");
  const profile = await loadProfile();
  if (!matchesPilotEnvironment(profile.environment)) throw new Error("PILOT_RUNTIME_ONLY");
  const internalTest = isInternalTest();
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
    if (req.headers.host !== host) return res.sendStatus(421);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const pickupQr = await loadInternalPickupQr(profile);
  // DEC-PILOT-RUNTIME-ENVIRONMENT: the Store's own address opens pickup ordering, so the pickup
  // poster's QR code is just the customer origin and never needs reprinting when keys rotate.
  // The old InternalTest path stays for an app version cached before this change.
  const pickupEntry = (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers["sec-fetch-site"] !== "same-origin" ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      Object.keys(req.query).length !== 0
    )
      return res.status(400).json({ code: "INTERNAL_ENTRY_UNAVAILABLE" });
    res.json({ schemaVersion: 1, qrToken: pickupQr.token() });
  };
  app.get("/bff/customer/pickup-entry", pickupEntry);
  if (internalTest) app.get("/bff/internal-test/pickup-entry", pickupEntry);
  let resources, simulator;
  try {
    resources = await createInternalTestResources();
    simulator = await createInternalSimulatedProvider();
    const entry = await createInternalCustomerEntry(resources),
      items = await createInternalTestItems(resources);
    // WP-2423 Q11: each DEMO launcher table opens its current issued code; none issued → 503.
    // InternalTest only: a Pilot Store's guests scan the printed table codes (DIN-TABLE-LIST).
    if (internalTest)
      registerInternalDiningEntry(app, {
        profile,
        tables: diningEntries.map(({ selector, label, tableReference }) => ({
          selector,
          label,
          loadQr: async () => {
            const token = await entry.dining.currentToken(tableReference);
            if (typeof token !== "string") throw new Error("INTERNAL_DINING_QR_UNAVAILABLE");
            return { token: () => token };
          },
        })),
      });
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
    // WP-2423 DEC-COGNITO-STORE-STAFF: the TEST-ONLY staff sign-in page is not served when staff
    // sign in with their own Cognito account.
    if (merchant.staffSignInMode !== "cognito") installInternalStaffLogin(app, merchant);
    app.use("/merchant", createMerchantBffRouter(merchant.bff));

    app.post(
      "/api/v1/checkout-sessions/:checkout_session_id/payment-reconciliation",
      express.json({ limit: "2kb", strict: true }),
      new CustomerPaymentResultHandler({
        allowedOrigin: origin,
        port: { read: (input) => terminal.reconcile(input) },
      }).handler("reconcile"),
    );
    // DEC-STRIPE-PILOT-WIRING: the payment form the customer app shows comes from this
    // installation's runtime configuration (payment.json), not from the build.
    app.get("/bff/customer/payment-configuration", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (
        req.headers["sec-fetch-site"] !== "same-origin" ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        Object.keys(req.query).length !== 0
      )
        return res.status(400).json({ code: "PAYMENT_CONFIGURATION_UNAVAILABLE" });
      res.json(
        isStripeProvider(simulator)
          ? {
              schemaVersion: 1,
              mode: "stripe",
              publishableKey: simulator.publishableKey,
              returnUrl: simulator.returnUrl,
              // Apple Pay / Google Pay only on the domain registered and verified with Stripe.
              wallets:
                simulator.walletDomain !== null &&
                new URL(origin).hostname === simulator.walletDomain,
              // Wire name kept for installed apps: the Store's address opens pickup ordering
              // (`/bff/customer/pickup-entry`), in InternalTest and in a Pilot Store alike.
              internalTestEntry: true,
            }
          : { schemaVersion: 1, mode: "simulation", internalTestEntry: true },
      );
    });
    if (isStripeProvider(simulator)) {
      // The guest's ephemeral Stripe client credential, re-authorized against the current
      // Guest, Order, payment window and owner fences before and after the Stripe read.
      const history = createPostgresPaymentIntentCreationStore(
        resources.transactions,
        resources.scope,
        { now: resources.now, generateObservationReference: resources.credentials.reference },
      );
      app.post(
        "/api/v1/checkout-sessions/:checkout_session_id/payment-handoff",
        express.json({ limit: "2kb", strict: true }),
        new CustomerPaymentHandoffHandler({
          allowedOrigin: origin,
          port: {
            async retrieve(input) {
              const prepared = await intents.resolveRequest(input);
              return createCustomerSessionPaymentHandoff({
                access: checkout.accessOptions,
                history,
                transactions: resources.transactions,
                currentAdmission: () => prepared.admission,
                allowConfirmation: async () => true,
                provider: simulator.handoff,
              }).retrieve(input);
            },
          },
        }).handler(),
      );
    }
    for (const [path, confirmation] of simulator.simulation === true
      ? [
          ["simulation-confirm", "SIMULATE_CAPTURE"],
          ["simulation-fail", "SIMULATE_FAILURE"],
        ]
      : []) {
      const handler = new CustomerPaymentIntentHandler({
        allowedOrigin: origin,
        port: {
          async create(input) {
            await terminal.confirm(input, confirmation);
            return intents.create(input);
          },
          // WP-2423 Q20: another (simulated) card after a decline, on the same payment.
          async retry(input) {
            return (await terminal.confirm(input, confirmation, { retry: true })).created;
          },
          // WP-2423 abandoned payment: confirm the guest's open attempt after they came back.
          async resume(input) {
            return (await terminal.confirm(input, confirmation, { resume: true })).created;
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
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host, connection: "close" },
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
    // WP-2423 (v15 run): hashed build files are cached for a year and sent compressed; the app
    // pages and other unhashed files are revalidated so a deploy is picked up.
    // WP-2423 menu descriptions and photos: published product photo sizes, named by content hash.
    if (productImageDirectory !== undefined)
      app.get("/media/images/:name", createPilotProductImages(productImageDirectory).fileHandler);
    const assets = resolve("apps/customer-pwa/dist");
    app.use(createPilotStaticAssets(assets));
    const merchantAssets = resolve("apps/merchant-web/dist");
    app.use(createPilotStaticAssets(merchantAssets));
    app.use("/assets", missingPilotAsset);
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
    server.listen(listenPort, "127.0.0.1", () =>
      process.stdout.write(
        "Pilot customer HTTPS listening on 127.0.0.1:" + server.address().port + "\n",
      ),
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
