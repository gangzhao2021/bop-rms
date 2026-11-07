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
    counterCode: null,
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

  it("shows a collected order as collected and stops checking (v15: was an error)", async () => {
    let calls = 0;
    const client: CustomerPickupCodeClient = {
      load: async () => {
        calls += 1;
        return { schemaVersion: 1, status: "Collected", orderReference: id(1) };
      },
    };
    const controller = createPickupCodeController(id(1), "1001", client, () => now);
    await controller.reveal();
    expect(controller.getState()).toEqual({ status: "collected" });
    expect(calls).toBe(1);
    expect(() =>
      parsePickupCodeResult(
        { schemaVersion: 1, status: "Collected", orderReference: id(1), proofValue: "x" },
        id(1),
        "1001",
        now,
      ),
    ).toThrow();
    controller.dispose();
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

  it("keeps the six-digit code a guest reads to staff (WP-2423)", () => {
    const parsed = parsePickupCodeResult(
      ready({ proofKind: "Opaque", proofValue: "A".repeat(21) + "Q", counterCode: "048213" }),
      id(1),
      "1001",
      now,
    );
    expect(parsed).toMatchObject({ status: "Ready", counterCode: "048213" });
    expect(() =>
      parsePickupCodeResult(
        Object.fromEntries(Object.entries(ready()).filter(([key]) => key !== "counterCode")),
        id(1),
        "1001",
        now,
      ),
    ).toThrow("invalid pickup proof");
  });

  it("rejects malformed, overlong, expired, mismatched and credential-bearing NotReady results", () => {
    const candidates = [
      { ...ready(), privateSelectorHash: "forbidden" },
      Object.defineProperty(ready(), "proofValue", { enumerable: true, get: () => "123456" }),
      { ...ready(), [Symbol("secret")]: true },
      Object.assign(Object.create({ inherited: true }), ready()),
      ready({ orderReference: id(9) }),
      ready({ proofValue: "12345" }),
      ready({ counterCode: "12345" }),
      ready({ counterCode: "12345A" }),
      ready({ counterCode: 123456 }),
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

it("clears proof during refresh and rejects a late reply after session context changes", async () => {
  let change!: () => void, finish!: (value: unknown) => void;
  const release = vi.fn(),
    load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(ready())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
  const controller = createPickupCodeController(
    id(1),
    "1001",
    {
      load,
      subscribeContextChange(listener) {
        change = listener;
        return release;
      },
    },
    () => now,
  );
  const unsubscribe = controller.subscribe(() => undefined);
  await controller.reveal();
  expect(controller.getState().status).toBe("ready");
  const pending = controller.refresh();
  expect(controller.getState()).toEqual({ status: "loading" });
  change();
  expect(controller.getState()).toEqual({ status: "permission-denied" });
  finish(ready());
  await pending;
  expect(controller.getState()).toEqual({ status: "permission-denied" });
  unsubscribe();
  expect(release).toHaveBeenCalledTimes(1);
  expect(controller.getState()).toEqual({ status: "hidden" });
  controller.dispose();
});
it("clears already displayed proof immediately on session change", async () => {
  let change!: () => void;
  const release = vi.fn();
  const controller = createPickupCodeController(
    id(1),
    "1001",
    {
      load: async () => ready(),
      subscribeContextChange(listener) {
        change = listener;
        return release;
      },
    },
    () => now,
  );
  controller.subscribe(() => undefined);
  await controller.reveal();
  change();
  expect(controller.getState()).toEqual({ status: "permission-denied" });
  controller.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});
it("rejects noncanonical opaque proof encoding", () => {
  expect(() =>
    parsePickupCodeResult(
      ready({ proofKind: "Opaque", proofValue: "A".repeat(21) + "B" }),
      id(1),
      "1001",
      now,
    ),
  ).toThrow();
  expect(
    parsePickupCodeResult(
      ready({ proofKind: "Opaque", proofValue: "A".repeat(22) }),
      id(1),
      "1001",
      now,
    ).status,
  ).toBe("Ready");
});

it("keeps checking quietly after the order turns Ready until the code is issued (WP-2423)", async () => {
  vi.useFakeTimers();
  const answers: unknown[] = [
    { schemaVersion: 1, status: "NotReady", orderReference: id(1) },
    { schemaVersion: 1, status: "NotReady", orderReference: id(1) },
    new PickupCodeClientError("service_unavailable"),
    ready(),
  ];
  let calls = 0;
  const seen: string[] = [];
  const client: CustomerPickupCodeClient = {
    load: async () => {
      const answer = answers[calls++];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const controller = createPickupCodeController(id(1), "1001", client, () => now);
  controller.subscribe(() => seen.push(controller.getState().status));
  controller.followUntilReady?.(true);
  await controller.reveal();
  expect(controller.getState()).toEqual({ status: "not-ready" });
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  expect(controller.getState()).toEqual({ status: "not-ready" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(3);
  expect(controller.getState()).toEqual({ status: "unavailable" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(4);
  expect(controller.getState().status).toBe("ready");
  // Follow-ups never flash the "checking" state between answers.
  expect(seen).toEqual(["loading", "not-ready", "not-ready", "unavailable", "ready"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toBe(4);
  controller.dispose();
});

it("stops following when the order is no longer Ready or the page closes", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const client: CustomerPickupCodeClient = {
    load: async () => {
      calls += 1;
      return { schemaVersion: 1, status: "NotReady", orderReference: id(1) };
    },
  };
  const controller = createPickupCodeController(id(1), "1001", client, () => now);
  controller.followUntilReady?.(true);
  await controller.reveal();
  controller.followUntilReady?.(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toBe(1);
  controller.followUntilReady?.(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(2);
  controller.dispose();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toBe(2);
});

it("does not follow up a not-ready code before the order is Ready", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const client: CustomerPickupCodeClient = {
    load: async () => {
      calls += 1;
      return { schemaVersion: 1, status: "NotReady", orderReference: id(1) };
    },
  };
  const controller = createPickupCodeController(id(1), "1001", client, () => now);
  await controller.reveal();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toBe(1);
  controller.dispose();
});

// WP-2423: a ready order without a usable code is never shown as not ready.
it("shows a ready order without a usable code and follows only a code still being issued", async () => {
  vi.useFakeTimers();
  const without = (reason: string, orderNumber = "1001") => ({
    schemaVersion: 1,
    status: "ReadyWithoutCode",
    orderReference: id(1),
    orderNumber,
    reason,
  });
  expect(parsePickupCodeResult(without("CounterOrder"), id(1), "1001", now)).toEqual({
    status: "ReadyWithoutCode",
    orderNumber: "1001",
    reason: "CounterOrder",
  });
  for (const value of [
    without("Expired"),
    without("CodeUnavailable", "1002"),
    { ...without("CodePending"), extra: true },
  ])
    expect(() => parsePickupCodeResult(value, id(1), "1001", now)).toThrow();
  const answers: unknown[] = [without("CodePending"), without("CodePending"), ready()];
  let calls = 0;
  const client: CustomerPickupCodeClient = { load: async () => answers[calls++] };
  const controller = createPickupCodeController(id(1), "1001", client, () => now);
  controller.followUntilReady?.(true);
  await controller.reveal();
  expect(controller.getState()).toEqual({
    status: "ready-without-code",
    orderNumber: "1001",
    reason: "CodePending",
  });
  // The code is checked every second at first, so it shows about a second after it is issued.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(3);
  expect(controller.getState().status).toBe("ready");
  controller.dispose();

  let finalCalls = 0;
  const final = createPickupCodeController(
    id(1),
    "1001",
    {
      load: async () => {
        finalCalls += 1;
        return without("CodeUnavailable");
      },
    },
    () => now,
  );
  final.followUntilReady?.(true);
  await final.reveal();
  expect(final.getState()).toEqual({
    status: "ready-without-code",
    orderNumber: "1001",
    reason: "CodeUnavailable",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(finalCalls).toBe(1);
  final.dispose();
});
