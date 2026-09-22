import { expect, it, vi } from "vitest";
import type { CustomerSessionPaymentIntentOptions } from "./customer-session-payment-intent.js";
import { createCustomerAdditionalDiningPaymentComposition } from "./customer-additional-dining-payment-composition.js";
const mocks = vi.hoisted(() => ({
  submission: vi.fn(),
  clock: vi.fn(),
  tips: vi.fn(),
  payment: vi.fn(),
}));
vi.mock("./customer-additional-dining-session-submission.js", () => ({
  createCustomerAdditionalDiningSessionSubmission: mocks.submission,
}));
vi.mock("./customer-additional-dining-session-clock.js", () => ({
  createCustomerAdditionalDiningSessionClock: mocks.clock,
}));
vi.mock("./customer-session-tip-selection.js", () => ({
  createCustomerAdditionalDiningSessionTipSelection: mocks.tips,
}));
vi.mock("./customer-session-payment-intent.js", () => ({
  createCustomerSessionPaymentIntent: mocks.payment,
}));
function fixture() {
  vi.resetAllMocks();
  const id = (n: number) => "01902402-0000-7000-8000-" + n.toString().padStart(12, "0");
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const transactions = { run: vi.fn() },
    access = { scope };
  const sourceClock = { now: () => "2026-09-13T12:00:00.000Z" };
  const parent = {
    orderReference: id(4),
    expectedOrderVersion: 3,
    originalOrderCreatedAt: "2026-09-13T11:00:00.000Z",
    batchSequence: 2,
  };
  const create = vi.fn(),
    preparePaymentClock = vi.fn(),
    select = vi.fn();
  mocks.submission.mockReturnValue({ create });
  mocks.clock.mockReturnValue({ preparePaymentClock });
  mocks.tips.mockReturnValue({ select });
  const result = { create: vi.fn() };
  mocks.payment.mockReturnValue(result);
  const options = {
    submission: {
      access,
      parent,
      runtime: { inventory: { scope }, transactions },
      source: { clock: sourceClock },
      historyAuthorization: vi.fn(),
    },
    tip: {
      preparation: { scope, now: () => "2020-01-01T00:00:00.000Z" },
      authorizeOrder: vi.fn(),
      tip: { audit: vi.fn() },
    },
    payment: {
      inventory: { load: vi.fn() },
      history: { resolveOperation: vi.fn() },
      nextPreparationReference: () => id(5),
      payment: vi.fn(),
    },
  } as unknown as Parameters<typeof createCustomerAdditionalDiningPaymentComposition>[0];
  return {
    options,
    scope,
    parent,
    access,
    transactions,
    sourceClock,
    result,
    create,
    preparePaymentClock,
    select,
  };
}
it("wires shared session, parent, transaction and clock into the Additional payment path", () => {
  const f = fixture();
  expect(createCustomerAdditionalDiningPaymentComposition(f.options)).toBe(f.result);
  expect(mocks.submission).toHaveBeenCalledWith(f.options.submission);
  expect(mocks.clock).toHaveBeenCalledWith(
    expect.objectContaining({
      access: f.access,
      scope: f.scope,
      transactions: f.transactions,
      authorizeHistory: f.options.submission.historyAuthorization,
    }),
  );
  expect(mocks.tips.mock.calls[0]?.[0]).toBe(f.access);
  expect(mocks.tips.mock.calls[0]?.[2]).toBe(f.parent);
  const tip = mocks.tips.mock.calls[0]?.[1] as typeof f.options.tip & { transactions: unknown };
  expect(tip.transactions).toBe(f.transactions);
  expect(tip.preparation.now()).toBe(f.sourceClock.now());
  const payment = mocks.payment.mock.calls[0]?.[0] as CustomerSessionPaymentIntentOptions;
  expect(payment.submissionKind).toBe("Additional");
  expect(payment.orders.create).toBe(f.create);
  expect(payment.orders.preparePaymentClock).toBe(f.preparePaymentClock);
  expect(payment.tips.select).toBe(f.select);
  expect(payment.payment).toBe(f.options.payment.payment);
});
it("rejects foreign tip scope before constructing owner adapters", () => {
  const f = fixture();
  expect(() =>
    createCustomerAdditionalDiningPaymentComposition({
      ...f.options,
      tip: {
        ...f.options.tip,
        preparation: {
          ...f.options.tip.preparation,
          scope: { ...f.options.tip.preparation.scope, storeReference: f.scope.brandReference },
        },
      },
    }),
  ).toThrow();
  expect(mocks.submission).not.toHaveBeenCalled();
  expect(mocks.payment).not.toHaveBeenCalled();
});
