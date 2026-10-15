import { beforeEach, expect, it, vi } from "vitest";
import { KitchenStaleTicketError } from "@rms/kitchen";
import { createMerchantKitchenStaleClose } from "./merchant-kitchen-stale-close.js";

const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  close: vi.fn(),
  dates: vi.fn(),
  today: vi.fn(),
  rounds: vi.fn(),
}));
vi.mock("./merchant-round-business-date.js", () => ({
  createMerchantRoundBusinessDates: () => doubles.rounds,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("./merchant-store-business-day.js", () => ({
  createMerchantStoreBusinessDay: () => doubles.today,
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenStaleTicketStore: doubles.store,
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  listStoreOrderBusinessDates: doubles.dates,
}));
const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-10-14T12:00:00.000Z";
const command = {
  idempotencyKey: id(10),
  ticketReference: id(2),
  expectedTicketVersion: "4",
  reasonCode: "NOT_MADE_ABANDONED",
  correlationReference: id(11),
};
type Options = Parameters<typeof createMerchantKitchenStaleClose>[0];
function setup() {
  const allowed = vi.fn(async () => true);
  const authorize = vi.fn(async () => ({ sessionReference: id(9), policy: { code: "Standard" } }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(7),
    selected: { tenantReference: id(14) },
    context: { brand: { brandReference: id(12) } },
    store: { storeReference: id(13), timeZone: "America/Toronto" },
    allowed,
  });
  doubles.store.mockReturnValue({ close: doubles.close });
  doubles.close.mockResolvedValue({
    status: "Closed",
    closure: {
      ticketReference: id(2),
      reasonCode: "NOT_MADE_ABANDONED",
      foodMade: false,
      orderBusinessDate: "2026-10-09",
      closedAt: now,
    },
  });
  const close = createMerchantKitchenStaleClose({
    persistence: { transactions: { run }, now: () => now } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    nextReference: () => id(99),
  });
  return { close, allowed, run };
}
const input = (body: unknown) => ({ sessionCookie: "synthetic", csrf: "synthetic", command: body });
beforeEach(() => vi.resetAllMocks());

it("DEC-KITCHEN-STALE-TICKETS: a manager closes with the narrow permission; actor, Store, time and both business days come from the server", async () => {
  const { close } = setup();
  await expect(close(input(command))).resolves.toEqual({
    status: "Closed",
    ticketReference: id(2),
    reasonCode: "NOT_MADE_ABANDONED",
    foodMade: false,
    orderBusinessDate: "2026-10-09",
    closedAt: now,
  });
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("kitchen.ticket.close_stale");
  expect(doubles.store).toHaveBeenCalledWith(
    expect.objectContaining({ brandReference: id(12), storeReference: id(13) }),
  );
  const call = doubles.close.mock.calls[0]?.[1];
  expect(call).toMatchObject({ command, actorReference: id(7), occurredAt: now });
  doubles.dates.mockResolvedValue(new Map([[id(3), "2026-10-09"]]));
  doubles.today.mockResolvedValue({ businessDate: "2026-10-14" });
  doubles.rounds.mockResolvedValue(new Map([[id(4), "2026-10-09"]]));
  await expect(call.businessDays(id(3), id(4))).resolves.toEqual({
    orderBusinessDate: "2026-10-09",
    currentBusinessDate: "2026-10-14",
  });
  expect(doubles.rounds.mock.calls[0]?.[1]).toEqual([id(4)]);
  // WP-2423 D4: a round added today to a table opened on an earlier day is today's work.
  doubles.rounds.mockResolvedValue(new Map([[id(4), "2026-10-14"]]));
  await expect(call.businessDays(id(3), id(4))).resolves.toEqual({
    orderBusinessDate: "2026-10-14",
    currentBusinessDate: "2026-10-14",
  });
  expect(doubles.dates.mock.calls[0]?.[1]).toEqual({
    brandReference: id(12),
    storeReference: id(13),
  });
});

it("DEC-KITCHEN-STALE-TICKETS: refuses browser authority, unknown reasons and a revoked permission", async () => {
  {
    const { close, run } = setup();
    for (const body of [
      { ...command, actorReference: id(20) },
      { ...command, storeReference: id(21) },
      { ...command, orderBusinessDate: "2026-10-01" },
      { ...command, reasonCode: "REFUNDED" },
    ])
      await expect(close(input(body))).rejects.toMatchObject({
        code: "KITCHEN_STALE_TICKET_INPUT_INVALID",
      });
    expect(run).not.toHaveBeenCalled();
  }
  {
    const { close, allowed } = setup();
    allowed.mockResolvedValue(false);
    await expect(close(input(command))).rejects.toBeInstanceOf(KitchenStaleTicketError);
    expect(doubles.close).not.toHaveBeenCalled();
  }
});
