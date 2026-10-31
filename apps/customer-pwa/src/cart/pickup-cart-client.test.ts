import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPickupCartClient } from "./pickup-cart-client.js";
import { createConfigureController } from "../menu/configure-state.js";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
import type { CartView } from "./types.js";
const id = (n: number) => `018f9900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const source = "s".repeat(43),
  candidate = "c".repeat(43),
  proof = "p".repeat(43);
const view: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 1,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-09-10T00:00:00.000Z",
      absoluteExpiresAt: "2026-09-10T00:00:00.000Z",
    },
    items: [],
    quote: null,
    warnings: [],
  },
};
const draft = { quantity: 1, optionSelections: [], customerNote: null };
function fixture() {
  const state = {
    current: null as CartView | null,
    loseActivation: false,
    loseAdd: false,
    unavailable: false,
    reset: false,
  };
  const calls: {
    url: string;
    key: string | null;
    csrf: string | null;
    body: string | undefined;
  }[] = [];
  const response = (status: number, value: unknown) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      key: headers.get("idempotency-key"),
      csrf: headers.get("x-csrf-token"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url === "/bff/customer/cart")
      return state.current
        ? response(200, state.current)
        : response(404, {
            schemaVersion: 1,
            error: { code: "cart_not_found", messageKey: "customer.cart.not_found" },
          });
    if (state.unavailable)
      return response(503, {
        error: {
          code: "cart_binding_unavailable",
          messageKey: "customer.cart.binding_unavailable",
        },
      });
    if (url.endsWith("/prepare"))
      return response(200, {
        status: "Prepared",
        operationReference: headers.get("idempotency-key"),
        candidateCsrfToken: candidate,
        recoveryProof: proof,
        expiresAt: "2026-09-10T00:00:00.000Z",
      });
    if (url.endsWith("/activate") || url.endsWith("/complete")) {
      state.current = view;
      if (state.reset) setCustomerCsrfCredential(source);
      if (state.loseActivation) {
        state.loseActivation = false;
        throw new Error("synthetic response loss");
      }
      return response(200, {
        status: "Activated",
        operationReference: headers.get("idempotency-key"),
        csrfToken: candidate,
      });
    }
    if (url.endsWith("/items")) {
      state.current = {
        ...view,
        cart: {
          ...view.cart,
          version: 2,
          items: [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: "Synthetic tea",
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
              warnings: [],
            },
          ],
        },
      };
      if (state.loseAdd) {
        state.loseAdd = false;
        throw new Error("synthetic item acknowledgement loss");
      }
      return response(200, state.current);
    }
    throw new Error("unexpected route");
  });
  vi.stubGlobal("fetch", fetch);
  setCustomerCsrfCredential(source);
  return { state, calls, fetch, client: createBrowserPickupCartClient() };
}
afterEach(() => {
  setCustomerCsrfCredential(null);
  vi.unstubAllGlobals();
});
describe("browser Pickup Cart composition", () => {
  it("constructs without I/O and keeps current-Cart reads side-effect free", async () => {
    const f = fixture();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.client.loadCurrent()).toBeNull();
    expect(f.calls.map((x) => x.url)).toEqual(["/bff/customer/cart"]);
    expect(getCustomerCsrfCredential()).toBe(source);
  });
  it("reuses an existing current Cart without binding", async () => {
    const f = fixture();
    f.state.current = view;
    expect(await f.client.createCart({ operationReference: id(20) })).toEqual(view);
    expect(f.calls.map((x) => x.url)).toEqual(["/bff/customer/cart"]);
  });
  it("prepares a distinct UUIDv7 and hands off the shared credential before reading", async () => {
    const f = fixture();
    expect(await f.client.createCart({ operationReference: id(20) })).toEqual(view);
    expect(f.calls.map((x) => x.url)).toEqual([
      "/bff/customer/cart",
      "/bff/customer/cart-binding/prepare",
      "/bff/customer/cart-binding/activate",
      "/bff/customer/cart",
    ]);
    const preparation = f.calls[1];
    expect(preparation?.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(preparation?.key).not.toBe(id(20));
    expect(f.calls[2]?.key).toBe(preparation?.key);
    expect(getCustomerCsrfCredential()).toBe(candidate);
  });
  it("recovers the original binding after activation acknowledgement loss", async () => {
    const f = fixture();
    f.state.loseActivation = true;
    await expect(f.client.createCart({ operationReference: id(20) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(getCustomerCsrfCredential()).toBe(source);
    expect(await f.client.createCart({ operationReference: id(20) })).toEqual(view);
    const prepare = f.calls.filter((x) => x.url.endsWith("/prepare"));
    const complete = f.calls.filter((x) => x.url.endsWith("/complete"));
    expect(prepare).toHaveLength(1);
    expect(complete).toHaveLength(1);
    expect(complete[0]?.key).toBe(prepare[0]?.key);
    expect(complete[0]?.csrf).toBe(candidate);
  });
  it("connects real configure orchestration and reuses the original Add after an unknown response", async () => {
    const f = fixture();
    f.state.loseAdd = true;
    let key = 20;
    const controller = createConfigureController({ client: f.client, keyFactory: () => id(key++) });
    await controller.submit(id(3), draft);
    expect(controller.getState()).toMatchObject({ status: "outcome-unknown" });
    const before = f.calls.length;
    controller.setOnline(false);
    controller.setOnline(true);
    expect(f.calls).toHaveLength(before);
    await controller.retry();
    expect(controller.getState()).toMatchObject({
      status: "added",
      cart: { cart: { version: 2 } },
    });
    const adds = f.calls.filter((x) => x.url.endsWith("/items"));
    expect(adds).toHaveLength(2);
    expect(adds[1]).toEqual(adds[0]);
    expect(adds[0]?.csrf).toBe(candidate);
    expect(f.calls.filter((x) => x.url.endsWith("/prepare"))).toHaveLength(1);
    expect(f.calls.some((x) => x.url === "/api/v1/carts")).toBe(false);
  });
  it("leaves an unavailable binding provider unresolved without adding", async () => {
    const f = fixture();
    f.state.unavailable = true;
    await expect(f.client.createCart({ operationReference: id(20) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(getCustomerCsrfCredential()).toBe(source);
    expect(f.calls.some((x) => x.url.endsWith("/activate") || x.url.endsWith("/items"))).toBe(
      false,
    );
  });
  it("denies offline creation before any request", async () => {
    const f = fixture();
    vi.stubGlobal("navigator", { onLine: false });
    await expect(f.client.createCart({ operationReference: id(20) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(f.calls).toEqual([]);
  });
  it("cannot publish into the same-valued newer shared context", async () => {
    const f = fixture();
    f.state.reset = true;
    await expect(f.client.createCart({ operationReference: id(20) })).rejects.toMatchObject({
      code: "network_unknown",
    });
    expect(getCustomerCsrfCredential()).toBe(source);
    expect(f.calls.filter((x) => x.url === "/bff/customer/cart")).toHaveLength(1);
  });
});
