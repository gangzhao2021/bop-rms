import { expect, it, vi } from "vitest";
import { createCustomerAdmittedAdditionalDiningPayment } from "./customer-admitted-additional-dining-payment.js";
import type { createCustomerPersistentAdditionalDiningPayment } from "./customer-persistent-additional-dining-payment.js";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  flow: vi.fn(),
  history: vi.fn(),
  paymentAuth: vi.fn(),
}));
vi.mock("./customer-additional-dining-payment-store.js", () => ({
  createCustomerAdditionalDiningPaymentStore: mocks.store,
}));
vi.mock("./customer-persistent-additional-dining-payment.js", () => ({
  createCustomerPersistentAdditionalDiningPayment: (options: unknown) => {
    mocks.flow(options);
    return { create: async () => options };
  },
}));
vi.mock("./customer-additional-dining-history-authorization.js", () => ({
  createCustomerAdditionalDiningHistoryAuthorization: mocks.history,
}));
vi.mock("./customer-dining-payment-authorization.js", () => ({
  createPersistentAdditionalDiningPaymentAuthorization: mocks.paymentAuth,
}));
function fixture() {
  vi.resetAllMocks();
  mocks.history.mockImplementation(() => vi.fn());
  mocks.paymentAuth.mockImplementation(() => ({ authorize: vi.fn() }));
  const admission = vi.fn((credentials: unknown) => {
    void credentials;
    return { authorizeHistory: vi.fn(), inventory: { authorize: vi.fn(), evaluate: vi.fn() } };
  });
  const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
  const sourceClock = { now: () => "2026-09-13T12:00:00.000Z" };
  const options = {
    flow: {
      submission: { runtime: { inventory: { scope } }, source: { clock: sourceClock } },
      tip: { quoteVersion: 2 },
    },
    transactions: { run: vi.fn() },
    generateObservationReference: vi.fn(),
    admission,
    payment: {
      inventory: { load: vi.fn() },
      nextPreparationReference: vi.fn(),
      ports: vi.fn(() => ({})),
    },
  } as unknown as Parameters<typeof createCustomerAdmittedAdditionalDiningPayment>[0];
  return {
    service: createCustomerAdmittedAdditionalDiningPayment(options),
    options,
    admission,
    scope,
  };
}
const input = {
  sessionCredential: "s".repeat(43),
  csrfCredential: "c".repeat(43),
  checkoutSessionReference: "synthetic",
  selectionReference: "synthetic",
  tip: { amountMinor: 0n, currencyCode: "CAD" },
};
it("uses the same admitted repository for recovery and new claims", async () => {
  const f = fixture(),
    repository = {};
  mocks.store.mockReturnValue(repository);
  const result = (await f.service.create(input)) as unknown as Parameters<
    typeof createCustomerPersistentAdditionalDiningPayment
  >[0];
  expect(result.payment.history).toBe(repository);
  const context = {} as Parameters<typeof result.payment.payment>[0];
  expect(result.payment.payment(context).repository).toBe(repository);
  expect(mocks.store).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: f.scope,
      quoteVersion: 2,
      transactions: f.options.transactions,
    }),
  );
});
it("creates separate authorization closures and repositories for separate requests", async () => {
  const f = fixture(),
    first = {},
    second = {};
  mocks.store.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await f.service.create(input);
  await f.service.create({ ...input, sessionCredential: "x".repeat(43) });
  expect(f.admission).toHaveBeenCalledTimes(2);
  expect(f.admission.mock.calls[0]?.[0]).not.toEqual(f.admission.mock.calls[1]?.[0]);
  expect(mocks.flow.mock.calls[0]?.[0].payment.history).toBe(first);
  expect(mocks.flow.mock.calls[1]?.[0].payment.history).toBe(second);
});
it("rejects invalid credentials before constructing a repository", async () => {
  const f = fixture();
  await expect(f.service.create({ ...input, sessionCredential: "invalid" })).rejects.toThrow();
  expect(mocks.store).not.toHaveBeenCalled();
  expect(f.admission).not.toHaveBeenCalled();
});

it("installs current credential history authority instead of a caller-supplied replacement", async () => {
  const f = fixture();
  mocks.store.mockReturnValue({});
  await f.service.create(input);
  const store = mocks.store.mock.calls[0]?.[0];
  expect(store.authorizeHistory).toBe(mocks.history.mock.results[0]?.value);
  expect(store.authorizeHistory).not.toBe(f.admission.mock.results[0]?.value.authorizeHistory);
  expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ scope: f.scope }), {
    sessionCredential: input.sessionCredential,
    csrfCredential: input.csrfCredential,
  });
});

it("installs actual Payment authority and shares history authorization with admission", async () => {
  const f = fixture();
  mocks.store.mockReturnValue({});
  const result = (await f.service.create(input)) as unknown as Parameters<
    typeof createCustomerPersistentAdditionalDiningPayment
  >[0];
  const context = {} as Parameters<typeof result.payment.payment>[0];
  const ports = result.payment.payment(context);
  expect(ports.authorization).toBe(mocks.paymentAuth.mock.results[0]?.value);
  expect(mocks.paymentAuth.mock.calls[0]?.[0].history.authorize).toBe(
    mocks.store.mock.calls[0]?.[0].authorizeHistory,
  );
  expect(mocks.paymentAuth.mock.calls[0]?.[1]).toEqual({
    sessionCredential: input.sessionCredential,
    csrfCredential: input.csrfCredential,
  });
});
