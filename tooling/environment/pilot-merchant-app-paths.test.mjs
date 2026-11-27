import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { merchantRoutes } from "../../apps/merchant-web/src/pilot-routes.ts";
import { pilotMerchantAppPaths } from "./pilot-merchant-app-paths.mjs";

// v15 2026-11-02: platform support signed in and got the customer app's "Page not found": the HTTPS
// entry sent only /app and /operations to the merchant app. Its real route list, every merchant
// screen's sample address.
const express = createRequire(new URL("../../apps/api/package.json", import.meta.url))("express");
const directory = mkdtempSync(path.join(os.tmpdir(), "merchant-paths-"));
let server, origin;
beforeAll(async () => {
  writeFileSync(path.join(directory, "merchant.html"), "merchant app");
  writeFileSync(path.join(directory, "customer.html"), "customer app");
  const app = express();
  app.get([...pilotMerchantAppPaths], (_req, res) =>
    res.sendFile(path.join(directory, "merchant.html")),
  );
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(directory, "customer.html")));
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
afterAll(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});
const page = async (address) => (await globalThis.fetch(origin + address)).text();

it("the server's own file sends this list to the merchant app", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./pilot-customer-server.mjs", import.meta.url), "utf8");
  expect(source).toContain("app.get([...pilotMerchantAppPaths]");
});
it("every merchant screen is served the merchant app, and guests keep theirs", async () => {
  expect(merchantRoutes.length).toBeGreaterThan(20);
  for (const route of merchantRoutes)
    if (!route.sample.startsWith("/internal-test"))
      expect(await page(route.sample), route.sample).toBe("merchant app");
  expect(await page("/platform/support-cases")).toBe("merchant app");
  for (const address of ["/", "/menu", "/cart", "/checkout"])
    expect(await page(address), address).toBe("customer app");
});
