import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.scope }));
import { createMerchantRefundTransactions } from "./merchant-refund-transactions.js";
type Options = Parameters<typeof createMerchantRefundTransactions>[0];
const id = (n: number) => "0190fa82-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
async function fixture() {
  const state = { tenant: id(1), brand: id(2), store: id(3), actor: id(4) };
  const allowed = vi.fn(async () => true);
  d.scope.mockImplementation(async () => ({
    selected: { tenantReference: state.tenant },
    context: { brand: { brandReference: state.brand } },
    store: { storeReference: state.store },
    actorReference: state.actor,
    sessionReference: id(5),
    allowed,
  }));
  let rolledBack: unknown = null;
  const options = {
    persistence: {
      transactions: {
        run: async (work: (t: object) => Promise<unknown>) =>
          work({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }).catch(
            (error: unknown) => {
              rolledBack = error;
              throw error;
            },
          ),
      },
    } as unknown as Options["persistence"],
    sessionCookie: "synthetic-cookie",
    sessionReference: id(5),
    orderReference: id(6),
    requestReference: id(7),
  };
  const context = await createMerchantRefundTransactions(options);
  const query = { ...context.scope, orderReference: id(6), requestReference: id(7) };
  return { state, allowed, context, query, rolledBack: () => rolledBack };
}
it("binds the current Store scope with the refund execution permission", async () => {
  const f = await fixture();
  expect(f.context.scope).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
  });
  expect(f.context.actorReference).toBe(id(4));
  expect(d.scope.mock.calls[0]?.slice(2)).toEqual(["payment.refund.execute", id(5)]);
});
it("WP-2423: a run resolves the caller in full at its start and before its commit only", async () => {
  const f = await fixture();
  d.scope.mockClear();
  f.allowed.mockClear();
  const during: boolean[] = [];
  let ran: object | null = null;
  await f.context.transactions.run(async (tx) => {
    ran = tx;
    for (let i = 0; i < 5; i += 1) during.push(await f.context.authorize(tx, f.query));
    during.push(await (await f.context.resolveAuthority(tx)).authorize());
    // Another Order or request is refused without a query.
    during.push(await f.context.authorize(tx, { ...f.query, orderReference: id(99) }));
    during.push(await f.context.authorize(tx, { ...f.query, requestReference: id(99) }));
    // Another transaction is not this run's.
    await expect(f.context.resolveAuthority({ query: vi.fn() })).rejects.toThrow(
      "ORDINARY_REFUND_SEND_DENIED",
    );
  });
  expect(during).toEqual([true, true, true, true, true, true, false, false]);
  expect(d.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The run has ended: its owner callbacks are refused.
  await expect(f.context.authorize(ran as never, f.query)).rejects.toThrow(
    "ORDINARY_REFUND_SEND_DENIED",
  );
});
it("WP-2423: a changed selection refuses the run before its work", async () => {
  const f = await fixture();
  f.state.store = id(99);
  const work = vi.fn();
  await expect(f.context.transactions.run(work)).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(work).not.toHaveBeenCalled();
});
it("WP-2423: a permission withdrawn or Session ended during a run refuses it inside the transaction", async () => {
  const f = await fixture();
  f.allowed.mockReset();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const work = vi.fn(async () => "written");
  await expect(f.context.transactions.run(work)).rejects.toThrow("ORDINARY_REFUND_SEND_DENIED");
  expect(work).toHaveBeenCalledOnce();
  expect(f.rolledBack()).toMatchObject({ message: "ORDINARY_REFUND_SEND_DENIED" });
});
