import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantKitchenQuery } from "./merchant-kitchen-query.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  service: vi.fn(),
  queries: vi.fn(),
  lock: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createKitchenQueueProjectionService: doubles.service,
  createPostgresKitchenQueueQueries: doubles.queries,
  lockPostgresKitchenQueueRead: doubles.lock,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantKitchenQuery>[0];
function setup() {
  const allowed = vi.fn(async () => true),
    authorize = vi.fn(async () => ({ sessionReference: id(9) }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.service.mockReturnValue({ list: doubles.list, get: doubles.get });
  doubles.list.mockResolvedValue({
    items: [
      { workItemReference: id(5), ticketAggregateVersion: 9007199254740993n, workItemVersion: 2n },
    ],
  });
  doubles.get.mockResolvedValue({
    item: {
      workItemReference: id(5),
      ticketAggregateVersion: 9007199254740993n,
      workItemVersion: 2n,
    },
  });
  const operation = createMerchantKitchenQuery({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    sha256: () => "sha256:" + "a".repeat(64),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { kind: "List", filters: {}, cursor: null, limit: 20 },
  };
  return { operation, input, allowed, authorize, run, tx };
}
beforeEach(() => vi.resetAllMocks());
it("authenticates before business reads", async () => {
  const f = setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["actorReference", "brandReference", "storeReference", "observedAt"])(
  "rejects browser authority field %s",
  async (field) => {
    const f = setup();
    await expect(
      f.operation({ ...f.input, query: { ...f.input.query, [field]: id(99) } }),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_INPUT_INVALID" });
    expect(doubles.queries).not.toHaveBeenCalled();
  },
);
it("rejects current denied permission before owner reads and locking", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "KITCHEN_QUEUE_PERMISSION_DENIED",
  });
  expect(doubles.lock).not.toHaveBeenCalled();
});
it("derives current authority, preserves integer strings, and rechecks permissions", async () => {
  const f = setup();
  const result = await f.operation(f.input);
  expect(result).toEqual({
    operatorStatus: "Unverified",
    storeReference: id(4),
    items: [
      {
        workItemReference: id(5),
        ticketAggregateVersion: "9007199254740993",
        workItemVersion: "2",
      },
    ],
  });
  expect(doubles.list).toHaveBeenCalledWith({
    actorReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    observedAt: "2026-09-19T12:00:00.000Z",
    filters: {},
    cursor: null,
    limit: 20,
  });
  expect(doubles.lock).toHaveBeenCalledTimes(1);
  f.allowed.mockResolvedValue(false);
  expect(await doubles.queries.mock.calls[0]?.[0].authorize()).toBe(false);
});
it("returns detail with exact version strings", async () => {
  const f = setup();
  expect(
    await f.operation({ ...f.input, query: { kind: "Get", workItemReference: id(5) } }),
  ).toEqual({
    operatorStatus: "Unverified",
    storeReference: id(4),
    item: {
      workItemReference: id(5),
      ticketAggregateVersion: "9007199254740993",
      workItemVersion: "2",
    },
  });
});
it("preserves projection-owned selected modifiers through List and Get", async () => {
  const f = setup();
  const selectedOptions = [
    {
      optionReference: id(6),
      quantity: 2,
      localizedNames: { "en-CA": "Extra mushrooms" },
    },
  ];
  doubles.list.mockResolvedValue({
    items: [
      {
        workItemReference: id(5),
        ticketAggregateVersion: 3n,
        workItemVersion: 2n,
        selectedOptions,
      },
    ],
  });
  doubles.get.mockResolvedValue({
    item: {
      workItemReference: id(5),
      ticketAggregateVersion: 3n,
      workItemVersion: 2n,
      selectedOptions,
    },
  });

  const list = await f.operation(f.input);
  const detail = await f.operation({
    ...f.input,
    query: { kind: "Get", workItemReference: id(5) },
  });

  expect(list).toMatchObject({ items: [{ selectedOptions }] });
  expect(detail).toMatchObject({ item: { selectedOptions } });
});
