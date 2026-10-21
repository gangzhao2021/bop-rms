import { describe, expect, it, vi } from "vitest";
import { isPrivatePath } from "../pwa/service-worker-policy.js";
import { createOrderMessageOptionsClient } from "../checkout/order-messages-client.js";
import { redeemOrderRecovery, takeOrderRecoveryToken } from "./order-recovery.js";

const token = "A".repeat(43);
const order = "/orders/0190aa20-0000-7000-8000-000000000001";
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("DEC-PILOT-NOTIFICATIONS R1: one-time order link page", () => {
  it("takes the token from the fragment and clears the address bar first", () => {
    const replaceState = vi.fn();
    expect(
      takeOrderRecoveryToken({
        pathname: "/resume",
        search: "",
        hash: `#t=${token}`,
        replaceState,
      }),
    ).toBe(token);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/resume");
  });

  it.each([
    { search: "?t=x", hash: `#t=${token}` },
    { search: "", hash: "#t=short" },
    { search: "", hash: `#resume=${token}` },
  ])("refuses any other shape but still clears the address bar %#", ({ search, hash }) => {
    const replaceState = vi.fn();
    expect(takeOrderRecoveryToken({ pathname: "/resume", search, hash, replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/resume");
  });

  it("ignores other pages", () => {
    const replaceState = vi.fn();
    expect(
      takeOrderRecoveryToken({ pathname: "/", search: "", hash: `#t=${token}`, replaceState }),
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("posts the token once in the body (never the URL) and opens only a clean order path", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      reply(200, { schemaVersion: 1, redirectPath: order }),
    );
    await expect(redeemOrderRecovery(fetcher, token)).resolves.toEqual({
      kind: "Open",
      path: order,
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/v1/customer/order-recovery");
    expect(String(url)).not.toContain(token);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ token });
  });

  it.each([
    [400, { schemaVersion: 1, error: { code: "order_link_unavailable" } }, "Expired"],
    [429, {}, "TooManyTries"],
    [503, {}, "TryAgain"],
    [200, { schemaVersion: 1, redirectPath: "https://elsewhere.example/orders/x" }, "Expired"],
  ])("maps %s to one plain outcome", async (status, body, kind) => {
    await expect(redeemOrderRecovery(async () => reply(status, body), token)).resolves.toEqual({
      kind,
    });
  });

  it("treats a network failure as try again", async () => {
    await expect(
      redeemOrderRecovery(async () => {
        throw new TypeError("offline");
      }, token),
    ).resolves.toEqual({ kind: "TryAgain" });
  });

  it("keeps /resume out of the service worker cache", () => {
    expect(isPrivatePath("/resume")).toBe(true);
  });
});

describe("DEC-PILOT-NOTIFICATIONS: order message options", () => {
  it("reads which channels can send", async () => {
    const client = createOrderMessageOptionsClient(async () =>
      reply(200, { schemaVersion: 1, orderMessages: { sms: true, email: false } }),
    );
    await expect(client.read()).resolves.toEqual({ sms: true, email: false });
  });
  it("offers nothing when the answer is missing or malformed", async () => {
    for (const fetcher of [
      async () => reply(503, {}),
      async () => reply(200, { orderMessages: { sms: true } }),
      async () => {
        throw new TypeError("offline");
      },
    ])
      await expect(createOrderMessageOptionsClient(fetcher).read()).resolves.toEqual({
        sms: false,
        email: false,
      });
  });
});
