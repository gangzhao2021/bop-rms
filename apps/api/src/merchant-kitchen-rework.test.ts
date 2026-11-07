import { beforeEach, expect, it, vi } from "vitest";
import { KitchenReworkError } from "@rms/kitchen";
import { createMerchantKitchenRework } from "./merchant-kitchen-rework.js";

const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenReworkStore: doubles.store,
}));
const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-10-14T12:00:00.000Z";
const item = {
  reworkReference: id(1),
  ticketReference: id(2),
  originalWorkItemReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  orderItemReference: id(6),
  ordinal: 1,
  reasonCode: "DROPPED",
  note: null,
  quantity: 1,
  wasteApplies: true,
  status: "Queued",
  version: 1,
  createdBy: id(7),
  createdAt: now,
  startedBy: null,
  startedAt: null,
  completedBy: null,
  completedAt: null,
  eventReference: id(8),
};
const create = {
  action: "CreateKitchenRework",
  idempotencyKey: id(10),
  originalWorkItemReference: id(3),
  reasonCode: "DROPPED",
  note: null,
  quantity: 1,
  correlationReference: id(11),
};
type Options = Parameters<typeof createMerchantKitchenRework>[0];
function setup(policy = "NamedKdsOperator") {
  const allowed = vi.fn(async () => true);
  const reworkDecision = vi.fn(async (): Promise<unknown> => ({ effect: "Allow" }));
  // One current-fact read for the board permission and the remake permission together.
  const authorizeActions = vi.fn(
    async (actions: readonly string[]) =>
      new Map(
        await Promise.all(
          actions.map(
            async (action) =>
              [
                action,
                action === "kitchen.work_item.rework"
                  ? await reworkDecision()
                  : { effect: "Allow" },
              ] as const,
          ),
        ),
      ),
  );
  const authorize = vi.fn(async () => ({ sessionReference: id(9), policy: { code: policy } }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const inside = { thrown: false };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => {
    try {
      return await work(tx);
    } catch (error) {
      inside.thrown = true;
      throw error;
    }
  });
  doubles.scope.mockResolvedValue({
    actorReference: id(7),
    context: { brand: { brandReference: id(12) } },
    store: { storeReference: id(13) },
    allowed,
    authorizeActions,
  });
  doubles.store.mockReturnValue({ execute: doubles.execute, listCurrent: doubles.list });
  doubles.execute.mockResolvedValue({ status: "Applied", action: "CreateKitchenRework", item });
  doubles.list.mockResolvedValue([]);
  const rework = createMerchantKitchenRework({
    persistence: { transactions: { run }, now: () => now } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    nextReference: () => id(99),
  });
  return { rework, allowed, authorizeActions, reworkDecision, authorize, run, inside };
}
const input = (command: unknown) => ({ sessionCookie: "synthetic", csrf: "synthetic", command });
beforeEach(() => vi.resetAllMocks());

it("WP-2423 Q26: a named kitchen operator with the rework permission remakes a dish; actor, scope and time come from the session", async () => {
  const { rework } = setup();
  const result = await rework.command(input(create));
  expect(result).toMatchObject({ status: "Applied", action: "CreateKitchenRework" });
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("kitchen.work_item.rework");
  expect(doubles.store).toHaveBeenCalledWith(
    expect.objectContaining({ brandReference: id(12), storeReference: id(13) }),
  );
  expect(doubles.execute.mock.calls[0]?.[1]).toEqual({
    command: create,
    actorReference: id(7),
    occurredAt: now,
  });
});

it("WP-2423 Q26: starting or finishing a remake needs the kitchen board permission only", async () => {
  const { rework } = setup();
  doubles.execute.mockResolvedValue({ status: "Applied", action: "StartKitchenRework", item });
  await rework.command(
    input({
      action: "StartKitchenRework",
      idempotencyKey: id(14),
      reworkReference: id(1),
      expectedVersion: 1,
      correlationReference: id(15),
    }),
  );
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("kitchen.operate");
});

it("WP-2423 (2026-10-18): cancelling an open remake needs the remake permission and passes the reason through", async () => {
  const { rework } = setup();
  const cancel = {
    action: "CancelKitchenRework",
    idempotencyKey: id(16),
    reworkReference: id(1),
    expectedVersion: 1,
    cancelReasonCode: "OPENED_BY_MISTAKE",
    correlationReference: id(17),
  };
  doubles.execute.mockResolvedValue({
    status: "Applied",
    action: "CancelKitchenRework",
    item: {
      ...item,
      status: "Cancelled",
      version: 2,
      cancelledBy: id(7),
      cancelledAt: now,
      cancelReasonCode: "OPENED_BY_MISTAKE",
    },
  });
  const result = await rework.command(input(cancel));
  expect(doubles.scope.mock.calls[0]?.[2]).toBe("kitchen.work_item.rework");
  expect(doubles.execute.mock.calls[0]?.[1]).toMatchObject({ command: cancel });
  expect(result).toMatchObject({
    action: "CancelKitchenRework",
    rework: { status: "Cancelled", cancelReasonCode: "OPENED_BY_MISTAKE", cancelledAt: now },
  });
  // No browser-chosen reason outside the list, and no extra authority fields.
  for (const invalid of [
    { ...cancel, cancelReasonCode: "CHANGED_MIND" },
    { ...cancel, actorReference: id(20) },
  ])
    await expect(rework.command(input(invalid))).rejects.toMatchObject({
      code: "KITCHEN_REWORK_INPUT_INVALID",
    });
});

it("WP-2423 Q26: refuses other sessions, missing permission and browser-supplied authority", async () => {
  {
    const { rework, run } = setup("Standard");
    await expect(rework.command(input(create))).rejects.toMatchObject({
      code: "KITCHEN_REWORK_PERMISSION_DENIED",
    });
    expect(run).not.toHaveBeenCalled();
  }
  {
    const { rework, allowed } = setup();
    allowed.mockResolvedValue(false);
    await expect(rework.command(input(create))).rejects.toBeInstanceOf(KitchenReworkError);
    expect(doubles.execute).not.toHaveBeenCalled();
  }
  {
    const { rework, run } = setup();
    for (const extra of [{ actorReference: id(20) }, { storeReference: id(21) }])
      await expect(rework.command(input({ ...create, ...extra }))).rejects.toMatchObject({
        code: "KITCHEN_REWORK_INPUT_INVALID",
      });
    expect(run).not.toHaveBeenCalled();
  }
});

it("WP-2423 Q26: the board read says whether this operator may remake", async () => {
  const { rework, authorizeActions, reworkDecision, allowed } = setup();
  await expect(rework.query({ sessionCookie: "s", csrf: "c" })).resolves.toMatchObject({
    storeReference: id(13),
    canRework: true,
    items: [],
  });
  // WP-2423: two full resolutions — both permissions at the start, the caller before the reply.
  expect(authorizeActions).toHaveBeenCalledExactlyOnceWith([
    "kitchen.operate",
    "kitchen.work_item.rework",
  ]);
  expect(allowed).toHaveBeenCalledOnce();
  reworkDecision.mockResolvedValue({ effect: "Deny" });
  await expect(rework.query({ sessionCookie: "s", csrf: "c" })).resolves.toMatchObject({
    canRework: false,
  });
});

it("WP-2423: a board read is refused when the permission is withdrawn during it", async () => {
  const { rework, allowed, inside } = setup();
  allowed.mockResolvedValue(false);
  await expect(rework.query({ sessionCookie: "s", csrf: "c" })).rejects.toMatchObject({
    code: "KITCHEN_REWORK_PERMISSION_DENIED",
  });
  expect(doubles.list).toHaveBeenCalledOnce();
  expect(inside.thrown).toBe(true);
});

it("WP-2423: a remake resolves the caller twice and is refused before commit if withdrawn", async () => {
  {
    const { rework, allowed } = setup();
    await rework.command(input(create));
    expect(doubles.scope).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledTimes(2);
  }
  vi.clearAllMocks();
  {
    const { rework, allowed, inside } = setup();
    allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(rework.command(input(create))).rejects.toMatchObject({
      code: "KITCHEN_REWORK_PERMISSION_DENIED",
    });
    expect(doubles.execute).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledTimes(2);
    // Thrown inside the transaction callback, so the remake does not commit.
    expect(inside.thrown).toBe(true);
  }
});
