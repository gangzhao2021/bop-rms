import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantKitchenQuery, kdsOperatorStatus } from "./merchant-kitchen-query.js";
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
      {
        workItemReference: id(5),
        orderReference: id(6),
        ticketAggregateVersion: 9007199254740993n,
        workItemVersion: 2n,
      },
    ],
  });
  doubles.get.mockResolvedValue({
    item: {
      workItemReference: id(5),
      orderReference: id(6),
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
        orderReference: id(6),
        ticketAggregateVersion: "9007199254740993",
        workItemVersion: "2",
        allergens: { status: "Unavailable" },
        orderLabel: null,
        customerNote: null,
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
      orderReference: id(6),
      ticketAggregateVersion: "9007199254740993",
      workItemVersion: "2",
      allergens: { status: "Unavailable" },
      orderLabel: null,
      customerNote: null,
    },
  });
});
it("WP-2423 Q3: serves the published menu disclosure per work item and restores Store scope", async () => {
  const f = setup();
  const disclosure = {
    registryVersionReference: id(30),
    items: [
      {
        allergenReference: id(31),
        code: "MILK",
        localizedNames: { "en-CA": "Milk", "fr-CA": "Lait" },
        classification: "Contains",
      },
    ],
    allergenFreeClaim: false,
    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
  };
  f.tx.query.mockImplementation((async (sql: string) =>
    sql.includes("FROM rms_kitchen.kitchen_work_item")
      ? {
          rows: [
            {
              work_item: id(5),
              menu_version: id(20),
              sku: id(21),
              product_version: id(22),
              customer_note: "Synthetic note: no onions",
            },
          ],
          rowCount: 1,
        }
      : sql.includes("FROM rms_ordering.order_header")
        ? {
            rows: [
              { order_id: id(6), order_number: "14", order_type: "DineIn", dining_session: id(40) },
            ],
            rowCount: 1,
          }
        : sql.includes("FROM rms_dining.dining_session")
          ? { rows: [{ session_id: id(40), label: "T4" }], rowCount: 1 }
          : sql.includes("published_menu_projection_sellable")
            ? {
                rows: [
                  {
                    menu_version: id(20),
                    sellable: id(21),
                    product_version: id(22),
                    default_locale: "en-CA",
                    disclosure: JSON.stringify(disclosure),
                  },
                ],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 }) as never);
  const result = (await f.operation(f.input)) as {
    items: { allergens: unknown; orderLabel: unknown; customerNote: unknown }[];
  };
  // WP-2423 Q2: the Order's number and current table, and the note for display only.
  expect(result.items[0]?.orderLabel).toEqual({
    orderNumber: "14",
    orderType: "DineIn",
    tableLabel: "T4",
  });
  expect(result.items[0]?.customerNote).toBe("Synthetic note: no onions");
  expect(result.items[0]?.allergens).toEqual({
    status: "Declared",
    items: [{ code: "MILK", name: "Milk", classification: "Contains" }],
  });
  const calls = f.tx.query.mock.calls as unknown as [string, unknown[]][];
  const catalogRead = calls.findIndex(([sql]) =>
    sql.includes("published_menu_projection_sellable"),
  );
  expect(calls[catalogRead - 1]?.[1]).toEqual([id(3)]);
  expect(calls[catalogRead + 1]).toEqual([
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [id(3), id(4)],
  ]);
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
        orderReference: id(7),
        ticketAggregateVersion: 3n,
        workItemVersion: 2n,
        selectedOptions,
      },
    ],
  });
  doubles.get.mockResolvedValue({
    item: {
      workItemReference: id(5),
      orderReference: id(7),
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
describe("kdsOperatorStatus", () => {
  const base = (session: object, overrides: object = {}) => ({
    session: session as Parameters<typeof kdsOperatorStatus>[0]["session"],
    actorReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    observedAt: "2026-09-19T12:00:00.000Z",
    projection: {
      projectionGenerationReference: id(7),
      sourceCheckpointReference: id(8),
      freshnessStatus: "Fresh" as const,
      asOfUtc: "2026-09-19T11:59:59.000Z",
    },
    ...overrides,
  });
  const kds = (overrides: object = {}) => ({
    sessionReference: id(9),
    status: "Active",
    version: 1,
    policy: { code: "NamedKdsOperator" },
    idleExpiresAt: "2026-09-19T13:00:00.000Z",
    absoluteExpiresAt: "2026-09-19T23:00:00.000Z",
    ...overrides,
  });
  it("is Named only for a current NamedKdsOperator Session", () => {
    expect(kdsOperatorStatus(base(kds()))).toBe("Named");
  });
  it("keeps ordinary Workforce Sessions unverified for Kitchen commands", () => {
    expect(kdsOperatorStatus(base(kds({ policy: { code: "WorkforceStandard" } })))).toBe(
      "Unverified",
    );
  });
  it("fails closed at the earlier of idle and absolute expiry", () => {
    // Authentication already refuses expired Sessions; Kitchen evidence also refuses them.
    expect(kdsOperatorStatus(base(kds({ idleExpiresAt: "2026-09-19T11:59:00.000Z" })))).toBe(
      "Unavailable",
    );
    expect(kdsOperatorStatus(base(kds({ absoluteExpiresAt: "2026-09-19T12:00:00.000Z" })))).toBe(
      "Unavailable",
    );
    expect(kdsOperatorStatus(base(kds({ status: "Revoked" })))).toBe("Locked");
  });
  it("leaves staleness to the board freshness gate", () => {
    const stale = base(kds());
    expect(
      kdsOperatorStatus({
        ...stale,
        projection: { ...stale.projection, freshnessStatus: "Stale" },
      }),
    ).toBe("Named");
  });
  it("fails closed for projection evidence newer than the observation", () => {
    const future = base(kds());
    expect(
      kdsOperatorStatus({
        ...future,
        projection: { ...future.projection, asOfUtc: "2026-09-19T12:00:01.000Z" },
      }),
    ).toBe("Unavailable");
  });
});
