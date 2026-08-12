import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPickupCodeController,
  createUnavailablePickupCodeClient,
  parsePickupCodeResult,
  PickupCodeClientError,
  type CustomerPickupCodeClient,
} from "./pickup-code-controller.js";

const id = (n: number) => `018f7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = Date.parse("2026-08-11T14:00:00.000Z");

afterEach(() => vi.useRealTimers());

function ready(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "Ready",
    orderReference: id(1),
    orderNumber: "1001",
    storeDisplayName: "Synthetic Harbour Store",
    pickupInstruction: "Show this proof at the pickup counter.",
    generation: 1,
    proofKind: "HumanCode",
    proofValue: "123456",
    observedAt: "2026-08-11T13:55:00.000Z",
    expiresAt: "2026-08-11T14:30:00.000Z",
    ...overrides,
  };
}

describe("WP-1706 Pickup Code controller", () => {
  it("starts closed and keeps the default runtime unavailable", async () => {
    const controller = createPickupCodeController(
      id(1),
      "1001",
      createUnavailablePickupCodeClient(),
      () => now,
    );
    expect(controller.getState()).toEqual({ status: "hidden" });
    await controller.reveal();
    expect(controller.getState()).toEqual({ status: "unavailable" });
  });

  it("reveals a strictly scoped Ready proof only after the explicit query", async () => {
    let calls = 0;
    const client: CustomerPickupCodeClient = {
      load: async (orderReference) => {
        calls += 1;
        expect(orderReference).toBe(id(1));
        return ready();
      },
    };
    const controller = createPickupCodeController(id(1), "1001", client, () => now);
    expect(calls).toBe(0);
    await controller.reveal();
    expect(controller.getState()).toEqual({
      status: "ready",
      view: parsePickupCodeResult(ready(), id(1), "1001", now),
      refreshing: false,
    });
    controller.dispose();
    expect(controller.getState()).toEqual({ status: "hidden" });
  });

  it("keeps NotReady proof-free and uses refresh as a Query only", async () => {
    let calls = 0;
    const client: CustomerPickupCodeClient = {
      load: async () => {
        calls += 1;
        return { schemaVersion: 1, status: "NotReady", orderReference: id(1) };
      },
    };
    const controller = createPickupCodeController(id(1), "1001", client, () => now);
    await controller.reveal();
    await controller.refresh();
    expect(calls).toBe(2);
    expect(controller.getState()).toEqual({ status: "not-ready" });
  });

  it("clears an accepted raw proof on offline and does nothing on reconnect", async () => {
    let calls = 0;
    const controller = createPickupCodeController(
      id(1),
      "1001",
      {
        load: async () => {
          calls += 1;
          return ready();
        },
      },
      () => now,
    );
    await controller.reveal();
    controller.setOnline(false);
    expect(controller.getState()).toEqual({ status: "offline" });
    controller.setOnline(true);
    expect(calls).toBe(1);
  });

  it("clears the proof when its accepted expiry is reached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const controller = createPickupCodeController(id(1), "1001", {
      load: async () => ready({ expiresAt: "2026-08-11T14:00:00.100Z" }),
    });
    await controller.reveal();
    expect(controller.getState().status).toBe("ready");
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getState()).toEqual({ status: "expired" });
  });

  it.each([
    ["permission_denied", "permission-denied"],
    ["not_found", "not-found"],
    ["feature_disabled", "feature-disabled"],
    ["conflict", "conflict"],
    ["service_unavailable", "unavailable"],
  ] as const)("maps %s to the bounded %s state", async (code, status) => {
    const controller = createPickupCodeController(id(1), "1001", {
      load: async () => {
        throw new PickupCodeClientError(code);
      },
    });
    await controller.reveal();
    expect(controller.getState()).toEqual({ status });
  });

  it("rejects malformed, overlong, expired, mismatched and credential-bearing NotReady results", () => {
    const candidates = [
      { ...ready(), privateSelectorHash: "forbidden" },
      Object.defineProperty(ready(), "proofValue", { enumerable: true, get: () => "123456" }),
      { ...ready(), [Symbol("secret")]: true },
      Object.assign(Object.create({ inherited: true }), ready()),
      ready({ orderReference: id(9) }),
      ready({ proofValue: "12345" }),
      ready({ expiresAt: "2026-08-11T13:59:59.000Z" }),
      ready({ expiresAt: "2026-08-11T15:00:01.000Z" }),
      { schemaVersion: 1, status: "NotReady", orderReference: id(1), proofValue: "123456" },
    ];
    for (const candidate of candidates)
      expect(() => parsePickupCodeResult(candidate, id(1), "1001", now)).toThrow(
        "invalid pickup proof",
      );
  });
});
