import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceStaffSignInEnded,
  backgroundReadAllowed,
  gateStaffSignInFetch,
  installStaffSignInFetchGate,
  setStaffSessionEnded,
  staffSessionEnded,
  subscribeSignedInRequestRefused,
  subscribeStaffSessionEnded,
  subscribeStaffSignInEndedElsewhere,
  usesStaffSignIn,
} from "./staff-session-reads.js";

afterEach(() => setStaffSessionEnded(false));

describe("v15 cbff9d6f: no reads with a sign-in that has ended", () => {
  it("stops background reads while the sign-in has ended and allows them again after", () => {
    expect(backgroundReadAllowed(true)).toBe(true);
    expect(backgroundReadAllowed(false)).toBe(false);
    setStaffSessionEnded(true);
    expect(staffSessionEnded()).toBe(true);
    expect(backgroundReadAllowed(true)).toBe(false);
    setStaffSessionEnded(false);
    expect(backgroundReadAllowed(true)).toBe(true);
  });

  it("tells every subscribed screen once per change, and stops telling unsubscribed ones", () => {
    const first = vi.fn(),
      second = vi.fn();
    const stopFirst = subscribeStaffSessionEnded(first);
    const stopSecond = subscribeStaffSessionEnded(second);
    setStaffSessionEnded(true);
    setStaffSessionEnded(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    setStaffSessionEnded(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it("treats a page without a document (server render) as visible", () => {
    expect(backgroundReadAllowed()).toBe(true);
    setStaffSessionEnded(true);
    expect(backgroundReadAllowed()).toBe(false);
  });
});

describe("v15 37e0ecbe: refused reads check the sign-in; nothing is sent after it ended", () => {
  const base = () => "https://store.example/app";
  const answer = (status: number) =>
    vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status })));

  it("knows which requests use the staff sign-in and which are the sign-in plumbing", () => {
    for (const path of [
      "/merchant/orders",
      "/merchant/pickup/query",
      "/merchant/operations-alerts",
      "/merchant/staff-pin",
      "/merchant/sessions",
    ])
      expect(usesStaffSignIn(path, base())).toBe(true);
    for (const path of [
      "/merchant/session",
      "/merchant/session/expiry",
      "/merchant/session/activity",
      "/merchant/sign-in-entry",
      "/merchant/logout",
      "/merchant/staff-switch",
      "/merchant/staff-switch/refund-recheck",
      "/platform/templates",
      "https://elsewhere.example/merchant/orders",
    ])
      expect(usesStaffSignIn(path, base())).toBe(false);
    expect(usesStaffSignIn(new URL("https://store.example/merchant/orders"), base())).toBe(true);
    expect(usesStaffSignIn(new Request("https://store.example/merchant/logout"), base())).toBe(
      false,
    );
  });

  it("reports a 401 or 403 on a signed-in request, and nothing else", async () => {
    const refused = vi.fn();
    const stop = subscribeSignedInRequestRefused(refused);
    for (const status of [200, 404, 409, 503]) {
      await gateStaffSignInFetch(answer(status), base)("/merchant/orders");
    }
    expect(refused).not.toHaveBeenCalled();
    await gateStaffSignInFetch(answer(403), base)("/merchant/pickup/query", { method: "POST" });
    await gateStaffSignInFetch(answer(401), base)("/merchant/orders");
    expect(refused).toHaveBeenCalledTimes(2);
    // The deadline check's own answers are the guard's to read, not a refused read.
    await gateStaffSignInFetch(answer(401), base)("/merchant/session/expiry");
    await gateStaffSignInFetch(answer(403), base)("/merchant/staff-switch/refund-recheck");
    expect(refused).toHaveBeenCalledTimes(2);
    stop();
  });

  it("sends no signed-in request after the sign-in ended, but still the sign-in plumbing", async () => {
    const original = answer(200);
    const gated = gateStaffSignInFetch(original, base);
    setStaffSessionEnded(true);
    await expect(gated("/merchant/pickup/query", { method: "POST" })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(gated("/merchant/orders")).rejects.toMatchObject({ name: "AbortError" });
    expect(original).not.toHaveBeenCalled();
    await gated("/merchant/session/expiry");
    await gated("/merchant/sign-in-entry");
    await gated("/merchant/staff-switch/refund-recheck", { method: "POST" });
    await gated("/merchant/logout", { method: "POST" });
    expect(original).toHaveBeenCalledTimes(4);
    // "Check again" found the sign-in valid: reads go out again.
    setStaffSessionEnded(false);
    await gated("/merchant/orders");
    expect(original).toHaveBeenCalledTimes(5);
  });

  it("sends no signed-in request from a page being closed, and again after a back/forward restore", async () => {
    const original = answer(200);
    const target = new EventTarget() as EventTarget & { fetch: typeof fetch; location: Location };
    target.fetch = original;
    target.location = { href: "https://store.example/app" } as Location;
    installStaffSignInFetchGate(target as unknown as typeof globalThis);
    const gated = target.fetch;
    expect(gated).not.toBe(original);
    target.dispatchEvent(new Event("pagehide"));
    await expect(gated(`https://store.example/merchant/pickup/query`)).rejects.toMatchObject({
      name: "AbortError",
    });
    await gated(`https://store.example/merchant/session/expiry`);
    expect(original).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event("pageshow"));
    await gated(`https://store.example/merchant/pickup/query`);
    expect(original).toHaveBeenCalledTimes(2);
    // Installed once per tab.
    installStaffSignInFetchGate(target as unknown as typeof globalThis);
    expect(target.fetch).toBe(gated);
  });

  it("tells the other tabs, not this one, that the sign-in ended", async () => {
    const here = vi.fn();
    const stop = subscribeStaffSignInEndedElsewhere(here);
    const otherTab = new BroadcastChannel("bop-staff-session");
    const heard = new Promise<unknown>((resolve) => {
      otherTab.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
    });
    announceStaffSignInEnded();
    expect(await heard).toMatchObject({ kind: "SignInEnded" });
    // A message from another tab reaches this one.
    const elsewhere = new BroadcastChannel("bop-staff-session");
    const reached = new Promise<void>((resolve) => here.mockImplementation(() => resolve()));
    elsewhere.postMessage({ kind: "SignInEnded", from: "another-tab" });
    await reached;
    expect(here).toHaveBeenCalledTimes(1);
    elsewhere.close();
    otherTab.close();
    stop();
  });
});
