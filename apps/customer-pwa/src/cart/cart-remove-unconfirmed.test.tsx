import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartPage } from "./CartPage.js";
import { createBrowserCustomerCartClient, setCustomerCartCsrfCredential } from "./cart-client.js";
import {
  createCartStateController,
  type CartState,
  type CartStateController,
} from "./cart-state.js";
import type { CartView } from "./types.js";
import { LanguageRoot } from "../i18n/i18n.js";

// WP-2423 shared-table-checkout (d): a remove the Store's side answered 503 is "not confirmed".
// The guest is told plainly that the network or the store was busy and that trying again won't
// change it twice, and the one button resends the same change with the same key.

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function tableCart(version: number, withLine: boolean): CartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: withLine
        ? [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: "Synthetic noodles",
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
              warnings: [],
            },
          ]
        : [],
      quote: null,
      warnings: [],
    },
  };
}

function pageFor(state: CartState): string {
  const controller: CartStateController = {
    getState: () => state,
    load: async () => undefined,
    refresh: async () => true,
    removeItem: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
    updateItem: async () => undefined,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={controller} />
    </MemoryRouter>,
  );
}

const unconfirmed: CartState = {
  status: "command-failed",
  cart: tableCart(3, true),
  issueCodes: [],
  retryAfterSeconds: null,
  canRetrySameOperation: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCustomerCartCsrfCredential(null);
  renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
});

describe("A remove the store couldn't confirm", () => {
  // Regression lock (passes on bc7e2965 too): the retry logic already existed; this proves it
  // through a real HTTP 503, not a synthetic client error.
  it("retries a 503 remove through HTTP with the same Idempotency-Key and the line goes", async () => {
    setCustomerCartCsrfCredential("c".repeat(43));
    const deletes: string[] = [];
    let deleteCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "GET") return new Response(JSON.stringify(tableCart(3, true)));
        if (init.method !== "DELETE") throw new Error(`unexpected ${init.method}`);
        deletes.push(String((init.headers as Record<string, string>)["idempotency-key"]));
        deleteCount += 1;
        if (deleteCount === 1)
          return new Response(JSON.stringify({ error: { code: "cart_service_unavailable" } }), {
            status: 503,
          });
        return new Response(JSON.stringify(tableCart(4, false)));
      }),
    );
    let key = 40;
    const controller = createCartStateController({
      client: createBrowserCustomerCartClient(),
      keyFactory: () => id(key++),
    });
    await controller.load();
    await controller.removeItem(id(2));
    expect(controller.getState()).toMatchObject({
      status: "command-failed",
      canRetrySameOperation: true,
    });
    await controller.retry();
    expect(deletes).toEqual([id(40), id(40)]);
    const state = controller.getState();
    expect(state.status).toBe("ready");
    expect("cart" in state ? state.cart?.cart.items : null).toEqual([]);
  });

  it("says in English that the network or the store was busy, and offers to try again", () => {
    const html = pageFor(unconfirmed);
    expect(html).toContain("We couldn’t confirm this change");
    expect(html).toContain(
      "The network or the store’s system was busy. Trying again won’t change it twice.",
    );
    expect(html).toMatch(/<button[^>]*>Try this again<\/button>/u);
    expect(html).not.toContain("Retry the same operation");
    expect(html).not.toContain("connection dropped");
  });

  it("says it in Chinese without blaming the guest's connection", () => {
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    const html = pageFor(unconfirmed);
    expect(html).toContain("还没确认这次修改");
    expect(html).toContain("可能是网络或店里系统忙。再试一次不会重复修改。");
    expect(html).toMatch(/<button[^>]*>再试一次<\/button>/u);
    expect(html).not.toContain("重试同一操作");
    expect(html).not.toContain("网络中断");
  });
});
