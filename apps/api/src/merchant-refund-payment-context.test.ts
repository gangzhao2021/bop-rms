import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantRefundPaymentContext } from "./merchant-refund-payment-context.js";
import { kdsOperatorProfileAllows } from "./merchant-kds-operator-profile.js";
const d = vi.hoisted(() => ({
  cards: (): unknown => ({
    loadByIntent: async () => null,
    loadByBatch: async () => null,
  }),
  resolve: vi.fn(),
  workforce: vi.fn(),
  binding: vi.fn(),
  terminal: vi.fn(),
  position: vi.fn(),
  bindingOptions: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("./merchant-workforce-authority-source.js", () => ({
  createMerchantWorkforcePermissionSource: () => d.workforce,
}));
const observations = vi.hoisted(() => ({
  at: null as string | null,
  calls: [] as string[],
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  // v15 2026-10-18: the time read once the Order's refund fence is held (recorded per call).
  observeOrdinaryRefundOrderAfterFence: async (
    _tx: unknown,
    _scope: unknown,
    orderReference: string,
    notBefore: string,
  ) => {
    observations.calls.push(orderReference);
    return observations.at ?? notBefore;
  },
  // WP-2423 item 4: no card-machine payment unless a test says so.
  createPostgresCardMachinePaymentStore: () => d.cards(),
  createPostgresPaymentIntentBindingSource: (options: unknown) => {
    d.bindingOptions(options);
    return d.binding;
  },
  createPostgresPaymentTerminalStore: () => ({ read: d.terminal }),
  createPostgresOrderPaymentRefundPosition: () => d.position,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantRefundPaymentContext>[0];
const at = "2026-09-20T12:00:00.000Z";
function setup() {
  const tx = {},
    allowed = vi.fn(async () => true);
  const current = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(4),
    allowed,
    kdsOperatorProfileAllows: vi.fn<(action: string) => boolean>(() => true),
  };
  d.resolve.mockResolvedValue(current);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  const authorize = vi.fn(async () => ({ sessionReference: id(5) }));
  const configure = vi.fn(async () => ({
    providerAccountReference: id(6),
    environment: "Test" as const,
    roleMapping: { Manager: ["manager"], Owner: ["owner"], Finance: [] },
  }));
  const operation = createMerchantRefundPaymentContext({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    resolveConfiguration: configure,
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { paymentIntentReference: id(8) },
  };
  return { tx, allowed, current, run, authorize, configure, operation, input };
}
const binding = {
  paymentIntentReference: id(8),
  paymentAttemptReference: id(13),
  orderReference: id(9),
  orderBatchReference: id(11),
};
const terminal = {
  ...binding,
  outcome: "Succeeded",
  recordedAt: at,
  paymentTransactionReference: id(14),
  amount: { currencyCode: "CAD", amountMinor: 2260n },
  providerIntentReference: "private",
};
beforeEach(() => {
  vi.clearAllMocks();
  observations.at = null;
  observations.calls.length = 0;
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] });
  d.binding.mockResolvedValue(binding);
  d.terminal.mockResolvedValue(terminal);
  d.position.mockResolvedValue({
    confirmedMinor: 100n,
    pendingMinor: 1130n,
    snapshotDigest: "private",
  });
});
it("binds actual captured payment and returns distinct confirmed and pending refund amounts", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    ...binding,
    observedAt: at,
    paymentState: "Captured",
    paymentMethod: "Online",
    currencyCode: "CAD",
    capturedAmountMinor: "2260",
    confirmedRefundMinor: "100",
    pendingRefundMinor: "1130",
    canRequest: true,
  });
  expect(d.position.mock.calls[0]?.[1]).toEqual({
    orderReference: id(9),
    paymentTransactionReference: id(14),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(13),
    observedAt: at,
  });
});
it.each([null, { ...terminal, outcome: "Failed" }])(
  "does not invent zero captured/refund amounts without capture case %#",
  async (value) => {
    const f = setup();
    d.terminal.mockResolvedValue(value);
    expect(await f.operation(f.input)).toEqual({
      ...binding,
      observedAt: at,
      paymentState: value === null ? "Unresolved" : "Failed",
      paymentMethod: "Online",
      currencyCode: null,
      capturedAmountMinor: null,
      confirmedRefundMinor: null,
      pendingRefundMinor: null,
      canRequest: true,
    });
    expect(d.position).not.toHaveBeenCalled();
  },
);
it("denies a kitchen display sign-in before any refund permission or payment lookup", async () => {
  const f = setup();
  f.current.kdsOperatorProfileAllows.mockImplementation((action: string) =>
    kdsOperatorProfileAllows({ policy: { code: "NamedKdsOperator" } }, action),
  );
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.workforce).not.toHaveBeenCalled();
  expect(d.binding).not.toHaveBeenCalled();
});
it("denies non-manager read before payment lookup", async () => {
  const f = setup();
  d.workforce.mockResolvedValue({ decision: { effect: "Allow" }, activeRoleCodes: ["kitchen"] });
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.binding).not.toHaveBeenCalled();
});
it.each([
  { ...terminal, paymentAttemptReference: id(99) },
  { ...terminal, orderReference: id(99) },
  { ...terminal, recordedAt: "2026-09-21T12:00:00.000Z" },
])("rejects incompatible terminal facts case %#", async (value) => {
  const f = setup();
  d.terminal.mockResolvedValue(value);
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(d.position).not.toHaveBeenCalled();
});
it("rejects refund totals exceeding captured amount", async () => {
  const f = setup();
  d.position.mockResolvedValue({ confirmedMinor: 2000n, pendingMinor: 1000n });
  await expect(f.operation(f.input)).rejects.toThrow();
});
it("WP-2423: resolves the caller in full exactly twice (start and before the reply)", async () => {
  const f = setup();
  await f.operation(f.input);
  expect(d.resolve).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // Who may read refunds is decided at the start and re-decided before the reply.
  expect(d.workforce).toHaveBeenCalledTimes(2);
});
it("WP-2423: a permission withdrawn or Session ended during the read refuses the reply", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
  expect(d.position).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
it("WP-2423: refund read access withdrawn during the read refuses the reply", async () => {
  const f = setup();
  d.workforce
    .mockResolvedValueOnce({ decision: { effect: "Allow" }, activeRoleCodes: ["manager"] })
    .mockResolvedValue({ decision: { effect: "Deny" }, activeRoleCodes: [] });
  await expect(f.operation(f.input)).rejects.toThrow("ORDINARY_REFUND_REQUEST_DENIED");
});
it("WP-2423: owner reads take the run's guard (true during the run, false after)", async () => {
  const f = setup();
  const during: boolean[] = [];
  d.binding.mockImplementation(async (tx: unknown) => {
    const { authorize } = d.bindingOptions.mock.calls[0]?.[0] as {
      authorize(tx: unknown): Promise<boolean>;
    };
    during.push(await authorize(tx));
    // Not this run's transaction: refused without a query.
    during.push(await authorize({ query: vi.fn() }));
    return binding;
  });
  await f.operation(f.input);
  const { authorize } = d.bindingOptions.mock.calls[0]?.[0] as {
    authorize(tx: unknown): Promise<boolean>;
  };
  const tx = d.binding.mock.calls[0]?.[0];
  expect(during).toEqual([true, false]);
  expect(await authorize(tx)).toBe(false);
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
it("rejects client supplied scope and clock", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, observedAt: at } }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
