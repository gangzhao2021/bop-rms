import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantKitchenCommand } from "./merchant-kitchen-command.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  service: vi.fn(),
  store: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createKitchenWorkLifecycleService: doubles.service,
  createPostgresKitchenWorkLifecycleStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = {
  action: "AcceptKitchenWorkItem",
  idempotencyKey: id(1),
  actorReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  ticketReference: id(5),
  workItemReference: id(6),
  orderItemReference: id(7),
  expectedTicketVersion: "1",
  expectedWorkItemVersion: "1",
  correlationReference: id(8),
};
type Options = Parameters<typeof createMerchantKitchenCommand>[0];
function setup() {
  const allowed = vi.fn(async () => true);
  const authorize = vi.fn(async () => ({
    sessionReference: id(9),
    policy: { code: "NamedKdsOperator" },
  }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({});
  doubles.service.mockReturnValue({ execute: doubles.execute });
  doubles.execute.mockResolvedValue({ outcome: "Accepted" });
  const operation = createMerchantKitchenCommand({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    lifecycle: {} as Options["lifecycle"],
    validateCurrentSource: vi.fn(async () => true),
  });
  const input = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf", command };
  return { operation, input, allowed, authorize, run, tx };
}
beforeEach(() => vi.resetAllMocks());
it("authenticates before opening business transactions", async () => {
  const s = setup();
  s.authorize.mockRejectedValue(new Error("denied"));
  await expect(s.operation(s.input)).rejects.toThrow();
  expect(s.run).not.toHaveBeenCalled();
  expect(doubles.service).not.toHaveBeenCalled();
});
it.each(["WorkforceStandard", "Privileged", undefined])(
  "rejects a %s session before opening business transactions",
  async (policyCode) => {
    const s = setup();
    s.authorize.mockResolvedValue({
      sessionReference: id(9),
      policy: policyCode ? { code: policyCode } : undefined,
    } as never);
    await expect(s.operation(s.input)).rejects.toMatchObject({
      code: "KITCHEN_WORK_PERMISSION_DENIED",
    });
    expect(s.run).not.toHaveBeenCalled();
    expect(doubles.service).not.toHaveBeenCalled();
  },
);
it.each(["actorReference", "brandReference", "storeReference"])(
  "rejects body %s outside current authority",
  async (field) => {
    const s = setup();
    await expect(
      s.operation({ ...s.input, command: { ...command, [field]: id(99) } }),
    ).rejects.toMatchObject({ code: "KITCHEN_WORK_PERMISSION_DENIED" });
    expect(doubles.store).not.toHaveBeenCalled();
  },
);
it("rejects current denied permission before owner access", async () => {
  const s = setup();
  s.allowed.mockResolvedValue(false);
  await expect(s.operation(s.input)).rejects.toMatchObject({
    code: "KITCHEN_WORK_PERMISSION_DENIED",
  });
  expect(doubles.store).not.toHaveBeenCalled();
});
it("binds trusted authority and rechecks revoked authority for execute and recovery", async () => {
  const s = setup();
  await expect(s.operation(s.input)).resolves.toEqual({ outcome: "Accepted" });
  const service = doubles.service.mock.calls[0]?.[0];
  const store = doubles.store.mock.calls[0]?.[0];
  expect(doubles.scope).toHaveBeenCalledWith(s.tx, s.input.sessionCookie, "kitchen.operate", id(9));
  expect(await service.trustedContext.resolveAuthority()).toEqual({
    actorReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    observedAt: "2026-09-19T12:00:00.000Z",
  });
  expect(service.clock.now()).toBe((await service.trustedContext.resolveAuthority()).observedAt);
  expect(doubles.execute).toHaveBeenCalledWith(command);
  expect(await store.authorize(s.tx, { access: "Recover", idempotencyKey: id(1) })).toBe(true);
  s.allowed.mockResolvedValue(false);
  expect(await service.authorization.authorize(command)).toBe(false);
  expect(await store.authorize(s.tx, { access: "Execute", command })).toBe(false);
  expect(await store.authorize(s.tx, { access: "Recover", idempotencyKey: id(1) })).toBe(false);
});

it("binds browser intent to current named Actor and Brand while preserving its Store and idempotency", async () => {
  const s = setup();
  const { actorReference: _actor, brandReference: _brand, ...intent } = command;
  void _actor;
  void _brand;
  await s.operation({ ...s.input, command: { ...intent, authority: "CurrentMerchantSession" } });
  expect(doubles.execute).toHaveBeenCalledWith(command);
});
it("rejects browser intent after Store switch and rejects authority injection", async () => {
  const s = setup();
  const { actorReference: _actor, brandReference: _brand, ...intent } = command;
  void _actor;
  void _brand;
  await expect(
    s.operation({
      ...s.input,
      command: { ...intent, authority: "CurrentMerchantSession", storeReference: id(99) },
    }),
  ).rejects.toMatchObject({ code: "KITCHEN_WORK_PERMISSION_DENIED" });
  await expect(
    s.operation({
      ...s.input,
      command: { ...intent, authority: "CurrentMerchantSession", actorReference: id(99) },
    }),
  ).rejects.toMatchObject({ code: "KITCHEN_WORK_INPUT_INVALID" });
  expect(doubles.execute).not.toHaveBeenCalled();
});
