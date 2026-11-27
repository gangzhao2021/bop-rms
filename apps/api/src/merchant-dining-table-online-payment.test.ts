import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningTableOnlinePaymentStop } from "./merchant-dining-table-online-payment.js";
import { DiningTableCheckoutError } from "./merchant-dining-table-checkout.js";

const m = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.scope }));

const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningTableOnlinePaymentStop>[0];
interface Authority {
  allowed(tx: object): Promise<boolean>;
}

function setup(payments: {
  stopAndRecord: (authority: Authority) => Promise<void>;
  read: (authority: Authority) => Promise<{ bill: unknown }>;
}) {
  const allowed = vi.fn(async () => true);
  m.scope.mockResolvedValue({
    selected: { tenantReference: id(3) },
    context: { brand: { brandReference: id(4) } },
    store: { storeReference: id(5) },
    actorReference: id(11),
    allowed,
  });
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}));
  const stop = createMerchantDiningTableOnlinePaymentStop({
    persistence: { transactions: { run } } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(20) }),
    } as unknown as Options["authentication"],
    payments: () => payments as unknown as ReturnType<Options["payments"]>,
  });
  return {
    stop: () => stop({ sessionCookie: "s", csrf: "c", command: { diningSessionReference: id(6) } }),
    allowed,
  };
}
beforeEach(() => vi.clearAllMocks());

it("M89: a recorded stop whose reply read fails still answers Stopped, without a bill", async () => {
  const f = setup({
    stopAndRecord: async () => undefined,
    read: async () => {
      throw new DiningTableCheckoutError("TABLE_CHECKOUT_PERMISSION_DENIED");
    },
  });
  await expect(f.stop()).resolves.toEqual({ status: "Stopped", bill: null });
});

it("M89: a stop that was not recorded keeps its meaning", async () => {
  const refused = setup({
    stopAndRecord: async () => {
      throw new DiningTableCheckoutError("TABLE_CHECKOUT_PERMISSION_DENIED");
    },
    read: async () => ({ bill: {} }),
  });
  await expect(refused.stop()).rejects.toMatchObject({ code: "TABLE_CHECKOUT_PERMISSION_DENIED" });
  const failing = setup({
    stopAndRecord: async () => {
      throw new Error("provider offline");
    },
    read: async () => ({ bill: {} }),
  });
  await expect(failing.stop()).rejects.toMatchObject({ code: "TABLE_CHECKOUT_UNAVAILABLE" });
});

it("M89: resolves the staff once per transaction however often the owner asks", async () => {
  const tx = {};
  const f = setup({
    stopAndRecord: async (authority) => {
      for (let i = 0; i < 12; i += 1) expect(await authority.allowed(tx)).toBe(true);
      expect(await authority.allowed({})).toBe(true);
    },
    read: async () => ({ bill: { totalMinor: "100" } }),
  });
  await expect(f.stop()).resolves.toEqual({ status: "Stopped", bill: { totalMinor: "100" } });
  // The first check, then one resolve per distinct transaction.
  expect(m.scope).toHaveBeenCalledTimes(3);
});
