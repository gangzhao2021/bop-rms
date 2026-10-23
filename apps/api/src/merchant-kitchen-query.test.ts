import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantKitchenQuery, kdsOperatorStatus } from "./merchant-kitchen-query.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  service: vi.fn(),
  queries: vi.fn(),
  lock: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  roundDates: vi.fn(),
  today: vi.fn(),
}));
vi.mock("./merchant-round-business-date.js", async (original) => ({
  ...(await original<object>()),
  createMerchantRoundBusinessDates: () => doubles.roundDates,
}));
vi.mock("./merchant-business-day-window.js", () => ({
  createMerchantBusinessDayWindows: () => ({ today: doubles.today }),
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
    authorizeAction = vi.fn<(action: string) => Promise<{ effect: string }>>(async () => ({
      effect: "Deny",
    })),
    authorize = vi.fn(async () => ({ sessionReference: id(9) }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
    authorizeAction,
  });
  doubles.service.mockReturnValue({ list: doubles.list, get: doubles.get });
  doubles.list.mockResolvedValue({
    items: [
      {
        workItemReference: id(5),
        ticketReference: id(7),
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
  return { operation, input, allowed, authorize, authorizeAction, run, tx };
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
    canCloseEarlierDayTickets: false,
    // The Store's business day could not be read here: the search says nothing about acceptance.
    awaitingAcceptance: null,
    items: [
      {
        workItemReference: id(5),
        ticketReference: id(7),
        orderReference: id(6),
        ticketAggregateVersion: "9007199254740993",
        workItemVersion: "2",
        allergens: { status: "Unavailable" },
        orderLabel: null,
        businessDate: null,
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
      businessDate: null,
      customerNote: null,
    },
  });
});
it("DEC-KITCHEN-STALE-TICKETS: labels each ticket with its Order's business day, drops closed tickets at once and says who may close", async () => {
  const f = setup();
  doubles.list.mockResolvedValue({
    items: [
      { workItemReference: id(5), ticketReference: id(7), orderReference: id(6) },
      { workItemReference: id(8), ticketReference: id(10), orderReference: id(11) },
    ].map((item) => ({ ...item, ticketAggregateVersion: 3n, workItemVersion: 2n })),
  });
  f.authorizeAction.mockResolvedValue({ effect: "Allow" });
  f.tx.query.mockImplementation((async (sql: string) =>
    sql.includes("FROM rms_kitchen.kitchen_ticket_closure")
      ? { rows: [{ ticket: id(10) }], rowCount: 1 }
      : sql.includes("business_date::text")
        ? { rows: [{ order_id: id(6), business_date: "2026-10-09" }], rowCount: 1 }
        : { rows: [], rowCount: 0 }) as never);
  const result = (await f.operation(f.input)) as {
    canCloseEarlierDayTickets: boolean;
    items: { workItemReference: string; businessDate: string | null }[];
  };
  expect(result.items.map((item) => [item.workItemReference, item.businessDate])).toEqual([
    [id(5), "2026-10-09"],
  ]);
  expect(result.canCloseEarlierDayTickets).toBe(true);
  expect(f.authorizeAction).toHaveBeenCalledWith("kitchen.ticket.close_stale");
});
it("WP-2423 D4: a round added today to a table opened on an earlier day is today's kitchen work", async () => {
  const f = setup();
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4), timeZone: "America/Toronto" },
    allowed: f.allowed,
    authorizeAction: f.authorizeAction,
  });
  doubles.list.mockResolvedValue({
    items: [
      // The table's first round (Oct 11) and a round added today (Oct 15), one Order.
      { workItemReference: id(5), ticketReference: id(7), orderBatchReference: id(20) },
      { workItemReference: id(8), ticketReference: id(10), orderBatchReference: id(21) },
    ].map((item) => ({
      ...item,
      orderReference: id(6),
      ticketAggregateVersion: 3n,
      workItemVersion: 2n,
    })),
  });
  f.tx.query.mockImplementation((async (sql: string) =>
    sql.includes("business_date::text")
      ? { rows: [{ order_id: id(6), business_date: "2026-10-11" }], rowCount: 1 }
      : { rows: [], rowCount: 0 }) as never);
  doubles.roundDates.mockResolvedValue(
    new Map([
      [id(20), "2026-10-11"],
      [id(21), "2026-10-15"],
    ]),
  );
  const result = (await f.operation(f.input)) as {
    items: { workItemReference: string; businessDate: string | null }[];
  };
  expect(doubles.roundDates.mock.calls[0]?.[1]).toEqual([id(20), id(21)]);
  expect(result.items.map((item) => [item.workItemReference, item.businessDate])).toEqual([
    [id(5), "2026-10-11"],
    [id(8), "2026-10-15"],
  ]);
  // A round whose date can't be resolved keeps the Order's date (the earlier behaviour).
  doubles.roundDates.mockResolvedValue(new Map());
  const fallback = (await f.operation(f.input)) as typeof result;
  expect(fallback.items.map((item) => item.businessDate)).toEqual(["2026-10-11", "2026-10-11"]);
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
    // WP-2423 Q7 slice 2: no staff record names this order or round.
    enteredByStaff: false,
  });
  expect(result.items[0]?.customerNote).toBe("Synthetic note: no onions");
  expect(result.items[0]?.allergens).toEqual({
    status: "Declared",
    forChoices: false,
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
  // WP-2423 ⑪: with per-choice disclosure the cook sees what this item contains as ordered (here
  // with no option chosen: none of the listed allergens), not every choice's union.
  Object.assign(disclosure, {
    byChoice: {
      options: [id(50)],
      outcomes: [[], [{ code: "MILK", classification: "Contains" }]],
      sets: [[0], [1, 0]],
    },
  });
  // Options unknown on the item are never read as "none chosen": the union stays.
  const unknown = (await f.operation(f.input)) as typeof result;
  expect(unknown.items[0]?.allergens).toMatchObject({
    forChoices: false,
    items: [{ code: "MILK" }],
  });
  doubles.list.mockResolvedValue({
    items: [
      {
        workItemReference: id(5),
        ticketReference: id(7),
        orderReference: id(6),
        ticketAggregateVersion: 9007199254740993n,
        workItemVersion: 2n,
        selectedOptions: [],
      },
    ],
  });
  const exact = (await f.operation(f.input)) as typeof result;
  expect(exact.items[0]?.allergens).toEqual({ status: "Declared", forChoices: true, items: [] });
  doubles.list.mockResolvedValue({
    items: [
      {
        workItemReference: id(5),
        ticketReference: id(7),
        orderReference: id(6),
        ticketAggregateVersion: 9007199254740993n,
        workItemVersion: 2n,
        selectedOptions: [
          { optionReference: id(50), quantity: 2, localizedNames: { "en-CA": "Whole milk" } },
        ],
      },
    ],
  });
  const withOption = (await f.operation(f.input)) as typeof result;
  expect(withOption.items[0]?.allergens).toEqual({
    status: "Declared",
    forChoices: true,
    items: [{ code: "MILK", name: "Milk", classification: "Contains" }],
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
        ticketReference: id(12),
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

it("WP-2423 v15: names today's orders waiting for acceptance on the first page only", async () => {
  const f = setup();
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4), timeZone: "America/Toronto" },
    selected: { tenantReference: id(1) },
    allowed: f.allowed,
    authorizeAction: f.authorizeAction,
  });
  doubles.today.mockResolvedValue({
    businessDate: "2026-09-19",
    startsAt: "2026-09-19T08:00:00.000Z",
    timeZone: "America/Toronto",
  });
  const query = f.tx.query as unknown as ReturnType<
    typeof vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>
  >;
  query.mockImplementation(async (sql: string) =>
    sql.includes("order_payment_acceptance_wait")
      ? {
          rows: [
            { order_id: id(20), order_number: "13", order_type: "Pickup", dining_session: null },
            { order_id: id(21), order_number: "7", order_type: "DineIn", dining_session: id(22) },
          ],
          rowCount: 2,
        }
      : sql.includes("rms_dining.dining_session")
        ? { rows: [{ session_id: id(22), label: "T4" }], rowCount: 1 }
        : sql.includes("capacity_asap_commitment")
          ? { rows: [{ order_id: id(20), expires_at: "2026-09-19T12:02:00.000Z" }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
  );
  const result = (await f.operation(f.input)) as { awaitingAcceptance: unknown };
  expect(doubles.today).toHaveBeenCalledWith(expect.anything(), "2026-09-19T12:00:00.000Z");
  // Warn before timeouts: the paid pickup carries when it is refunded unless accepted; a dine-in
  // round is never refunded for waiting.
  expect(result.awaitingAcceptance).toEqual([
    {
      orderNumber: "13",
      orderType: "Pickup",
      tableLabel: null,
      acceptBy: "2026-09-19T12:02:00.000Z",
    },
    { orderNumber: "7", orderType: "DineIn", tableLabel: "T4", acceptBy: null },
  ]);
  const deadlines = query.mock.calls.find(([sql]) =>
    String(sql).includes("capacity_asap_commitment"),
  );
  expect(deadlines?.[1]).toEqual([id(3), id(4), [id(20)]]);
  const waiting = query.mock.calls.find(([sql]) =>
    String(sql).includes("order_payment_acceptance_wait"),
  );
  // Today's business day only: an earlier day's order with the same number is never named.
  expect(waiting?.[1]).toEqual([id(3), id(4), "2026-09-19", "2026-09-19T08:00:00.000Z", 100]);
  // Later pages do not read it again.
  const next = (await f.operation({
    ...f.input,
    query: { ...f.input.query, cursor: { afterWorkItemReference: id(5) } },
  })) as Record<string, unknown>;
  expect(Object.hasOwn(next, "awaitingAcceptance")).toBe(false);
});
