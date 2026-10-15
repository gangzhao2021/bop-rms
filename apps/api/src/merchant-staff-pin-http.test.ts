import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MerchantStaffPinError, type createMerchantStaffPin } from "./merchant-staff-pin.js";
import {
  fullSignInMutationPaths,
  installMerchantStaffPinRoutes,
  resolveStaffSignInEntry,
  staffPinFullSignInGate,
  staffSwitchPath,
} from "./merchant-staff-pin-http.js";

/** WP-2423 Q18 option A: the shared-tablet staff PIN HTTP contract (ports stubbed). */
type Port = ReturnType<typeof createMerchantStaffPin>;
const origin = "https://127.0.0.1:4443";
const tablet = "t".repeat(43);
const fullSignIn = { path: "/internal-test/staff", testOnly: true };
let server: Server | null = null;
afterEach(async () => {
  const current = server;
  server = null;
  if (current) await new Promise((resolve) => current.close(resolve));
});
async function start(port: Partial<Port>) {
  const app = express();
  const router = express.Router();
  const options = { exactOrigin: origin, fullSignIn, staffPin: port as Port };
  router.use(staffPinFullSignInGate(options));
  installMerchantStaffPinRoutes(router, options);
  router.post("/payments/refunds/request", (_request, response) => response.json({ ok: true }));
  router.get("/sign-in-entry", (request, response) => {
    void resolveStaffSignInEntry(request, options).then((entry) => response.json(entry));
  });
  app.use("/merchant", router);
  const created = createServer(app);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const address = created.address();
  const base = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : 0);
  return (
    path: string,
    init: { method?: string; cookie?: string; body?: unknown; site?: string; from?: string } = {},
  ) =>
    globalThis.fetch(base + "/merchant" + path, {
      method: init.method ?? "POST",
      headers: {
        origin: init.from ?? origin,
        "sec-fetch-site": init.site ?? "same-origin",
        "content-type": "application/json",
        "x-bop-csrf": "c".repeat(43),
        ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
}

describe("staff PIN HTTP", () => {
  it("gates refunds, prices, staff, roles and Store payment settings of an unverified PIN session", async () => {
    for (const path of [
      "/payments/refunds/request",
      "/payments/refunds/approve",
      "/orders/cancel",
      "/orders/cancel-items",
      "/commerce/pricing/command",
      "/pricing/price-books",
      "/tax-config/authoring/commands",
      "/organization/roles/command",
      "/organization/staff/command",
      "/store-setup/payment-configuration",
    ])
      expect(fullSignInMutationPaths.has(path), path).toBe(true);
    for (const path of ["/orders/accept", "/kitchen/work", "/pickup/handoff", "/counter/orders"])
      expect(fullSignInMutationPaths.has(path), path).toBe(false);
    let required = true;
    const call = await start({ requiresFullSignIn: async () => required });
    const refused = await call("/payments/refunds/request", {
      cookie: "__Host-bop-merchant=" + "s".repeat(43),
      body: {},
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "full_sign_in_required" });
    required = false;
    expect(
      (
        await call("/payments/refunds/request", {
          cookie: "__Host-bop-merchant=" + "s".repeat(43),
          body: {},
        })
      ).status,
    ).toBe(200);
  });

  it("sends a registered tablet to the PIN screen and anyone else to the full sign-in", async () => {
    const call = await start({ isRegisteredDevice: async (cookie) => cookie === tablet });
    expect(
      await (
        await call("/sign-in-entry", { method: "GET", cookie: "__Host-bop-store-device=" + tablet })
      ).json(),
    ).toEqual({ path: staffSwitchPath, testOnly: false });
    expect(
      await (
        await call("/sign-in-entry", {
          method: "GET",
          cookie: "__Host-bop-store-device=" + "x".repeat(43),
        })
      ).json(),
    ).toEqual(fullSignIn);
    expect(await (await call("/sign-in-entry", { method: "GET" })).json()).toEqual(fullSignIn);
  });

  it("maps PIN outcomes without echoing the PIN and sets a strict session cookie", async () => {
    const outcomes = [
      { status: "SignedIn", sessionCookie: "n".repeat(43) },
      { status: "Rejected" },
      { status: "Locked", lockedUntil: "2026-10-14T20:15:00.000Z" },
      { status: "Throttled", retryAfterSeconds: 120 },
    ] as const;
    let index = 0;
    const seen: unknown[] = [];
    const call = await start({
      unlock: async (input) => {
        seen.push(input);
        return outcomes[index++] as never;
      },
    });
    const send = () =>
      call("/staff-switch/unlock", {
        cookie: "__Host-bop-store-device=" + tablet,
        body: { choice: "0190b3a0-0000-7000-8000-000000000003", pin: "482913" },
      });
    const signedIn = await send();
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toBe(
      "__Host-bop-merchant=" + "n".repeat(43) + "; Path=/; Secure; HttpOnly; SameSite=Strict",
    );
    expect(await signedIn.json()).toEqual({ status: "SignedIn", next: "/operations/orders" });
    const rejected = await send();
    expect([rejected.status, await rejected.text()]).toEqual([401, '{"error":"pin_rejected"}']);
    const locked = await send();
    expect([locked.status, await locked.json()]).toEqual([
      423,
      { error: "pin_locked", lockedUntil: "2026-10-14T20:15:00.000Z" },
    ]);
    const busy = await send();
    expect([busy.status, busy.headers.get("retry-after"), await busy.json()]).toEqual([
      429,
      "120",
      { error: "device_busy", retryAfterSeconds: 120 },
    ]);
    expect(seen[0]).toMatchObject({ deviceCookie: tablet, pin: "482913" });
    // No tablet cookie, a cross-site form, or extra fields are refused before any check.
    expect((await call("/staff-switch/unlock", { body: { choice: "a", pin: "1" } })).status).toBe(
      404,
    );
    expect(
      (
        await call("/staff-switch/unlock", {
          cookie: "__Host-bop-store-device=" + tablet,
          from: "https://evil.example",
          site: "cross-site",
          body: { choice: "a", pin: "1" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/staff-switch/unlock", {
          cookie: "__Host-bop-store-device=" + tablet,
          body: { choice: "a", pin: "1", extra: true },
        })
      ).status,
    ).toBe(403);
    expect(seen).toHaveLength(4);
  });

  it("clears the cookie of a tablet that is no longer registered", async () => {
    const call = await start({
      switchScreen: async () => {
        throw new MerchantStaffPinError("DeviceNotRegistered");
      },
    });
    const response = await call("/staff-switch", {
      method: "GET",
      cookie: "__Host-bop-store-device=" + tablet,
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-bop-store-device=; .*Max-Age=0$/u);
    expect(await response.json()).toEqual({ error: "device_not_registered", fullSignIn });
  });

  it("sets the tablet cookie HttpOnly, Secure and SameSite=Strict, never in the body", async () => {
    const call = await start({
      registerDevice: async () =>
        ({
          status: "Registered",
          deviceCookie: "d".repeat(43),
          device: {
            device: "0190b3a0-0000-7000-8000-000000000009",
            label: "Front counter",
            registeredAt: "2026-10-14T20:00:00.000Z",
            registeredBy: "Mia",
            lastUsedAt: null,
          },
        }) as never,
      setOwnPin: async () => {
        throw new MerchantStaffPinError("FullSignInRequired");
      },
    });
    const response = await call("/store-devices/register", {
      cookie: "__Host-bop-merchant=" + "s".repeat(43),
      body: { label: "Front counter" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-bop-store-device=" +
        "d".repeat(43) +
        "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000",
    );
    expect(JSON.stringify(await response.json())).not.toContain("d".repeat(43));
    const pin = await call("/staff-pin", {
      cookie: "__Host-bop-merchant=" + "s".repeat(43),
      body: { pin: "482913", confirmation: "482913" },
    });
    expect([pin.status, await pin.json()]).toEqual([403, { error: "full_sign_in_required" }]);
  });
});
