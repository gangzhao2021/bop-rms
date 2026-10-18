import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantPickupIdentityCheck,
  phoneLastFour,
} from "./merchant-pickup-identity-check.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  contact: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresPickupHandoffStore: doubles.store,
}));
vi.mock("@rms/ordering", () => ({ loadOrderPickupContact: doubles.contact }));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantPickupIdentityCheck>[0];
const ready = (overrides: Record<string, unknown> = {}) => ({
  source: {
    fulfillmentReference: id(6),
    canonicalPhase: "Ready",
    lockedAt: "2026-09-19T12:00:00.000Z",
  },
  capability: { expiresAt: "2026-09-19T13:00:00.000Z" },
  codeChecksLocked: true,
  notCollected: false,
  ...overrides,
});
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true),
    installContext = vi.fn(async () => undefined);
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({ lockByOrder: doubles.current });
  doubles.current.mockResolvedValue(ready());
  doubles.contact.mockResolvedValue({
    status: "Available",
    name: "Sam Lee",
    channel: "Phone",
    value: "+1 (416) 555-0123",
    detailsReference: id(30),
    detailsVersion: 1,
  });
  const operation = createMerchantPickupIdentityCheck({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    store: {} as Options["store"],
    installContext,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { orderReference: id(5), storeReference: id(4), fulfillmentReference: id(6) },
  };
  return { operation, input, authorize, allowed, run };
}
beforeEach(() => vi.resetAllMocks());

it("WP-2423: returns only the name and the last four phone digits for a locked code", async () => {
  const f = setup();
  // The owner store is authorized, while the read runs, for this staff member, this order and the
  // handoff permission, without resolving the caller again.
  const during: boolean[] = [];
  doubles.current.mockImplementation(async () => {
    const authorize = doubles.store.mock.calls[0]?.[0].authorize;
    during.push(
      await authorize(
        {},
        { actorReference: id(2), orderReference: id(5), permission: "fulfillment.pickup.complete" },
      ),
      await authorize(
        {},
        {
          actorReference: id(2),
          orderReference: id(99),
          permission: "fulfillment.pickup.complete",
        },
      ),
    );
    return ready();
  });
  const result = await f.operation(f.input);
  expect(result).toEqual({ status: "Available", name: "Sam Lee", phoneLast4: "0123" });
  expect(JSON.stringify(result)).not.toContain("555");
  expect(doubles.contact).toHaveBeenCalledWith(
    expect.anything(),
    { brandReference: id(3), storeReference: id(4) },
    id(5),
  );
  expect(during).toEqual([true, false]);
  // Resolved in full once at the start and once more before the reply.
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // Not after the read has finished.
  expect(
    await doubles.store.mock.calls[0]?.[0].authorize(
      {},
      { actorReference: id(2), orderReference: id(5), permission: "fulfillment.pickup.complete" },
    ),
  ).toBe(false);
});

it("authenticates before any read and refuses another Store or a withdrawn permission", async () => {
  const f = setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
  f.authorize.mockResolvedValue({ sessionReference: id(1) });
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, storeReference: id(99) } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  expect(doubles.contact).not.toHaveBeenCalled();
});

it("rejects extra fields before any read", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, includePhone: true } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_INPUT_INVALID" });
  expect(f.run).not.toHaveBeenCalled();
});

it("reads nothing while the pickup code can still be used, or the order is not ready", async () => {
  const f = setup();
  doubles.current.mockResolvedValue(ready({ codeChecksLocked: false }));
  await expect(f.operation(f.input)).rejects.toMatchObject({ code: "PICKUP_HANDOFF_NOT_READY" });
  doubles.current.mockResolvedValue(
    ready({ source: { ...ready().source, canonicalPhase: "Completed" } }),
  );
  await expect(f.operation(f.input)).rejects.toMatchObject({ code: "PICKUP_HANDOFF_NOT_READY" });
  doubles.current.mockResolvedValue(ready({ notCollected: true }));
  await expect(f.operation(f.input)).rejects.toMatchObject({ code: "PICKUP_HANDOFF_NOT_READY" });
  doubles.current.mockResolvedValue(
    ready({ source: { ...ready().source, fulfillmentReference: id(9) } }),
  );
  await expect(f.operation(f.input)).rejects.toMatchObject({ code: "PICKUP_HANDOFF_NOT_READY" });
  expect(doubles.contact).not.toHaveBeenCalled();
  // An expired code, or none sent, allows the in-person check.
  doubles.current.mockResolvedValue(
    ready({ codeChecksLocked: false, capability: { expiresAt: "2026-09-19T11:00:00.000Z" } }),
  );
  await expect(f.operation(f.input)).resolves.toMatchObject({ status: "Available" });
  doubles.current.mockResolvedValue(ready({ codeChecksLocked: false, capability: null }));
  await expect(f.operation(f.input)).resolves.toMatchObject({ status: "Available" });
});

it("says when the contact was removed, never given, or was an email", async () => {
  const f = setup();
  doubles.contact.mockResolvedValue({ status: "Removed", removedAt: "2026-09-01T00:00:00.000Z" });
  expect(await f.operation(f.input)).toEqual({ status: "Removed" });
  doubles.contact.mockResolvedValue({ status: "NotGiven" });
  expect(await f.operation(f.input)).toEqual({ status: "NotGiven" });
  doubles.contact.mockResolvedValue({
    status: "Available",
    name: "Sam Lee",
    channel: "Email",
    value: "sam@example.test",
    detailsReference: id(30),
    detailsVersion: 1,
  });
  expect(await f.operation(f.input)).toEqual({
    status: "Available",
    name: "Sam Lee",
    phoneLast4: null,
  });
});

it("keeps only the last four digits of a phone", () => {
  expect(phoneLastFour("Phone", "+1 416-555-0199")).toBe("0199");
  expect(phoneLastFour("Phone", "12")).toBeNull();
  expect(phoneLastFour("Email", "a1234@example.test")).toBeNull();
});

it("refuses the reply when the permission is withdrawn while the details are read", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
});
