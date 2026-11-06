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
  // M02: a well-formed code of a Store not served now may be a Store that failed to load: a
  // retryable outage (no merchant answers it either way).
  await expect(storeOf(entry(unknown))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
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

it("order messages go to the guest's own Store, and without a cookie to no Store", async () => {
  const messages = { method: "GET", url: "/api/v1/customer/order-messages" };
  const second = store(2, 2, ["2:" + credential]);
  const storeOf = routing([store(1, 1), second]);
  expect(await storeOf({ ...messages, cookie: cookieOf(credential) })).toBe(second);
  // The first Store must not answer for another merchant: a guest could be promised a text that
  // never comes.
  expect(await storeOf(messages)).toBeNull();
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
  // M02: a scan naming a Store not served now is an outage, not the first Store's refusal.
  await expect(storeOf(entry(ref(999)))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
  expect(await storeOf(entry("not-a-reference"))).toBe(first);
});

// M02 (v15 07b7a1b7): a reload replays the scan that started no visit yet; it must reach the
// Store that was scanned, never the installation's first one.
const token = (publicStoreReference) =>
  "x." + Buffer.from(JSON.stringify({ publicStoreReference })).toString("base64url") + ".y";
const resume = (cookie) => ({
  method: "POST",
  url: "/bff/customer/entry",
  body: Buffer.from(JSON.stringify({ resume: true, intent: "Join" })),
  ...(cookie === undefined ? {} : { cookie }),
});

it("M02: a replayed scan goes to the scanned Store; without one, to no merchant", async () => {
  const a = store(1, 1),
    b = store(2, 2);
  const storeOf = routing([a, b]);
  expect(await storeOf(resume("x=1; __Secure-bop-scan=" + token(b.publicStoreReference)))).toBe(b);
  // The guest's Session cookie names no scan; a forged or doubled scan cookie names no Store.
  expect(await storeOf(resume(cookieOf(credential)))).toBeNull();
  expect(await storeOf(resume())).toBeNull();
  expect(await storeOf(resume("__Secure-bop-scan=" + token("not-a-reference")))).toBeNull();
  const twice = "__Secure-bop-scan=" + token(b.publicStoreReference);
  expect(await storeOf(resume(twice + "; " + twice))).toBeNull();
});

it("M02: a scan of a Store not served now is unavailable, never another Store (one Tenant too)", async () => {
  // One Tenant, several Stores: anything unowned goes to the first Store, but a waiting scan of a
  // Store that failed to start must not (the first Store refuses the code and the scan is lost).
  const a = store(1, 1),
    b = store(2, 1);
  const storeOf = routing([a, b]);
  const down = "__Secure-bop-scan=" + token(ref(103));
  await expect(storeOf(resume(down))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
  expect(await storeOf(resume("__Secure-bop-scan=" + token(b.publicStoreReference)))).toBe(b);
  // No waiting scan: the first Store answers as one Store would (asks the guest to scan).
  expect(await storeOf(resume())).toBe(a);
  // A scan in the body still goes by its own code.
  expect(await storeOf({ ...entry(b.publicStoreReference), cookie: down })).toBe(b);
});

it("M02: a fresh scan of a Store not served now is unavailable, never 'no merchant' (several Tenants)", async () => {
  const a = store(1, 1),
    b = store(2, 2);
  const storeOf = routing([a, b]);
  await expect(storeOf(entry(ref(103)))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
  expect(await storeOf(entry(b.publicStoreReference))).toBe(b);
  // A code that names no Store at all is still no merchant's.
  expect(await storeOf(entry("not-a-reference"))).toBeNull();
});

it("M02: with only one Store of several served, a scan or replay of another is still unavailable", async () => {
  const a = store(1, 1);
  const resolve = vi.fn(async () => null);
  const storeOf = createCustomerStoreRouting({
    stores: [a],
    multiStore: true,
    createSessions: () => ({ resolve }),
  });
  const down = "__Secure-bop-scan=" + token(ref(103));
  await expect(storeOf(resume(down))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
  await expect(storeOf(entry(ref(103)))).rejects.toThrow("CUSTOMER_STORE_UNAVAILABLE");
  expect(await storeOf(resume("__Secure-bop-scan=" + token(a.publicStoreReference)))).toBe(a);
  expect(await storeOf(entry(a.publicStoreReference))).toBe(a);
  // No waiting scan: this Store asks the guest to scan. Everything else is this Store's, unread.
  expect(await storeOf(resume())).toBe(a);
  expect(await storeOf({ ...other, cookie: cookieOf(credential) })).toBe(a);
  expect(resolve).not.toHaveBeenCalled();
  // One Store and no other in stores.json: everything is its own, as before.
  const alone = createCustomerStoreRouting({ stores: [a], createSessions: () => ({ resolve }) });
  expect(await alone(resume(down))).toBe(a);
  expect(await alone(entry(ref(103)))).toBe(a);
});
