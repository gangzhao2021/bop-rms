import express from "express";
import { afterEach, expect, it } from "vitest";
import { installMerchantCommerceRoutes } from "./merchant-bff-commerce-routes.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { MerchantMenuError } from "./merchant-menus.js";
import { MerchantOneStoreDishError } from "./merchant-one-store-dishes.js";

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

const post = async (options: MerchantBffRouterOptions, path: string, body: unknown) => {
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
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://merchant.invalid",
      "sec-fetch-site": "same-origin",
      "x-bop-csrf": "csrf",
      cookie: "__Host-bop-merchant=session",
    },
    body: JSON.stringify(body),
  });
};

/**
 * WP-2423 item 3: a save that stopped after the dish was made names the dish, so saving again
 * continues it instead of making a second one, and the page shows "stopped part-way".
 */
it("a dish save that stopped says which dish exists, as a stop and never as a refusal", async () => {
  const product = "019a0000-0000-7000-8000-000000000001";
  const options = {
    exactOrigin: "https://merchant.invalid",
    oneStoreDishes: {
      command: async () => {
        throw Object.assign(new MerchantOneStoreDishError("StoppedPartWay"), {
          productReference: product,
        });
      },
    },
  } as unknown as MerchantBffRouterOptions;
  const response = await post(options, "/commerce/one-store-dishes/command", {
    action: "SaveDish",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "StoppedPartWay",
    part: "OneStoreDish",
    productReference: product,
  });
});

it("the Option prices read takes nothing (every dish) or one dish, and nothing else", async () => {
  const product = "019a0000-0000-7000-8000-000000000002";
  const asked: unknown[] = [];
  const options = {
    exactOrigin: "https://merchant.invalid",
    optionPrices: {
      query: async (input: { productReference?: unknown; usual?: unknown }) => {
        asked.push([input.productReference, input.usual]);
        return { products: [] };
      },
    },
  } as unknown as MerchantBffRouterOptions;
  const path = "/commerce/option-prices/query";
  expect((await post(options, path, {})).status).toBe(200);
  expect((await post(options, path, { productReference: product })).status).toBe(200);
  expect((await post(options, path, { productReference: null })).status).toBe(200);
  expect(asked).toEqual([
    [undefined, undefined],
    [product, true],
    [null, true],
  ]);
  for (const bad of [
    { productReference: "not-a-reference" },
    { productReference: product, usual: true },
    { other: 1 },
  ])
    expect((await post(options, path, bad)).status).toBe(403);
  expect(asked).toHaveLength(3);
});
