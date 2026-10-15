import { expect, it, vi } from "vitest";
import { guestsLeftRoundText } from "./TableGuestsLeft.js";
import {
  createTableClosePlanClient,
  parseTableClosePlan,
  resolvesOnConfirm,
  type TableCloseRound,
} from "./dining-table-close-plan-client.js";

const id = (n: number) => "01a4d500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const round = (overrides: Partial<TableCloseRound>): TableCloseRound => ({
  orderBatchReference: id(20),
  sequence: 4,
  state: "PaidNotSent",
  openItemCount: 2,
  startedItemCount: 0,
  cancellableItemReferences: [],
  refund: { method: "Online", amountMinor: "1130" },
  cancelsAt: null,
  ...overrides,
});
const wire = {
  orderReference: id(3),
  diningSessionReference: id(2),
  orderVersion: 19,
  observedAt: "2026-10-15T19:00:00.000Z",
  rounds: [
    {
      orderBatchReference: id(20),
      sequence: 4,
      state: "PaidNotSent",
      openItemCount: 1,
      startedItemCount: 0,
      cancellableItemReferences: [],
      refund: { method: "Online", amountMinor: "1130" },
      cancelsAt: null,
    },
    {
      orderBatchReference: id(21),
      sequence: 1,
      state: "AlreadyRefunded",
      openItemCount: 1,
      startedItemCount: 0,
      cancellableItemReferences: [],
      refund: { method: "Online", amountMinor: "0" },
      cancelsAt: null,
    },
  ],
  totals: { onlineMinor: "1130", cardMachineMinor: "0" },
};

it("DEC-TABLE-CLOSE-GUESTS-LEFT: words each round for staff, with amounts and no internal codes", () => {
  const now = Date.parse("2026-10-15T19:00:00.000Z");
  const texts = [
    guestsLeftRoundText(round({}), "America/Toronto", now),
    guestsLeftRoundText(
      round({ refund: { method: "CardMachine", amountMinor: "593" } }),
      "America/Toronto",
      now,
    ),
    guestsLeftRoundText(round({ state: "AlreadyRefunded" }), "America/Toronto", now),
    guestsLeftRoundText(
      round({ state: "NotPaid", refund: null, cancelsAt: "2026-10-15T19:20:00.000Z" }),
      "America/Toronto",
      now,
    ),
    guestsLeftRoundText(
      round({
        state: "PartlyStarted",
        refund: null,
        startedItemCount: 1,
        cancellableItemReferences: [id(30)],
      }),
      "America/Toronto",
      now,
      "450",
    ),
    guestsLeftRoundText(round({ state: "BeingMade", refund: null }), "America/Toronto", now),
    guestsLeftRoundText(
      round({
        state: "RefundOnCardMachine",
        refund: { method: "CardMachine", amountMinor: "593" },
      }),
      "America/Toronto",
      now,
    ),
  ];
  expect(texts[0]).toBe(
    "Round 4: paid CAD 11.30 online but never sent to the kitchen. It will be cancelled and the guest refunded.",
  );
  expect(texts[1]).toContain("refund it on the card machine");
  expect(texts[2]).toContain("already refunded in full");
  expect(texts[3]).toContain("cancelled automatically at 15:20");
  expect(texts[4]).toContain("CAD 4.50 refunded");
  expect(texts[5]).toContain("mark them served");
  expect(texts[6]).toContain("Refund CAD 5.93 on the card machine");
  for (const text of texts) expect(text).not.toMatch(/[0-9a-f]{8}-|GUEST_LEFT|PaidNotSent|Batch/u);
});

it("DEC-TABLE-CLOSE-GUESTS-LEFT: parses the plan strictly and resolves rounds with the existing cancellations", async () => {
  const plan = parseTableClosePlan(wire, { order: id(3), session: id(2) });
  expect(plan.rounds.map(resolvesOnConfirm)).toEqual([true, true]);
  expect(() => parseTableClosePlan(wire, { order: id(9), session: id(2) })).toThrow();
  expect(() =>
    parseTableClosePlan(
      { ...wire, rounds: [{ ...wire.rounds[0], refund: null }] },
      { order: id(3), session: id(2) },
    ),
  ).toThrow();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "Cancelled" }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "order_version_conflict" }), { status: 409 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "full_sign_in_required" }), { status: 403 }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  const client = createTableClosePlanClient(fetcher);
  const first = plan.rounds[0] as TableCloseRound;
  expect(await client.resolve(plan, first, id(40), csrf)).toBe("Done");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel");
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    orderReference: id(3),
    orderBatchReference: id(20),
    expectedOrderVersion: 19,
    operationReference: id(40),
    reasonCode: "GUEST_LEFT",
  });
  expect(await client.resolve(plan, first, id(41), csrf)).toBe("Changed");
  expect(await client.resolve(plan, first, id(42), csrf)).toBe("FullSignInRequired");
  expect(await client.resolve(plan, first, id(42), csrf)).toBe("Unknown");
  // Lines not started of a round partly made go through the item cancellation.
  const items = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
  await createTableClosePlanClient(items).resolve(
    plan,
    round({ state: "PartlyStarted", refund: null, cancellableItemReferences: [id(30)] }),
    id(43),
    csrf,
  );
  expect(items.mock.calls[0]?.[0]).toBe("/merchant/orders/cancel-items");
  expect(JSON.parse(String(items.mock.calls[0]?.[1]?.body))).toMatchObject({
    orderItemReferences: [id(30)],
    reasonCode: "GUEST_LEFT",
  });
});
