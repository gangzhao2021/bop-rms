import { Buffer } from "node:buffer";
import { expect, it, vi } from "vitest";
import { createCustomerStoreRouting } from "./pilot-customer-store-routing.mjs";

const ref = (n) => "018f4f8a-9c2d-7a11-8d01-" + String(n).padStart(12, "0");
const store = (n, tenant, sessions = []) => ({
  storeReference: ref(n),
  brandReference: ref(tenant + 50),
  tenantReference: ref(tenant),
  publicStoreReference: ref(n + 100),
  transactions: { sessions },
  // Each Store hashes with its own key: the same cookie is a different selector at each.
  hashSession: (credential) => n + ":" + credential,
});
const routing = (stores) =>
  createCustomerStoreRouting({
    stores,
    createSessions: (transactions) => ({
      resolve: async (selector) => (transactions.sessions.includes(selector) ? {} : null),
    }),
  });
const cookieOf = (value) => "__Host-bop-guest=" + value;
const credential = "a".repeat(43);
const entry = (publicStoreReference) => ({
  method: "POST",
  url: "/bff/customer/entry",
  body: Buffer.from(
    JSON.stringify({
      qrToken:
        "x." + Buffer.from(JSON.stringify({ publicStoreReference })).toString("base64url") + ".y",
    }),
  ),
});
const menu = (reference) => ({
  method: "GET",
  url: "/api/v1/public/stores/" + reference + "/menu",
});
const other = { method: "GET", url: "/bff/customer/session" };

it("DEC-MULTI-MERCHANT-ONE-INSTALLATION: a request no merchant owns reaches no merchant's Store", async () => {
  const storeOf = routing([store(1, 1), store(2, 2)]);
  const unknown = ref(999);
  expect(await storeOf(menu(unknown))).toBeNull();
  expect(await storeOf(entry(unknown))).toBeNull();
  expect(await storeOf({ ...entry("not-a-reference") })).toBeNull();
  expect(await storeOf(other)).toBeNull();
  expect(await storeOf({ ...other, cookie: cookieOf(credential) })).toBeNull();
});

it("a fresh browser's CSRF token comes from the first Store: it names no merchant's data", async () => {
  const first = store(1, 1);
  const storeOf = routing([first, store(2, 2)]);
  expect(await storeOf({ method: "GET", url: "/api/v1/customer/session/csrf" })).toBe(first);
  expect(await storeOf({ method: "GET", url: "/bff/customer/payment-configuration" })).toBe(first);
  // A guest of a Store gets it from their own Store.
  const second = store(2, 2, ["2:" + credential]);
  expect(
    await routing([first, second])({
      method: "GET",
      url: "/api/v1/customer/session/csrf",
      cookie: cookieOf(credential),
    }),
  ).toBe(second);
});

it("routes a guest to their own merchant's Store by server-side records", async () => {
  const a = store(1, 1),
    b = store(2, 2, ["2:" + credential]);
  const storeOf = routing([a, b]);
  expect((await storeOf(menu(a.publicStoreReference))).storeReference).toBe(a.storeReference);
  expect((await storeOf(menu(b.publicStoreReference))).storeReference).toBe(b.storeReference);
  expect((await storeOf(entry(b.publicStoreReference))).storeReference).toBe(b.storeReference);
  expect((await storeOf({ ...other, cookie: cookieOf(credential) })).storeReference).toBe(
    b.storeReference,
  );
});

it("remembers a found Session and keeps checking the other Stores when one hash fails", async () => {
  const resolve = vi.fn(async (selector) => (selector === "2:" + credential ? {} : null));
  const broken = {
    ...store(1, 1),
    hashSession: () => {
      throw new Error("key");
    },
  };
  const storeOf = createCustomerStoreRouting({
    stores: [broken, store(2, 2)],
    createSessions: () => ({ resolve }),
  });
  const request = { ...other, cookie: cookieOf(credential) };
  expect((await storeOf(request)).storeReference).toBe(ref(2));
  expect((await storeOf(request)).storeReference).toBe(ref(2));
  expect(resolve).toHaveBeenCalledOnce();
});

it("Stores of one Tenant still fall back to the installation's first Store", async () => {
  const first = store(1, 1);
  const storeOf = routing([first, store(2, 1)]);
  expect(await storeOf(other)).toBe(first);
  expect(await storeOf(menu(ref(999)))).toBe(first);
  expect(await storeOf(entry(ref(999)))).toBe(first);
});
