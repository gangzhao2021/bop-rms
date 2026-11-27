import { beforeEach, expect, it, vi } from "vitest";
import {
  createPickupClosedPaymentSweep,
  createPickupPaymentWindowClosure,
  createPickupPaymentWindowDispatcher,
} from "./pickup-payment-window-closure.js";
const m = vi.hoisted(() => ({
  order: [] as string[],
  fence: vi.fn(),
  commitment: vi.fn(),
  intent: vi.fn(),
  terminal: vi.fn(),
  close: vi.fn(),
  closureOptions: vi.fn(),
  discover: vi.fn(),
  release: vi.fn(),
  releaseOptions: vi.fn(),
  expiredOpen: vi.fn(),
  closedByWindow: vi.fn(),
}));
vi.mock("@rms/fulfillment", () => ({
  createPostgresAsapCapacityStore: () => ({
    withCurrentSubmission: async (
      _reference: string,
      work: (tx: unknown, record: unknown) => Promise<unknown>,
    ) => {
      m.order.push("fulfillment");
      const record = m.commitment();
      return record === null ? null : work({}, record);
    },
  }),
}));
vi.mock("@rms/payment", () => ({
  createPostgresPaymentOperationFence: (options: {
    authorize(tx: unknown, query: Record<string, string>): Promise<boolean>;
  }) => ({
    acquire: async (tx: unknown, input: Record<string, string>) => {
      m.order.push("fence");
      m.fence(input);
      if (!(await options.authorize(tx, { ...input }))) throw new Error("denied");
      return { paymentIntentReference: null };
    },
  }),
  createPostgresPaymentIntentCreationStore: (runner: {
    run(work: (tx: unknown) => Promise<unknown>): Promise<unknown>;
  }) => ({
    resolveOperation: async () => {
      m.order.push("payment");
      return m.intent();
    },
    listExpiredOpenOperations: (query: unknown) => runner.run(async () => m.expiredOpen(query)),
  }),
  // Like Payment's own store: exactly its scope shape, or PAYMENT_INTENT_INPUT_INVALID.
  createPostgresPaymentTerminalStore: (_runner: unknown, scope: object) => {
    if (
      Object.keys(scope).sort().join() !==
      "brandReference,environment,providerAccountReference,storeReference"
    )
      throw Object.assign(new Error("invalid"), { code: "PAYMENT_INTENT_INPUT_INVALID" });
    return { read: async () => m.terminal() };
  },
  parsePaymentIntentCreationRecord: (value: unknown) => value,
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresPickupPaymentWindowCandidates: () => ({ discover: m.discover }),
  loadPickupPaymentWindowClosure: async (_tx: unknown, scope: unknown, order: string) =>
    m.closedByWindow(scope, order),
  createPostgresPickupPaymentWindowClosure: (options: unknown) => {
    m.closureOptions(options);
    return {
      close: async (tx: unknown, input: unknown) => {
        m.order.push("ordering");
        return m.close(tx, input);
      },
    };
  },
}));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: (options: unknown) => {
    m.releaseOptions(options);
    return { release: m.release, verify: vi.fn() };
  },
}));
const id = (n: number) => `0190ee72-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
// Payment requested at 05:00; the window is that request + 30 minutes.
const expiresAt = "2026-09-21T05:30:00.000Z";
const link = {
  owner: "Fulfillment",
  commitmentReference: id(10),
  commitmentVersion: 1,
  ownerContextReference: id(11),
  ownerIntentDigest: "sha256:" + "a".repeat(64),
  ownerSnapshotDigest: "sha256:" + "b".repeat(64),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  cartReference: id(7),
  cartVersion: 1,
  quoteReference: id(8),
  guestSessionReference: id(9),
  paymentOperationReference: id(12),
  preparedAt: "2026-09-21T04:59:00.000Z",
  validUntil: "2026-09-21T05:09:00.000Z",
};
const commitment = (overrides = {}) => ({
  allocationReference: id(10),
  orderReference: id(4),
  orderBatchReference: id(5),
  paymentOperationReference: id(12),
  guestSessionReference: id(9),
  cartReference: id(7),
  cartVersion: 1,
  quoteReference: id(8),
  state: "PaymentPending",
  preparationValidUntil: "2026-09-21T05:09:00.000Z",
  capacityExpiresAt: expiresAt,
  ...overrides,
});
const intent = {
  intent: {
    paymentIntentReference: id(40),
    paymentOperationReference: id(12),
    preparation: {
      brandReference: id(2),
      storeReference: id(3),
      orderReference: id(4),
      orderBatchReference: id(5),
      submissionReference: id(6),
      guestSessionReference: id(9),
      sourceCartReference: id(7),
      sourceCartVersion: 1,
      quoteReference: id(8),
    },
  },
  attempt: { providerEnvironment: "Test" },
};
const terminal = (outcome: string) => ({
  brandReference: id(2),
  storeReference: id(3),
  paymentIntentReference: id(40),
  orderReference: id(4),
  outcome,
});
const termination = {
  terminationReference: id(50),
  terminatedAt: "2026-09-21T05:31:00.000Z",
};
let clock = "2026-09-21T05:31:00.000Z";
let references = 60;
beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") fn.mockReset();
  m.order.length = 0;
  clock = "2026-09-21T05:31:00.000Z";
  references = 60;
  m.commitment.mockReturnValue(commitment());
  m.intent.mockReturnValue(null);
  m.terminal.mockReturnValue(null);
  m.close.mockResolvedValue({ status: "Closed", record: termination });
  m.release.mockResolvedValue({ status: "Released", entryCount: 1 });
});
function fixture() {
  const tx = { query: vi.fn() };
  const authorize = vi.fn(async () => true);
  const port = createPickupPaymentWindowClosure({
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(13),
      environment: "Test",
    },
    systemActorReference: id(30),
    transactions: { run: async (work) => work(tx) },
    now: () => clock,
    newReference: () => id(references++),
    authorize,
    authorizeDiscovery: async () => true,
  });
  return { tx, authorize, port };
}
it("closes an unpaid pickup after its window under the Payment fence and releases its stock in the same transaction", async () => {
  const f = fixture();
  expect(await f.port.close({ link, orderReference: id(4) })).toEqual({
    status: "Closed",
    paymentEvidence: "NoPaymentStarted",
    inventory: { status: "Released", entryCount: 1 },
  });
  expect(m.order).toEqual(["fence", "fulfillment", "payment", "ordering"]);
  expect(m.fence).toHaveBeenCalledWith({
    orderReference: id(4),
    paymentOperationReference: id(12),
  });
  expect(m.close).toHaveBeenCalledWith(f.tx, {
    link: expect.objectContaining({ orderReference: id(4), owner: "Fulfillment" }),
    windowEndedAt: expiresAt,
    closedAt: clock,
    paymentEvidence: "NoPaymentStarted",
    terminationReference: id(60),
    auditReference: id(61),
  });
  expect(m.releaseOptions).toHaveBeenCalledWith(
    expect.objectContaining({ reasonCode: "PAYMENT_WINDOW_EXPIRED", systemActorReference: id(30) }),
  );
  const [tx, request] = m.release.mock.calls[0] as [unknown, Record<string, unknown>];
  expect(tx).toBe(f.tx);
  expect(request).toMatchObject({
    source: {
      kind: "PickupPaymentWindowClosure/v1",
      reference: id(50),
      submissionReference: id(6),
      orderReference: id(4),
      occurredAt: termination.terminatedAt,
    },
    releasedAt: termination.terminatedAt,
  });
});
it("never closes within the window or after a captured payment", async () => {
  const f = fixture();
  clock = "2026-09-21T05:29:59.999Z";
  expect(await f.port.close({ link })).toEqual({ status: "NotDue", windowEndsAt: expiresAt });
  clock = "2026-09-21T05:31:00.000Z";
  m.intent.mockReturnValue(intent);
  m.terminal.mockReturnValue(terminal("Succeeded"));
  expect(await f.port.close({ link })).toEqual({ status: "Paid" });
  m.commitment.mockReturnValue(commitment({ state: "Consumed" }));
  expect(await f.port.close({ link })).toEqual({ status: "Paid" });
  expect(m.close).not.toHaveBeenCalled();
  expect(m.release).not.toHaveBeenCalled();
});
it("records whether a payment failed or never resolved, and uses the preparation validity when payment never started", async () => {
  const f = fixture();
  m.intent.mockReturnValue(intent);
  m.terminal.mockReturnValue(terminal("Failed"));
  expect(await f.port.close({ link })).toMatchObject({ paymentEvidence: "PaymentFailed" });
  m.terminal.mockReturnValue(null);
  expect(await f.port.close({ link })).toMatchObject({ paymentEvidence: "PaymentUnresolved" });
  m.intent.mockReturnValue(null);
  m.commitment.mockReturnValue(
    commitment({ state: "Prepared", capacityExpiresAt: null, preparationValidUntil: validUntil() }),
  );
  clock = "2026-09-21T05:08:59.999Z";
  expect(await f.port.close({ link })).toEqual({
    status: "NotDue",
    windowEndsAt: "2026-09-21T05:09:00.000Z",
  });
  clock = "2026-09-21T05:09:00.000Z";
  expect(await f.port.close({ link })).toMatchObject({
    status: "Closed",
    paymentEvidence: "NoPaymentStarted",
  });
  function validUntil() {
    return "2026-09-21T05:09:00.000Z";
  }
});
it("leaves Orders Ordering says are not eligible and verifies an earlier closure's release", async () => {
  const f = fixture();
  m.close.mockResolvedValue({ status: "NotEligible", reason: "PaymentRecorded" });
  expect(await f.port.close({ link })).toEqual({
    status: "NotEligible",
    reason: "PaymentRecorded",
  });
  expect(m.release).not.toHaveBeenCalled();
  m.close.mockResolvedValue({ status: "AlreadyClosed", record: termination });
  m.release.mockResolvedValue({ status: "AlreadyApplied", entryCount: 1 });
  clock = "2026-09-21T05:40:00.000Z";
  expect(await f.port.close({ link })).toEqual({
    status: "AlreadyClosed",
    paymentEvidence: null,
    inventory: { status: "AlreadyApplied", entryCount: 1 },
  });
  expect((m.release.mock.calls[0] as [unknown, { releasedAt: string }])[1].releasedAt).toBe(clock);
});
it("fails closed on mismatched owner facts, another Store or lost authority", async () => {
  const f = fixture();
  m.commitment.mockReturnValue(commitment({ paymentOperationReference: id(99) }));
  await expect(f.port.close({ link })).rejects.toThrow();
  m.commitment.mockReturnValue(null);
  await expect(f.port.close({ link })).rejects.toThrow();
  m.commitment.mockReturnValue(commitment());
  m.intent.mockReturnValue({
    ...intent,
    intent: {
      ...intent.intent,
      preparation: { ...intent.intent.preparation, orderReference: id(98) },
    },
  });
  await expect(f.port.close({ link })).rejects.toThrow();
  await expect(f.port.close({ link: { ...link, storeReference: id(97) } })).rejects.toThrow();
  m.intent.mockReturnValue(null);
  f.authorize.mockResolvedValue(false);
  await expect(f.port.close({ link })).rejects.toThrow();
  expect(m.close).not.toHaveBeenCalled();
});
it("dispatches each discovered Order after discovery and keeps going past a failing one", async () => {
  const closed = vi.fn();
  const failures: string[] = [];
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ orderReference: id(100 + i), link }));
  const discover = vi.fn().mockResolvedValueOnce(page(2)).mockResolvedValueOnce(page(1));
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE"))
    .mockResolvedValue({ status: "NotDue", windowEndsAt: expiresAt });
  const dispatcher = createPickupPaymentWindowDispatcher({
    closure: { discover, close },
    now: () => clock,
    pageSize: 2,
    onOutcome: closed,
    onFailure: (code) => failures.push(code),
  });
  expect(await dispatcher.runOnce()).toBe(2);
  expect(failures).toEqual(["PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE"]);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(discover).toHaveBeenLastCalledWith({ observedAt: clock, after: null, limit: 2 });
  // A full page continues after its last Order; a short page restarts the scan.
  await dispatcher.runOnce();
  expect(discover).toHaveBeenLastCalledWith({ observedAt: clock, after: id(101), limit: 2 });
  discover.mockResolvedValue([]);
  await dispatcher.runOnce();
  expect(discover).toHaveBeenLastCalledWith({ observedAt: clock, after: null, limit: 2 });
  expect(await dispatcher.stop()).toBe("drained");
  expect(await dispatcher.runOnce()).toBe(0);
  expect(() =>
    createPickupPaymentWindowDispatcher({
      closure: { discover, close },
      now: () => clock,
      pageSize: 0,
    }),
  ).toThrow("PICKUP_PAYMENT_WINDOW_DISPATCHER_CONFIG_INVALID");
});
it("retries a persistently failing Order with a doubling delay instead of every poll", async () => {
  const failures: string[] = [];
  let at = Date.parse("2026-09-21T06:00:00.000Z");
  const failingOrder = { orderReference: id(100), link };
  const discover = vi.fn().mockResolvedValue([failingOrder]);
  const close = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("private detail"), { code: "PAYMENT_INTENT_INPUT_INVALID" }),
    );
  const dispatcher = createPickupPaymentWindowDispatcher({
    closure: { discover, close },
    now: () => new Date(at).toISOString(),
    pageSize: 10,
    onFailure: (code) => failures.push(code),
  });
  const poll = async (advanceMs: number) => {
    at += advanceMs;
    await dispatcher.runOnce();
  };
  await poll(0);
  expect(failures).toEqual(["PAYMENT_INTENT_INPUT_INVALID"]);
  // 15-second polls inside the first minute do not retry it.
  for (let i = 0; i < 3; i++) await poll(15_000);
  expect(close).toHaveBeenCalledTimes(1);
  await poll(15_000);
  expect(close).toHaveBeenCalledTimes(2);
  // The next delay is two minutes, then four.
  await poll(60_000);
  expect(close).toHaveBeenCalledTimes(2);
  await poll(60_000);
  expect(close).toHaveBeenCalledTimes(3);
  await poll(180_000);
  expect(close).toHaveBeenCalledTimes(3);
  await poll(60_000);
  expect(close).toHaveBeenCalledTimes(4);
  // Once it succeeds the delay resets; an Order that stops being a candidate is forgotten.
  close.mockResolvedValue({ status: "NotDue", windowEndsAt: expiresAt });
  await poll(480_000);
  expect(close).toHaveBeenCalledTimes(5);
  close.mockRejectedValue(new Error("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE"));
  await poll(15_000);
  await poll(15_000);
  expect(close).toHaveBeenCalledTimes(6);
  discover.mockResolvedValue([]);
  await poll(15_000);
  discover.mockResolvedValue([failingOrder]);
  await poll(15_000);
  expect(close).toHaveBeenCalledTimes(7);
  expect(failures).toHaveLength(6);
  expect(failures.join()).not.toContain("private");
});

it("settles the open card payments of pickups closed by their payment window, backing off while the Provider can't", async () => {
  let at = Date.parse("2026-09-21T06:00:00.000Z");
  const now = () => new Date(at).toISOString();
  // Payment lists two expired open payments: a closed pickup's and a dine-in round's.
  m.expiredOpen.mockResolvedValue([
    { paymentOperationReference: id(201), orderReference: id(301) },
    { paymentOperationReference: id(202), orderReference: id(302) },
  ]);
  m.closedByWindow.mockImplementation(async (_scope: unknown, order: string) =>
    order === id(301) ? { closedAt: expiresAt } : null,
  );
  const resolve = vi.fn().mockResolvedValue({ status: "Unavailable" });
  const outcomes: unknown[] = [];
  let allowed = true;
  const tx = {};
  const sweep = createPickupClosedPaymentSweep({
    scope: { brandReference: id(2), storeReference: id(3) },
    transactions: { run: async (work) => work(tx as never) },
    now,
    pageSize: 10,
    authorize: async (transaction, observedAt) =>
      transaction === tx && observedAt === now() && allowed,
    resolve,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  expect(await sweep.runOnce()).toBe(1);
  expect(m.expiredOpen).toHaveBeenCalledWith({ observedAt: now(), after: null, limit: 10 });
  expect(m.closedByWindow).toHaveBeenCalledWith(
    { brandReference: id(2), storeReference: id(3) },
    id(301),
  );
  // Only the pickup closed by its window is settled; the dine-in round keeps its own path.
  expect(resolve.mock.calls).toEqual([[id(201)]]);
  // Provider unreachable: asked again after a minute, then two, never on every poll.
  at += 15_000;
  expect(await sweep.runOnce()).toBe(0);
  at += 45_000;
  expect(await sweep.runOnce()).toBe(1);
  at += 60_000;
  expect(await sweep.runOnce()).toBe(0);
  // Settled (cancelled at the Provider and recorded as failed): no more backoff kept.
  resolve.mockResolvedValue({ status: "Failed", notCompleted: true });
  at += 60_000;
  expect(await sweep.runOnce()).toBe(1);
  expect(outcomes.at(-1)).toEqual({ status: "Failed", notCompleted: true });
  expect(resolve).toHaveBeenCalledTimes(3);
  // Lost authority asks nobody.
  allowed = false;
  at += 3_600_000;
  await expect(sweep.runOnce()).rejects.toThrow("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE");
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(() =>
    createPickupClosedPaymentSweep({
      scope: { brandReference: id(2), storeReference: id(3) },
      transactions: { run: async (work) => work(tx as never) },
      now,
      pageSize: 0,
      authorize: async () => true,
      resolve,
    }),
  ).toThrow("PICKUP_CLOSED_PAYMENT_SWEEP_CONFIG_INVALID");
});

it("pages through Payment's expired open payments with a cursor", async () => {
  const page = (from: number, n: number) =>
    Array.from({ length: n }, (_, k) => ({
      paymentOperationReference: id(400 + from + k),
      orderReference: id(500 + from + k),
    }));
  m.expiredOpen.mockReset();
  m.expiredOpen.mockResolvedValueOnce(page(0, 2)).mockResolvedValueOnce(page(2, 1));
  m.closedByWindow.mockResolvedValue({ closedAt: expiresAt });
  const resolve = vi.fn().mockResolvedValue({ status: "Paid" });
  const sweep = createPickupClosedPaymentSweep({
    scope: { brandReference: id(2), storeReference: id(3) },
    transactions: { run: async (work) => work({} as never) },
    now: () => "2026-09-21T06:00:00.000Z",
    pageSize: 2,
    authorize: async () => true,
    resolve,
  });
  await sweep.runOnce();
  await sweep.runOnce();
  expect(m.expiredOpen.mock.calls.map(([query]) => (query as { after: unknown }).after)).toEqual([
    null,
    id(401),
  ]);
  expect(resolve).toHaveBeenCalledTimes(3);
});

it("runs the closed-payment sweep after the closures without letting its failure block them", async () => {
  const failures: string[] = [];
  const order: string[] = [];
  const discover = vi.fn().mockResolvedValue([{ orderReference: id(100), link }]);
  const close = vi.fn(async () => {
    order.push("close");
    return { status: "NotDue" as const, windowEndsAt: expiresAt };
  });
  const runOnce = vi.fn(async () => {
    order.push("payments");
    return 2;
  });
  const dispatcher = createPickupPaymentWindowDispatcher({
    closure: { discover, close },
    now: () => "2026-09-21T06:00:00.000Z",
    pageSize: 10,
    onFailure: (code) => failures.push(code),
    closedPayments: { runOnce },
  });
  expect(await dispatcher.runOnce()).toBe(3);
  expect(order).toEqual(["close", "payments"]);
  runOnce.mockRejectedValue(new Error("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE"));
  expect(await dispatcher.runOnce()).toBe(1);
  expect(close).toHaveBeenCalledTimes(2);
  expect(failures).toEqual(["PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE"]);
});
