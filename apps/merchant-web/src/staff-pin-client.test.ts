import { describe, expect, it, vi } from "vitest";
import {
  checkNewPin,
  createStaffPinClient,
  isTrivialPin,
  parsePinStatus,
  parseStaffSwitch,
  parseStoreDevices,
  StaffPinError,
  storeClockTime,
  validDeviceLabel,
} from "./staff-pin-client.js";

const csrf = "a".repeat(43);
const at = "2026-10-14T19:45:00.000Z";
const entry = { path: "/internal-test/staff", testOnly: true };
const respond = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => Promise.resolve(new Response(JSON.stringify(body), { status })));
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as StaffPinError;
  }
  throw new Error("expected a failure");
};

describe("easy PIN rule", () => {
  it.each([
    "000000",
    "999999",
    "123456",
    "654321",
    "012345",
    "987654",
    "121212",
    "123123",
    "909090",
    "456456",
  ])("%s is too easy", (pin) => expect(isTrivialPin(pin)).toBe(true));
  it.each(["482913", "135790", "112233", "123457", "102938"])("%s is allowed", (pin) =>
    expect(isTrivialPin(pin)).toBe(false),
  );
  it("checks format, then match, then ease", () => {
    expect(checkNewPin("12345", "12345")).toBe("Format");
    expect(checkNewPin("12a456", "12a456")).toBe("Format");
    expect(checkNewPin("482913", "482914")).toBe("Mismatch");
    expect(checkNewPin("123456", "123456")).toBe("TooSimple");
    expect(checkNewPin("482913", "482913")).toBeNull();
  });
  it("accepts tablet names of 1 to 40 characters without control characters", () => {
    expect(validDeviceLabel("Front counter")).toBe(true);
    expect(validDeviceLabel("   ")).toBe(false);
    expect(validDeviceLabel("x".repeat(41))).toBe(false);
    expect(validDeviceLabel("Front\u0007counter")).toBe(false);
  });
});

describe("parsing", () => {
  it("reads the staff list and the not-set-up answer as closed records", () => {
    const read = parseStaffSwitch(200, {
      storeLabel: "Queen St",
      timeZone: "America/Toronto",
      staff: [{ choice: "c-1", name: "Ana" }],
      fullSignIn: entry,
    });
    expect(read).toEqual({
      kind: "Ready",
      storeLabel: "Queen St",
      timeZone: "America/Toronto",
      staff: [{ choice: "c-1", name: "Ana" }],
      fullSignIn: entry,
    });
    expect(parseStaffSwitch(404, { error: "device_not_registered", fullSignIn: entry })).toEqual({
      kind: "NotRegistered",
      fullSignIn: entry,
    });
    expect(() =>
      parseStaffSwitch(200, {
        storeLabel: "Queen St",
        timeZone: "America/Toronto",
        staff: [],
        fullSignIn: entry,
        extra: 1,
      }),
    ).toThrow(StaffPinError);
    expect(() =>
      parseStaffSwitch(200, {
        storeLabel: "Queen St",
        timeZone: "Not/AZone",
        staff: [],
        fullSignIn: entry,
      }),
    ).toThrow(StaffPinError);
    expect(() =>
      parseStaffSwitch(200, {
        storeLabel: "Queen St",
        timeZone: "America/Toronto",
        staff: [],
        fullSignIn: { path: "https://elsewhere.example/", testOnly: false },
      }),
    ).toThrow(StaffPinError);
  });
  it("reads PIN status and the tablets page, keeping hidden sections as null", () => {
    expect(
      parsePinStatus({
        pin: { state: "Set", changedAt: at, lockedUntil: null },
        signIn: "Pin",
        verifiedUntil: null,
      }),
    ).toEqual({
      pin: { state: "Set", changedAt: at, lockedUntil: null },
      signIn: "Pin",
      verifiedUntil: null,
    });
    expect(() =>
      parsePinStatus({
        pin: { state: "Unknown", changedAt: null, lockedUntil: null },
        signIn: "Pin",
        verifiedUntil: null,
      }),
    ).toThrow(StaffPinError);
    expect(parseStoreDevices({ thisDevice: null, devices: null, staffPins: null })).toEqual({
      thisDevice: null,
      devices: null,
      staffPins: null,
    });
    const read = parseStoreDevices({
      thisDevice: { device: "d-1", label: "Front counter" },
      devices: [
        {
          device: "d-1",
          label: "Front counter",
          registeredAt: at,
          registeredBy: "Mia",
          lastUsedAt: null,
        },
      ],
      staffPins: [{ staff: "s-1", name: "Ana", state: "Reset", changedAt: at, lockedUntil: null }],
    });
    expect(read.devices?.[0]?.label).toBe("Front counter");
    expect(read.staffPins?.[0]?.state).toBe("Reset");
  });
  it("formats lock times on the store's clock", () => {
    expect(storeClockTime(at, "America/Toronto")).toBe("3:45 PM");
  });
});

describe("requests", () => {
  it("sends a PIN once in the body, without the session token, and reads sign-in", async () => {
    const fetcher = respond(200, { status: "SignedIn", next: "/operations/orders" });
    const client = createStaffPinClient(null, fetcher);
    await expect(client.unlock("c-1", "482913")).resolves.toEqual({
      next: "/operations/orders",
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/merchant/staff-switch/unlock");
    expect(String(url)).not.toContain("482913");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    expect((init?.headers as Record<string, string>)["X-BOP-CSRF"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({ choice: "c-1", pin: "482913" });
  });
  it("maps wrong, locked, busy, removed and down answers", async () => {
    const unlock = (status: number, body: unknown) =>
      failure(createStaffPinClient(null, respond(status, body)).unlock("c-1", "482913"));
    expect((await unlock(401, { error: "pin_rejected" })).code).toBe("Rejected");
    const locked = await unlock(423, { error: "pin_locked", lockedUntil: at });
    expect(locked.code).toBe("Locked");
    expect(locked.detail.lockedUntil).toBe(at);
    const busy = await unlock(429, { error: "device_busy", retryAfterSeconds: 120 });
    expect(busy.code).toBe("Busy");
    expect(busy.detail.retryAfterSeconds).toBe(120);
    expect((await unlock(404, { error: "device_not_registered" })).code).toBe("NotRegistered");
    expect((await unlock(503, { error: "staff_switch_unavailable" })).code).toBe("Unavailable");
    expect((await unlock(429, null)).detail.retryAfterSeconds).toBe(60);
    const offline = createStaffPinClient(
      null,
      vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect((await failure(offline.unlock("c-1", "482913"))).code).toBe("Offline");
  });
  it("sets a PIN with the session token and maps the reasons", async () => {
    const fetcher = respond(200, { pin: { state: "Set", changedAt: at, lockedUntil: null } });
    await expect(createStaffPinClient(csrf, fetcher).setPin("482913", "482913")).resolves.toEqual({
      state: "Set",
      changedAt: at,
      lockedUntil: null,
    });
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>)["X-BOP-CSRF"]).toBe(
      csrf,
    );
    const set = (status: number, body: unknown) =>
      failure(createStaffPinClient(csrf, respond(status, body)).setPin("482913", "482913"));
    const simple = await set(422, { error: "pin_invalid", reason: "TooSimple" });
    expect([simple.code, simple.detail.reason]).toEqual(["Invalid", "TooSimple"]);
    expect((await set(403, { error: "full_sign_in_required" })).code).toBe("FullSignInRequired");
    expect((await set(403, { error: "request_denied" })).code).toBe("Denied");
    expect((await set(503, { error: "staff_pin_unavailable" })).code).toBe("Unavailable");
  });
  it("registers, removes and resets with the session token", async () => {
    const device = {
      device: "d-1",
      label: "Front counter",
      registeredAt: at,
      registeredBy: "Mia",
      lastUsedAt: null,
    };
    const register = respond(201, { device });
    await expect(
      createStaffPinClient(csrf, register).registerDevice("  Front counter "),
    ).resolves.toEqual(device);
    expect(JSON.parse(String(register.mock.calls[0]?.[1]?.body))).toEqual({
      label: "Front counter",
    });
    expect(
      (
        await failure(
          createStaffPinClient(
            csrf,
            respond(409, { error: "device_already_registered" }),
          ).registerDevice("Front"),
        )
      ).code,
    ).toBe("AlreadyRegistered");
    await expect(
      createStaffPinClient(csrf, respond(200, { revoked: true, signedOut: 2 })).revokeDevice("d-1"),
    ).resolves.toEqual({ signedOut: 2 });
    expect(
      (
        await failure(
          createStaffPinClient(csrf, respond(404, { error: "device_not_found" })).revokeDevice(
            "d-1",
          ),
        )
      ).code,
    ).toBe("NotFound");
    expect(
      (
        await failure(
          createStaffPinClient(csrf, respond(409, { error: "pin_not_set" })).resetPin("s-1"),
        )
      ).code,
    ).toBe("PinNotSet");
    expect((await failure(createStaffPinClient(null, respond(200, {})).resetPin("s-1"))).code).toBe(
      "Unavailable",
    );
  });
});
