import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrdinaryRefundSendCommand } from "./merchant-ordinary-refund-send-command.js";
const f = vi.hoisted(() => ({ scope: vi.fn(), compose: vi.fn(), provider: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => f.scope }));
vi.mock("./merchant-ordinary-refund-operation.js", () => ({
  createMerchantOrdinaryRefundSend: f.compose,
}));
type Options = Parameters<typeof createMerchantOrdinaryRefundSendCommand>[0];
type Send = Parameters<
  typeof import("./merchant-ordinary-refund-operation.js").createMerchantOrdinaryRefundSend
>[0];
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function setup() {
  const state = { allowed: true, actor: id(4) },
    events: string[] = [];
  let transaction = 0;
  f.scope.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: state.actor,
    allowed: async () => state.allowed,
  }));
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => {
    const tx = { number: ++transaction };
    try {
      const result = await work(tx);
      events.push("commit");
      return result;
    } catch (e) {
      events.push("rollback");
      throw e;
    }
  });
  const configure = vi.fn(async () => ({})) as unknown as Options["resolveConfiguration"];
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      operationReference: id(6),
      orderReference: id(7),
      requestReference: id(8),
      dispatchReference: id(9),
      auditReference: id(10),
      approvalReference: null,
    },
  };
  const command = createMerchantOrdinaryRefundSendCommand({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(5) }),
    } as unknown as Options["authentication"],
    resolveConfiguration: configure,
    audit: {
      reasonCode: "CUSTOMER_REQUEST",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
  return { state, events, run, configure, input, command };
}
it("rechecks current session across committed dispatch and observation transactions", async () => {
  const x = setup();
  let captured: Parameters<Send["authorize"]>[0] | undefined;
  let options: Send | undefined;
  f.compose.mockImplementation((value: Send) => {
    options = value;
    return async () => {
      await value.transactions.run(async (tx) => {
        captured = tx;
        expect(
          await value.authorize(tx, {
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            orderReference: id(7),
            requestReference: id(8),
          }),
        ).toBe(true);
      });
      expect(x.events).toEqual(["commit", "commit"]);
      f.provider();
      await value.transactions.run(async () => undefined);
      return { state: "NeedsReconciliation" };
    };
  });
  await expect(x.command(x.input)).resolves.toEqual({ state: "NeedsReconciliation" });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(x.run).toHaveBeenCalledTimes(3);
  if (!options || !captured) throw new Error("Missing captured transaction");
  await expect(
    options.authorize(captured, {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      orderReference: id(7),
      requestReference: id(8),
    }),
  ).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(
    f.scope.mock.calls.every((call) => call[2] === "payment.refund.execute" && call[3] === id(5)),
  ).toBe(true);
});
it("rolls back on permission withdrawal before commit without reaching Provider I/O", async () => {
  const x = setup();
  f.compose.mockImplementation((value: Send) => async () => {
    await value.transactions.run(async () => {
      x.state.allowed = false;
    });
    f.provider();
  });
  await expect(x.command(x.input)).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(x.events).toEqual(["commit", "rollback"]);
  expect(f.provider).not.toHaveBeenCalled();
});
it("denies an actor change after preflight before dispatch work", async () => {
  const x = setup(),
    work = vi.fn();
  f.compose.mockImplementation((value: Send) => async () => {
    x.state.actor = id(99);
    return value.transactions.run(work);
  });
  await expect(x.command(x.input)).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(work).not.toHaveBeenCalled();
});
it("rejects browser money fields before starting a transaction", async () => {
  const x = setup();
  await expect(
    x.command({ ...x.input, command: { ...x.input.command, amountMinor: "100" } }),
  ).rejects.toThrow();
  expect(x.run).not.toHaveBeenCalled();
  expect(f.compose).not.toHaveBeenCalled();
});
