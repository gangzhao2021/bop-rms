import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
const doubles = vi.hoisted(() => ({ resolve: vi.fn(), compose: vi.fn(), prepare: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.resolve }));
vi.mock("./merchant-ordinary-refund-operation.js", () => ({
  createMerchantOrdinaryRefundOperation: doubles.compose,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantOrdinaryRefundCommand>[0];
function setup() {
  const tx = {};
  const allowed = vi.fn(async () => true);
  doubles.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
  });
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const configure = vi.fn(async () => ({})) as unknown as Options["resolveConfiguration"];
  const operation = createMerchantOrdinaryRefundCommand({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    resolveConfiguration: configure,
    audit: {
      reasonCode: "CUSTOMER_REQUEST",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(6),
      requestReference: id(7),
      paymentAttemptReference: id(8),
      operationReference: id(9),
      auditReference: id(10),
      approvalReference: null,
    },
  };
  return { tx, allowed, run, authenticate, configure, operation, input };
}
beforeEach(() => {
  vi.clearAllMocks();
  doubles.prepare.mockResolvedValue({ status: "Created" });
  doubles.compose.mockImplementation(() => ({ prepareAndRecord: doubles.prepare }));
});
it("binds session, executor, selected scope and stable Provider operation identity", async () => {
  const f = setup();
  await f.operation(f.input);
  expect(doubles.resolve).toHaveBeenCalledWith(
    f.tx,
    "synthetic-cookie",
    "payment.refund.execute",
    id(5),
  );
  expect(doubles.prepare.mock.calls[0]?.[1]).toEqual({
    ...f.input.command,
    executorReference: id(4),
    providerOperationReference: id(9),
  });
  const opts = doubles.compose.mock.calls[0]?.[0];
  const query = { ...opts.scope, orderReference: id(6), requestReference: id(7) };
  expect(await opts.authorize({}, query)).toBe(true);
  expect(await opts.authorize({}, { ...query, requestReference: id(99) })).toBe(false);
  f.allowed.mockResolvedValue(false);
  expect(await opts.authorize({}, query)).toBe(false);
});
it.each([
  "executorReference",
  "amountMinor",
  "providerAccountReference",
  "providerOperationReference",
  "tenantReference",
])("rejects body injection of %s before transaction", async (key) => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, [key]: id(99) } }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects authentication and CSRF failure before transaction", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects revoked execute authority before configuration", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.configure).not.toHaveBeenCalled();
});
it("throws before caller transaction commits when final authorization is lost", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_COMMAND_DENIED");
  expect(doubles.prepare).toHaveBeenCalledTimes(1);
});

it("supplies current server context and retained authority to configuration without browser overrides", async () => {
  const f = setup();
  await f.operation(f.input);
  const calls = vi.mocked(f.configure).mock.calls;
  expect(calls[0]?.[1]).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  });
  const authority = calls[0]?.[2];
  expect(authority?.context).toEqual({ brand: { brandReference: id(2) } });
  expect(Object.isFrozen(authority)).toBe(true);
  expect(await authority?.authorize()).toBe(true);
  f.allowed.mockResolvedValue(false);
  expect(await authority?.authorize()).toBe(false);
});
