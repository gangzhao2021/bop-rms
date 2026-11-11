import { expect, it, vi } from "vitest";
import { readRefundWithdrawnUnits } from "./order-refund-withdrawal.js";

const d = vi.hoisted(() => ({ withdrawals: vi.fn(), declined: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  listOrderItemRefundWithdrawals: d.withdrawals,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<object>()),
  listDeclinedOrdinaryRefundRequests: d.declined,
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("WP-2423 M10: counts the units withdrawn per dish, leaving out a declined refund's", async () => {
  d.withdrawals.mockResolvedValue([
    { orderItemReference: id(1), refundRequestReference: id(10), withdrawnQuantity: 1 },
    { orderItemReference: id(1), refundRequestReference: id(11), withdrawnQuantity: 2 },
    { orderItemReference: id(2), refundRequestReference: id(12), withdrawnQuantity: 1 },
  ]);
  d.declined.mockResolvedValue(new Set([id(11)]));
  const units = await readRefundWithdrawnUnits(
    {} as never,
    { brandReference: id(90), storeReference: id(91) },
    [id(80)],
  );
  expect([...units]).toEqual([
    [id(1), 1],
    [id(2), 1],
  ]);
  expect(d.declined).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
    id(10),
    id(11),
    id(12),
  ]);
  d.withdrawals.mockResolvedValue([]);
  expect(
    (
      await readRefundWithdrawnUnits(
        {} as never,
        { brandReference: id(90), storeReference: id(91) },
        [],
      )
    ).size,
  ).toBe(0);
});
