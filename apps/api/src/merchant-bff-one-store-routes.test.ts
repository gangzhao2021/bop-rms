import express from "express";
import { afterEach, expect, it } from "vitest";
import { installMerchantCommerceRoutes } from "./merchant-bff-commerce-routes.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { MerchantMenuError } from "./merchant-menus.js";

const servers: import("node:http").Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * v15 2026-10-29: "List it" on the one-page menu answered ReviewBlocked without what the menu review
 * named missing, so staff saw only the generic text. The one-page route now passes it on.
 */
it("passes on what a blocked menu review names, from the one-page menu's List it", async () => {
  const problem = {
    missing: "Stopped",
    reason: "AllergenEvidenceDiffers",
    productName: "二人套餐",
    sizeName: null,
    optionName: null,
    quantity: null,
    ingredientName: null,
  };
  const options = {
    exactOrigin: "https://merchant.invalid",
    oneStoreDishes: {
      command: async () => {
        throw new MerchantMenuError("ReviewBlocked", problem as never);
      },
    },
  } as unknown as MerchantBffRouterOptions;
  const app = express();
  app.use(express.json());
  const router = express.Router();
  installMerchantCommerceRoutes(router, options);
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/commerce/one-store-dishes/command`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://merchant.invalid",
        "sec-fetch-site": "same-origin",
        "x-bop-csrf": "csrf",
        cookie: "__Host-bop-merchant=session",
      },
      body: JSON.stringify({ action: "ListAll" }),
    },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "ReviewBlocked", part: "Menu", problem });
});
